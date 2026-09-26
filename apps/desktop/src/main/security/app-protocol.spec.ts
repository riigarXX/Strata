// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createAppProtocolHandler,
  installAppProtocol,
  registerAppScheme,
  resolveAssetSegments,
} from './app-protocol'
import { buildCsp } from './csp'

const CSP = buildCsp()
const SECRET = 'TOP-SECRET-OUTSIDE-THE-RENDERER'

let workDir: string
let handler: (request: Request) => Promise<Response>

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'strata-app-protocol-'))
  const root = join(workDir, 'out', 'renderer')
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(workDir, 'out', 'main'))
  await writeFile(join(root, 'index.html'), '<!doctype html><div id="app"></div>')
  await writeFile(join(root, 'assets', 'index-abc.js'), 'export const a = 1')
  await writeFile(join(root, 'assets', 'index-abc.css'), 'body{margin:0}')
  await writeFile(join(root, 'assets', 'font-abc.woff2'), 'wOF2')
  await writeFile(join(root, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(root, 'assets', 'data.json'), '{"a":1}')
  await writeFile(join(root, 'assets', 'index-abc.js.map'), '{}')
  await writeFile(join(root, 'assets', 'no-extension'), 'x')
  await writeFile(join(root, '.hidden.js'), 'x')
  await writeFile(join(workDir, 'out', 'main', 'index.js'), SECRET)
  await writeFile(join(workDir, 'secret.txt'), SECRET)
  await writeFile(join(workDir, 'secret.js'), SECRET)
  await symlink(join(workDir, 'secret.js'), join(root, 'assets', 'escape.js'))
  await symlink(join(workDir, 'out', 'main'), join(root, 'assets', 'escape-dir'))
  await symlink(join(root, 'assets', 'index-abc.js'), join(root, 'assets', 'inside.js'))
  handler = createAppProtocolHandler({ rendererRoot: root, csp: CSP })
})

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

const get = (url: string, init?: RequestInit): Promise<Response> => handler(new Request(url, init))

describe('resolveAssetSegments', () => {
  it('la raíz es la única ruta que cae en index.html', () => {
    expect(resolveAssetSegments('app://strata/')).toEqual(['index.html'])
    expect(resolveAssetSegments('app://strata/?x=1#/route')).toEqual(['index.html'])
  })

  it('devuelve los segmentos decodificados de una ruta normal', () => {
    expect(resolveAssetSegments('app://strata/assets/index-abc.js')).toEqual([
      'assets',
      'index-abc.js',
    ])
    expect(resolveAssetSegments('app://strata/assets/a%20b.js?v=1#x')).toEqual(['assets', 'a b.js'])
  })

  it.each([
    'app://strata/assets%2f..%2f..%2fmain/index.js',
    'app://strata/assets%5c..%5cmain/index.js',
    'app://strata/assets/..%2fmain/index.js',
    'app://strata/assets/index.js%00.png',
    'app://strata/%2fetc/hosts',
    'app://strata//etc/hosts',
    'app://strata/assets//index.js',
    'app://strata/assets/',
    'app://strata/.hidden.js',
    'app://strata/assets/%E0%A4%A',
    'app://strata/C:%5Cwindows%5Cwin.ini',
    'app://strata',
    'app://evil/index.html',
    'app://STRATA/index.html',
    'app://strata:8080/index.html',
    'app://user@strata/index.html',
    'app://strata.evil.test/index.html',
    'file:///etc/hosts',
    'https://strata/index.html',
    'not a url',
    '',
  ])('rechaza %s', (url) => {
    expect(resolveAssetSegments(url)).toBeNull()
  })

  it.each([
    ['app://strata/assets/../../main/index.js', ['main', 'index.js']],
    ['app://strata/%2e%2e/main/index.js', ['main', 'index.js']],
    ['app://strata/assets/%2E%2E/x.js', ['x.js']],
    ['app://strata/./index.html', ['index.html']],
  ])('%s: el parser de URL colapsa los puntos y nunca quedan fuera de la raíz', (url, expected) => {
    // Los segmentos son siempre relativos a out/renderer: subir con `..` deja de ser posible antes de llegar aquí.
    expect(resolveAssetSegments(url)).toEqual(expected)
  })

  it('un %252e%252e se decodifica una sola vez y queda como nombre literal, no como ..', () => {
    expect(resolveAssetSegments('app://strata/assets/%252e%252e/index.js')).toEqual([
      'assets',
      '%2e%2e',
      'index.js',
    ])
  })
})

