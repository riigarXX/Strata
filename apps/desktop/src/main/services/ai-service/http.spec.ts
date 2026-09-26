// @vitest-environment node
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiError } from './errors'
import { createAiHttp, type AiHttpRequest } from './http'
import { json, startFakeAiServer, type FakeAiServer } from './testing'

const servers: FakeAiServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function server(handler: Parameters<typeof startFakeAiServer>[0]): Promise<FakeAiServer> {
  const started = await startFakeAiServer(handler)
  servers.push(started)
  return started
}

const request = (fake: FakeAiServer, patch: Partial<AiHttpRequest> = {}): AiHttpRequest => ({
  url: new URL('/x', fake.baseUrl),
  method: 'GET',
  timeoutMs: 2_000,
  maxBytes: 100_000,
  ...patch,
})

const normalized = (code: string, retryable?: boolean) => ({
  normalized: { code, ...(retryable === undefined ? {} : { retryable }) },
})

describe('createAiHttp.json', () => {
  it('lee una respuesta JSON y envía el cuerpo como JSON sin credenciales ni cookies', async () => {
    const fake = await server((_request, response) => json(response, { ok: true }))

    const data = await createAiHttp().json(request(fake, { method: 'POST', body: { a: 1 } }))

    expect(data).toEqual({ ok: true })
    const [received] = fake.requests
    expect(received?.method).toBe('POST')
    expect(JSON.parse(received?.body ?? '')).toEqual({ a: 1 })
    expect(received?.headers['content-type']).toBe('application/json')
    expect(received?.headers['authorization']).toBeUndefined()
    expect(received?.headers['cookie']).toBeUndefined()
  })

  it.each([
    [404, 'not_found'],
    [401, 'permission_denied'],
    [403, 'permission_denied'],
    [408, 'timeout'],
    [429, 'busy'],
    [503, 'busy'],
    [500, 'connection_failed'],
    [400, 'connection_failed'],
  ])('traduce el estado %i a %s sin citar el cuerpo del servidor', async (status, code) => {
    const fake = await server((_request, response) =>
      json(response, { error: 'prompt echo: SELECT secret FROM users' }, status),
    )

    const failure = await createAiHttp()
      .json(request(fake))
      .catch((reason: unknown) => reason)

    expect(failure).toMatchObject(normalized(code))
    expect(JSON.stringify(failure)).not.toContain('secret')
  })

  it('no sigue redirecciones: ni a otro servidor del bucle local ni fuera', async () => {
    const target = await server((_request, response) => json(response, { reached: true }))
    const fake = await server((_request, response) => {
      response.writeHead(302, { location: `${target.baseUrl}/steal` })
      response.end()
    })

    const failure = await createAiHttp()
      .json(request(fake, { method: 'POST', body: { schema: 'users(id)' } }))
      .catch((reason: unknown) => reason)

    expect(failure).toMatchObject(normalized('connection_failed', false))
    expect(target.requests).toEqual([])
    for (const status of [301, 307, 308]) {
      fake.respondWith((_request, response) => {
        response.writeHead(status, { location: 'http://evil.example.com/' })
        response.end()
      })
      await expect(createAiHttp().json(request(fake))).rejects.toMatchObject(
        normalized('connection_failed'),
      )
    }
  })

  it('agota el tiempo con timeout reintentable', async () => {
    const fake = await server(() => undefined)

    await expect(createAiHttp().json(request(fake, { timeoutMs: 50 }))).rejects.toMatchObject(
      normalized('timeout', true),
    )
  })

  it('cancela con cancelled, también si la señal ya venía cancelada', async () => {
    const fake = await server(() => undefined)
    const controller = new AbortController()
    const pending = createAiHttp().json(request(fake, { signal: controller.signal }))
    setTimeout(() => controller.abort(), 20)

    await expect(pending).rejects.toMatchObject(normalized('cancelled', false))

    const already = AbortSignal.abort()
    await expect(createAiHttp().json(request(fake, { signal: already }))).rejects.toMatchObject(
      normalized('cancelled'),
    )
    expect(fake.requests).toHaveLength(1)
  })

  it('rechaza una respuesta que supera el tope de bytes', async () => {
    const fake = await server((_request, response) => json(response, { data: 'x'.repeat(5_000) }))

    await expect(createAiHttp().json(request(fake, { maxBytes: 1_000 }))).rejects.toMatchObject(
      normalized('connection_failed', false),
    )
  })

  it('rechaza una respuesta que no es JSON', async () => {
    const fake = await server((_request, response) => response.end('<html>hola</html>'))

    await expect(createAiHttp().json(request(fake))).rejects.toMatchObject(
      normalized('connection_failed', false),
    )
  })

  it('un servidor apagado es connection_failed reintentable, sin datos de la conexión', async () => {
    const fake = await server(() => undefined)
    const url = new URL('/x', fake.baseUrl)
    await fake.close()

    const failure = await createAiHttp()
      .json({ ...request(fake), url })
      .catch((reason: unknown) => reason)

    expect(failure).toMatchObject(normalized('connection_failed', true))
    expect(JSON.stringify(failure)).not.toContain('127.0.0.1')
    expect(JSON.stringify(failure)).not.toContain('ECONNREFUSED')
  })

  it.each([
    'http://evil.example.com/x',
    'http://127.0.0.1@evil.example.com:1234/x',
    'http://127.0.0.1/x',
    'ftp://127.0.0.1:1234/x',
  ])('no llama a fetch con %s', async (url) => {
    const fetchSpy = vi.fn<typeof fetch>()

    await expect(
      createAiHttp(fetchSpy).json({
        url: new URL(url),
        method: 'GET',
        timeoutMs: 100,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject(normalized('validation_failed'))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('pide siempre redirect: manual y una señal de cancelación', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => Response.json({ ok: true }))

    await createAiHttp(fetchSpy).json({
      url: new URL('http://127.0.0.1:1234/x'),
      method: 'GET',
      timeoutMs: 100,
      maxBytes: 100,
    })

    const init = fetchSpy.mock.calls[0]?.[1]
    expect(init?.redirect).toBe('manual')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('createAiHttp.ndjson', () => {
  it('entrega una línea por llamada y reensambla las que llegan cortadas entre trozos', async () => {
    const fake = await server(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.write('{"status":"pulling manifest"}\n{"status":"pull')
      await sleep(20)
      response.write('ing abc","completed":5,')
      await sleep(20)
      response.write('"total":10}\n\n')
      await sleep(20)
      response.end('{"status":"success"}')
    })
    const lines: unknown[] = []

    await createAiHttp().ndjson(request(fake, { method: 'POST' }), (line) => lines.push(line))

    expect(lines).toEqual([
      { status: 'pulling manifest' },
      { status: 'pulling abc', completed: 5, total: 10 },
      { status: 'success' },
    ])
  })

  it('una línea cortada al final del flujo es una respuesta inválida, no un éxito', async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200)
      response.end('{"status":"ok"}\n{"status":"pull')
    })
    const lines: unknown[] = []

    await expect(
      createAiHttp().ndjson(request(fake), (line) => lines.push(line)),
    ).rejects.toMatchObject(normalized('connection_failed', false))
    expect(lines).toEqual([{ status: 'ok' }])
  })

  it('rechaza una línea sin salto de línea que crece sin límite', async () => {
    const fake = await server(async (_request, response) => {
      response.writeHead(200)
      for (let i = 0; i < 10; i++) {
        response.write('x'.repeat(20_000))
        await sleep(2)
      }
      response.end()
    })

    await expect(createAiHttp().ndjson(request(fake), () => undefined)).rejects.toMatchObject(
      normalized('connection_failed', false),
    )
  })

  it('rechaza un flujo que supera el tope total de bytes', async () => {
    const fake = await server((_request, response) => {
      response.writeHead(200)
      response.end(`${'{"status":"x"}\n'.repeat(200)}`)
    })

    await expect(
      createAiHttp().ndjson(request(fake, { maxBytes: 500 }), () => undefined),
    ).rejects.toMatchObject(normalized('connection_failed'))
  })

  it('el tiempo es de inactividad: se renueva con cada trozo y vence si el flujo se para', async () => {
    const fake = await server(async (_request, response) => {
      response.writeHead(200)
      for (let i = 0; i < 6; i++) {
        response.write(`{"status":"step ${i}"}\n`)
        await sleep(30)
      }
    })
    const lines: unknown[] = []

    await expect(
      createAiHttp().ndjson(request(fake, { timeoutMs: 100 }), (line) => lines.push(line)),
    ).rejects.toMatchObject(normalized('timeout', true))
    expect(lines).toHaveLength(6)
  })

  it('cancela a mitad del flujo', async () => {
    const fake = await server(async (_request, response) => {
      response.writeHead(200)
      response.write('{"status":"pulling"}\n')
    })
    const controller = new AbortController()

    await expect(
      createAiHttp().ndjson(request(fake, { signal: controller.signal }), () => controller.abort()),
    ).rejects.toMatchObject(normalized('cancelled', false))
  })

  it('un error propio lanzado al procesar una línea llega tal cual y corta la descarga; cualquier otro se reduce a uno fijo', async () => {
    const fake = await server(async (_request, response) => {
      response.writeHead(200)
      response.write('{"error":"boom"}\n')
      await sleep(500)
      response.end('{"status":"never"}\n')
    })
    const seen: unknown[] = []

    await expect(
      createAiHttp().ndjson(request(fake), (line) => {
        seen.push(line)
        throw aiError('not_found', 'The model was not found')
      }),
    ).rejects.toMatchObject(normalized('not_found'))
    expect(seen).toEqual([{ error: 'boom' }])

    await expect(
      createAiHttp().ndjson(request(fake), () => {
        throw new Error('SELECT secret FROM users')
      }),
    ).rejects.toMatchObject({
      normalized: { code: 'connection_failed', message: expect.not.stringContaining('secret') },
    })
  })
})
