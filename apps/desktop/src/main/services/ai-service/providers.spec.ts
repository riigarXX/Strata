// @vitest-environment node
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiProvider, GenerateRequest, PullProgress } from './ai-provider'
import { resolveAiEndpoint } from './endpoint'
import { createAiHttp } from './http'
import { createOllamaProvider } from './ollama-provider'
import { createOpenAiCompatibleProvider } from './openai-provider'
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

const timeouts = { probeMs: 300, listMs: 1_000, generateMs: 1_000, pullIdleMs: 300 }
const ollama = (fake: FakeAiServer): AiProvider =>
  createOllamaProvider(resolveAiEndpoint(fake.baseUrl), createAiHttp(), timeouts)
const openai = (fake: FakeAiServer, path = ''): AiProvider =>
  createOpenAiCompatibleProvider(
    resolveAiEndpoint(`${fake.baseUrl}${path}`),
    createAiHttp(),
    timeouts,
  )

const generateRequest: GenerateRequest = {
  model: 'qwen3:14b',
  system: 'SYSTEM PROMPT',
  user: 'USER PROMPT',
  maxTokens: 512,
  temperature: 0.1,
  contextTokens: 8192,
}

describe('proveedor Ollama', () => {
  it('probe: alcanzable con su versión', async () => {
    const fake = await server((_request, response) => json(response, { version: '0.13.4' }))

    expect(await ollama(fake).probe()).toEqual({ reachable: true, version: '0.13.4' })
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/api/version' })
  })

  it('probe: un servidor que no es Ollama (404), con error o apagado no cuenta como alcanzable', async () => {
    const fake = await server((_request, response) => json(response, {}, 404))
    expect(await ollama(fake).probe()).toEqual({ reachable: false, version: null })
    fake.respondWith((_request, response) => json(response, {}, 500))
    expect(await ollama(fake).probe()).toEqual({ reachable: false, version: null })
    await fake.close()
    expect(await ollama(fake).probe()).toEqual({ reachable: false, version: null })
  })

  it('probe: descarta una versión con caracteres raros', async () => {
    const fake = await server((_request, response) =>
      json(response, { version: '<script>alert(1)</script>' }),
    )
    expect(await ollama(fake).probe()).toEqual({ reachable: true, version: null })
  })

  it('listModels: solo modelos con nombre válido, con su tamaño', async () => {
    const fake = await server((_request, response) =>
      json(response, {
        models: [
          { name: 'qwen3:14b', size: 9_000_000_000 },
          { name: 'nomic-embed-text:latest', size: 274_000_000 },
          { name: 'has space', size: 1 },
          { name: 'x', size: -5 },
          { size: 1 },
          'not an object',
        ],
      }),
    )

    expect(await ollama(fake).listModels()).toEqual([
      { name: 'qwen3:14b', sizeBytes: 9_000_000_000, embedding: false },
      { name: 'nomic-embed-text:latest', sizeBytes: 274_000_000, embedding: true },
      { name: 'x', sizeBytes: null, embedding: false },
    ])
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/api/tags' })
  })

  it('listModels: reconoce los modelos de embeddings por sus capacidades y, sin ellas, por familia o nombre', async () => {
    const fake = await server((_request, response) =>
      json(response, {
        models: [
          { name: 'nomic-embed-text:latest', capabilities: ['embedding'] },
          { name: 'qwen3:14b', capabilities: ['completion', 'tools', 'thinking'] },
          // `capabilities` manda sobre el nombre.
          { name: 'embed-tuned-sql:latest', capabilities: ['completion'] },
          // Versiones antiguas de Ollama: sin `capabilities`.
          { name: 'model-a', details: { family: 'nomic-bert', families: ['nomic-bert'] } },
          { name: 'model-b', details: { family: 'llama', families: ['llama', 'bert'] } },
          { name: 'mxbai-embed-large:latest', details: { family: 'llama' } },
          { name: 'llama3.2:3b', details: { family: 'llama', families: ['llama'] } },
        ],
      }),
    )

    const found = await ollama(fake).listModels()
    expect(found.filter((model) => model.embedding).map((model) => model.name)).toEqual([
      'nomic-embed-text:latest',
      'model-a',
      'model-b',
      'mxbai-embed-large:latest',
    ])
  })

  it('listModels: una respuesta sin `models` es una lista vacía', async () => {
    const fake = await server((_request, response) => json(response, { other: 1 }))
    expect(await ollama(fake).listModels()).toEqual([])
  })

  it('generate: /api/chat sin streaming, con think:false, temperatura baja y ventana de contexto', async () => {
    const fake = await server((_request, response) =>
      json(response, { message: { role: 'assistant', content: 'SELECT 1' }, done: true }),
    )

    const text = await ollama(fake).generate(generateRequest)

    expect(text).toBe('SELECT 1')
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({ method: 'POST', path: '/api/chat' })
    expect(JSON.parse(fake.requests[0]?.body ?? '')).toEqual({
      model: 'qwen3:14b',
      messages: [
        { role: 'system', content: 'SYSTEM PROMPT' },
        { role: 'user', content: 'USER PROMPT' },
      ],
      stream: false,
      think: false,
      options: { temperature: 0.1, num_predict: 512, num_ctx: 8192 },
    })
  })

  it('generate: una respuesta sin contenido es un error, no una cadena vacía', async () => {
    const fake = await server((_request, response) => json(response, { message: {} }))
    await expect(ollama(fake).generate(generateRequest)).rejects.toMatchObject({
      normalized: { code: 'connection_failed' },
    })
  })

  it('generate: un modelo que no está instalado es not_found', async () => {
    const fake = await server((_request, response) =>
      json(response, { error: "model 'x' not found" }, 404),
    )
    await expect(ollama(fake).generate(generateRequest)).rejects.toMatchObject({
      normalized: { code: 'not_found' },
    })
  })

  describe('pullModel', () => {
    const pull = async (fake: FakeAiServer, signal?: AbortSignal) => {
      const progress: PullProgress[] = []
      const provider = ollama(fake)
      const result = await provider
        .pullModel?.('qwen3:14b', (p) => progress.push(p), signal)
        .then(() => undefined)
        .catch((reason: unknown) => reason)
      return { progress, result }
    }

    it('pide /api/pull con streaming y reenvía el avance hasta success', async () => {
      const fake = await server((_request, response) => {
        response.writeHead(200)
        response.write('{"status":"pulling manifest"}\n')
        response.write(
          '{"status":"pulling 8934d96d3f08","digest":"sha256:8934","total":1000,"completed":250}\n',
        )
        response.write(
          '{"status":"pulling 8934d96d3f08","digest":"sha256:8934","total":1000,"completed":1000}\n',
        )
        response.write('{"status":"verifying sha256 digest"}\n')
        response.end('{"status":"success"}\n')
      })

      const { progress, result } = await pull(fake)

      expect(result).toBeUndefined()
      expect(JSON.parse(fake.requests[0]?.body ?? '')).toEqual({ model: 'qwen3:14b', stream: true })
      expect(fake.requests[0]?.path).toBe('/api/pull')
      expect(progress).toEqual([
        { status: 'pulling manifest', completed: null, total: null },
        { status: 'pulling 8934d96d3f08', completed: 250, total: 1000 },
        { status: 'pulling 8934d96d3f08', completed: 1000, total: 1000 },
        { status: 'verifying sha256 digest', completed: null, total: null },
        { status: 'success', completed: null, total: null },
      ])
    })

    it('reensambla líneas de progreso cortadas entre trozos', async () => {
      const fake = await server(async (_request, response) => {
        response.writeHead(200)
        response.write('{"status":"pulling abc","total":10,')
        await sleep(15)
        response.write('"completed":5}\n{"status"')
        await sleep(15)
        response.end(':"success"}\n')
      })

      const { progress, result } = await pull(fake)

      expect(result).toBeUndefined()
      expect(progress.map((p) => p.status)).toEqual(['pulling abc', 'success'])
      expect(progress[0]).toEqual({ status: 'pulling abc', completed: 5, total: 10 })
    })

    it('una línea {"error"} corta la descarga: not_found si el modelo no existe, fallo genérico si no', async () => {
      const missing = await server((_request, response) => {
        response.writeHead(200)
        response.end(
          '{"status":"pulling manifest"}\n{"error":"pull model manifest: file does not exist"}\n',
        )
      })
      expect((await pull(missing)).result).toMatchObject({ normalized: { code: 'not_found' } })

      const other = await server((_request, response) => {
        response.writeHead(200)
        response.end('{"error":"insufficient disk space at /Users/rigarxx/.ollama"}\n')
      })
      const { result } = await pull(other)
      expect(result).toMatchObject({ normalized: { code: 'connection_failed', retryable: false } })
      expect(JSON.stringify(result)).not.toContain('rigarxx')
    })

    it('un flujo que termina sin success es un fallo reintentable (descarga incompleta)', async () => {
      const fake = await server((_request, response) => {
        response.writeHead(200)
        response.end('{"status":"pulling abc","total":10,"completed":5}\n')
      })
      expect((await pull(fake)).result).toMatchObject({
        normalized: { code: 'connection_failed', retryable: true },
      })
    })

    it('un flujo cortado a mitad de línea no cuenta como éxito', async () => {
      const fake = await server((_request, response) => {
        response.writeHead(200)
        response.end('{"status":"pulling abc"}\n{"status":"succ')
      })
      expect((await pull(fake)).result).toMatchObject({ normalized: { code: 'connection_failed' } })
    })

    it('una línea con success dentro de un texto no cuenta: solo el estado exacto', async () => {
      const fake = await server((_request, response) => {
        response.writeHead(200)
        response.end('{"status":"not a success yet"}\n')
      })
      expect((await pull(fake)).result).toMatchObject({ normalized: { code: 'connection_failed' } })
    })

    it('ignora líneas que no son objetos y limpia el estado de caracteres de control', async () => {
      const fake = await server((_request, response) => {
        response.writeHead(200)
        response.write('[1,2]\n42\n"texto"\n')
        response.write('{"status":"pulling\\u001b[31m x\\ny","completed":-3,"total":"9"}\n')
        response.end('{"status":"success"}\n')
      })

      const { progress } = await pull(fake)

      expect(progress[0]).toEqual({ status: 'pulling [31m x y', completed: null, total: null })
    })

    it('se para si el servidor deja de enviar avance (tiempo de inactividad)', async () => {
      const fake = await server((_request, response) => {
        response.writeHead(200)
        response.write('{"status":"pulling abc"}\n')
      })
      expect((await pull(fake)).result).toMatchObject({ normalized: { code: 'timeout' } })
    })

    it('se cancela con la señal', async () => {
      const fake = await server((_request, response) => {
        response.writeHead(200)
        response.write('{"status":"pulling abc"}\n')
      })
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 40)

      expect((await pull(fake, controller.signal)).result).toMatchObject({
        normalized: { code: 'cancelled' },
      })
    })
  })
})

