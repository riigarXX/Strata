// @vitest-environment node
import { IPC_CHANNELS } from '@strata/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createAppOrigin } from '../security/app-origin'
import type { IpcSenderLike } from '../security/sender-validation'
import { createAiHandlers } from './ai-handlers'

const ENTRY_URL = 'app://strata/index.html'
const appOrigin = createAppOrigin()
const channels = IPC_CHANNELS.ai
const mainFrame = { url: ENTRY_URL }
const webContents = { mainFrame }
const trustedEvent: IpcSenderLike = { sender: webContents, senderFrame: mainFrame }

const generated = {
  requestId: 'r1',
  sql: 'SELECT 1',
  risk: 'read',
  statementType: 'query',
  warnings: [],
} as const

function setup() {
  const aiService = {
    status: vi.fn(async () => ({ providers: [] })),
    listModels: vi.fn(async () => [{ name: 'qwen3:14b', sizeBytes: 9, embedding: false }]),
    generateSql: vi.fn(async (): Promise<unknown> => generated),
    pullModel: vi.fn(async () => ({ requestId: 'r2', model: 'qwen3:14b' })),
    cancel: vi.fn((requestId: string) => ({ requestId, outcome: 'requested' as const })),
  }
  const handlers = createAiHandlers({
    aiService: aiService as never,
    getMainWindow: () => ({ webContents }),
    appOrigin,
  })
  return { handlers, aiService }
}

const call = (
  handlers: ReturnType<typeof setup>['handlers'],
  channel: string,
  payload?: unknown,
  event: IpcSenderLike = trustedEvent,
) => {
  const handler = handlers[channel]
  if (!handler) throw new Error(`sin handler para ${channel}`)
  return handler(event, payload)
}

describe('createAiHandlers', () => {
  it('registra exactamente los canales de petición del dominio ai, no el de avance', () => {
    const { handlers } = setup()
    expect(Object.keys(handlers).sort()).toEqual(
      [
        channels.status,
        channels.listModels,
        channels.generateSql,
        channels.pullModel,
        channels.cancel,
      ].sort(),
    )
    expect(handlers).not.toHaveProperty(channels.pullProgress)
  })

  it('pasa cada petición validada al servicio y responde en un IpcResult', async () => {
    const { handlers, aiService } = setup()
    const generate = { requestId: 'r1', sessionId: 's1', question: 'How many users?' }

    expect(await call(handlers, channels.status)).toEqual({ ok: true, data: { providers: [] } })
    expect(await call(handlers, channels.listModels, {})).toEqual({
      ok: true,
      data: [{ name: 'qwen3:14b', sizeBytes: 9, embedding: false }],
    })
    expect(await call(handlers, channels.generateSql, generate)).toEqual({
      ok: true,
      data: generated,
    })
    expect(
      await call(handlers, channels.pullModel, { requestId: 'r2', model: 'qwen3:14b' }),
    ).toEqual({ ok: true, data: { requestId: 'r2', model: 'qwen3:14b' } })
    expect(await call(handlers, channels.cancel, { requestId: 'r1' })).toEqual({
      ok: true,
      data: { requestId: 'r1', outcome: 'requested' },
    })
    expect(aiService.generateSql).toHaveBeenCalledWith(generate)
    expect(aiService.cancel).toHaveBeenCalledWith('r1')
  })

  it.each([
    [channels.listModels, { baseUrl: 'http://evil.example.com:11434' }],
    [channels.listModels, { baseUrl: 'http://127.0.0.1@evil.example.com:11434' }],
    [channels.listModels, { provider: 'openai' }],
    [channels.generateSql, { requestId: 'r1', sessionId: 's1', question: '' }],
    [channels.generateSql, { requestId: 'r1', sessionId: 's1', question: 'x'.repeat(2001) }],
    [channels.generateSql, { requestId: 'r1', sessionId: 's1', question: 'q', model: 'other' }],
    [channels.generateSql, { requestId: 'r1', sessionId: 's1', question: 'q', schema: 'DROP' }],
    [channels.generateSql, { sessionId: 's1', question: 'q' }],
    [channels.pullModel, { requestId: 'r1', model: 'a b' }],
    [channels.pullModel, { requestId: 'r1', model: 'x', baseUrl: 'http://127.0.0.1:1234' }],
    [channels.cancel, { requestId: '' }],
    [channels.status, {}],
  ])('%s responde validation_failed con %j sin llegar al servicio', async (channel, payload) => {
    const { handlers, aiService } = setup()

    expect(await call(handlers, channel, payload)).toEqual({
      ok: false,
      error: { code: 'validation_failed', message: 'The request is not valid', retryable: false },
    })
    for (const method of Object.values(aiService)) expect(method).not.toHaveBeenCalled()
  })

  it.each(Object.values({ ...channels, pullProgress: undefined }).filter(Boolean) as string[])(
    '%s rechaza un remitente que no es la ventana principal',
    async (channel) => {
      const { handlers, aiService } = setup()
      const stranger = { url: 'https://evil.example.com/' }

      const rejection = await call(handlers, channel, undefined, {
        sender: { mainFrame: stranger },
        senderFrame: stranger,
      }).catch((reason: unknown) => reason)

      expect((rejection as Error).message).toBe('IPC sender not allowed')
      for (const method of Object.values(aiService)) expect(method).not.toHaveBeenCalled()
    },
  )

  it('un error del servicio con datos sensibles llega como error genérico', async () => {
    const { handlers, aiService } = setup()
    aiService.generateSql.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:11434 prompt=SELECT secret FROM users'),
    )

    const result = await call(handlers, channels.generateSql, {
      requestId: 'r1',
      sessionId: 's1',
      question: 'q',
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'An unexpected internal error occurred',
        retryable: false,
      },
    })
  })

  it('no deja pasar campos de más en la respuesta (p. ej. filas): el resultado no se valida, se rechaza', async () => {
    const { handlers, aiService } = setup()
    aiService.generateSql.mockResolvedValueOnce({ ...generated, rows: [['secret']] })

    const result = await call(handlers, channels.generateSql, {
      requestId: 'r1',
      sessionId: 's1',
      question: 'q',
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
