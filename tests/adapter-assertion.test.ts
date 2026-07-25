import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import axios from 'axios'
import { BorrowerApiClient } from '../src/client.js'
import { BorrowerEnvironment, BorrowerEndpoint } from '../src/types.js'
import {
  AdapterAssertionConsentMethod,
  AdapterAssertionSkipReason,
} from '../src/types.js'
import type { BorrowerClientConfig, AdapterAssertionPushBody } from '../src/types.js'

vi.mock('axios')
const mockedAxios = vi.mocked(axios, true)

function makeConfig(overrides?: Partial<BorrowerClientConfig>): BorrowerClientConfig {
  return {
    environment: BorrowerEnvironment.STAGING,
    credentials: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      gatewayKey: 'test-gateway-key',
      serviceKey: 'test-service-key',
    },
    ...overrides,
  }
}

function makeClient(overrides?: Partial<BorrowerClientConfig>): BorrowerApiClient {
  return new BorrowerApiClient(makeConfig(overrides))
}

function baseSignalsBody(overrides?: Partial<AdapterAssertionPushBody>): AdapterAssertionPushBody {
  return {
    ihsId: 42,
    traceId: 'trace-abc-123',
    asOfDate: '2026-07-20T00:00:00.000Z',
    assertingService: 'external-bff',
    consent: {
      method: AdapterAssertionConsentMethod.CIBA_CARRIER_OOB,
      bindingMessage: 'Confirm access for Acme Lending?',
      authReqId: 'auth-req-xyz',
      assertedAt: '2026-07-20T00:05:00.000Z',
    },
    outcome: {
      kind: 'signals',
      fields: { phoneTenureMonths: 36 },
    },
    ...overrides,
  }
}

