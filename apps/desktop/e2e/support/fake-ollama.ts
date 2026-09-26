import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test as base } from './strata-app'

// Un Ollama falso en el bucle local para los E2E de la IA: ningún test depende de un modelo real. Cada test recibe su
// propio servidor en un puerto libre de 127.0.0.1 (fixture `ollama`) que registra todo lo que le llega.

export interface RecordedRequest {
  method: string
  path: string
  /** Cabecera `Host` tal cual la envió la app: `127.0.0.1:<puerto>` si solo se habló con el bucle local. */
  host: string | undefined
  localAddress: string | undefined
  remoteAddress: string | undefined
  headers: IncomingHttpHeaders
  body: string
}

/** Una descarga (`POST /api/pull`) que el test conduce línea a línea. */
export interface FakePull {
  readonly request: RecordedRequest
  /** Escribe una línea NDJSON de avance (o `{ error }`). */
  send(line: unknown): void
  /** Cierra la respuesta con normalidad. */
  end(): void
  /** Corta la conexión a mitad, como un servidor que se cae. */
  abort(): void
  /** `true` cuando la app cerró su lado (cancelación). */
  readonly clientClosed: boolean
}

export interface FakeModel {
  name: string
  size: number
}

const DEFAULT_PULL_LINES: unknown[] = [
  { status: 'pulling manifest' },
  { status: 'pulling abc', total: 10, completed: 10 },
  { status: 'success' },
]

export class FakeOllama {
  /** `http://127.0.0.1:<puerto>`: un puerto libre del bucle local, siempre por encima de 1024. */
  readonly url: string
  readonly requests: RecordedRequest[] = []

  /** Contenido que devuelve `/api/chat`. */
  answer = 'SELECT id, name FROM people ORDER BY id'
  /** Retraso antes de responder a `/api/chat` (una respuesta lenta que el usuario cancela). */
  chatDelayMs = 0
  /** Estado HTTP de `/api/chat`: 404 (modelo no instalado), 504 (tiempo agotado)… */
  chatStatus = 200
  /** Lo que lista `/api/tags`. */
  models: FakeModel[] = [{ name: 'qwen3:14b', size: 123 }]
  /** Con `holdPull` a `false`, `/api/pull` envía estas líneas y termina sola. */
  pullLines: unknown[] = DEFAULT_PULL_LINES
  /** Con `true`, `/api/pull` espera a que el test la conduzca con `nextPull()`. */
  holdPull = false
  /** Peticiones a `/api/chat` que la app abandonó antes de recibir respuesta. */
  abortedChats = 0

  private readonly server: Server
  private readonly pending: FakePull[] = []
  private readonly waiters: ((pull: FakePull) => void)[] = []
  private closed = false

  private constructor(server: Server, port: number) {
    this.server = server
    this.url = `http://127.0.0.1:${port}`
  }

  static async start(): Promise<FakeOllama> {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const fake = new FakeOllama(server, (server.address() as AddressInfo).port)
    server.on('request', (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () =>
        fake.handle(request, response, Buffer.concat(chunks).toString('utf8')),
      )
    })
    return fake
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path)
  }

  clearRequests(): void {
    this.requests.length = 0
  }

  /** Espera a que la app abra una descarga y la entrega para conducirla. Requiere `holdPull`. */
  nextPull(): Promise<FakePull> {
    const ready = this.pending.shift()
    if (ready) return Promise.resolve(ready)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private handle(request: IncomingMessage, response: ServerResponse, body: string): void {
    const recorded: RecordedRequest = {
      method: request.method ?? '',
      path: request.url ?? '',
      host: request.headers.host,
      localAddress: request.socket.localAddress,
      remoteAddress: request.socket.remoteAddress,
      headers: request.headers,
      body,
    }
    this.requests.push(recorded)

    switch (recorded.path) {
      case '/api/version':
        return this.json(response, { version: '9.9.9' })
      case '/api/tags':
        return this.json(response, { models: this.models })
      case '/api/chat':
        return this.chat(response)
      case '/api/pull':
        return this.pull(recorded, response)
      default:
        return this.json(response, {}, 404)
    }
  }

  private json(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }

  private chat(response: ServerResponse): void {
    if (this.chatStatus !== 200) {
      // Un texto reconocible: la interfaz nunca debe mostrar lo que diga el servidor.
      this.json(response, { error: 'fake-server-says-something' }, this.chatStatus)
      return
    }
    const reply = (): void =>
      this.json(response, { message: { role: 'assistant', content: this.answer } })
    if (this.chatDelayMs <= 0) {
      reply()
      return
    }
    const timer = setTimeout(reply, this.chatDelayMs)
    response.on('close', () => {
      clearTimeout(timer)
      if (!response.writableFinished) this.abortedChats += 1
    })
  }

  private pull(request: RecordedRequest, response: ServerResponse): void {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    if (!this.holdPull) {
      for (const line of this.pullLines) response.write(`${JSON.stringify(line)}\n`)
      response.end()
      return
    }
    response.flushHeaders()
    let clientClosed = false
    response.on('close', () => {
      if (!response.writableFinished) clientClosed = true
    })
    const pull: FakePull = {
      request,
      send: (line) => void response.write(`${JSON.stringify(line)}\n`),
      end: () => void response.end(),
      abort: () => void response.destroy(),
      get clientClosed() {
        return clientClosed
      },
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter(pull)
    else this.pending.push(pull)
  }
}

interface Fixtures {
  /** Ollama falso de este test (puerto libre de 127.0.0.1); se cierra al terminar. */
  ollama: FakeOllama
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  ollama: async ({}, use) => {
    const fake = await FakeOllama.start()
    await use(fake)
    await fake.close()
  },
})

export { expect }
