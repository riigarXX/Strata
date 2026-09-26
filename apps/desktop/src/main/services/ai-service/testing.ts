import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: string
}

export type FakeHandler = (request: RecordedRequest, response: ServerResponse) => unknown

export interface FakeAiServer {
  /** `http://127.0.0.1:<puerto>`: un puerto libre del bucle local, siempre por encima de 1024. */
  readonly baseUrl: string
  readonly requests: RecordedRequest[]
  /** Sustituye la respuesta de las siguientes peticiones. */
  respondWith(handler: FakeHandler): void
  close(): Promise<void>
}

export const json = (response: ServerResponse, body: unknown, status = 200): void => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** Servidor HTTP falso en el bucle local: los tests automáticos nunca dependen de un modelo ni de Ollama. */
export async function startFakeAiServer(handler: FakeHandler): Promise<FakeAiServer> {
  let current = handler
  const requests: RecordedRequest[] = []
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((incoming, response) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const recorded: RecordedRequest = {
        method: incoming.method ?? '',
        path: incoming.url ?? '',
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(recorded)
      void Promise.resolve(current(recorded, response)).catch(() => response.destroy())
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    respondWith(next) {
      current = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
