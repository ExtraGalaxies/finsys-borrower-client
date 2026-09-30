import { BorrowerEnvironment, BorrowerEndpoint, type BorrowerClientConfig } from './types.js'

export const BASE_URLS: Record<BorrowerEnvironment, string> = {
  [BorrowerEnvironment.STAGING]: 'https://finsys-api-stage.finhero.asia',
  [BorrowerEnvironment.PRODUCTION]: 'https://finsys-api.finhero.asia',
}

export const ENDPOINT_PATHS: Record<BorrowerEndpoint, string> = {
  [BorrowerEndpoint.LOGIN]: '/auth/client/login',
  [BorrowerEndpoint.SUBMISSION]: '/client/ihs/client/submission',
  [BorrowerEndpoint.UPDATE]: '/client/ihs/update',
  [BorrowerEndpoint.UPLOAD_FILE]: '/file/upload/file/temp',
  [BorrowerEndpoint.STATUS]: '/client/ihs/check/status',
  [BorrowerEndpoint.CREATE_CONSENT]: '/client/ihs/createConsentEvent',
  // Mounted at root (not under /client) — finsys-api's
  // controllers/index.ts does `router.use('/adapters', adapterAssertionController)`.
  // The adapterId + trailing "/assertions" segment is appended via
  // resolveUrl()'s suffix parameter: submitAdapterAssertion() calls
  // resolveUrl(SUBMIT_ADAPTER_ASSERTION, `${adapterId}/assertions`).
  [BorrowerEndpoint.SUBMIT_ADAPTER_ASSERTION]: '/adapters',
}

const NOT_A_URL =
  'baseUrl must be an absolute http(s) URL, such as https://finsys-api.example.com (SYS-3769)'

/**
 * Returns `raw` as a bare origin such as `http://finsys-api:8006`, or throws.
 * Every call appends a fixed path to this origin, so a path here is a mistake,
 * usually an old per-endpoint URL pasted in whole. Messages never repeat the
 * path, query or password, which can carry secrets.
 */
export function normalizeBaseUrl(raw: string): string {
  if (typeof raw !== 'string') throw new Error(NOT_A_URL)
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(NOT_A_URL)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`baseUrl must use http or https, not ${url.protocol} (SYS-3769)`)
  }
  if (url.username || url.password) {
    throw new Error('baseUrl must not contain a username or password (SYS-3769)')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      `baseUrl must be an origin only, like ${url.origin}, with no path, query or fragment (SYS-3769)`
    )
  }
  return url.origin
}

/**
 * The origin every call from a client with `config` goes to, or throws. The
 * types already rule these cases out; this also catches plain-JS callers and
 * config read from files.
 */
export function resolveBaseUrl(config: BorrowerClientConfig): string {
  const raw: { environment?: unknown; baseUrl?: unknown; endpointOverrides?: unknown } = config
  if (raw.endpointOverrides !== undefined) {
    throw new Error(
      'endpointOverrides was removed in 4.0.0 (SYS-3769); set baseUrl to the finsys-api origin instead'
    )
  }
  if (raw.environment !== undefined && raw.baseUrl !== undefined) {
    throw new Error('Set either environment or baseUrl, not both (SYS-3769)')
  }
  if (raw.baseUrl !== undefined) return normalizeBaseUrl(raw.baseUrl as string)
  if (raw.environment === undefined) {
    throw new Error('Set either environment or baseUrl (SYS-3769)')
  }
  if (typeof raw.environment !== 'string' || !Object.hasOwn(BASE_URLS, raw.environment)) {
    throw new Error(
      `Unknown environment "${String(raw.environment)}"; use ${Object.values(BorrowerEnvironment).join(' or ')} (SYS-3769)`
    )
  }
  return BASE_URLS[raw.environment as BorrowerEnvironment]
}
