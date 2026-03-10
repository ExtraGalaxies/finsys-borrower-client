import { describe, it, expect } from 'vitest'
import { buildSubmissionPayloads } from '../src/types.js'
import type { FieldData } from '@finsys/core'

// ─── Test form config (matches lead-gen-ui finhero-sme form-config.json) ─────

const SME_FORM_FIELDS: Record<string, FieldData> = {
  fullName: {
    displayName: 'Full Name',
    type: 'text',
    category: 'contact',
    required: true,
  },
  email: {
    displayName: 'Email',
    type: 'text',
    category: 'contact',
    required: true,
    inputType: 'email',
  },
  totalFinancing: {
    displayName: 'Financing Amount (RM)',
    type: 'slider',
    category: 'financing',
    required: true,
  },
  formOfDisclosure: {
    displayName: 'Consent',
    type: 'checkbox',
    category: 'consent',
  },
  bank_statement_t1: {
    displayName: 'Bank Statement (Month T-1)',
    type: 'file',
    category: 'documents',
    required: true,
    ihs_column_names: ['bankBalanceT1'],
  },
  bank_statement_t2: {
    displayName: 'Bank Statement (Month T-2)',
    type: 'file',
    category: 'documents',
    required: true,
    ihs_column_names: ['bankBalanceT2'],
  },
  bank_statement_t3: {
    displayName: 'Bank Statement (Month T-3)',
    type: 'file',
    category: 'documents',
    required: true,
    ihs_column_names: ['bankBalanceT3'],
  },
  financials: {
    displayName: 'Audited Financial Statement',
    type: 'file',
    category: 'documents',
    required: true,
    ihs_column_names: [
      'shareCapital',
      'totalEquityT1',
      'totalEquityT2',
      'totalCurrentLiabilities',
      'shortTermLiabilities',
      'totalAssets',
      'totalCurrentAssets',
      'tangibleAssets',
      'netProfitT1',
      'netProfitT2',
      'endOfYearCash',
      'netOperatingCashFlow',
      'ebitda',
    ],
  },
  ssm: {
    displayName: 'Form 9 / Section 17 / Form D',
    type: 'file',
    category: 'documents',
    required: true,
    ihs_column_names: ['incorporatedDate'],
  },
}

// Mock uploaded file URLs (as returned by FinSys uploadFile API)
const MOCK_URLS = {
  bank_t1: 'https://finherodms.blob.core.windows.net/dms-general-storage/237ee0a0578cf2d01dd7787717c65e4e24c344a014030b4de0057a06ea6e5ba6',
  bank_t2: 'https://finherodms.blob.core.windows.net/dms-general-storage/a23a5c72d806311126bec18c611b4f354cd4795c82281d60a55315520531b101',
  bank_t3: 'https://finherodms.blob.core.windows.net/dms-general-storage/c6b8f6225b6d00ec248ca7940e396b5f1e5bbd2e247285e4977899c2f9a8b96e',
  financials: 'https://finherodms.blob.core.windows.net/dms-general-storage/2b7d13cb6f9bb64d8bd0b65c361458a9b9237cc0ae85763a4b7b748a5f871472',
  ssm: 'https://finherodms.blob.core.windows.net/dms-general-storage/73b371998e4e50244bb1db08dbd3b4aa3e68e378b63e76aacc46a7a9182d3979',
}

