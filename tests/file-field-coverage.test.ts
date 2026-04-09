import { describe, it, expect } from 'vitest'
import { getBaseFieldSpecs } from '@finsys/core'
import { buildSubmissionPayloads } from '../src/types.js'

/**
 * Guard test: every file-type field in the base specs must have a matching
 * FILE_FIELD_RULES entry in types.ts. This prevents new file fields from
 * silently falling through to supplementaryDoc.
 *
 * If this test fails, add an explicit rule for the new file field in
 * FILE_FIELD_RULES (src/types.ts).
 */
describe('file field coverage guard', () => {
  it('every file-type base spec field produces a non-supplementaryDoc mapping', () => {
    const fileFields = getBaseFieldSpecs().filter((f) => f.type === 'file')
    const unmapped: string[] = []

    for (const field of fileFields) {
      const name = field.name
      if (!name) throw new Error(`Base spec file field at index ${fileFields.indexOf(field)} has no name`)
      const fakeFileFields: Record<string, unknown> = {
        [name]: [{ url: `https://test.example.com/${name}.pdf`, name: `${name}.pdf` }],
      }

      const { finalizePayload } = buildSubmissionPayloads({}, fakeFileFields)

      const suppDocs = finalizePayload.supplementaryDoc as { path: string }[] | undefined
      if (suppDocs?.some((d) => d.path.includes(name))) {
        unmapped.push(name)
      }
    }

    expect(unmapped).toEqual([])
  })
})
