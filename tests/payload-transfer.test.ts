import { describe, it, expect } from 'vitest'
import { getBaseFieldSpecMap } from '@finsys/core'
import {
  resolvePayloadTransfer,
  listDocumentPatterns,
} from '../src/payload-transfer.js'

describe('resolvePayloadTransfer', () => {
  describe('document routing — takes precedence over ihs_column', () => {
    it.each([
      ['bank_statement_t1', 'bankStatements', 'path_array', 1],
      ['bank_statement_t6', 'bankStatements', 'path_array', 6],
      ['epf_statement_t2', 'epfStatements', 'path_array', 2],
      ['payslip_statement_t4', 'payslips', 'path_array', 4],
    ])('routes %s as document → %s', (name, apiField, format, tIndex) => {
      const rule = resolvePayloadTransfer(name)
      expect(rule).not.toBeNull()
      expect(rule!.kind).toBe('document')
      if (rule!.kind === 'document') {
        expect(rule.apiField).toBe(apiField)
        expect(rule.format).toBe(format)
        expect(rule.tIndex).toBe(tIndex)
      }
    })

    it.each([
      ['form9', 'form9', 'url_string'],
      ['ssm', 'ssm', 'url_string'],
      ['ic', 'ic', 'url_string'],
      ['experian_report', 'experianReports', 'url_string'],
      ['management_account', 'managementAccounts', 'path_array'],
    ])('routes single-file %s as document → %s', (name, apiField, format) => {
      const rule = resolvePayloadTransfer(name)
      expect(rule).not.toBeNull()
      expect(rule!.kind).toBe('document')
      if (rule!.kind === 'document') {
        expect(rule.apiField).toBe(apiField)
        expect(rule.format).toBe(format)
        expect(rule.tIndex).toBeUndefined()
      }
    })

    it('routes financials_* prefix matches as financialStatements document', () => {
      const rule = resolvePayloadTransfer('financials_fincap_t1')
      expect(rule!.kind).toBe('document')
      if (rule!.kind === 'document') {
        expect(rule.apiField).toBe('financialStatements')
      }
    })

    it('routes supplementaryDoc_* prefix matches as supplementaryDoc document', () => {
      const rule = resolvePayloadTransfer('supplementaryDoc_extra')
      expect(rule!.kind).toBe('document')
      if (rule!.kind === 'document') {
        expect(rule.apiField).toBe('supplementaryDoc')
        expect(rule.format).toBe('path_only')
      }
    })
  })

  describe('ihs_column resolution — for fields in BASE_FIELD_SPECS that are not documents', () => {
    it.each(['fullName', 'email', 'totalFinancing', 'mobilePhoneNo'])(
      'routes %s as ihs_column passthrough',
      (name) => {
        const rule = resolvePayloadTransfer(name)
        expect(rule).not.toBeNull()
        expect(rule!.kind).toBe('ihs_column')
        if (rule!.kind === 'ihs_column') {
          expect(rule.name).toBe(name)
        }
      }
    )
  })

  describe('unknown fields', () => {
    it.each(['Policy', 'PolicyCheckbox', 'Consent', 'pdpaCheckbox', 'customUiField'])(
      'returns null for UI-only field %s (not in BASE_FIELD_SPECS)',
      (name) => {
        expect(resolvePayloadTransfer(name)).toBeNull()
      }
    )

    it('returns null for typo of a document field name', () => {
      // "bonkstatement_t1" doesn't match any document pattern AND isn't in
      // BASE_FIELD_SPECS — exactly the kind of fat-finger that would have
      // silently slipped through pre-fix.
      expect(resolvePayloadTransfer('bonkstatement_t1')).toBeNull()
    })
  })

  describe('contract: every BASE_FIELD_SPECS name resolves to a rule', () => {
    // SYS-2347 contract test — if a new form field is added to @finsys/core
    // without thinking about how it lands on the API payload, this fails.
    // Either the new field is a real Ihs column (resolves to ihs_column
    // automatically) or it needs a document pattern in DOCUMENT_PATTERNS.
    it('every base-field-spec name has a non-null payload-transfer rule', () => {
      const baseSpecs = getBaseFieldSpecMap()
      const unresolved: string[] = []
      for (const name of baseSpecs.keys()) {
        if (resolvePayloadTransfer(name) === null) {
          unresolved.push(name)
        }
      }
      expect(unresolved, `BASE_FIELD_SPECS names with no rule: ${unresolved.join(', ')}`).toHaveLength(0)
    })

    // SYS-3706: the check above is too weak for FILE fields. A file field
    // that matches no document pattern still resolves, as an ihs_column
    // (every base-spec name does), so a new document type added to core
    // passed it while its upload fell through to supplementaryDoc: stored,
    // never extracted. Every file field must route as a document, to the API
    // field and wire format core declares for it.
    it('every file base-field-spec routes as a document to its declared document_type and wire_format', () => {
      const wrong: string[] = []
      for (const spec of getBaseFieldSpecMap().values()) {
        const s = spec as { name: string; type?: string; document_type?: string; wire_format?: string }
        if (s.type !== 'file' || !s.document_type) continue
        const rule = resolvePayloadTransfer(s.name)
        if (
          rule?.kind !== 'document' ||
          rule.apiField !== s.document_type ||
          (s.wire_format !== undefined && rule.format !== s.wire_format)
        ) {
          const got = rule ? (rule.kind === 'document' ? `${rule.apiField}/${rule.format}` : rule.kind) : 'null'
          wrong.push(`${s.name} -> ${got} (want ${s.document_type}/${s.wire_format})`)
        }
      }
      expect(wrong, `file fields not routed to their document type: ${wrong.join(', ')}`).toHaveLength(0)
    })
  })

  describe('listDocumentPatterns', () => {
    it('returns the 10 known document patterns', () => {
      const patterns = listDocumentPatterns()
      expect(patterns).toHaveLength(10)
      const apiFields = new Set(patterns.map((p) => p.apiField))
      expect(apiFields).toEqual(
        new Set([
          'bankStatements',
          'financialStatements',
          'epfStatements',
          'payslips',
          'form9',
          'ssm',
          'ic',
          'experianReports',
          'managementAccounts',
          'supplementaryDoc',
        ])
      )
    })
  })
})
