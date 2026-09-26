import { AiBaseUrlSchema } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { parseBaseUrl } from './base-url'

describe('parseBaseUrl', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['  http://127.0.0.1:1234/  ', 'http://127.0.0.1:1234'],
    ['HTTP://LocalHost:8080/v1', 'http://localhost:8080/v1'],
    ['http://[::1]:9000', 'http://[::1]:9000'],
    ['https://localhost:8443/api/v1/', 'https://localhost:8443/api/v1'],
  ])('accepts %s and returns its canonical form', (input, canonical) => {
    expect(parseBaseUrl(input)).toEqual({ ok: true, value: canonical })
  })

  it.each([
    ['', /Escribe la dirección/],
    ['   ', /Escribe la dirección/],
    ['127.0.0.1:11434', /http:\/\//],
    ['ftp://127.0.0.1:11434', /http:\/\//],
    ['http://192.168.1.5:11434', /de este equipo/],
    ['http://example.com:11434', /de este equipo/],
    ['http://localhost.evil.com:11434', /de este equipo/],
    ['http://127.0.0.1@evil.com:11434', /de este equipo/],
    ['http://0.0.0.0:11434', /de este equipo/],
    ['http://127.1:11434', /de este equipo/],
    ['http://127.0.0.1', /puerto/],
    ['http://localhost/v1', /puerto/],
    ['http://127.0.0.1:80', /entre 1024 y 65535/],
    ['http://127.0.0.1:70000', /entre 1024 y 65535/],
    ['http://127.0.0.1:11434/../etc', /no es válida/],
    ['http://127.0.0.1:11434?x=1', /no es válida/],
    ['http://127.0.0.1:11434/#frag', /no es válida/],
    ['http://user:pass@127.0.0.1:11434', /de este equipo|no es válida/],
    ['http://127.0.0.1:11434\\evil', /no es válida/],
    [`http://127.0.0.1:11434/${'a'.repeat(200)}`, /no es válida/],
  ])('rejects %j with a clear message', (input, message) => {
    const result = parseBaseUrl(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(message)
  })

  it('agrees with the contract on every input: what the contract rejects, the client rejects', () => {
    const inputs = [
      'http://127.0.0.1:11434',
      'http://127.0.0.1:11434/',
      'http://localhost:1023',
      'http://[::ffff:127.0.0.1]:11434',
      'http://127.0.0.1:11434/a b',
      'http://127.0.0.1:11434/%2e%2e',
      'https://LOCALHOST:65535',
      'http://127.0.0.1:065535',
    ]
    for (const input of inputs) {
      expect(parseBaseUrl(input).ok, input).toBe(AiBaseUrlSchema.safeParse(input).success)
    }
  })
})
