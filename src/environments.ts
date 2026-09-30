import { BorrowerEnvironment, BorrowerEndpoint, type BorrowerClientConfig } from './types.js'

// Frozen: every URL is built from these, so a change at runtime would redirect calls.
export const BASE_URLS: Readonly<Record<BorrowerEnvironment, string>> = Object.freeze({
  [BorrowerEnvironment.STAGING]: 'https://finsys-api-stage.finhero.asia',
  [BorrowerEnvironment.PRODUCTION]: 'https://finsys-api.finhero.asia',
})

export const ENDPOINT_PATHS: Readonly<Record<BorrowerEndpoint, string>> = Object.freeze({
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
})

const NOT_A_URL =
  'baseUrl must be an absolute http(s) URL, such as https://finsys-api.example.com (SYS-3769)'

/** localhost, a loopback address, or a one-word Docker service name such as `finsys-api`. */
function isLocalHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true
  return !hostname.includes('.') && !hostname.startsWith('[')
}

/**
 * Returns `raw` as a bare origin such as `http://finsys-api:8006`, or throws.
 * Every call appends a fixed path to this origin, so a path here is a mistake.
 * Plain http is allowed only for a local host, since login sends the client
 * secret. Messages repeat at most `url.origin`; the rest of `raw` can carry secrets.
 */
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error(NOT_A_URL)
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(NOT_A_URL)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must use http or https (SYS-3769)')
  }
  if (url.username || url.password) {
    throw new Error('baseUrl must not contain a username or password (SYS-3769)')
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      `baseUrl must be an origin only, like ${url.origin}, with no path, query or fragment (SYS-3769)`
    )
  }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error(
      'baseUrl must use https unless the host is local, such as localhost or finsys-api (SYS-3769)'
    )
  }
  return url.origin
}

/**
 * The origin every call from a client with `config` goes to, or throws. The
 * types rule out the bad configs below, but they still arrive from plain-JS
 * callers and config read from files.
 */
export function resolveBaseUrl(config: BorrowerClientConfig): string {
  if (typeof config !== 'object' || config === null) {
    throw new Error('BorrowerApiClient needs a config object with environment or baseUrl (SYS-3769)')
  }
  const raw: { environment?: unknown; baseUrl?: unknown; endpointOverrides?: unknown } = config
  // null counts as unset: JSON and YAML config have no other way to say it.
  const isSet = (value: unknown) => value !== undefined && value !== null
  if (isSet(raw.endpointOverrides)) {
    throw new Error(
      'endpointOverrides was removed in 4.0.0 (SYS-3769); set baseUrl to the finsys-api origin instead'
    )
  }
  if (isSet(raw.environment) && isSet(raw.baseUrl)) {
    throw new Error('Set either environment or baseUrl, not both (SYS-3769)')
  }
  if (isSet(raw.baseUrl)) return normalizeBaseUrl(raw.baseUrl)
  if (!isSet(raw.environment)) {
    throw new Error('Set either environment or baseUrl (SYS-3769)')
  }
  if (typeof raw.environment !== 'string' || !Object.hasOwn(BASE_URLS, raw.environment)) {
    // Repeat the value only when it looks like a name; a URL put here by
    // mistake can carry a password or token.
    const shown =
      typeof raw.environment === 'string' && /^[A-Za-z_-]{1,20}$/.test(raw.environment)
        ? ` "${raw.environment}"`
        : ''
    throw new Error(
      `Unknown environment${shown}; use ${Object.values(BorrowerEnvironment).join(' or ')} (SYS-3769)`
    )
  }
  return BASE_URLS[raw.environment as BorrowerEnvironment]
}
