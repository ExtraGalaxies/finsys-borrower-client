import axios, { type AxiosError } from 'axios'
import FormData from 'form-data'
import { BASE_URLS, ENDPOINT_PATHS } from './environments.js'
import type {
  BorrowerClientConfig,
  CachedToken,
  UpstreamErrorDetail,
  UploadResult,
  SubmissionResult,
  UpdateResult,
  StatusResult,
  ConnectionTestResult,
  ConsentEventResult,
  AdapterAssertionPushBody,
  AdapterAssertionSubmitResult,
} from './types.js'
import { BorrowerEndpoint } from './types.js'

// SYS-3022: the header name must match finsys-api's SERVICE_ACCOUNT_HEADER
// constant (src/types/FinhubUserContext.ts) and FinHub's own outbound
// service-account gateway (finsys_api_gateway.ts). Kept literal here
// rather than imported from a shared package — finsys-api is a peer, not
// a dep of this client.
const SERVICE_ACCOUNT_KEY_HEADER = 'X-Finhub-Service-Key'

export class BorrowerApiClient {
  private config: BorrowerClientConfig
  private cachedToken: CachedToken | null = null
  /** Deduplicates concurrent login() calls to prevent token refresh races. */
  private pendingLogin: Promise<string> | null = null

  constructor(config: BorrowerClientConfig) {
    this.config = config
  }

  /**
   * Resolve the full URL for a given endpoint.
   * Uses endpointOverrides if provided, otherwise derives from environment base URL.
   */
  private resolveUrl(endpoint: BorrowerEndpoint, suffix?: string): string {
    const override = this.config.endpointOverrides?.[endpoint]
    if (override) {
      return suffix ? `${override}/${suffix}` : override
    }
    const base = BASE_URLS[this.config.environment]
    const path = ENDPOINT_PATHS[endpoint]
    const url = `${base}${path}`
    return suffix ? `${url}/${suffix}` : url
  }

