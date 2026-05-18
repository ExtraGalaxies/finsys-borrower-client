import {
  resolvePayloadTransfer,
  type FileFieldFormat,
  type PayloadTransferRule,
} from './payload-transfer.js'

export enum BorrowerEnvironment {
  STAGING = 'staging',
  PRODUCTION = 'production',
}

export enum BorrowerEndpoint {
  LOGIN = 'login',
  SUBMISSION = 'submission',
  UPDATE = 'update',
  UPLOAD_FILE = 'uploadFile',
  STATUS = 'status',
  CREATE_CONSENT = 'createConsent',
}

export interface ConsentEventResult {
  success: boolean
  data?: {
    ihsId: number
    id: number
    consentDefinitionId: number
    consentGiven: boolean
    ipAddress?: string
    createdAt?: string
  }
  message?: string
}

/**
 * Typed upstream error detail surfaced on failed result objects.
 *
 * Populated when the underlying axios call receives a response from
 * finsys-api. All fields are optional: WAF blocks at App Gateway
 * arrive with no body, so only `status` is set; some legacy paths
 * return only a `message` string, so `code`/`desc` may be undefined.
 *
 * Source shape: `finsys-api` returns errors as `{ err: { code, desc } }`
 * via its global errorHandler middleware. See SYS-2437.
 */
export interface UpstreamErrorDetail {
  /** Upstream error code (e.g. "APPLICATION_IS_FINALIZED" from finsys-api err.code). */
  code?: string
  /** Human-readable upstream error description (finsys-api err.desc). */
  desc?: string
  /** HTTP status from the upstream response. */
  status?: number
}

export interface BorrowerClientConfig {
  environment: BorrowerEnvironment
  credentials: {
    clientId: string
    clientSecret: string
    gatewayKey?: string
    /** SYS-2150: per-tenant FinXtract APIM subscription key for OCR billing attribution. */
    finxtractApiKey?: string
  }
  /** Optional per-endpoint full URL overrides */
  endpointOverrides?: Partial<Record<BorrowerEndpoint, string>>
}

export interface CachedToken {
  token: string
  expiresAt: number
}

export interface UploadResult {
  success: boolean
  url?: string
  data?: unknown
  message?: string
  /** Typed upstream error detail on failure (SYS-2437). Undefined on success. */
  upstream?: UpstreamErrorDetail
}

export interface SubmissionResult {
  success: boolean
  applicationId?: string
  ihsId?: string
  message?: string
  errors?: Record<string, string[]>
  data?: unknown
  /** Typed upstream error detail on failure (SYS-2437). Undefined on success. */
  upstream?: UpstreamErrorDetail
}

export interface UpdateResult {
  success: boolean
  message?: string
  data?: unknown
  /** Typed upstream error detail on failure (SYS-2437). Undefined on success. */
  upstream?: UpstreamErrorDetail
}

export interface StatusResult {
  success: boolean
  ihsId?: string
  status?: string
  message?: string
  data?: unknown
  /** Typed upstream error detail on failure (SYS-2437). Undefined on success. */
  upstream?: UpstreamErrorDetail
}

export interface ConnectionTestResult {
  success: boolean
  message: string
}

/**
 * Reference to a file that was uploaded via `BorrowerApiClient.uploadFile()`.
 * This is the shape that should be stored in form state after a successful upload.
 */
export interface UploadedFileRef {
  url: string
  name: string
}

// ─── Submission Payload Builder ──────────────────────────────────────────

/**
 * Result of `buildSubmissionPayloads()` — the two payloads for the two-step submission flow.
 */
export interface SubmissionPayloads {
  /** Step 1: Metadata-only payload (no document references) */
  createPayload: Record<string, unknown>
  /** Step 2: Full payload with transformed document references */
  finalizePayload: Record<string, unknown>
}

/**
 * Default fields that cannot be updated on an existing IHS entity.
 * These are excluded from the finalize (PATCH) payload.
 *
 * Consumers can extend this set via the `options.nonUpdatableFields` parameter
 * of `buildSubmissionPayloads()`.
 */
const DEFAULT_NON_UPDATABLE_FIELDS = new Set([
  'email',
  'fullName',
])

/**
 * Document-routing rules now live in `./payload-transfer.ts`. The
 * `resolvePayloadTransfer()` helper imported above returns a
 * discriminated union covering both `ihs_column` (passthrough scalar)
 * and `document` (file-field routing) — see that module for the full
 * registry + rationale (SYS-2347).
 */

type DocumentRule = Extract<PayloadTransferRule, { kind: 'document' }>

/**
 * Build the two-step submission payloads from form data.
 *
 * The FinSys API uses a two-step flow:
 * 1. **Create** (POST): Submit metadata only → returns `ihsId`
 * 2. **Finalize** (PATCH): Send documents + metadata with `ihsId`
 *
 * Field routing is governed by the payload-transfer registry in
 * `./payload-transfer.ts`. Each formData key resolves to one of:
 * - `ihs_column` — top-level scalar passthrough on the payload
 * - `document`   — misuse: caller passed a file URL as a scalar; warn
 *                  (or throw in strict mode) and skip
 * - unknown      — drop silently (or throw in strict mode)
 *
 * File fields are provided separately and mapped to API document
 * arrays per the same registry's document patterns:
 * - `bank_statement_tN`    → `bankStatements: [{ path, month: N, year }]`
 * - `financials*`          → `financialStatements: [{ path, year: ordinal }]`
 * - `epf_statement_tN`     → `epfStatements: [{ path, month: N, year }]`
 * - `payslip_statement_tN` → `payslips: [{ path, month: N, year }]`
 * - `form9` / `ssm` / `ic` → top-level URL string
 * - Unrecognized file fields → routed to `supplementaryDoc: [{ path }]`
 *
 * @param formData - The validated form data (metadata only, no file fields)
 * @param fileFields - File field data, separated by the frontend
 * @param now - Optional date for bank statement year computation (defaults to current date)
 * @param options - Optional configuration
 * @param options.nonUpdatableFields - Additional field names to exclude from the finalize payload
 * @param options.strict - When true, throw on caller misuse (document field
 *                         passed as scalar, unknown formData key) instead of
 *                         the default warn-and-skip. Recommended for new
 *                         callers; opt-in for backcompat with existing ones.
 */
