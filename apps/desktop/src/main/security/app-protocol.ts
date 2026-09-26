import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import type { Protocol } from 'electron'
import { APP_HOST, APP_SCHEME } from './app-origin'

/**
 * Único contenido que sirve el esquema propio: lo que emite Vite en `out/renderer`. Lo que no esté aquí
 * (`.map`, `.node`, cualquier extensión desconocida) responde 404 aunque exista el archivo.
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * Privilegios mínimos, y cada uno justificado (ADR 0011):
 * - `standard`: URL con host, resolución de rutas relativas y origen propio (sin él `app://strata` no tiene origen).
 * - `secure`: contexto seguro, como `file://` y `https://`; sin él Chromium trataría los recursos como contenido mixto.
 * - `supportFetchAPI`: la CSP `connect-src 'self'` solo deja al renderer leer `app://strata/*`, y los E2E y el smoke
 *   comprueban la cabecera CSP de la propia página con `fetch`. No amplía la superficie: es el mismo contenido que ya
 *   cargan `<script>` y `<link>`.
 * Sin `bypassCSP` (la CSP se aplica siempre), sin `corsEnabled` (todo es del mismo origen), sin `allowServiceWorkers`,
 * `stream` ni `codeCache`.
 * Debe llamarse antes de `app.whenReady()`.
 */
export function registerAppScheme(protocol: Pick<Protocol, 'registerSchemesAsPrivileged'>): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

/**
 * Traduce una URL `app://strata/...` a los segmentos de ruta relativos a `out/renderer`, o `null` si no es un
 * recurso servible. La raíz `/` es la única que cae en `index.html`. Se rechaza todo lo que pueda salir del
 * directorio o resultar ambiguo: otros hosts, credenciales o puerto, segmentos vacíos, `.`, `..` o que empiecen por
 * punto (también tras decodificar `%2e%2e`), separadores o NUL codificados (`%2f`, `%5c`, `%00`) y codificaciones inválidas.
 */
export function resolveAssetSegments(rawUrl: string): string[] | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null
  if (url.username !== '' || url.password !== '') return null
  if (url.pathname === '/') return ['index.html']

  const segments: string[] = []
  for (const raw of url.pathname.slice(1).split('/')) {
    let segment: string
    try {
      segment = decodeURIComponent(raw)
    } catch {
      return null
    }
    if (segment === '' || segment.startsWith('.') || /[\\/\0]/.test(segment)) return null
    segments.push(segment)
  }
  return segments
}

export interface AppProtocolOptions {
  /** Directorio del renderer compilado (`out/renderer`): es lo único que se sirve. */
  rendererRoot: string
  /** Política CSP que acompaña a cada respuesta como cabecera real. */
  csp: string
}

const plain = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status, headers })

export function createAppProtocolHandler({
  rendererRoot,
  csp,
}: AppProtocolOptions): (request: Request) => Promise<Response> {
  // La raíz real se resuelve una vez y en la primera petición: los symlinks que apunten fuera de ella se rechazan.
  let realRoot: Promise<string> | undefined

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plain(405, { Allow: 'GET, HEAD' })
    }

    const segments = resolveAssetSegments(request.url)
    const contentType = MIME_TYPES[extname(segments?.at(-1) ?? '').toLowerCase()]
    if (!segments || !contentType) return plain(404)

    try {
      realRoot ??= realpath(rendererRoot)
      const root = await realRoot
      const file = await realpath(join(root, ...segments))
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return plain(404)

      return new Response(request.method === 'HEAD' ? null : new Uint8Array(await readFile(file)), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          // Ningún `Access-Control-Allow-*`: solo el propio origen puede leer estos recursos.
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      })
    } catch {
      // Sin detalle: ni la ruta real ni el motivo del fallo salen hacia el renderer.
      return plain(404)
    }
  }
}

export function installAppProtocol(
  protocol: Pick<Protocol, 'handle'>,
  options: AppProtocolOptions,
): void {
  protocol.handle(APP_SCHEME, createAppProtocolHandler(options))
}
