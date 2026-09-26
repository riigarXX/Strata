import { isAdapterError } from '@strata/db-core'
import { aiError } from './errors'
import { assertLoopbackUrl } from './endpoint'

export interface AiHttpRequest {
  url: URL
  method: 'GET' | 'POST'
  body?: unknown
  /** Tiempo total para `json`; para `ndjson`, tiempo máximo sin recibir nada. */
  timeoutMs: number
  signal?: AbortSignal
  /** Tope de bytes que se leen de la respuesta: un servidor local defectuoso no debe agotar la memoria. */
  maxBytes: number
}

/** Cliente HTTP del proceso main hacia el servidor local del modelo: solo bucle local, sin redirecciones. */
export interface AiHttp {
  json(request: AiHttpRequest): Promise<unknown>
  /** Una línea JSON por llamada a `onLine`; una línea cortada entre dos trozos se reensambla. */
  ndjson(request: AiHttpRequest, onLine: (value: unknown) => void): Promise<void>
}

const MAX_NDJSON_LINE_BYTES = 64 * 1024

interface Deadline {
  readonly signal: AbortSignal
  reason(): 'timeout' | 'cancelled' | undefined
  refresh(): void
  dispose(): void
}

function createDeadline(external: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController()
  let reason: 'timeout' | 'cancelled' | undefined
  const abort = (why: 'timeout' | 'cancelled'): void => {
    reason ??= why
    controller.abort()
  }
  const arm = (): NodeJS.Timeout => setTimeout(() => abort('timeout'), timeoutMs)
  let timer = arm()
  const onExternalAbort = (): void => abort('cancelled')
  if (external?.aborted) onExternalAbort()
  else external?.addEventListener('abort', onExternalAbort, { once: true })

  return {
    signal: controller.signal,
    reason: () => reason,
    refresh() {
      clearTimeout(timer)
      timer = arm()
    },
    dispose() {
      clearTimeout(timer)
      external?.removeEventListener('abort', onExternalAbort)
    },
  }
}

function statusError(status: number): Error {
  if (status === 404) return aiError('not_found', 'The AI server does not have that model or route')
  if (status === 401 || status === 403) {
    return aiError('permission_denied', 'The AI server refused the request')
  }
  if (status === 408 || status === 504) return aiError('timeout', 'The AI server timed out', true)
  if (status === 429 || status === 503) return aiError('busy', 'The AI server is busy', true)
  return aiError('connection_failed', 'The AI server could not process the request', false)
}

// Toda causa que no sea ya un error propio se reduce a un mensaje fijo: la del servidor puede llevar la pregunta o el esquema.
function failure(deadline: Deadline, cause: unknown): Error {
  const reason = deadline.reason()
  if (reason === 'cancelled') return aiError('cancelled', 'The request was cancelled', false)
  if (reason === 'timeout')
    return aiError('timeout', 'The AI server took too long to respond', true)
  if (isAdapterError(cause)) return cause
  return aiError('connection_failed', 'Could not reach the local AI server', true)
}

const invalidResponse = (): Error =>
  aiError('connection_failed', 'The AI server sent an unexpected response', false)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw invalidResponse()
  }
}

async function open(
  fetchImpl: typeof fetch,
  request: AiHttpRequest,
  deadline: Deadline,
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  assertLoopbackUrl(request.url)
  const response = await fetchImpl(request.url, {
    method: request.method,
    headers:
      request.body === undefined
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: deadline.signal,
    // Una redirección podría llevar la petición (con el esquema en el cuerpo) fuera del bucle local.
    redirect: 'manual',
  })
  if (!response.body) throw invalidResponse()
  const reader = response.body.getReader()
  if (response.status >= 300 && response.status < 400) {
    await reader.cancel().catch(() => undefined)
    throw aiError('connection_failed', 'The AI server tried to redirect the request', false)
  }
  if (!response.ok) {
    await reader.cancel().catch(() => undefined)
    throw statusError(response.status)
  }
  return reader
}

export function createAiHttp(fetchImpl: typeof fetch = fetch): AiHttp {
  return {
    async json(request) {
      const deadline = createDeadline(request.signal, request.timeoutMs)
      try {
        const reader = await open(fetchImpl, request, deadline)
        const decoder = new TextDecoder()
        let text = ''
        let bytes = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.byteLength
            if (bytes > request.maxBytes) throw invalidResponse()
            text += decoder.decode(value, { stream: true })
          }
        } finally {
          await reader.cancel().catch(() => undefined)
        }
        return parseJson(text + decoder.decode())
      } catch (cause) {
        throw failure(deadline, cause)
      } finally {
        deadline.dispose()
      }
    },

    async ndjson(request, onLine) {
      const deadline = createDeadline(request.signal, request.timeoutMs)
      try {
        const reader = await open(fetchImpl, request, deadline)
        const decoder = new TextDecoder()
        let pending = ''
        let bytes = 0
        const emit = (line: string): void => {
          const trimmed = line.trim()
          if (trimmed !== '') onLine(parseJson(trimmed))
        }
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            deadline.refresh()
            bytes += value.byteLength
            if (bytes > request.maxBytes) throw invalidResponse()
            pending += decoder.decode(value, { stream: true })
            for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
              emit(pending.slice(0, end))
              pending = pending.slice(end + 1)
            }
            if (pending.length > MAX_NDJSON_LINE_BYTES) throw invalidResponse()
          }
          emit(pending + decoder.decode())
        } finally {
          await reader.cancel().catch(() => undefined)
        }
      } catch (cause) {
        throw failure(deadline, cause)
      } finally {
        deadline.dispose()
      }
    },
  }
}
