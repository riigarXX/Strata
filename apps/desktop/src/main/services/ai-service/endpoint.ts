import { normalizeAiBaseUrl } from '@strata/contracts'
import { aiError } from './errors'

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Convierte la dirección guardada en la URL base del servidor y vuelve a comprobarla ya parseada por WHATWG:
 * el contrato solo admite una gramática cerrada, y esto es la segunda barrera (SSRF) por si un valor llegara a
 * main sin pasar por ella. La URL devuelta acaba siempre en `/`.
 */
export function resolveAiEndpoint(baseUrl: string): URL {
  const normalized = normalizeAiBaseUrl(baseUrl)
  if (normalized === undefined) throw invalidEndpoint()
  const url = new URL(`${normalized}/`)
  assertLoopbackUrl(url)
  return url
}

/** Se aplica a cada petición justo antes de enviarla, no solo al configurar la dirección. */
export function assertLoopbackUrl(url: URL): void {
  const allowed =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    url.port !== '' &&
    url.search === '' &&
    url.hash === ''
  if (!allowed) throw invalidEndpoint()
}

function invalidEndpoint(): Error {
  return aiError('validation_failed', 'The AI server address must be a local address with a port')
}

/** `path` es relativo a la base (`api/chat`); la ruta que trae la base (`/v1`) se conserva. */
export function endpointUrl(base: URL, path: string): URL {
  const url = new URL(path, base)
  assertLoopbackUrl(url)
  return url
}
