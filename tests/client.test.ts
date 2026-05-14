import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import axios from 'axios'
import { BorrowerApiClient } from '../src/client.js'
import { BorrowerEnvironment, BorrowerEndpoint } from '../src/types.js'
import type { BorrowerClientConfig } from '../src/types.js'

vi.mock('axios')
const mockedAxios = vi.mocked(axios, true)

function makeConfig(overrides?: Partial<BorrowerClientConfig>): BorrowerClientConfig {
  return {
    environment: BorrowerEnvironment.STAGING,
    credentials: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      gatewayKey: 'test-gateway-key',
    },
    ...overrides,
  }
}

function makeClient(overrides?: Partial<BorrowerClientConfig>): BorrowerApiClient {
  return new BorrowerApiClient(makeConfig(overrides))
}

// Helper to set up a successful login mock
function mockLogin() {
  mockedAxios.post.mockResolvedValueOnce({
    data: { token: 'mock-token', expires_in: 3600 },
  } as any)
}

describe('BorrowerApiClient.createConsentEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedAxios.isAxiosError = (error: any): error is any =>
      error?.isAxiosError === true
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns invalid ihsId error for empty ihsId', async () => {
    const client = makeClient()
    const result = await client.createConsentEvent('', {
      consentDefinitionId: 1,
      consentGiven: true,
    })

    expect(result.success).toBe(false)
    expect(result.message).toBe('Invalid ihsId format')
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it('returns invalid ihsId error for unsafe characters', async () => {
    const client = makeClient()
    const result = await client.createConsentEvent('ihs/../../../etc', {
      consentDefinitionId: 1,
      consentGiven: true,
    })

    expect(result.success).toBe(false)
    expect(result.message).toBe('Invalid ihsId format')
  })

  it('creates a consent event successfully', async () => {
    const client = makeClient()

    // Login call
    mockLogin()

    // createConsentEvent call
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        data: {
          ihsId: 42,
          id: 7,
          consentDefinitionId: 3,
          consentGiven: true,
          ipAddress: '127.0.0.1',
          createdAt: '2026-04-05T12:00:00Z',
        },
      },
    } as any)

    const result = await client.createConsentEvent('IHS-42', {
      consentDefinitionId: 3,
      consentGiven: true,
      ipAddress: '127.0.0.1',
    })

    expect(result.success).toBe(true)
    expect(result.message).toBe('Consent event created')
    expect(result.data).toEqual({
      ihsId: 42,
      id: 7,
      consentDefinitionId: 3,
      consentGiven: true,
      ipAddress: '127.0.0.1',
      createdAt: '2026-04-05T12:00:00Z',
    })

    // Verify the POST was made to the correct URL
    const postCalls = mockedAxios.post.mock.calls
    expect(postCalls).toHaveLength(2) // login + consent
    const consentCall = postCalls[1]
    expect(consentCall[0]).toContain('/ihs/createConsentEvent/IHS-42')
  })

  it('sends X-Finxtract-Subscription-Key header when finxtractApiKey is configured', async () => {
    // SYS-2150: the per-tenant FinXtract key must reach finsys-api so OCR calls
    // are attributed to the correct billing subscriber.
    const client = new BorrowerApiClient({
      environment: BorrowerEnvironment.STAGING,
      credentials: {
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        finxtractApiKey: 'my-apim-subscription-key',
      },
    })

    mockLogin()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { id: 1 } },
    } as any)

    await client.createConsentEvent('IHS-1', { consentDefinitionId: 1, consentGiven: true })

    const consentCall = mockedAxios.post.mock.calls[1]
    const headers = consentCall[2]?.headers as Record<string, string>
    expect(headers['X-Finxtract-Subscription-Key']).toBe('my-apim-subscription-key')
  })

  it('omits X-Finxtract-Subscription-Key header when finxtractApiKey is not configured', async () => {
    const client = makeClient() // no finxtractApiKey in makeConfig()

    mockLogin()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { id: 1 } },
    } as any)

    await client.createConsentEvent('IHS-1', { consentDefinitionId: 1, consentGiven: true })

    const consentCall = mockedAxios.post.mock.calls[1]
    const headers = consentCall[2]?.headers as Record<string, string>
    expect(headers['X-Finxtract-Subscription-Key']).toBeUndefined()
  })

  it('sends authenticated headers with gateway key', async () => {
    const client = makeClient()

    mockLogin()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { id: 1 } },
    } as any)

    await client.createConsentEvent('IHS-1', {
      consentDefinitionId: 1,
      consentGiven: true,
    })

    const consentCall = mockedAxios.post.mock.calls[1]
    const headers = consentCall[2]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer mock-token')
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('test-gateway-key')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('retries on 401 (token expired)', async () => {
    const client = makeClient()

    // First login
    mockLogin()

    // First consent attempt fails with 401
    const axiosError = new Error('Unauthorized') as any
    axiosError.isAxiosError = true
    axiosError.response = { status: 401, data: { message: 'Token expired' } }
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    // Second login (after invalidation)
    mockedAxios.post.mockResolvedValueOnce({
      data: { token: 'new-mock-token', expires_in: 3600 },
    } as any)

    // Retry consent succeeds
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { id: 2, consentDefinitionId: 5, consentGiven: true } },
    } as any)

    const result = await client.createConsentEvent('IHS-99', {
      consentDefinitionId: 5,
      consentGiven: true,
    })

    expect(result.success).toBe(true)
    // 4 calls: login, fail consent, re-login, retry consent
    expect(mockedAxios.post).toHaveBeenCalledTimes(4)
  })

  it('returns error message on non-401 axios error', async () => {
    const client = makeClient()

    mockLogin()

    const axiosError = new Error('Server Error') as any
    axiosError.isAxiosError = true
    axiosError.response = { status: 500, data: { message: 'Internal server error' } }
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    const result = await client.createConsentEvent('IHS-50', {
      consentDefinitionId: 1,
      consentGiven: true,
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('500')
    expect(result.message).toContain('Internal server error')
  })

  it('returns generic error message on non-axios error', async () => {
    const client = makeClient()

    mockLogin()

    mockedAxios.post.mockRejectedValueOnce(new Error('Network failure'))

    const result = await client.createConsentEvent('IHS-77', {
      consentDefinitionId: 1,
      consentGiven: false,
    })

    expect(result.success).toBe(false)
    expect(result.message).toBe('An unexpected error occurred during consent creation')
  })

  it('uses endpoint override when configured', async () => {
    const client = makeClient({
      endpointOverrides: {
        [BorrowerEndpoint.CREATE_CONSENT]: 'https://custom.api.com/consent',
      },
    })

    mockLogin()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { id: 1 } },
    } as any)

    await client.createConsentEvent('IHS-10', {
      consentDefinitionId: 1,
      consentGiven: true,
    })

    const consentCall = mockedAxios.post.mock.calls[1]
    expect(consentCall[0]).toBe('https://custom.api.com/consent/IHS-10')
  })

  it('sends the payload correctly', async () => {
    const client = makeClient()

    mockLogin()
    mockedAxios.post.mockResolvedValueOnce({
      data: { data: { id: 1 } },
    } as any)

    const payload = {
      consentDefinitionId: 42,
      consentGiven: false,
      ipAddress: '192.168.1.1',
    }

    await client.createConsentEvent('IHS-123', payload)

    const consentCall = mockedAxios.post.mock.calls[1]
    expect(consentCall[1]).toEqual(payload)
  })
})