describe('BorrowerApiClient.submitAdapterAssertion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedAxios.isAxiosError = (error: any): error is any => error?.isAxiosError === true
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Validation guards ────────────────────────────────────────────

  it('returns invalid adapterId error for empty adapterId', async () => {
    const client = makeClient()
    const result = await client.submitAdapterAssertion('', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.message).toBe('Invalid adapterId format')
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('returns invalid adapterId error for unsafe characters (path traversal attempt)', async () => {
    const client = makeClient()
    const result = await client.submitAdapterAssertion('../../etc/passwd', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.message).toBe('Invalid adapterId format')
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('returns an error when no serviceKey is configured', async () => {
    const client = makeClient({
      credentials: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
      },
    })
    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.message).toContain('serviceKey')
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  // ── Auth: service-key header, NOT the borrower-token login() flow ──

  it('sends X-Finhub-Service-Key header and does NOT call login()', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 10, signalCount: 1 } },
    } as any)

    await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    // Exactly one POST — no login() request preceding it.
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
    const [, , requestConfig] = mockedAxios.post.mock.calls[0]
    const headers = requestConfig?.headers as Record<string, string>
    expect(headers['X-Finhub-Service-Key']).toBe('test-service-key')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('includes the gateway key header when configured', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 10, signalCount: 1 } },
    } as any)

    await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    const [, , requestConfig] = mockedAxios.post.mock.calls[0]
    const headers = requestConfig?.headers as Record<string, string>
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('test-gateway-key')
  })

  it('sends the WAF-bypass User-Agent header (shared with authenticatedHeaders())', async () => {
    // Azure Application Gateway's WAF rejects bot-shaped traffic without a
    // browser User-Agent — see the identical comment on authenticatedHeaders().
    // This must not regress to copy-paste drift between the two header builders.
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 10, signalCount: 1 } },
    } as any)

    await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    const [, , requestConfig] = mockedAxios.post.mock.calls[0]
    const headers = requestConfig?.headers as Record<string, string>
    expect(headers['User-Agent']).toMatch(/Mozilla\/5\.0/)
  })

  it('posts to the correct URL: /adapters/:adapterId/assertions', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 10, signalCount: 1 } },
    } as any)

    await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    const [url] = mockedAxios.post.mock.calls[0]
    expect(url).toContain('/adapters/carrier-phone/assertions')
  })

  it('uses endpoint override when configured', async () => {
    const client = makeClient({
      endpointOverrides: {
        [BorrowerEndpoint.SUBMIT_ADAPTER_ASSERTION]: 'https://custom.api.com/adapters',
      },
    })
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 10, signalCount: 1 } },
    } as any)

    await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    const [url] = mockedAxios.post.mock.calls[0]
    expect(url).toBe('https://custom.api.com/adapters/carrier-phone/assertions')
  })

  // ── Happy path: signals outcome ─────────────────────────────────

  it('submits a signals outcome and returns the 201 data shape', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 7, adapterRunId: 55, signalCount: 1 } },
    } as any)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ consentEventId: 7, adapterRunId: 55, signalCount: 1 })
  })

  // ── Malformed 201 envelope: don't declare success on a bad body ──

  it('returns success:false on a 201 with no data envelope at all', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({ data: {} } as any)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.message).toBe(
      'Adapter assertion response was malformed: missing consentEventId or signalCount'
    )
    expect(result.data).toBeUndefined()
  })

  it('returns success:false on a 201 missing consentEventId', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { adapterRunId: 10, signalCount: 1 } },
    } as any)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.message).toBe(
      'Adapter assertion response was malformed: missing consentEventId or signalCount'
    )
  })

  it('returns success:false on a 201 missing signalCount', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 7, adapterRunId: 10 } },
    } as any)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.message).toBe(
      'Adapter assertion response was malformed: missing consentEventId or signalCount'
    )
  })

  it('accepts a null adapterRunId (skip outcome shape) without treating it as malformed', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 8, adapterRunId: null, signalCount: 0 } },
    } as any)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ consentEventId: 8, adapterRunId: null, signalCount: 0 })
  })

  it('sends the request body verbatim (no transformation)', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 1, signalCount: 1 } },
    } as any)

    const body = baseSignalsBody({ instanceKey: 'line-1' })
    await client.submitAdapterAssertion('carrier-phone', body)

    const [, sentBody] = mockedAxios.post.mock.calls[0]
    expect(sentBody).toEqual(body)
  })

  // ── Happy path: skip outcome ─────────────────────────────────────

  it('submits a skip outcome (identity mismatch) with zero signalCount', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 8, adapterRunId: 56, signalCount: 0 } },
    } as any)

    const body = baseSignalsBody({
      outcome: { kind: 'skip', reason: AdapterAssertionSkipReason.IDENTITY_MISMATCH },
    })
    const result = await client.submitAdapterAssertion('carrier-phone', body)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ consentEventId: 8, adapterRunId: 56, signalCount: 0 })

    const [, sentBody] = mockedAxios.post.mock.calls[0]
    expect((sentBody as AdapterAssertionPushBody).outcome).toEqual({
      kind: 'skip',
      reason: 'IDENTITY_MISMATCH',
    })
  })

  it('submits a skip outcome (data null)', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 9, adapterRunId: 57, signalCount: 0 } },
    } as any)

    const body = baseSignalsBody({
      outcome: { kind: 'skip', reason: AdapterAssertionSkipReason.DATA_NULL },
    })
    await client.submitAdapterAssertion('carrier-phone', body)

    const [, sentBody] = mockedAxios.post.mock.calls[0]
    expect((sentBody as AdapterAssertionPushBody).outcome).toEqual({
      kind: 'skip',
      reason: 'DATA_NULL',
    })
  })

  // ── instanceKey omitted vs provided ──────────────────────────────

  it('omits instanceKey from the body when not provided by the caller', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 1, signalCount: 1 } },
    } as any)

    const body = baseSignalsBody()
    delete (body as { instanceKey?: string }).instanceKey
    await client.submitAdapterAssertion('carrier-phone', body)

    const [, sentBody] = mockedAxios.post.mock.calls[0]
    expect(Object.prototype.hasOwnProperty.call(sentBody as object, 'instanceKey')).toBe(false)
  })

  it('includes instanceKey verbatim when provided by the caller', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 1, signalCount: 1 } },
    } as any)

    const body = baseSignalsBody({ instanceKey: 'line-2' })
    await client.submitAdapterAssertion('carrier-phone', body)

    const [, sentBody] = mockedAxios.post.mock.calls[0]
    expect((sentBody as AdapterAssertionPushBody).instanceKey).toBe('line-2')
  })

  // ── Enum-label / field-value string preservation ────────────────

  it('preserves numeric-looking enum-label strings verbatim (no coercion to number)', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 1, signalCount: 2 } },
    } as any)

    const body = baseSignalsBody({
      outcome: {
        kind: 'signals',
        fields: {
          carrierTierCode: '3',
          accountRefLeadingZeros: '012345',
        },
      },
    })
    await client.submitAdapterAssertion('carrier-phone', body)

    const [, sentBody] = mockedAxios.post.mock.calls[0]
    const fields = (sentBody as AdapterAssertionPushBody).outcome as { fields: Record<string, unknown> }
    expect(fields.fields.carrierTierCode).toBe('3')
    expect(typeof fields.fields.carrierTierCode).toBe('string')
    expect(fields.fields.accountRefLeadingZeros).toBe('012345')
    expect(typeof fields.fields.accountRefLeadingZeros).toBe('string')
  })

  it('survives a JSON round-trip (JSON.parse(JSON.stringify(body))) with enum-label strings intact', async () => {
    // Guards against a transport-layer serializer (e.g. a proxy that
    // JSON.parse/stringify's the payload en route) silently upgrading a
    // numeric-looking string to a JSON number, which axios's own request
    // serialization does NOT do but a naive re-serialization could.
    const body = baseSignalsBody({
      outcome: {
        kind: 'signals',
        fields: {
          carrierTierCode: '3',
          accountRefLeadingZeros: '012345',
        },
      },
    })

    const roundTripped = JSON.parse(JSON.stringify(body)) as AdapterAssertionPushBody
    const fields = (roundTripped.outcome as { fields: Record<string, unknown> }).fields

    expect(fields.carrierTierCode).toBe('3')
    expect(typeof fields.carrierTierCode).toBe('string')
    expect(fields.accountRefLeadingZeros).toBe('012345')
    expect(typeof fields.accountRefLeadingZeros).toBe('string')
  })

  it('preserves boolean and null field values verbatim', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 1, signalCount: 2 } },
    } as any)

    const body = baseSignalsBody({
      outcome: {
        kind: 'signals',
        fields: { isActive: false, missingValue: null },
      },
    })
    await client.submitAdapterAssertion('carrier-phone', body)

    const [, sentBody] = mockedAxios.post.mock.calls[0]
    const fields = (sentBody as AdapterAssertionPushBody).outcome as { fields: Record<string, unknown> }
    expect(fields.fields.isActive).toBe(false)
    expect(fields.fields.missingValue).toBeNull()
  })

  it('passes consent.authReqId and bindingMessage through verbatim', async () => {
    const client = makeClient()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { consentEventId: 1, adapterRunId: 1, signalCount: 1 } },
    } as any)

    const body = baseSignalsBody({
      consent: {
        method: AdapterAssertionConsentMethod.CIBA_CARRIER_OOB,
        bindingMessage: 'Confirm 012345 access?',
        authReqId: '00998877',
        assertedAt: '2026-07-20T00:05:00.000Z',
      },
    })
    await client.submitAdapterAssertion('carrier-phone', body)

    const [, sentBody] = mockedAxios.post.mock.calls[0]
    const consent = (sentBody as AdapterAssertionPushBody).consent
    expect(consent.authReqId).toBe('00998877')
    expect(consent.bindingMessage).toBe('Confirm 012345 access?')
  })

  // ── Error mapping: each documented error code ───────────────────

  function mockErrorResponse(status: number, code: string, desc: string) {
    const axiosError = new Error(desc) as any
    axiosError.isAxiosError = true
    axiosError.response = { status, data: { err: { code, desc } } }
    mockedAxios.post.mockRejectedValueOnce(axiosError)
  }

  it.each([
    [400, 'INVALID_PAYLOAD', 'The request body is missing required fields or has an invalid shape.'],
    [401, 'UNAUTHORIZED', 'Service-account authentication is required for this endpoint.'],
    [403, 'ADAPTER_NOT_ALLOWLISTED_FOR_PROGRAM', "The application's program does not declare this adapter in its altDataAdapters allowlist."],
    [404, 'ADAPTER_NOT_FOUND', 'No adapter is registered with the given id.'],
    [404, 'IHS_NOT_FOUND', 'No IHS application exists with the given id.'],
    [409, 'ADAPTER_NOT_EXTERNAL_MODE', 'The adapter is registered, but not in external-assertion mode. This endpoint only accepts pushes for adapters declared external-assertion.'],
    [409, 'IHS_NOT_IN_CREATING_APPLICATION', 'The IHS application is not in CREATING_APPLICATION status.'],
    [422, 'FIELD_OUT_OF_CONTRACT', "One or more submitted fields are not in the adapter's declared produces list."],
    [422, 'ENUM_LABEL_OUT_OF_SET', "One or more enum-kind fields carry a label outside the adapter's declared enumValues set."],
    [500, 'INTERNAL_ERROR', 'An unexpected error occurred while processing the assertion push.'],
  ])('maps %i %s to a typed upstream error result', async (status, code, desc) => {
    const client = makeClient()
    mockErrorResponse(status, code, desc)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({ code, desc, status })
    expect(result.message).toContain(desc)
    expect(result.message).toContain(String(status))
  })

  // Real 401 vocabulary from finsys-api's serviceAccountAuth middleware
  // (customMiddlewares/serviceAccountAuth.ts) — these are the codes a live
  // caller with a wrong or unconfigured service key actually receives.
  // Unlike ADAPTER_ASSERTION_ERRORS' codes, the middleware's error bodies
  // carry NO `desc` field at all (`{ err: { code } }` only) — the client
  // must fall back to the code itself for the message, exactly like any
  // other legacy/partial upstream error shape.
  it('maps 401 BAD_SERVICE_KEY (no desc field) to a typed upstream result', async () => {
    const client = makeClient()
    const axiosError = new Error('Unauthorized') as any
    axiosError.isAxiosError = true
    axiosError.response = { status: 401, data: { err: { code: 'BAD_SERVICE_KEY' } } }
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({ code: 'BAD_SERVICE_KEY', desc: undefined, status: 401 })
    expect(result.message).toBe('Adapter assertion submission failed (401): BAD_SERVICE_KEY')
  })

  it('maps 401 SERVICE_ACCOUNT_NOT_CONFIGURED (no desc field) to a typed upstream result', async () => {
    const client = makeClient()
    const axiosError = new Error('Unauthorized') as any
    axiosError.isAxiosError = true
    axiosError.response = {
      status: 401,
      data: { err: { code: 'SERVICE_ACCOUNT_NOT_CONFIGURED' } },
    }
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({
      code: 'SERVICE_ACCOUNT_NOT_CONFIGURED',
      desc: undefined,
      status: 401,
    })
    expect(result.message).toBe(
      'Adapter assertion submission failed (401): SERVICE_ACCOUNT_NOT_CONFIGURED'
    )
  })

  it('does NOT retry on 401 (unlike the bearer-token flow) — a bad service key never self-heals', async () => {
    const client = makeClient()
    mockErrorResponse(401, 'UNAUTHORIZED', 'Service-account authentication is required for this endpoint.')

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(mockedAxios.post).toHaveBeenCalledTimes(1)
  })

  it('handles missing response body (WAF block) with status only', async () => {
    const client = makeClient()
    const axiosError = new Error('Forbidden') as any
    axiosError.isAxiosError = true
    axiosError.response = { status: 403, data: undefined }
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({ code: undefined, desc: undefined, status: 403 })
    expect(result.message).toBe('Adapter assertion submission failed (403): Unknown error')
  })

  it('handles a true axios network failure (isAxiosError=true, no response at all)', async () => {
    // Distinct from the "missing response body" WAF case above (which still
    // has error.response.status=403) and from the plain-Error case below
    // (which isn't an axios error at all). This exercises extractUpstream's
    // no-response branch: error.response is undefined entirely, e.g. a DNS
    // failure or connection refusal before any HTTP response existed.
    const client = makeClient()
    const axiosError = new Error('connect ECONNREFUSED') as any
    axiosError.isAxiosError = true
    axiosError.code = 'ECONNREFUSED'
    // No `response` property set at all.
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({ code: undefined, desc: undefined, status: undefined })
    expect(result.message).toBe('Adapter assertion submission failed: Unknown error')
    expect(result.message).not.toContain('undefined')
  })

  it('returns a generic message on non-axios error (network failure)', async () => {
    const client = makeClient()
    mockedAxios.post.mockRejectedValueOnce(new Error('Network failure'))

    const result = await client.submitAdapterAssertion('carrier-phone', baseSignalsBody())

    expect(result.success).toBe(false)
    expect(result.message).toBe('An unexpected error occurred during adapter assertion submission')
    expect(result.upstream).toBeUndefined()
  })
})
