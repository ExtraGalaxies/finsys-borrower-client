import { getBaseFieldSpecMap } from '@finsys/core'

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

export interface BorrowerClientConfig {
  environment: BorrowerEnvironment
  credentials: {
    clientId: string
    clientSecret: string
    gatewayKey?: string
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
}

export interface SubmissionResult {
  success: boolean
  applicationId?: string
  ihsId?: string
  message?: string
  errors?: Record<string, string[]>
  data?: unknown
}

export interface UpdateResult {
  success: boolean
  message?: string
  data?: unknown
}

export interface StatusResult {
  success: boolean
  ihsId?: string
  status?: string
  message?: string
  data?: unknown
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
 * Convention-based mapping rules for file fields → FinSys API document format.
 *
 * Field names in @finsys/core base specs match API field names directly.
 * These rules define the serialization format for each file field pattern:
 * - `bank_statement_tN`    → `bankStatements: [{ path, month: N, year }]`
 * - `financials*`          → `financialStatements: [{ path, year: ordinal }]`
 * - `epf_statement_tN`     → `epfStatements: [{ path, month: N, year }]`
 * - `payslip_statement_tN` → `payslips: [{ path, month: N, year }]`
 * - `form9`                → `form9: "url"`
 * - `ssm`                  → `ssm: "url"`
 * - `ic`                   → `ic: "url"`
 * - `supplementaryDoc_*`   → `supplementaryDoc: [{ path }]`
 */
type FileFieldFormat = 'path_array' | 'url_string' | 'path_only'

const FILE_FIELD_RULES: {
  pattern: RegExp
  apiField: string
  format: FileFieldFormat
}[] = [
  { pattern: /^bank_statement_t(\d+)$/, apiField: 'bankStatements', format: 'path_array' },
  { pattern: /^financials/, apiField: 'financialStatements', format: 'path_array' },
  { pattern: /^epf_statement_t(\d+)$/, apiField: 'epfStatements', format: 'path_array' },
  { pattern: /^payslip_statement_t(\d+)$/, apiField: 'payslips', format: 'path_array' },
  { pattern: /^form9$/, apiField: 'form9', format: 'url_string' },
  { pattern: /^ssm$/, apiField: 'ssm', format: 'url_string' },
  { pattern: /^ic$/, apiField: 'ic', format: 'url_string' },
  { pattern: /^supplementaryDoc_/, apiField: 'supplementaryDoc', format: 'path_only' },
]

interface ResolvedMapping {
  apiField: string
  format: FileFieldFormat
  /** For bank_statement_tN: the N offset. undefined for other fields. */
  tIndex?: number
}

/** Match a file field name against known conventions. */
function resolveFieldMapping(fieldName: string): ResolvedMapping | undefined {
  for (const rule of FILE_FIELD_RULES) {
    const match = fieldName.match(rule.pattern)
    if (match) {
      return {
        apiField: rule.apiField,
        format: rule.format,
        tIndex: match[1] ? Number.parseInt(match[1], 10) : undefined,
      }
    }
  }
  return undefined
}

/**
 * Build the two-step submission payloads from form data.
 *
 * The FinSys API uses a two-step flow:
 * 1. **Create** (POST): Submit metadata only → returns `ihsId`
 * 2. **Finalize** (PATCH): Send documents + metadata with `ihsId`
 *
 * Uses `@finsys/core`'s base field specs as an allowlist — only fields present
 * in the base specs are included in payloads. File fields are provided separately
 * and mapped to the API format using field name conventions:
 *
 * - `bank_statement_tN`    → `bankStatements: [{ path, month: N, year }]`
 * - `financials*`          → `financialStatements: [{ path, year: ordinal }]`
 * - `epf_statement_tN`     → `epfStatements: [{ path, month: N, year }]`
 * - `payslip_statement_tN` → `payslips: [{ path, month: N, year }]`
 * - `form9`                → `form9: "url"`
 * - `ssm`                  → `ssm: "url"`
 * - `ic`                   → `ic: "url"`
 * - Unrecognized file fields → routed to `supplementaryDoc: [{ path }]`
 *
 * @param formData - The validated form data (metadata only, no file fields)
 * @param fileFields - File field data, separated by the frontend
 * @param now - Optional date for bank statement year computation (defaults to current date)
 * @param options - Optional configuration
 * @param options.nonUpdatableFields - Additional field names to exclude from the finalize payload
 */
export function buildSubmissionPayloads(
  formData: Record<string, unknown>,
  fileFields: Record<string, unknown>,
  now?: Date,
  options?: { nonUpdatableFields?: string[] }
): SubmissionPayloads {
  const currentYear = (now ?? new Date()).getFullYear()
  const baseSpecs = getBaseFieldSpecMap()

  // Filter formData through base specs allowlist
  const createPayload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(formData)) {
    if (baseSpecs.has(key)) {
      createPayload[key] = value
    }
  }

  // Process file fields: map known patterns, route unknowns to supplementaryDoc
  const mappedFields: { name: string; mapping: ResolvedMapping }[] = []
  const unmappedFileFields: { name: string; url: string }[] = []

  for (const name of Object.keys(fileFields)) {
    const mapping = resolveFieldMapping(name)
    if (mapping) {
      mappedFields.push({ name, mapping })
    } else {
      // Not in FILE_FIELD_RULES — route to supplementaryDoc
      const url = extractUrl(fileFields[name])
      if (url) {
        unmappedFileFields.push({ name, url })
      }
    }
  }

  // Group mapped file fields by apiField
  interface DocEntry {
    url: string
    mapping: ResolvedMapping
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
      documents[apiField] = entries[0].url
    } else if (format === 'path_only') {
      documents[apiField] = entries.map((e) => ({ path: e.url }))
    } else {
      // path_array: bank statements and financials
      documents[apiField] = entries.map((e, index) => {
        if (e.mapping.tIndex !== undefined) {
          return { path: e.url, month: e.mapping.tIndex, year: currentYear }
        }
        return { path: e.url, year: index + 1 }
      })
    }
  }

  // Route unmapped file fields to supplementaryDoc
  if (unmappedFileFields.length > 0) {
    const existing = documents.supplementaryDoc as { path: string }[] | undefined
    const suppDocs = existing ? [...existing] : []
    for (const { url } of unmappedFileFields) {
      suppDocs.push({ path: url })
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
