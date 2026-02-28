import type { FieldData } from '@finsys/core'

export enum BorrowerEnvironment {
  STAGING = 'staging',
  PRODUCTION = 'production',
}

export enum BorrowerEndpoint {
  LOGIN = 'login',
  SUBMISSION = 'submission',
  UPDATE = 'update',
  UPLOAD_FILE = 'uploadFile',
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
 * Matches lead-gen-ui BFF cleanup: email, fullName, mobilePhoneNo, formOfDisclosure.
 *
 * Consumers can extend this set via the `options.nonUpdatableFields` parameter
 * of `buildSubmissionPayloads()`.
 */
const DEFAULT_NON_UPDATABLE_FIELDS = new Set([
  'email',
  'fullName',
  'full_name',
  'mobilePhoneNo',
  'mobile_phone_no',
  'phone',
  'formOfDisclosure',
  'form_of_disclosure',
])

/**
 * Categories whose fields are excluded from the finalize (PATCH) payload.
 * These categories contain contact and consent fields that the IHS API rejects on update.
 */
const NON_UPDATABLE_CATEGORIES = new Set(['contact', 'consent'])

/**
 * Convention-based mapping rules for file fields → FinSys API document format.
 *
 * These are derived from the FinSys Borrower API's expected payload structure:
 * - `bank_statement_tN` → `bankStatements: [{ path, month: N, year: currentYear }]`
 * - `financials*`       → `financialStatements: [{ path, year: ordinalIndex }]`
 * - `ssm`               → `form9: "url"`
 */
const FILE_FIELD_RULES: {
  pattern: RegExp
  apiField: string
  format: 'path_array' | 'url_string'
}[] = [
  { pattern: /^bank_statement_t(\d+)$/, apiField: 'bankStatements', format: 'path_array' },
  { pattern: /^financials/, apiField: 'financialStatements', format: 'path_array' },
  { pattern: /^ssm$/, apiField: 'form9', format: 'url_string' },
]

interface ResolvedMapping {
  apiField: string
  format: 'path_array' | 'url_string'
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
 * File fields are identified from the form config `fields` object (entries with
 * `type: 'file'`) and mapped to the API format using field name conventions:
 *
 * - `bank_statement_tN` → grouped into `bankStatements: [{ path, month: N, year }]`
 * - `financials*`       → grouped into `financialStatements: [{ path, year: ordinal }]`
 * - `ssm`               → mapped to `form9: "url"`
 *
 * @param formData - The validated form data (file fields as UploadedFileRef[] or URL strings)
 * @param fields - The form config `fields` object (`Record<string, FieldData>` from `@finsys/core`)
 * @param now - Optional date for bank statement year computation (defaults to current date)
 * @param options - Optional configuration
 * @param options.nonUpdatableFields - Additional field names to exclude from the finalize payload
 */
export function buildSubmissionPayloads(
  formData: Record<string, unknown>,
  fields: Record<string, FieldData>,
  now?: Date,
  options?: { nonUpdatableFields?: string[] }
): SubmissionPayloads {
  const currentYear = (now ?? new Date()).getFullYear()

  // Identify file fields and their mappings
  const fileFieldNames = new Set<string>()
  const mappedFields: { name: string; mapping: ResolvedMapping }[] = []

  for (const [name, def] of Object.entries(fields)) {
    if (def.type !== 'file') continue
    fileFieldNames.add(name)
    const mapping = resolveFieldMapping(name)
    if (mapping) {
      mappedFields.push({ name, mapping })
    }
  }

  // Separate metadata from file fields
  const createPayload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(formData)) {
    if (!fileFieldNames.has(key)) {
      createPayload[key] = value
    }
  }

  // Group mapped file fields by apiField
  interface DocEntry {
    url: string
    mapping: ResolvedMapping
  }
  const docGroups = new Map<string, { format: 'path_array' | 'url_string'; entries: DocEntry[] }>()

  for (const { name, mapping } of mappedFields) {
    const url = extractUrl(formData[name])
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
    } else {
      documents[apiField] = entries.map((e, index) => {
        if (e.mapping.tIndex !== undefined) {
          // bank_statement_tN: month = N, year = current year
          return { path: e.url, month: e.mapping.tIndex, year: currentYear }
        }
        // financials etc: year = 1-based ordinal position
        return { path: e.url, year: index + 1 }
      })
    }
  }

  // Finalize payload = updatable metadata + transformed documents
  // Excludes fields the IHS API rejects on update, using two layers:
  // 1. Category-based: fields in 'contact' or 'consent' categories
  // 2. Name-based: known non-updatable field names (+ consumer-provided extras)
  const nonUpdatable = new Set(DEFAULT_NON_UPDATABLE_FIELDS)
  if (options?.nonUpdatableFields) {
    for (const f of options.nonUpdatableFields) nonUpdatable.add(f)
  }

  const finalizePayload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(createPayload)) {
    const fieldDef = fields[key]
    const category = fieldDef?.category
    if (nonUpdatable.has(key)) continue
    if (category && NON_UPDATABLE_CATEGORIES.has(category)) continue
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
