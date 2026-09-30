import { describe, it, expect, vi, beforeEach } from 'vitest'
import axios from 'axios'
import { BorrowerApiClient } from '../src/client.js'
import { BASE_URLS } from '../src/environments.js'
import { AdapterAssertionConsentMethod, BorrowerEnvironment } from '../src/types.js'
import type { AdapterAssertionPushBody, BorrowerClientConfig } from '../src/types.js'

vi.mock('axios')
const mockedAxios = vi.mocked(axios, true)

const credentials = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  serviceKey: 'test-service-key',
}

const assertionBody: AdapterAssertionPushBody = {
  ihsId: 42,
  traceId: 'trace-abc-123',
  asOfDate: '2026-07-20T00:00:00.000Z',
  assertingService: 'external-bff',
  consent: {
    consentDefinitionId: 9001,
    method: AdapterAssertionConsentMethod.CIBA_CARRIER_OOB,
    bindingMessage: 'Confirm access for Acme Lending?',
    authReqId: 'auth-req-xyz',
    assertedAt: '2026-07-20T00:05:00.000Z',
  },
  outcome: { kind: 'signals', fields: { phoneTenureMonths: 36 } },
}

// Calls every public method once and returns the URL of every request made.
async function urlsOfEveryCall(client: BorrowerApiClient): Promise<string[]> {
  await client.login()
  await client.uploadFile(Buffer.from('%PDF-1.4'), 'a.pdf')
  await client.submitApplication({ fullName: 'Test' })
  await client.getApplicationStatus('IHS-1')
  await client.updateApplication('IHS-1', { status: 'APPLICATION_FINALIZED' })
  await client.createConsentEvent('IHS-1', { consentDefinitionId: 1, consentGiven: true })
  await client.submitAdapterAssertion('carrier-phone', assertionBody)
  await client.testConnection()
  return [
    ...mockedAxios.post.mock.calls,
    ...mockedAxios.get.mock.calls,
    ...mockedAxios.patch.mock.calls,
  ].map((call) => String(call[0]))
}

function expectedUrls(base: string): string[] {
  return [
    `${base}/auth/client/login`,
    `${base}/file/upload/file/temp`,
    `${base}/client/ihs/client/submission`,
    `${base}/client/ihs/check/status/IHS-1`,
    `${base}/client/ihs/update/IHS-1`,
    `${base}/client/ihs/createConsentEvent/IHS-1`,
    `${base}/adapters/carrier-phone/assertions`,
  ]
}

beforeEach(() => {
  vi.resetAllMocks()
  mockedAxios.post.mockResolvedValue({
    data: { token: 'mock-token', expires_in: 3600, data: {} },
  } as any)
  mockedAxios.get.mockResolvedValue({ data: { data: {} } } as any)
  mockedAxios.patch.mockResolvedValue({ data: { data: {} } } as any)
})

describe('BorrowerApiClient target (SYS-3769)', () => {
  it('sends every call to baseUrl', async () => {
    const client = new BorrowerApiClient({ baseUrl: 'http://finsys-api:8006/', credentials })
    expect(client.baseUrl).toBe('http://finsys-api:8006')

    const urls = await urlsOfEveryCall(client)

    expect(urls).toEqual(expect.arrayContaining(expectedUrls('http://finsys-api:8006')))
    expect(urls.filter((url) => !url.startsWith('http://finsys-api:8006/'))).toEqual([])
  })

  it.each([BorrowerEnvironment.PRODUCTION, BorrowerEnvironment.STAGING])(
    'sends every call to the built-in %s host',
    async (environment) => {
      const client = new BorrowerApiClient({ environment, credentials })
      expect(client.baseUrl).toBe(BASE_URLS[environment])

      const urls = await urlsOfEveryCall(client)

      expect(urls).toEqual(expect.arrayContaining(expectedUrls(BASE_URLS[environment])))
      expect(urls.filter((url) => !url.startsWith(`${BASE_URLS[environment]}/`))).toEqual([])
    }
  )

  it.each<[string, Record<string, unknown>, string]>([
    [
      'endpointOverrides',
      { environment: 'staging', endpointOverrides: {} },
      'endpointOverrides was removed in 4.0.0 (SYS-3769); set baseUrl to the finsys-api origin instead',
    ],
    [
      'both targets',
      { environment: 'staging', baseUrl: 'http://finsys-api:8006' },
      'Set either environment or baseUrl, not both (SYS-3769)',
    ],
    ['no target', {}, 'Set either environment or baseUrl (SYS-3769)'],
    [
      'an unknown environment',
      { environment: 'prod' },
      'Unknown environment "prod"; use staging or production (SYS-3769)',
    ],
    [
      'an inherited property name as environment',
      { environment: 'toString' },
      'Unknown environment "toString"; use staging or production (SYS-3769)',
    ],
    [
      'a URL as environment without repeating it',
      { environment: 'https://svc:hunter2@x.example/?token=secret-token' },
      'Unknown environment; use staging or production (SYS-3769)',
    ],
    [
      'an object with no prototype as environment',
      { environment: Object.create(null) },
      'Unknown environment; use staging or production (SYS-3769)',
    ],
    [
      'a baseUrl with a path',
      { baseUrl: 'http://finsys-api:8006/auth/client/login' },
      'baseUrl must be an origin only, like http://finsys-api:8006, with no path, query or fragment (SYS-3769)',
    ],
  ])('refuses %s', (_label, target, message) => {
    const config = { ...target, credentials } as unknown as BorrowerClientConfig
    expect(() => new BorrowerApiClient(config)).toThrow(message)
  })

  it('accepts endpointOverrides: undefined', () => {
    const config = {
      environment: BorrowerEnvironment.STAGING,
      endpointOverrides: undefined,
      credentials,
    } as unknown as BorrowerClientConfig
    expect(new BorrowerApiClient(config).baseUrl).toBe(BASE_URLS[BorrowerEnvironment.STAGING])
  })
})