describe('BorrowerApiClient.submitApplication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedAxios.isAxiosError = (error: any): error is any =>
      error?.isAxiosError === true
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('surfaces upstream { err: { code, desc } } as typed upstream field on failure', async () => {
    const client = makeClient()
    mockLogin()

    const axiosError = new Error('Bad Request') as any
    axiosError.isAxiosError = true
    axiosError.response = {
      status: 400,
      data: { err: { code: 'INVALID_STATUS', desc: 'Invalid IHS status.' } },
    }
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    const result = await client.submitApplication({ totalFinancing: 100000 })

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({
      code: 'INVALID_STATUS',
      desc: 'Invalid IHS status.',
      status: 400,
    })
    expect(result.message).toContain('Invalid IHS status.')
  })

  it('falls back to legacy { message } body shape with status populated', async () => {
    const client = makeClient()
    mockLogin()

    const axiosError = new Error('Server Error') as any
    axiosError.isAxiosError = true
    axiosError.response = {
      status: 500,
      data: { message: 'Internal server error' },
    }
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    const result = await client.submitApplication({ totalFinancing: 100000 })

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({ code: undefined, desc: undefined, status: 500 })
    expect(result.message).toContain('Internal server error')
    expect(result.message).toContain('500')
  })

  it('handles missing response body (WAF block) with status only', async () => {
    const client = makeClient()
    mockLogin()

    const axiosError = new Error('Forbidden') as any
    axiosError.isAxiosError = true
    axiosError.response = { status: 403, data: undefined }
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    const result = await client.submitApplication({ totalFinancing: 100000 })

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({ code: undefined, desc: undefined, status: 403 })
    expect(result.message).toBe('Submission failed (403): Unknown error')
  })

  it('preserves partial-success branch (400 with data.ihsId) and does not populate upstream', async () => {
    const client = makeClient()
    mockLogin()

    const axiosError = new Error('Bad Request') as any
    axiosError.isAxiosError = true
    axiosError.response = {
      status: 400,
      data: { data: { ihsId: 'IHS-12345' } },
    }
    mockedAxios.post.mockRejectedValueOnce(axiosError)

    const result = await client.submitApplication({ totalFinancing: 100000 })

    expect(result.success).toBe(true)
    expect(result.ihsId).toBe('IHS-12345')
    expect(result.upstream).toBeUndefined()
  })
})

