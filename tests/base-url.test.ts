import { describe, it, expect } from 'vitest'
import { normalizeBaseUrl } from '../src/environments.js'

function messageOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected a throw')
}

const NOT_A_URL =
  'baseUrl must be an absolute http(s) URL, such as https://finsys-api.example.com (SYS-3769)'

describe('normalizeBaseUrl', () => {
  it.each([
    ['http://finsys-api:8006', 'http://finsys-api:8006'],
    ['http://finsys-api:8006/', 'http://finsys-api:8006'],
    ['  https://Finsys-API.Example.com  ', 'https://finsys-api.example.com'],
    ['https://finsys-api.example.com:443', 'https://finsys-api.example.com'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(normalizeBaseUrl(raw)).toBe(expected)
  })

  it('refuses an old full endpoint URL and names the origin to use', () => {
    expect(messageOf(() => normalizeBaseUrl('http://finsys-api:8006/auth/client/login'))).toBe(
      'baseUrl must be an origin only, like http://finsys-api:8006, with no path, query or fragment (SYS-3769)'
    )
  })

  it('refuses a query or fragment without repeating it', () => {
    for (const raw of ['https://x.example/?token=secret-token', 'https://x.example/#secret-token']) {
      const message = messageOf(() => normalizeBaseUrl(raw))
      expect(message).toContain('origin only')
      expect(message).not.toContain('secret-token')
    }
  })

  it('refuses a username or password without repeating them', () => {
    const message = messageOf(() => normalizeBaseUrl('https://svc-user:hunter2@x.example'))
    expect(message).toBe('baseUrl must not contain a username or password (SYS-3769)')
    expect(message).not.toContain('hunter2')
  })

  it.each(['ftp://x.example', 'finsys-api:8006'])('refuses the non-http scheme in %j', (raw) => {
    expect(messageOf(() => normalizeBaseUrl(raw))).toMatch(
      /^baseUrl must use http or https, not .+: \(SYS-3769\)$/
    )
  })

  it.each(['', '   ', 'not a url', '/auth/client/login'])('refuses %j as not a URL', (raw) => {
    expect(messageOf(() => normalizeBaseUrl(raw))).toBe(NOT_A_URL)
  })

  it('refuses a value that is not a string', () => {
    expect(messageOf(() => normalizeBaseUrl(8006 as unknown as string))).toBe(NOT_A_URL)
  })
})