export function buildSubmissionPayloads(
  formData: Record<string, unknown>,
  fileFields: Record<string, unknown>,
  now?: Date,
  options?: { nonUpdatableFields?: string[]; strict?: boolean }
): SubmissionPayloads {
  const currentYear = (now ?? new Date()).getFullYear()
  const strict = options?.strict ?? false

  // Route each formData key through the payload-transfer registry.
  const createPayload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(formData)) {
    const rule = resolvePayloadTransfer(key)
    if (!rule) {
      if (strict) {
        throw new Error(
          `buildSubmissionPayloads: unknown field "${key}" in formData (not in payload-transfer registry)`
        )
      }
      continue
    }
    if (rule.kind === 'ihs_column') {
      createPayload[key] = value
    } else if (rule.kind === 'document') {
      // Caller misuse — file URL passed as a top-level scalar instead of
      // via fileFields. Pre-fix this silently landed on the payload as a
      // bogus column write and crashed finsys-api's TypeORM (SYS-2321).
      const msg = `buildSubmissionPayloads: formData contains document field "${key}" — pass it via the fileFields argument instead`
      if (strict) throw new Error(msg)
      console.warn(msg)
    }
    // form_only: skip silently (no entries today; reserved for future)
  }

  // Process file fields: map known patterns, route unknowns to supplementaryDoc
  const mappedFields: { name: string; mapping: DocumentRule }[] = []
  const unmappedFileFields: { name: string; url: string }[] = []

  for (const name of Object.keys(fileFields)) {
    const rule = resolvePayloadTransfer(name)
    if (rule?.kind === 'document') {
      mappedFields.push({ name, mapping: rule })
    } else {
      // Not a known document pattern — route to supplementaryDoc.
      const url = extractUrl(fileFields[name])
      if (url) {
        unmappedFileFields.push({ name, url })
      }
    }
  }

  // Group mapped file fields by apiField
  interface DocEntry {
    url: string
    mapping: DocumentRule
  }
  const docGroups = new Map<string, { format: FileFieldFormat; entries: DocEntry[] }>()

  for (const { name, mapping } of mappedFields) {
    const url = extractUrl(fileFields[name])
    if (!url) continue

    const existing = docGroups.get(mapping.apiField)
    if (existing) {
      existing.entries.push({ url, mapping })
    } else {
      docGroups.set(mapping.apiField, {
        format: mapping.format,
        entries: [{ url, mapping }],
      })
    }
  }

  // Transform document groups into API format
  const documents: Record<string, unknown> = {}
  for (const [apiField, { format, entries }] of docGroups) {
    if (format === 'url_string') {
      documents[apiField] = encodeUrl(entries[0].url)
    } else if (format === 'path_only') {
      documents[apiField] = entries.map((e) => ({ path: encodeUrl(e.url) }))
    } else {
      // path_array: bank statements and financials
      documents[apiField] = entries.map((e, index) => {
        if (e.mapping.tIndex !== undefined) {
          return { path: encodeUrl(e.url), month: e.mapping.tIndex, year: currentYear }
        }
        return { path: encodeUrl(e.url), year: index + 1 }
      })
    }
  }

  // Route unmapped file fields to supplementaryDoc
  if (unmappedFileFields.length > 0) {
    const existing = documents.supplementaryDoc as { path: string }[] | undefined
    const suppDocs = existing ? [...existing] : []
    for (const { url } of unmappedFileFields) {
      suppDocs.push({ path: encodeUrl(url) })
    }
    documents.supplementaryDoc = suppDocs
  }

  // Finalize payload = updatable metadata + transformed documents
  const nonUpdatable = new Set(DEFAULT_NON_UPDATABLE_FIELDS)
  if (options?.nonUpdatableFields) {
    for (const f of options.nonUpdatableFields) nonUpdatable.add(f)
  }

  const finalizePayload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(createPayload)) {
    if (nonUpdatable.has(key)) continue
    finalizePayload[key] = value
  }
  Object.assign(finalizePayload, documents)

  return { createPayload, finalizePayload }
}

function encodeUrl(url: string): string {
  return Buffer.from(url).toString('base64')
}

/**
 * Extract a URL from a file field value.
 *
 * Accepted shapes:
 * - Plain URL string: `"https://..."`
 * - `UploadedFileRef[]`: `[{ url: "https://...", name: "file.pdf" }]`
 *
 * Note: For arrays, only the first element's URL is used. Each file field name
 * maps to one document entry — multiple files per field are not supported by
 * the upstream FinSys API format.
 *
 * Consumers must store uploaded file references using the `UploadedFileRef` shape.
 */
function extractUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0] as UploadedFileRef
    return first?.url || undefined
  }
  return undefined
}