describe('BorrowerApiClient.updateApplication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedAxios.isAxiosError = (error: any): error is any =>
      error?.isAxiosError === true
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('surfaces upstream { err: { code, desc } } as typed upstream field on failure', async () => {
    const client = makeClient()
    mockLogin()

    const axiosError = new Error('Conflict') as any
    axiosError.isAxiosError = true
    axiosError.response = {
      status: 409,
      data: { err: { code: 'APPLICATION_IS_FINALIZED', desc: 'This IHS application is finalized.' } },
    }
    mockedAxios.patch.mockRejectedValueOnce(axiosError)

    const result = await client.updateApplication('IHS-42', { status: 'APPLICATION_FINALIZED' })

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({
      code: 'APPLICATION_IS_FINALIZED',
      desc: 'This IHS application is finalized.',
      status: 409,
    })
    expect(result.message).toContain('This IHS application is finalized.')
  })

  it('falls back to legacy { message } body shape with status populated', async () => {
    const client = makeClient()
    mockLogin()

    const axiosError = new Error('Server Error') as any
    axiosError.isAxiosError = true
    axiosError.response = {
      status: 500,
      data: { message: 'Internal server error' },
    }
    mockedAxios.patch.mockRejectedValueOnce(axiosError)

    const result = await client.updateApplication('IHS-42', {})

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({ code: undefined, desc: undefined, status: 500 })
    expect(result.message).toContain('Internal server error')
  })

  it('handles missing response body with status only', async () => {
    const client = makeClient()
    mockLogin()

    const axiosError = new Error('Forbidden') as any
    axiosError.isAxiosError = true
    axiosError.response = { status: 403, data: undefined }
    mockedAxios.patch.mockRejectedValueOnce(axiosError)

    const result = await client.updateApplication('IHS-42', {})

    expect(result.success).toBe(false)
    expect(result.upstream).toEqual({ code: undefined, desc: undefined, status: 403 })
    expect(result.message).toBe('Update failed (403): Unknown error')
  })
})