describe('buildSubmissionPayloads', () => {
  it('produces a finalize payload matching the lead-gen-ui format', () => {
    // Simulate form data after uploads (file fields stored as UploadedFileRef[])
    const formData: Record<string, unknown> = {
      totalFinancing: 329000,
      fullName: 'John Doe',
      email: 'john@example.com',
      formOfDisclosure: 'consented',
      bank_statement_t1: [{ url: MOCK_URLS.bank_t1, name: 'bank-jan.pdf' }],
      bank_statement_t2: [{ url: MOCK_URLS.bank_t2, name: 'bank-feb.pdf' }],
      bank_statement_t3: [{ url: MOCK_URLS.bank_t3, name: 'bank-mar.pdf' }],
      financials: [{ url: MOCK_URLS.financials, name: 'financials-2025.pdf' }],
      ssm: [{ url: MOCK_URLS.ssm, name: 'form9.pdf' }],
    }

    // Pin date to 2026 so year is deterministic
    const now = new Date(2026, 1, 15) // Feb 15, 2026

    const { createPayload, finalizePayload } = buildSubmissionPayloads(
      formData,
      SME_FORM_FIELDS,
      now
    )

    // Step 1: createPayload should contain only metadata (no file references)
    expect(createPayload).toEqual({
      totalFinancing: 329000,
      fullName: 'John Doe',
      email: 'john@example.com',
      formOfDisclosure: 'consented',
    })

    // Step 2: finalizePayload should match the lead-gen-ui successful payload format
    // Contact/consent fields (fullName, email, formOfDisclosure) are excluded —
    // IHS API rejects these on update. Status is added by the service layer.
    expect(finalizePayload).toEqual({
      totalFinancing: 329000,
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

    // Verify non-updatable fields are excluded from finalize
    expect(finalizePayload).not.toHaveProperty('fullName')
    expect(finalizePayload).not.toHaveProperty('email')
    expect(finalizePayload).not.toHaveProperty('formOfDisclosure')
  })

  it('handles plain URL strings as file values', () => {
    const formData: Record<string, unknown> = {
      totalFinancing: 50000,
      bank_statement_t1: MOCK_URLS.bank_t1,
      ssm: MOCK_URLS.ssm,
    }

    const { finalizePayload } = buildSubmissionPayloads(
      formData,
      SME_FORM_FIELDS,
      new Date(2026, 5, 1) // June 2026
    )

    expect(finalizePayload.bankStatements).toEqual([
      { path: MOCK_URLS.bank_t1, month: 1, year: 2026 },
    ])
    expect(finalizePayload.form9).toBe(MOCK_URLS.ssm)
  })

  it('skips file fields with no uploaded value', () => {
    const formData: Record<string, unknown> = {
      totalFinancing: 100000,
      bank_statement_t1: [{ url: MOCK_URLS.bank_t1, name: 'stmt.pdf' }],
      bank_statement_t2: [], // empty — no upload
      bank_statement_t3: undefined, // not provided
      financials: [{ url: MOCK_URLS.financials, name: 'fin.pdf' }],
      // ssm missing entirely
    }

    const { createPayload, finalizePayload } = buildSubmissionPayloads(
      formData,
      SME_FORM_FIELDS,
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

  it('handles 6 bank statements (fincap-sme config)', () => {
    const fincapFields: Record<string, FieldData> = {}
    for (let i = 1; i <= 6; i++) {
      fincapFields[`bank_statement_t${i}`] = { type: 'file' }
    }

    const formData: Record<string, unknown> = {}
    for (let i = 1; i <= 6; i++) {
      formData[`bank_statement_t${i}`] = [{ url: `https://blob.example.com/bank-${i}`, name: `bank-${i}.pdf` }]
    }

    const { finalizePayload } = buildSubmissionPayloads(
      formData,
      fincapFields,
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
    const fincapFields: Record<string, FieldData> = {
      financials_fincap_t1: { type: 'file' },
      financials_fincap_t2: { type: 'file' },
    }

    const formData: Record<string, unknown> = {
      financials_fincap_t1: [{ url: 'https://blob.example.com/fin-t1', name: 'fin-t1.pdf' }],
      financials_fincap_t2: [{ url: 'https://blob.example.com/fin-t2', name: 'fin-t2.pdf' }],
    }

    const { finalizePayload } = buildSubmissionPayloads(formData, fincapFields)

    expect(finalizePayload.financialStatements).toEqual([
      { path: 'https://blob.example.com/fin-t1', year: 1 },
      { path: 'https://blob.example.com/fin-t2', year: 2 },
    ])
  })

  it('maps supplementaryDoc_* fields to supplementaryDoc path_only array', () => {
    const daasFields: Record<string, FieldData> = {
      totalFinancing: { type: 'slider', category: 'financing' },
      supplementaryDoc_companyprofile: { type: 'file', category: 'documents' },
      supplementaryDoc_nric: { type: 'file', category: 'documents' },
      supplementaryDoc_SKU: { type: 'file', category: 'documents' },
    }

    const formData: Record<string, unknown> = {
      totalFinancing: 75000,
      supplementaryDoc_companyprofile: [{ url: 'https://blob.example.com/company-profile.pdf', name: 'profile.pdf' }],
      supplementaryDoc_nric: [{ url: 'https://blob.example.com/nric.pdf', name: 'nric.pdf' }],
      supplementaryDoc_SKU: [{ url: 'https://blob.example.com/sku.json', name: 'Product_SKU.json' }],
    }

    const { createPayload, finalizePayload } = buildSubmissionPayloads(formData, daasFields)

    // createPayload excludes file fields
    expect(createPayload).toEqual({ totalFinancing: 75000 })

    // supplementaryDoc is a flat array of { path } objects (no month/year)
    expect(finalizePayload.supplementaryDoc).toEqual([
      { path: 'https://blob.example.com/company-profile.pdf' },
      { path: 'https://blob.example.com/nric.pdf' },
      { path: 'https://blob.example.com/sku.json' },
    ])
  })

  it('passes through unmapped file fields as plain URL strings', () => {
    const fieldsWithCustomFile: Record<string, FieldData> = {
      totalFinancing: { type: 'slider', category: 'financing' },
      bank_statement_t1: { type: 'file', category: 'documents' },
      custom_document: { type: 'file', category: 'documents' },
    }

    const formData: Record<string, unknown> = {
      totalFinancing: 50000,
      bank_statement_t1: [{ url: MOCK_URLS.bank_t1, name: 'bank.pdf' }],
      custom_document: [{ url: 'https://blob.example.com/custom.pdf', name: 'custom.pdf' }],
    }

    const { finalizePayload } = buildSubmissionPayloads(
      formData,
      fieldsWithCustomFile,
      new Date(2026, 0, 1)
    )

    // Mapped field works normally
    expect(finalizePayload.bankStatements).toEqual([
      { path: MOCK_URLS.bank_t1, month: 1, year: 2026 },
    ])

    // Unmapped file field passed through as plain URL
    expect(finalizePayload.custom_document).toBe('https://blob.example.com/custom.pdf')
  })

  it('skips unmapped file fields with no uploaded value', () => {
    const fieldsWithCustomFile: Record<string, FieldData> = {
      totalFinancing: { type: 'slider', category: 'financing' },
      custom_document: { type: 'file', category: 'documents' },
    }

    const formData: Record<string, unknown> = {
      totalFinancing: 50000,
      custom_document: [], // empty — no upload
    }

    const { finalizePayload } = buildSubmissionPayloads(formData, fieldsWithCustomFile)

    expect(finalizePayload).not.toHaveProperty('custom_document')
  })

  it('does not leak non-file fields into document groups', () => {
    const formData: Record<string, unknown> = {
      totalFinancing: 200000,
      fullName: 'Jane Doe',
      email: 'jane@test.com',
      formOfDisclosure: 'consented',
    }

    const { createPayload, finalizePayload } = buildSubmissionPayloads(
      formData,
      SME_FORM_FIELDS
    )

    // createPayload has all metadata
    expect(createPayload).toEqual({
      totalFinancing: 200000,
      fullName: 'Jane Doe',
      email: 'jane@test.com',
      formOfDisclosure: 'consented',
    })

    // finalizePayload excludes non-updatable contact fields
    expect(finalizePayload).toEqual({ totalFinancing: 200000 })
    expect(finalizePayload).not.toHaveProperty('fullName')
    expect(finalizePayload).not.toHaveProperty('email')
    expect(finalizePayload).not.toHaveProperty('formOfDisclosure')
  })
})
