// @vitest-environment node
import { EventEmitter } from 'node:events'
import { IPC_CHANNELS, type QueryEvent } from '@strata/contracts'
import { AdapterError, createNormalizedError } from '@strata/db-core'
import { describe, expect, it, vi } from 'vitest'
import { createAppOrigin } from '../security/app-origin'
import { createQueryExecutor, type QueryExecutor } from '../services/query-executor'
import {
  createSessionRuntime,
  createStreamingAdapter,
  REDACTION,
  until,
} from '../services/query-executor/testing'
import { createQueryHandlers, type QueryIpcEvent } from './query-handlers'

const ENTRY_URL = 'app://strata/index.html'
const appOrigin = createAppOrigin()
const channels = IPC_CHANNELS.query
const mainFrame = { url: ENTRY_URL }

function fakeWebContents() {
  const emitter = new EventEmitter()
  const sent: { channel: string; payload: QueryEvent }[] = []
  const webContents = {
    mainFrame,
    send: (channel: string, payload: QueryEvent) => sent.push({ channel, payload }),
    isDestroyed: () => false,
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) =>
      emitter.removeListener(event, listener),
  }
  const event = { sender: webContents, senderFrame: mainFrame } as unknown as QueryIpcEvent
  return { webContents, event, sent, emitter }
}

function setup(session: { readOnly?: boolean } = {}) {
  const adapter = createStreamingAdapter({ chunks: 3 })
  const runtime = createSessionRuntime(adapter, session)
  const executor = createQueryExecutor({
    getSessionRuntime: (id) => (id === runtime.session.sessionId ? runtime : undefined),
  })
  const window = fakeWebContents()
  const handlers = createQueryHandlers({
    queryExecutor: executor,
    getMainWindow: () => ({ webContents: window.webContents }),
    appOrigin,
  })
  const invoke = (channel: string, payload?: unknown, event: QueryIpcEvent = window.event) => {
    const handler = handlers[channel]
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler(event, payload)
  }
  return { invoke, handlers, adapter, executor, window }
}

const valid = { requestId: 'r1', sessionId: 'session-1', sql: 'SELECT n FROM t' }

