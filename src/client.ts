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
} from './types.js'
import { BorrowerEndpoint } from './types.js'

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
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      // Required to bypass Azure Application Gateway WAF bot protection
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...this.gatewayHeaders(),
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
        return {
          success: false,
          message: error.response?.data?.message || 'File upload failed',
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
        return {
          success: false,
          message: `Submission failed (${upstream.status}): ${apiMessage}`,
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
        const status = error.response?.status
        const respData = error.response?.data
        const apiMessage = respData?.message || respData?.error || 'Unknown error'
        return {
          success: false,
          ihsId,
          message: `Status check failed (${status}): ${apiMessage}`,
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
        return {
          success: false,
          message: `Update failed (${upstream.status}): ${apiMessage}`,
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
        return {
          success: false,
          message: `Consent creation failed (${error.response?.status}): ${error.response?.data?.message || 'Unknown error'}`,
        }
      }
      return {
        success: false,
        message: 'An unexpected error occurred during consent creation',
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