describe('createAppProtocolHandler: contenido', () => {
  it.each([
    ['app://strata/', 'text/html; charset=utf-8', '<!doctype html><div id="app"></div>'],
    ['app://strata/index.html', 'text/html; charset=utf-8', '<!doctype html><div id="app"></div>'],
    ['app://strata/assets/index-abc.js', 'text/javascript; charset=utf-8', 'export const a = 1'],
    ['app://strata/assets/index-abc.css', 'text/css; charset=utf-8', 'body{margin:0}'],
    ['app://strata/assets/font-abc.woff2', 'font/woff2', 'wOF2'],
    ['app://strata/assets/logo.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['app://strata/assets/data.json', 'application/json; charset=utf-8', '{"a":1}'],
    ['app://strata/assets/inside.js', 'text/javascript; charset=utf-8', 'export const a = 1'],
  ])('sirve %s con su tipo MIME', async (url, type, body) => {
    const response = await get(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(type)
    expect(await response.text()).toBe(body)
  })

  it('acompaña cada respuesta con la CSP como cabecera y sin cabeceras que abran CORS', async () => {
    for (const url of ['app://strata/', 'app://strata/assets/index-abc.js']) {
      const response = await get(url)
      expect(response.headers.get('content-security-policy')).toBe(CSP)
      expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
      const cors = [...response.headers.keys()].filter((name) => name.startsWith('access-control-'))
      expect(cors).toEqual([])
    }
  })

  it('HEAD devuelve las cabeceras sin cuerpo', async () => {
    const response = await get('app://strata/assets/index-abc.js', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(CSP)
    expect(await response.text()).toBe('')
  })
})

describe('createAppProtocolHandler: rechazos', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])(
    '%s responde 405 sin servir el archivo',
    async (method) => {
      const response = await get('app://strata/index.html', { method, body: 'x' })
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET, HEAD')
      expect(await response.text()).toBe('')
    },
  )

  it.each([
    ['un archivo que no existe', 'app://strata/assets/nope.js'],
    ['un directorio (sin listado)', 'app://strata/assets'],
    ['un directorio con barra final', 'app://strata/assets/'],
    ['una ruta que sube con ..', 'app://strata/assets/../../main/index.js'],
    ['una ruta que sube con %2e%2e', 'app://strata/assets/%2e%2e/%2e%2e/main/index.js'],
    ['un separador codificado', 'app://strata/assets%2f..%2f..%2fmain/index.js'],
    ['una ruta absoluta codificada', 'app://strata/%2fetc/hosts'],
    ['un archivo fuera del renderer, hermano', 'app://strata/../secret.js'],
    ['un symlink a un archivo fuera de la raíz', 'app://strata/assets/escape.js'],
    ['un symlink a un directorio fuera de la raíz', 'app://strata/assets/escape-dir/index.js'],
    ['un mapa de fuentes (extensión no servida)', 'app://strata/assets/index-abc.js.map'],
    ['un archivo sin extensión', 'app://strata/assets/no-extension'],
    ['un archivo oculto', 'app://strata/.hidden.js'],
    ['otro host', 'app://evil/index.html'],
  ])('responde 404 sin cuerpo ni cabeceras del archivo para %s', async (_name, url) => {
    const response = await get(url)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('')
    expect(response.headers.get('content-type')).toBeNull()
  })

  it('nunca entrega el contenido de fuera de out/renderer', async () => {
    for (const url of [
      'app://strata/../main/index.js',
      'app://strata/%2e%2e/main/index.js',
      'app://strata/assets/escape.js',
      'app://strata/assets/escape-dir/index.js',
      'app://strata/../secret.txt',
    ]) {
      expect(await (await get(url)).text()).not.toContain(SECRET)
    }
  })
})

describe('registerAppScheme e installAppProtocol', () => {
  it('registra solo standard, secure y supportFetchAPI: sin bypassCSP ni corsEnabled', () => {
    const protocol = { registerSchemesAsPrivileged: vi.fn() }
    registerAppScheme(protocol)

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledExactlyOnceWith([
      {
        scheme: 'app',
        privileges: { standard: true, secure: true, supportFetchAPI: true },
      },
    ])
  })

  it('atiende únicamente el esquema app', () => {
    const protocol = { handle: vi.fn() }
    installAppProtocol(protocol, { rendererRoot: workDir, csp: CSP })

    expect(protocol.handle).toHaveBeenCalledExactlyOnceWith('app', expect.any(Function))
  })
})