  /**
   * Build common headers with gateway key if configured.
   */
  private gatewayHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.config.credentials.gatewayKey) {
      headers['Ocp-Apim-Subscription-Key'] = this.config.credentials.gatewayKey
    }
    return headers
  }

  /**
   * Base headers shared by every JSON request against finsys-api,
   * regardless of auth mode (bearer-token or service-account). Extracted
   * so the WAF-bypass User-Agent isn't copy-pasted per call site (SYS-3022
   * review finding): `authenticatedHeaders()` layers `Authorization` +
   * the FinXtract key on top of this; `submitAdapterAssertion()` layers
   * the service-account key on top instead.
   */
  private baseJsonHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      // Required to bypass Azure Application Gateway WAF bot protection
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...this.gatewayHeaders(),
    }
  }

  /**
   * Invalidate the cached auth token.
   */
  invalidateToken(): void {
    this.cachedToken = null
  }

  /**
   * Authenticate with the FinSys Borrower API and return a bearer token.
   * Caches the token and auto-refreshes with a 30s buffer.
   * Concurrent calls are deduplicated — only one login request runs at a time.
   */
  async login(): Promise<string> {
    const now = Date.now()

    if (this.cachedToken && this.cachedToken.expiresAt - 30_000 > now) {
      return this.cachedToken.token
    }

    // Deduplicate concurrent login calls
    if (this.pendingLogin) {
      return this.pendingLogin
    }

    this.pendingLogin = this.performLogin(now)
    try {
      return await this.pendingLogin
    } finally {
      this.pendingLogin = null
    }
  }

  private async performLogin(now: number): Promise<string> {
    const { clientId, clientSecret } = this.config.credentials
    if (!clientId || !clientSecret) {
      throw new Error('Client credentials (clientId and clientSecret) are required')
    }

    const credentials = Buffer.from(`${clientId}|${clientSecret}`).toString('base64')

    const response = await axios.post(
      this.resolveUrl(BorrowerEndpoint.LOGIN),
      null,
      {
        headers: {
          'Cache-Control': 'no-cache',
          'encoded-Code': credentials,
          ...this.gatewayHeaders(),
        },
        timeout: 15_000,
      }
    )

    const token = response.data?.token
    if (!token || typeof token !== 'string') {
      throw new Error('Login response did not contain a valid token')
    }
    const expiresIn = response.data.expires_in || response.data.expiresIn
    const expiresAt = expiresIn ? now + expiresIn * 1000 : now + 3600_000

    this.cachedToken = { token, expiresAt }
    return token
  }

  /**
   * Build authenticated headers for API requests.
   */
  private authenticatedHeaders(token: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...this.baseJsonHeaders(),
    }
    // SYS-2150: forward per-tenant FinXtract key so finsys-api can attribute OCR billing correctly.
    if (this.config.credentials.finxtractApiKey) {
      headers['X-Finxtract-Subscription-Key'] = this.config.credentials.finxtractApiKey
    }
    return headers
  }

  /**
   * Execute an authenticated request with automatic 401 retry.
   */
  private async withAuth<T>(
    fn: (token: string) => Promise<T>
  ): Promise<T> {
    let token = await this.login()

    try {
      return await fn(token)
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        this.invalidateToken()
        token = await this.login()
        return fn(token)
      }
      throw error
    }
  }

  /**
   * Upload a file to the FinSys Borrower API.
   */
  async uploadFile(fileBuffer: Buffer, fileName: string): Promise<UploadResult> {
    try {
      return await this.withAuth(async (token) => {
        const formData = new FormData()
        formData.append('file', fileBuffer, fileName)

        // Spread all authenticated headers except Content-Type — FormData
        // provides its own multipart Content-Type with the boundary token.
        const { 'Content-Type': _ct, ...baseHeaders } = this.authenticatedHeaders(token)
        const { data } = await axios.post(
          this.resolveUrl(BorrowerEndpoint.UPLOAD_FILE),
          formData,
          {
            headers: {
              ...baseHeaders,
              ...formData.getHeaders(),
            },
            timeout: 60_000,
          }
        )

        return {
          success: true,
          url: data?.data?.url || data?.data?.fileUrl || data?.url,
          data: data?.data,
        }
      })
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const { upstream, apiMessage } = BorrowerApiClient.extractUpstream(error)
        const statusPart = upstream.status !== undefined ? ` (${upstream.status})` : ''
        return {
          success: false,
          message: `File upload failed${statusPart}: ${apiMessage}`,
          data: error.response?.data,
          upstream,
        }
      }
      return {
        success: false,
        message: (error as Error).message || 'An unexpected error occurred during file upload',
      }
    }
  }

  /**
   * Submit a loan application to the FinSys Borrower API.
   */
  async submitApplication(payload: Record<string, unknown>): Promise<SubmissionResult> {
    try {
      return await this.withAuth(async (token) => {
        const response = await axios.post(
          this.resolveUrl(BorrowerEndpoint.SUBMISSION),
          payload,
          {
            headers: this.authenticatedHeaders(token),
            timeout: 30_000,
          }
        )

        return {
          success: true,
          applicationId: response.data?.applicationId,
          ihsId: response.data?.data?.ihsId,
          message: response.data?.message || 'Application submitted successfully',
          data: response.data?.data,
        }
      })
    } catch (error) {
      if (axios.isAxiosError(error)) {
        // Handle "partial success" where API returns 400 but creates the application
        if (error.response?.status === 400 && error.response?.data?.data?.ihsId) {
          return {
            success: true,
            ihsId: error.response.data.data.ihsId,
            message: 'Application created (with warnings)',
            data: error.response.data.data,
          }
        }

        const { upstream, apiMessage } = BorrowerApiClient.extractUpstream(error)
        const statusPart = upstream.status !== undefined ? ` (${upstream.status})` : ''
        return {
          success: false,
          message: `Submission failed${statusPart}: ${apiMessage}`,
          errors: (error.response?.data as { errors?: Record<string, string[]> } | undefined)?.errors,
          data: error.response?.data,
          upstream,
        }
      }
      return {
        success: false,
        message: 'An unexpected error occurred during submission',
      }
    }
  }

  /**
   * Extract typed upstream error detail and a human-readable message from an
   * axios error response. Centralizes the fallback chain used by every
   * axios-error catch block in this client. See SYS-2437.
   *
   * Fallback for the message string:
   *   err.desc  ->  err.code  ->  respData.message  ->  respData.error  ->  'Unknown error'
   *
   * The structured `upstream` object always includes the HTTP status when one
   * is present; `code`/`desc` are only set when the response body has the
   * finsys-api { err: { code, desc } } shape.
   */
  private static extractUpstream(error: AxiosError): {
    upstream: UpstreamErrorDetail
    apiMessage: string
  } {
    const status = error.response?.status
    const respData = error.response?.data as Record<string, unknown> | undefined
    const err = respData?.err as { code?: string; desc?: string } | undefined

    const apiMessage =
      err?.desc ||
      err?.code ||
      (respData?.message as string | undefined) ||
      (respData?.error as string | undefined) ||
      'Unknown error'

    return {
      upstream: { code: err?.code, desc: err?.desc, status },
      apiMessage,
    }
  }

  /** Validate that an ID is safe for URL path construction. */
  private static readonly SAFE_ID_PATTERN = /^[\w-]+$/

  /**
   * Get the status of an application by IHS ID.
   */
  async getApplicationStatus(ihsId: string): Promise<StatusResult> {
    if (!ihsId || !BorrowerApiClient.SAFE_ID_PATTERN.test(ihsId)) {
      return { success: false, message: 'Invalid ihsId format' }
    }

    try {
      return await this.withAuth(async (token) => {
        const response = await axios.get(
          this.resolveUrl(BorrowerEndpoint.STATUS, ihsId),
          {
            headers: this.authenticatedHeaders(token),
            timeout: 15_000,
          }
        )

        const status = response.data?.data?.status || response.data?.status
        return {
          success: true,
          ihsId,
          status,
          message: response.data?.message || 'Status retrieved successfully',
          data: response.data?.data,
        }
      })
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const { upstream, apiMessage } = BorrowerApiClient.extractUpstream(error)
        const statusPart = upstream.status !== undefined ? ` (${upstream.status})` : ''
        return {
          success: false,
          ihsId,
          message: `Status check failed${statusPart}: ${apiMessage}`,
          data: error.response?.data,
          upstream,
        }
      }
      return {
        success: false,
        ihsId,
        message: 'An unexpected error occurred during status check',
      }
    }
  }

  /**
   * Update an existing application.
   */
  async updateApplication(
    ihsId: string,
    payload: Record<string, unknown>
  ): Promise<UpdateResult> {
    if (!ihsId || !BorrowerApiClient.SAFE_ID_PATTERN.test(ihsId)) {
      return { success: false, message: 'Invalid ihsId format' }
    }

    try {
      return await this.withAuth(async (token) => {
        const response = await axios.patch(
          this.resolveUrl(BorrowerEndpoint.UPDATE, ihsId),
          payload,
          {
            headers: this.authenticatedHeaders(token),
            timeout: 30_000,
          }
        )

        return {
          success: true,
          message: response.data?.message || 'Application updated successfully',
          data: response.data?.data,
        }
      })
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const { upstream, apiMessage } = BorrowerApiClient.extractUpstream(error)
        const statusPart = upstream.status !== undefined ? ` (${upstream.status})` : ''
        return {
          success: false,
          message: `Update failed${statusPart}: ${apiMessage}`,
          data: error.response?.data,
          upstream,
        }
      }
      return {
        success: false,
        message: 'An unexpected error occurred during application update',
      }
    }
  }

  /**
   * Create a consent event for an IHS application.
   */
  async createConsentEvent(
    ihsId: string,
    payload: { consentDefinitionId: number; consentGiven: boolean; ipAddress?: string }
  ): Promise<ConsentEventResult> {
    if (!ihsId || !BorrowerApiClient.SAFE_ID_PATTERN.test(ihsId)) {
      return { success: false, message: 'Invalid ihsId format' }
    }

    try {
      return await this.withAuth(async (token) => {
        const response = await axios.post(
          this.resolveUrl(BorrowerEndpoint.CREATE_CONSENT, ihsId),
          payload,
          {
            headers: this.authenticatedHeaders(token),
            timeout: 15_000,
          }
        )

        return {
          success: true,
          data: response.data?.data,
          message: 'Consent event created',
        }
      })
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const { upstream, apiMessage } = BorrowerApiClient.extractUpstream(error)
        const statusPart = upstream.status !== undefined ? ` (${upstream.status})` : ''
        return {
          success: false,
          message: `Consent creation failed${statusPart}: ${apiMessage}`,
        }
      }
      return {
        success: false,
        message: 'An unexpected error occurred during consent creation',
      }
    }
  }

  /**
   * SYS-3022 — push an externally-orchestrated adapter assertion:
   * `POST /adapters/:adapterId/assertions`.
   *
   * Used by an external BFF that has already run its own live-consent
   * ceremony (e.g. a carrier CIBA out-of-band flow) and holds the
   * resulting canonical signals — it pushes the result here instead of
   * finsys-api pull-triggering the adapter's own fetch().
   *
   * Auth is DELIBERATELY DIFFERENT from every other method on this
   * client: this endpoint is service-account-authenticated via the
   * `X-Finhub-Service-Key` header (a static shared secret configured as
   * `config.credentials.serviceKey`), not the `clientId`/`clientSecret`
   * borrower-token flow `login()` performs. There is no token to cache or
   * refresh, so this method does NOT call `withAuth()` — a 401 here means
   * "the configured service key is wrong or unset", and retrying with the
   * same key would never succeed.
   *
   * Field values in `body` (especially `outcome.fields` and
   * `consent.authReqId`) are sent verbatim — no numeric coercion, no
   * trimming. An enum-label string like `"3"` must survive as the string
   * `"3"`, not become the number `3`.
   */
  async submitAdapterAssertion(
    adapterId: string,
    body: AdapterAssertionPushBody
  ): Promise<AdapterAssertionSubmitResult> {
    if (!adapterId || !BorrowerApiClient.SAFE_ID_PATTERN.test(adapterId)) {
      return { success: false, message: 'Invalid adapterId format' }
    }
    if (!this.config.credentials.serviceKey) {
      return {
        success: false,
        message:
          'Service key (config.credentials.serviceKey) is required to submit an adapter assertion',
      }
    }

    try {
      const headers: Record<string, string> = {
        ...this.baseJsonHeaders(),
        [SERVICE_ACCOUNT_KEY_HEADER]: this.config.credentials.serviceKey,
      }

      const response = await axios.post(
        this.resolveUrl(BorrowerEndpoint.SUBMIT_ADAPTER_ASSERTION, `${adapterId}/assertions`),
        body,
        {
          headers,
          timeout: 30_000,
        }
      )

      // SYS-3022 review finding (SYS-2946 hardening class): don't declare
      // success on a 201 whose envelope is missing or malformed. Validate
      // the two fields every caller depends on for correctness —
      // consentEventId (used to correlate the consent record) and
      // signalCount (used to confirm how much data landed). adapterRunId
      // is legitimately `number | null` for a skip outcome — it is passed
      // through as-is, never used as a success gate.
      const responseData = response.data?.data as
        | { consentEventId?: unknown; adapterRunId?: unknown; signalCount?: unknown }
        | undefined
      if (
        typeof responseData?.consentEventId !== 'number' ||
        typeof responseData?.signalCount !== 'number'
      ) {
        return {
          success: false,
          message:
            'Adapter assertion response was malformed: missing consentEventId or signalCount',
        }
      }

      return {
        success: true,
        data: {
          consentEventId: responseData.consentEventId,
          adapterRunId: responseData.adapterRunId as number | null,
          signalCount: responseData.signalCount,
        },
        message: 'Adapter assertion submitted successfully',
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const { upstream, apiMessage } = BorrowerApiClient.extractUpstream(error)
        const statusPart = upstream.status !== undefined ? ` (${upstream.status})` : ''
        return {
          success: false,
          message: `Adapter assertion submission failed${statusPart}: ${apiMessage}`,
          upstream,
        }
      }
      return {
        success: false,
        message: 'An unexpected error occurred during adapter assertion submission',
      }
    }
  }

  /**
   * Test the connection by attempting to authenticate.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const { clientId, clientSecret } = this.config.credentials
    if (!clientId || !clientSecret) {
      return { success: false, message: 'Client credentials are not configured.' }
    }

    const credentials = Buffer.from(`${clientId}|${clientSecret}`).toString('base64')
    const url = this.resolveUrl(BorrowerEndpoint.LOGIN)

    try {
      const response = await axios.post(url, null, {
        headers: {
          'Cache-Control': 'no-cache',
          'encoded-Code': credentials,
          ...this.gatewayHeaders(),
        },
        timeout: 15_000,
      })

      const expiresIn = response.data?.expires_in || response.data?.expiresIn
      const expiresMsg = expiresIn ? ` Token expires in ${expiresIn} seconds.` : ''
      return { success: true, message: `Connected successfully.${expiresMsg}` }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          return { success: false, message: 'Connection timed out. The service may be unreachable.' }
        }
        if (!error.response) {
          const detail = error.code || error.message || ''
          return {
            success: false,
            message: `Could not reach the server. Check the base URL. (${detail})`,
          }
        }
        const status = error.response.status
        if (status === 401) return { success: false, message: 'Credentials rejected by the server.' }
        if (status === 403) return { success: false, message: 'Access forbidden. Check client permissions.' }
        if (status === 404) return { success: false, message: 'Login endpoint not found. Verify the base URL.' }
        if (status >= 500) return { success: false, message: `Server error (${status}). The service may be down.` }
        return { success: false, message: `Request failed with status ${status}.` }
      }
      return { success: false, message: 'An unexpected error occurred.' }
    }
  }
}
