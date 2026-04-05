import { describe, it, expect } from 'vitest'
import { buildSubmissionPayloads } from '../src/types.js'

// Mock uploaded file URLs (as returned by FinSys uploadFile API)
const MOCK_URLS = {
  bank_t1: 'https://finherodms.blob.core.windows.net/dms-general-storage/237ee0a0578cf2d01dd7787717c65e4e24c344a014030b4de0057a06ea6e5ba6',
  bank_t2: 'https://finherodms.blob.core.windows.net/dms-general-storage/a23a5c72d806311126bec18c611b4f354cd4795c82281d60a55315520531b101',
  bank_t3: 'https://finherodms.blob.core.windows.net/dms-general-storage/c6b8f6225b6d00ec248ca7940e396b5f1e5bbd2e247285e4977899c2f9a8b96e',
  financials: 'https://finherodms.blob.core.windows.net/dms-general-storage/2b7d13cb6f9bb64d8bd0b65c361458a9b9237cc0ae85763a4b7b748a5f871472',
  ssm: 'https://finherodms.blob.core.windows.net/dms-general-storage/73b371998e4e50244bb1db08dbd3b4aa3e68e378b63e76aacc46a7a9182d3979',
}

describe('buildSubmissionPayloads', () => {
  it('produces correct create and finalize payloads with allowlist filtering', () => {
    const formData: Record<string, unknown> = {
      totalFinancing: 329000,
      fullName: 'John Doe',
      email: 'john@example.com',
      mobilePhoneNo: '0123456789',
    }

    const fileFields: Record<string, unknown> = {
      bank_statement_t1: [{ url: MOCK_URLS.bank_t1, name: 'bank-jan.pdf' }],
      bank_statement_t2: [{ url: MOCK_URLS.bank_t2, name: 'bank-feb.pdf' }],
      bank_statement_t3: [{ url: MOCK_URLS.bank_t3, name: 'bank-mar.pdf' }],
      financials: [{ url: MOCK_URLS.financials, name: 'financials-2025.pdf' }],
      ssm: [{ url: MOCK_URLS.ssm, name: 'form9.pdf' }],
    }

    const now = new Date(2026, 1, 15) // Feb 15, 2026

    const { createPayload, finalizePayload } = buildSubmissionPayloads(
      formData,
      fileFields,
      now
    )

    // createPayload: all base-spec metadata (no file fields)
    expect(createPayload).toEqual({
      totalFinancing: 329000,
      fullName: 'John Doe',
      email: 'john@example.com',
      mobilePhoneNo: '0123456789',
    })

    // finalizePayload: excludes non-updatable (fullName, email) but includes mobilePhoneNo
    expect(finalizePayload).toEqual({
      totalFinancing: 329000,
      mobilePhoneNo: '0123456789',
      bankStatements: [
        { path: MOCK_URLS.bank_t1, month: 1, year: 2026 },
        { path: MOCK_URLS.bank_t2, month: 2, year: 2026 },
        { path: MOCK_URLS.bank_t3, month: 3, year: 2026 },
      ],
      financialStatements: [
        { path: MOCK_URLS.financials, year: 1 },
      ],
      form9: MOCK_URLS.ssm,
    })

    expect(finalizePayload).not.toHaveProperty('fullName')
    expect(finalizePayload).not.toHaveProperty('email')
  })

  it('filters out custom/UI-only fields not in base specs', () => {
    const formData: Record<string, unknown> = {
      totalFinancing: 100000,
      fullName: 'Jane Doe',
      email: 'jane@test.com',
      // These are NOT in base specs → should be filtered out
      Policy: 'accepted',
      PolicyCheckbox: true,
      Consent: 'yes',
      pdpaCheckbox: true,
      formOfDisclosure: ['consented'],
      customUiField: 'should-not-appear',
    }

    const { createPayload } = buildSubmissionPayloads(formData, {})

    expect(createPayload.totalFinancing).toBe(100000)
    expect(createPayload.fullName).toBe('Jane Doe')
    expect(createPayload.email).toBe('jane@test.com')

    // Custom/UI-only fields filtered by allowlist
    expect(createPayload.Policy).toBeUndefined()
    expect(createPayload.PolicyCheckbox).toBeUndefined()
    expect(createPayload.Consent).toBeUndefined()
    expect(createPayload.pdpaCheckbox).toBeUndefined()
    expect(createPayload.formOfDisclosure).toBeUndefined()
    expect(createPayload.customUiField).toBeUndefined()
  })

  it('handles plain URL strings as file values', () => {
    const fileFields: Record<string, unknown> = {
      bank_statement_t1: MOCK_URLS.bank_t1,
      ssm: MOCK_URLS.ssm,
    }

    const { finalizePayload } = buildSubmissionPayloads(
      { totalFinancing: 50000 },
      fileFields,
      new Date(2026, 5, 1) // June 2026
    )

    expect(finalizePayload.bankStatements).toEqual([
      { path: MOCK_URLS.bank_t1, month: 1, year: 2026 },
    ])
    expect(finalizePayload.form9).toBe(MOCK_URLS.ssm)
  })

  it('skips file fields with no uploaded value', () => {
    const fileFields: Record<string, unknown> = {
      bank_statement_t1: [{ url: MOCK_URLS.bank_t1, name: 'stmt.pdf' }],
      bank_statement_t2: [], // empty — no upload
      bank_statement_t3: undefined, // not provided
      financials: [{ url: MOCK_URLS.financials, name: 'fin.pdf' }],
      // ssm missing entirely
    }

    const { createPayload, finalizePayload } = buildSubmissionPayloads(
      { totalFinancing: 100000 },
      fileFields,
      new Date(2026, 0, 10) // Jan 2026
    )

    expect(createPayload).toEqual({ totalFinancing: 100000 })

    expect(finalizePayload.bankStatements).toEqual([
      { path: MOCK_URLS.bank_t1, month: 1, year: 2026 },
    ])
    expect(finalizePayload.financialStatements).toEqual([
      { path: MOCK_URLS.financials, year: 1 },
    ])
    expect(finalizePayload).not.toHaveProperty('form9')
  })

  it('handles 6 bank statements', () => {
    const fileFields: Record<string, unknown> = {}
    for (let i = 1; i <= 6; i++) {
      fileFields[`bank_statement_t${i}`] = [{ url: `https://blob.example.com/bank-${i}`, name: `bank-${i}.pdf` }]
    }

    const { finalizePayload } = buildSubmissionPayloads(
      {},
      fileFields,
      new Date(2026, 3, 1) // April 2026
    )

    expect(finalizePayload.bankStatements).toEqual([
      { path: 'https://blob.example.com/bank-1', month: 1, year: 2026 },
      { path: 'https://blob.example.com/bank-2', month: 2, year: 2026 },
      { path: 'https://blob.example.com/bank-3', month: 3, year: 2026 },
      { path: 'https://blob.example.com/bank-4', month: 4, year: 2026 },
      { path: 'https://blob.example.com/bank-5', month: 5, year: 2026 },
      { path: 'https://blob.example.com/bank-6', month: 6, year: 2026 },
    ])
  })

  it('handles multiple financial statements (fincap with t1/t2)', () => {
    const fileFields: Record<string, unknown> = {
      financials_fincap_t1: [{ url: 'https://blob.example.com/fin-t1', name: 'fin-t1.pdf' }],
      financials_fincap_t2: [{ url: 'https://blob.example.com/fin-t2', name: 'fin-t2.pdf' }],
    }

    const { finalizePayload } = buildSubmissionPayloads({}, fileFields)

    expect(finalizePayload.financialStatements).toEqual([
      { path: 'https://blob.example.com/fin-t1', year: 1 },
      { path: 'https://blob.example.com/fin-t2', year: 2 },
    ])
  })

  it('maps supplementaryDoc_* fields to supplementaryDoc path_only array', () => {
    const fileFields: Record<string, unknown> = {
      supplementaryDoc_companyprofile: [{ url: 'https://blob.example.com/company-profile.pdf', name: 'profile.pdf' }],
      supplementaryDoc_nric: [{ url: 'https://blob.example.com/nric.pdf', name: 'nric.pdf' }],
      supplementaryDoc_SKU: [{ url: 'https://blob.example.com/sku.json', name: 'Product_SKU.json' }],
    }

    const { createPayload, finalizePayload } = buildSubmissionPayloads(
      { totalFinancing: 75000 },
      fileFields
    )

    expect(createPayload).toEqual({ totalFinancing: 75000 })

    expect(finalizePayload.supplementaryDoc).toEqual([
      { path: 'https://blob.example.com/company-profile.pdf' },
      { path: 'https://blob.example.com/nric.pdf' },
      { path: 'https://blob.example.com/sku.json' },
    ])
  })

  it('routes custom file fields (not matching any rule) to supplementaryDoc', () => {
    const fileFields: Record<string, unknown> = {
      bank_statement_t1: [{ url: MOCK_URLS.bank_t1, name: 'bank.pdf' }],
      custom_document: [{ url: 'https://blob.example.com/custom.pdf', name: 'custom.pdf' }],
    }

    const { finalizePayload } = buildSubmissionPayloads(
      { totalFinancing: 50000 },
      fileFields,
      new Date(2026, 0, 1)
    )

    // Mapped field works normally
    expect(finalizePayload.bankStatements).toEqual([
      { path: MOCK_URLS.bank_t1, month: 1, year: 2026 },
    ])

    // Unmapped file field routed to supplementaryDoc
    expect(finalizePayload.supplementaryDoc).toEqual([
      { path: 'https://blob.example.com/custom.pdf' },
    ])
  })

  it('skips unmapped file fields with no uploaded value', () => {
    const fileFields: Record<string, unknown> = {
      custom_document: [], // empty — no upload
    }

    const { finalizePayload } = buildSubmissionPayloads(
      { totalFinancing: 50000 },
      fileFields
    )

    expect(finalizePayload).not.toHaveProperty('supplementaryDoc')
  })

  it('does not leak non-file fields into document groups', () => {
    const formData: Record<string, unknown> = {
      totalFinancing: 200000,
      fullName: 'Jane Doe',
      email: 'jane@test.com',
    }

    const { createPayload, finalizePayload } = buildSubmissionPayloads(
      formData,
      {} // no file fields
    )

    expect(createPayload).toEqual({
      totalFinancing: 200000,
      fullName: 'Jane Doe',
      email: 'jane@test.com',
    })

    // finalizePayload excludes only fullName/email
    expect(finalizePayload).toEqual({ totalFinancing: 200000 })
    expect(finalizePayload).not.toHaveProperty('fullName')
    expect(finalizePayload).not.toHaveProperty('email')
  })

  it('includes mobilePhoneNo in finalize payload (no longer non-updatable)', () => {
    const formData: Record<string, unknown> = {
      totalFinancing: 100000,
      fullName: 'Test User',
      email: 'test@test.com',
      mobilePhoneNo: '0123456789',
    }

    const { finalizePayload } = buildSubmissionPayloads(formData, {})

    expect(finalizePayload.mobilePhoneNo).toBe('0123456789')
    expect(finalizePayload).not.toHaveProperty('fullName')
    expect(finalizePayload).not.toHaveProperty('email')
  })

  it('excludes custom nonUpdatableFields from finalize payload', () => {
    const formData: Record<string, unknown> = {
      totalFinancing: 100000,
      fullName: 'Test User',
      email: 'test@test.com',
      mobilePhoneNo: '0123456789',
    }

    const { finalizePayload } = buildSubmissionPayloads(formData, {}, undefined, {
      nonUpdatableFields: ['mobilePhoneNo'],
    })

    expect(finalizePayload).not.toHaveProperty('mobilePhoneNo')
    expect(finalizePayload.totalFinancing).toBe(100000)
    // Default non-updatable fields still excluded
    expect(finalizePayload).not.toHaveProperty('fullName')
    expect(finalizePayload).not.toHaveProperty('email')
  })

  it('maps ssm_business_information to ssm (url_string format)', () => {
    const fileFields: Record<string, unknown> = {
      ssm_business_information: [{ url: 'https://blob.example.com/ssm-biz.pdf', name: 'ssm-biz.pdf' }],
    }

    const { finalizePayload } = buildSubmissionPayloads(
      { totalFinancing: 100000 },
      fileFields
    )

    // ssm_business_information maps to apiField 'ssm' (not 'form9')
    expect(finalizePayload.ssm).toBe('https://blob.example.com/ssm-biz.pdf')
    expect(finalizePayload).not.toHaveProperty('form9')
  })

  it('maps ssm to form9 (url_string format)', () => {
    const fileFields: Record<string, unknown> = {
      ssm: [{ url: 'https://blob.example.com/form9.pdf', name: 'form9.pdf' }],
    }

    const { finalizePayload } = buildSubmissionPayloads(
      { totalFinancing: 100000 },
      fileFields
    )

    expect(finalizePayload.form9).toBe('https://blob.example.com/form9.pdf')
    expect(finalizePayload).not.toHaveProperty('ssm')
  })

  it('handles both ssm_business_information and ssm in the same payload', () => {
    const fileFields: Record<string, unknown> = {
      ssm_business_information: [{ url: 'https://blob.example.com/ssm-biz.pdf', name: 'ssm-biz.pdf' }],
      ssm: [{ url: 'https://blob.example.com/form9.pdf', name: 'form9.pdf' }],
    }

    const { finalizePayload } = buildSubmissionPayloads(
      { totalFinancing: 100000 },
      fileFields
    )

    // ssm_business_information maps to 'ssm', ssm maps to 'form9'
    expect(finalizePayload.ssm).toBe('https://blob.example.com/ssm-biz.pdf')
    expect(finalizePayload.form9).toBe('https://blob.example.com/form9.pdf')
  })

  it('merges supplementaryDoc from rules and unmapped fields', () => {
    const fileFields: Record<string, unknown> = {
      supplementaryDoc_nric: [{ url: 'https://blob.example.com/nric.pdf', name: 'nric.pdf' }],
      custom_extra_doc: [{ url: 'https://blob.example.com/extra.pdf', name: 'extra.pdf' }],
    }

    const { finalizePayload } = buildSubmissionPayloads({}, fileFields)

    // Both rule-matched supplementaryDoc and unmapped files end up in supplementaryDoc
    expect(finalizePayload.supplementaryDoc).toEqual([
      { path: 'https://blob.example.com/nric.pdf' },
      { path: 'https://blob.example.com/extra.pdf' },
    ])
  })
})
