import { getBaseFieldSpecMap } from '@finsys/core'

/**
 * SYS-2347: payload-transfer registry for the FinSys Borrower API.
 *
 * Owns the contract for "given a form field name, where (and how) does
 * it land on the FinSys API submission payload?". The registry is the
 * single authority that `buildSubmissionPayloads()` consults — replaces
 * the pre-fix pattern of using `BASE_FIELD_SPECS` from @finsys/core as
 * an allowlist, which conflated form-schema membership with API
 * payload-routing intent and let form-only field names like
 * `bank_statement_t1` slip through onto the payload as top-level
 * scalars (SYS-2321 production crash).
 *
 * Lives in @finsys/borrower-client (not @finsys/core) because payload
 * routing for the borrower endpoint is this lib's specialty by
 * definition; bloating core with it taxes the lead-gen sites,
 * finsys-api, and finsys-client which have no use for it.
 */

export type FileFieldFormat = 'path_array' | 'url_string' | 'path_only'

export type PayloadTransferKind = 'ihs_column' | 'document' | 'form_only'

export type PayloadTransferRule =
  | { kind: 'ihs_column'; name: string }
  | {
      kind: 'document'
      apiField: string
      format: FileFieldFormat
      /** For numbered patterns like bank_statement_t<N>: the captured N. */
      tIndex?: number
    }
  | { kind: 'form_only'; name: string }

interface DocumentPattern {
  pattern: RegExp
  apiField: string
  format: FileFieldFormat
}

/**
 * Document routing patterns. Order matters when patterns could overlap;
 * the first match wins. These take precedence over `ihs_column`
 * resolution so that even if a form-only field name appears in
 * BASE_FIELD_SPECS for form-rendering purposes, it correctly routes
 * as a document.
 */
const DOCUMENT_PATTERNS: readonly DocumentPattern[] = [
  { pattern: /^bank_statement_t(\d+)$/, apiField: 'bankStatements', format: 'path_array' },
  { pattern: /^financials/, apiField: 'financialStatements', format: 'path_array' },
  { pattern: /^epf_statement_t(\d+)$/, apiField: 'epfStatements', format: 'path_array' },
  { pattern: /^payslip_statement_t(\d+)$/, apiField: 'payslips', format: 'path_array' },
  { pattern: /^form9$/, apiField: 'form9', format: 'url_string' },
  { pattern: /^ssm$/, apiField: 'ssm', format: 'url_string' },
  { pattern: /^ic$/, apiField: 'ic', format: 'url_string' },
  { pattern: /^supplementaryDoc_/, apiField: 'supplementaryDoc', format: 'path_only' },
]

/**
 * Resolve a field name to its payload-transfer rule.
 *
 * - Returns `{ kind: 'document', ... }` when the name matches a known
 *   document pattern. Document routing wins over column resolution.
 * - Returns `{ kind: 'ihs_column', name }` when the name is a real Ihs
 *   entity column (i.e. present in BASE_FIELD_SPECS and not a document).
 * - Returns `null` when the name is unknown to both — caller decides
 *   whether to drop silently (default) or throw (strict mode).
 *
 * `form_only` is reserved for future use (UI-derived fields that should
 * never appear on the payload); no entries today.
 */
export function resolvePayloadTransfer(fieldName: string): PayloadTransferRule | null {
  for (const rule of DOCUMENT_PATTERNS) {
    const match = fieldName.match(rule.pattern)
    if (match) {
      return {
        kind: 'document',
        apiField: rule.apiField,
        format: rule.format,
        tIndex: match[1] ? Number.parseInt(match[1], 10) : undefined,
      }
    }
  }
  if (getBaseFieldSpecMap().has(fieldName)) {
    return { kind: 'ihs_column', name: fieldName }
  }
  return null
}

/**
 * For tests / contract checks: enumerate every document pattern. Used
 * by the @finsys/core ↔ @finsys/borrower-client contract test that
 * asserts every name in BASE_FIELD_SPECS resolves to a rule.
 */
export function listDocumentPatterns(): readonly DocumentPattern[] {
  return DOCUMENT_PATTERNS
}