describe('proveedor compatible con OpenAI', () => {
  it('probe: alcanzable si /v1/models responde; sin versión', async () => {
    const fake = await server((request, response) =>
      request.path === '/v1/models' ? json(response, { data: [] }) : json(response, {}, 404),
    )
    expect(await openai(fake).probe()).toEqual({ reachable: true, version: null })
    await fake.close()
    expect(await openai(fake).probe()).toEqual({ reachable: false, version: null })
  })

  it('no repite /v1 si la dirección ya lo lleva', async () => {
    const fake = await server((_request, response) => json(response, { data: [{ id: 'm' }] }))

    await openai(fake, '/v1').listModels()
    await openai(fake).listModels()

    expect(fake.requests.map((r) => r.path)).toEqual(['/v1/models', '/v1/models'])
  })

  it('listModels: usa `id` y descarta los nombres inválidos', async () => {
    const fake = await server((_request, response) =>
      json(response, {
        data: [{ id: 'qwen/qwen3.8-27b' }, { id: 'text-embedding-nomic' }, { id: 'a b' }, {}],
      }),
    )
    expect(await openai(fake).listModels()).toEqual([
      { name: 'qwen/qwen3.8-27b', sizeBytes: null, embedding: false },
      { name: 'text-embedding-nomic', sizeBytes: null, embedding: true },
    ])
  })

  it('generate: /v1/chat/completions con temperatura y max_tokens, y /no_think y reasoning_effort solo en Qwen3', async () => {
    const fake = await server((_request, response) =>
      json(response, {
        choices: [
          { message: { role: 'assistant', content: 'SELECT 1', reasoning_content: 'SELECT 999' } },
        ],
      }),
    )

    const qwen = await openai(fake).generate({ ...generateRequest, model: 'qwen/qwen3.8-27b' })
    const llama = await openai(fake).generate({ ...generateRequest, model: 'llama-3.1-8b' })

    expect(qwen).toBe('SELECT 1')
    expect(llama).toBe('SELECT 1')
    const [first, second] = fake.requests.map((r) => JSON.parse(r.body))
    expect(fake.requests[0]?.path).toBe('/v1/chat/completions')
    expect(first).toEqual({
      model: 'qwen/qwen3.8-27b',
      messages: [
        { role: 'system', content: 'SYSTEM PROMPT\n/no_think' },
        { role: 'user', content: 'USER PROMPT' },
      ],
      stream: false,
      temperature: 0.1,
      max_tokens: 512,
      reasoning_effort: 'none',
    })
    expect(second.messages[0].content).toBe('SYSTEM PROMPT')
    expect(second).not.toHaveProperty('reasoning_effort')
  })

  it('generate: respuesta sin choices es un error', async () => {
    const fake = await server((_request, response) => json(response, { choices: [] }))
    await expect(openai(fake).generate(generateRequest)).rejects.toMatchObject({
      normalized: { code: 'connection_failed' },
    })
  })

  it('no descarga modelos', async () => {
    const fake = await server((_request, response) => json(response, {}))
    expect(openai(fake).pullModel).toBeUndefined()
  })
})
