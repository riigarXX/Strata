// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertLoopbackUrl, endpointUrl, resolveAiEndpoint } from './endpoint'

describe('resolveAiEndpoint', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434/'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434/'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1/'],
    ['HTTP://LOCALHOST:1234', 'http://localhost:1234/'],
    ['http://[::1]:11434', 'http://[::1]:11434/'],
  ])('resuelve %s', (value, expected) => {
    expect(resolveAiEndpoint(value).href).toBe(expected)
  })

  it.each([
    'http://127.0.0.1@evil.com',
    'http://127.0.0.1:11434@evil.com',
    'http://user:pass@127.0.0.1:11434',
    'http://localhost.evil.com:11434',
    'http://127.0.0.1.evil.com:11434',
    'http://[::ffff:127.0.0.1]:11434',
    'http://[::ffff:7f00:1]:11434',
    'http://0.0.0.0:11434',
    'http://[::]:11434',
    'http://127.0.0.2:11434',
    'http://127.1:11434',
    'http://2130706433:11434',
    'http://169.254.169.254:11434',
    'http://10.0.0.1:11434',
    'https://api.openai.com',
    'http://127.0.0.1',
    'http://127.0.0.1:80',
    'http://127.0.0.1:443',
    'http://127.0.0.1:22',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:11434?x=1',
    'http://127.0.0.1:11434#x',
    'http://127.0.0.1:11434\\@evil.com',
    'http://127.0.0.1:11434/../../etc',
    'ftp://127.0.0.1:11434',
    'file:///etc/passwd',
    '',
  ])('rechaza %j con validation_failed y sin repetir el valor', (value) => {
    let thrown: unknown
    try {
      resolveAiEndpoint(value)
    } catch (reason) {
      thrown = reason
    }
    expect(thrown).toMatchObject({
      normalized: { code: 'validation_failed', retryable: false },
    })
    if (value.length > 0) expect(JSON.stringify(thrown)).not.toContain(value)
  })
})

describe('assertLoopbackUrl', () => {
  it('admite las tres formas de bucle local con puerto explícito', () => {
    for (const url of ['http://127.0.0.1:1234/', 'http://localhost:1234/', 'http://[::1]:1234/']) {
      expect(() => assertLoopbackUrl(new URL(url))).not.toThrow()
    }
  })

  it.each([
    'http://127.0.0.1@evil.com/',
    'http://evil.com/',
    'http://localhost.evil.com:1234/',
    'http://user@127.0.0.1:1234/',
    'http://:pass@127.0.0.1:1234/',
    'http://[::ffff:127.0.0.1]:1234/',
    'http://0.0.0.0:1234/',
    'http://127.0.0.1/',
    'http://127.0.0.1:1234/?q=1',
    'http://127.0.0.1:1234/#f',
    'ftp://127.0.0.1:1234/',
    'ws://127.0.0.1:1234/',
    'data:text/plain,hola',
  ])('rechaza %s', (value) => {
    expect(() => assertLoopbackUrl(new URL(value))).toThrow()
  })

  it('WHATWG normaliza las formas cortas de 127.0.0.1: son la misma dirección, no un desvío', () => {
    expect(new URL('http://127.1:1234/').hostname).toBe('127.0.0.1')
    expect(() => assertLoopbackUrl(new URL('http://127.1:1234/'))).not.toThrow()
  })
})

describe('endpointUrl', () => {
  it('cuelga la ruta de la base conservando su prefijo', () => {
    const base = resolveAiEndpoint('http://localhost:1234/v1')
    expect(endpointUrl(base, 'models').href).toBe('http://localhost:1234/v1/models')
    expect(endpointUrl(resolveAiEndpoint('http://127.0.0.1:11434'), 'api/chat').href).toBe(
      'http://127.0.0.1:11434/api/chat',
    )
  })

  it('no puede salir del bucle local aunque la ruta lleve un origen', () => {
    const base = resolveAiEndpoint('http://127.0.0.1:11434')
    expect(() => endpointUrl(base, 'http://evil.com/x')).toThrow()
    expect(() => endpointUrl(base, '//evil.com/x')).toThrow()
  })
})
