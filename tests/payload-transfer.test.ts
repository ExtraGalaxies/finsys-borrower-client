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
  })

  describe('listDocumentPatterns', () => {
    it('returns the 8 known document patterns', () => {
      const patterns = listDocumentPatterns()
      expect(patterns).toHaveLength(8)
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
          'supplementaryDoc',
        ])
      )
    })
  })
})
