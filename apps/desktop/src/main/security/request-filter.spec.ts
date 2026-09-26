// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isRequestAllowed } from './request-filter'

describe('isRequestAllowed', () => {
  it.each([
    'app://strata/index.html',
    'app://strata/',
    'app://strata/assets/index-abc.js',
    'app://strata/assets/ibm-plex-sans-latin-400-normal.woff2',
  ])('deja pasar %s', (url) => {
    expect(isRequestAllowed(url)).toBe(true)
  })

  it.each([
    'file:///etc/hosts',
    'file:///Users/me/.ssh/id_rsa',
    'file:///Applications/Strata.app/Contents/Resources/app.asar/out/renderer/index.html',
    'file:///Applications/Strata.app/Contents/Resources/app.asar/out/renderer/../main/index.js',
    'file://evil-host/Applications/Strata.app/index.html',
    'FILE:///etc/hosts',
    'file:///',
    'file://',
  ])('cancela cualquier file: (%s)', (url) => {
    expect(isRequestAllowed(url)).toBe(false)
  })

  it.each([
    'app://evil/index.html',
    'app://strata.evil.test/index.html',
    'app://strata:8080/index.html',
    'app:///index.html',
  ])('cancela app:// de otro host (%s)', (url) => {
    expect(isRequestAllowed(url)).toBe(false)
  })

  it('no interviene en otros esquemas: la CSP y los guards de navegación se ocupan de ellos', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:5173/',
      'data:image/png;base64,AAAA',
      'devtools://devtools/x',
    ]) {
      expect(isRequestAllowed(url)).toBe(true)
    }
  })

  it('cancela lo que no es una URL', () => {
    expect(isRequestAllowed('not a url')).toBe(false)
    expect(isRequestAllowed('')).toBe(false)
  })
})