describe('createQueryHandlers', () => {
  it('registra exactamente un handler por canal de query que recibe peticiones', () => {
    const { handlers } = setup()
    expect(Object.keys(handlers).sort()).toEqual(
      [channels.execute, channels.cancel, channels.ack].sort(),
    )
  })

  it('execute responde de inmediato con un ack de arranque y emite los eventos al solicitante', async () => {
    const { invoke, window, adapter } = setup()

    const result = await invoke(channels.execute, valid)

    expect(result).toEqual({ ok: true, data: undefined })
    expect(window.sent).toEqual([])
    await until(() => window.sent.some(({ payload }) => payload.type === 'done'))
    expect(window.sent.every(({ channel }) => channel === IPC_CHANNELS.query.event)).toBe(true)
    expect(window.sent.every(({ payload }) => payload.requestId === 'r1')).toBe(true)
    expect(adapter.executed[0]).toMatchObject({ maxRows: 10_000, timeoutMs: 30_000 })
  })

  it('un ack por IPC repone crédito y cancel por IPC cancela', async () => {
    const adapter = createStreamingAdapter({ chunks: 20 })
    const runtime = createSessionRuntime(adapter)
    const executor = createQueryExecutor({ getSessionRuntime: () => runtime })
    const window = fakeWebContents()
    const handlers = createQueryHandlers({
      queryExecutor: executor,
      getMainWindow: () => ({ webContents: window.webContents }),
      appOrigin,
    })
    const call = (channel: string, payload: unknown) => handlers[channel]!(window.event, payload)

    await call(channels.execute, valid)
    await until(() => window.sent.length === 4)
    expect(adapter.pulled).toBe(4)

    await expect(
      call(channels.ack, { requestId: 'r1', statementIndex: 0, chunkIndex: 0 }),
    ).resolves.toEqual({ ok: true, data: undefined })
    await until(() => adapter.pulled === 5)

    await expect(call(channels.cancel, { requestId: 'r1' })).resolves.toEqual({
      ok: true,
      data: { requestId: 'r1', outcome: 'requested' },
    })
    await until(() => window.sent.some(({ payload }) => payload.type === 'cancelled'))
    await expect(call(channels.cancel, { requestId: 'r1' })).resolves.toEqual({
      ok: true,
      data: { requestId: 'r1', outcome: 'not_running' },
    })
  })

  it('un rechazo previo llega como error normalizado y no emite eventos', async () => {
    const { invoke, window } = setup({ readOnly: true })

    const blocked = await invoke(channels.execute, { ...valid, sql: 'DELETE FROM t' })
    const missing = await invoke(channels.execute, { ...valid, sessionId: 'nope' })

    expect(blocked).toMatchObject({ ok: false, error: { code: 'read_only_violation' } })
    expect(missing).toMatchObject({ ok: false, error: { code: 'no_session' } })
    expect(window.sent).toEqual([])
  })

  it('la segunda ejecución sobre la misma sesión responde busy', async () => {
    const adapter = createStreamingAdapter({ chunks: 20 })
    const runtime = createSessionRuntime(adapter)
    const executor = createQueryExecutor({ getSessionRuntime: () => runtime })
    const window = fakeWebContents()
    const handlers = createQueryHandlers({
      queryExecutor: executor,
      getMainWindow: () => ({ webContents: window.webContents }),
      appOrigin,
    })

    await handlers[channels.execute]!(window.event, valid)
    const second = await handlers[channels.execute]!(window.event, { ...valid, requestId: 'r2' })

    expect(second).toMatchObject({ ok: false, error: { code: 'busy' } })
  })

  describe('validación', () => {
    const invalidPayloads: [string, string, unknown][] = [
      ['execute', channels.execute, undefined],
      ['execute', channels.execute, { ...valid, sql: '   ' }],
      ['execute', channels.execute, { ...valid, requestId: '' }],
      ['execute', channels.execute, { ...valid, maxRows: -1 }],
      ['execute', channels.execute, { ...valid, chunkSize: 1_000_000 }],
      ['execute', channels.execute, { ...valid, readOnly: false }],
      ['execute', channels.execute, { ...valid, sql: 42 }],
      ['cancel', channels.cancel, {}],
      ['cancel', channels.cancel, { requestId: 'r', extra: 1 }],
      ['ack', channels.ack, { requestId: 'r1', statementIndex: -1, chunkIndex: 0 }],
      ['ack', channels.ack, { requestId: 'r1', statementIndex: 0 }],
      ['ack', channels.ack, 'r1'],
    ]

    it.each(invalidPayloads)(
      '%s rechaza el payload inválido sin llegar al ejecutor',
      async (_n, channel, payload) => {
        const { invoke, adapter } = setup()
        const result = await invoke(channel, payload)
        expect(result).toMatchObject({ ok: false, error: { code: 'validation_failed' } })
        expect(adapter.executed).toEqual([])
      },
    )

    it('el mensaje de validación no cita lo enviado', async () => {
      const { invoke } = setup()
      const result = await invoke(channels.execute, { ...valid, sql: 'x'.repeat(2_000_001) })
      expect(JSON.stringify(result)).not.toContain('xxxxxxxx')
    })
  })

  describe('remitente no confiable', () => {
    const otherFrame = { url: ENTRY_URL }
    const untrusted: Record<string, () => QueryIpcEvent> = {
      'otra ventana': () => {
        const other = fakeWebContents()
        return other.event
      },
      subframe: () => {
        const { webContents } = setup().window
        return { sender: webContents, senderFrame: otherFrame } as unknown as QueryIpcEvent
      },
      'origen ajeno': () => {
        const foreign = { url: 'https://evil.example/' }
        const wc = { ...setup().window.webContents, mainFrame: foreign }
        return { sender: wc, senderFrame: foreign } as unknown as QueryIpcEvent
      },
      'frame destruido': () =>
        ({ sender: setup().window.webContents, senderFrame: null }) as unknown as QueryIpcEvent,
    }

    it.each(Object.keys(untrusted))(
      '%s: todos los canales rechazan sin ejecutar nada',
      async (name) => {
        const executor: QueryExecutor = {
          execute: vi.fn(),
          cancel: vi.fn(),
          ack: vi.fn(),
          cancelSession: vi.fn(),
        }
        const window = fakeWebContents()
        const handlers = createQueryHandlers({
          queryExecutor: executor,
          getMainWindow: () => ({ webContents: window.webContents }),
          appOrigin,
        })
        const event = untrusted[name]!()
        const payloads: Record<string, unknown> = {
          [channels.execute]: valid,
          [channels.cancel]: { requestId: 'r1' },
          [channels.ack]: { requestId: 'r1', statementIndex: 0, chunkIndex: 0 },
        }

        for (const [channel, handler] of Object.entries(handlers)) {
          await expect(handler(event, payloads[channel])).rejects.toThrow('IPC sender not allowed')
        }
        expect(executor.execute).not.toHaveBeenCalled()
        expect(executor.cancel).not.toHaveBeenCalled()
        expect(executor.ack).not.toHaveBeenCalled()
      },
    )
  })

  describe('sin fugas de información sensible', () => {
    it('un fallo inesperado del ejecutor llega como internal_error sin su mensaje', async () => {
      const executor: QueryExecutor = {
        execute: () => {
          throw new Error(`connect ECONNREFUSED ${REDACTION.host} password=${REDACTION.secrets[0]}`)
        },
        cancel: vi.fn(),
        ack: vi.fn(),
        cancelSession: vi.fn(),
      }
      const window = fakeWebContents()
      const handlers = createQueryHandlers({
        queryExecutor: executor,
        getMainWindow: () => ({ webContents: window.webContents }),
        appOrigin,
      })

      const result = await handlers[channels.execute]!(window.event, valid)

      expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
      const text = JSON.stringify(result)
      expect(text).not.toContain(REDACTION.host)
      expect(text).not.toContain(REDACTION.secrets[0])
    })

    it('un AdapterError conserva su error normalizado', async () => {
      const normalized = createNormalizedError('busy', 'A query is already running')
      const executor: QueryExecutor = {
        execute: () => {
          throw new AdapterError(normalized)
        },
        cancel: vi.fn(),
        ack: vi.fn(),
        cancelSession: vi.fn(),
      }
      const window = fakeWebContents()
      const handlers = createQueryHandlers({
        queryExecutor: executor,
        getMainWindow: () => ({ webContents: window.webContents }),
        appOrigin,
      })

      await expect(handlers[channels.execute]!(window.event, valid)).resolves.toEqual({
        ok: false,
        error: normalized,
      })
    })

    it('los eventos de error enviados al renderer no contienen host, usuario ni password', async () => {
      const leaky = createNormalizedError(
        'syntax_error',
        `bad input on ${REDACTION.host} as ${REDACTION.user} pw ${REDACTION.secrets[0]}`,
      )
      const adapter = createStreamingAdapter({ chunks: 1, failWith: leaky })
      const runtime = createSessionRuntime(adapter)
      const executor = createQueryExecutor({ getSessionRuntime: () => runtime })
      const window = fakeWebContents()
      const handlers = createQueryHandlers({
        queryExecutor: executor,
        getMainWindow: () => ({ webContents: window.webContents }),
        appOrigin,
      })

      await handlers[channels.execute]!(window.event, valid)
      await until(() => window.sent.some(({ payload }) => payload.type === 'error'))

      const text = JSON.stringify(window.sent)
      for (const secret of [REDACTION.host, REDACTION.user, REDACTION.secrets[0]!]) {
        expect(text).not.toContain(secret)
      }
    })
  })

  it('recargar la página del solicitante cancela su ejecución', async () => {
    const adapter = createStreamingAdapter({ chunks: 50 })
    const runtime = createSessionRuntime(adapter)
    const executor = createQueryExecutor({ getSessionRuntime: () => runtime })
    const window = fakeWebContents()
    const handlers = createQueryHandlers({
      queryExecutor: executor,
      getMainWindow: () => ({ webContents: window.webContents }),
      appOrigin,
    })

    await handlers[channels.execute]!(window.event, valid)
    await until(() => window.sent.length === 4)
    window.emitter.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await until(() => adapter.open === 0)

    expect(adapter.cancelled).toEqual(['r1'])
    expect(window.emitter.listenerCount('destroyed')).toBe(0)
  })
})
