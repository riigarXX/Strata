// @vitest-environment node
import { IPC_CHANNELS } from '@strata/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createDbApi } from './db-api'

const noSubscribe = () => () => {}

const EXPECTED_METHODS = [
  'connect',
  'create',
  'delete',
  'disconnect',
  'list',
  'pickSqliteFile',
  'test',
  'update',
]

const EXPECTED_METADATA_METHODS = ['describeTable', 'listSchemas', 'listTables']
const EXPECTED_QUERY_METHODS = ['ack', 'cancel', 'execute', 'onEvent']
const EXPECTED_TRANSACTION_METHODS = ['begin', 'commit', 'rollback']
const EXPECTED_PREFERENCES_METHODS = ['get', 'update']
const EXPECTED_HISTORY_METHODS = ['clear', 'delete', 'list', 'onChange']
const EXPECTED_AI_METHODS = [
  'cancel',
  'generateSql',
  'listModels',
  'onPullProgress',
  'pullModel',
  'status',
]

describe('createDbApi', () => {
  it('expone exactamente `ai`, `connections`, `history`, `metadata`, `preferences`, `query` y `transactions` con los métodos concretos previstos', () => {
    const api = createDbApi(vi.fn(), noSubscribe)

    expect(Object.keys(api).sort()).toEqual([
      'ai',
      'connections',
      'history',
      'metadata',
      'preferences',
      'query',
      'transactions',
    ])
    expect(Object.keys(api.preferences).sort()).toEqual(EXPECTED_PREFERENCES_METHODS)
    expect(Object.keys(api.history).sort()).toEqual(EXPECTED_HISTORY_METHODS)
    expect(Object.keys(api.ai).sort()).toEqual(EXPECTED_AI_METHODS)
    expect(Object.keys(api.connections).sort()).toEqual(EXPECTED_METHODS)
    expect(Object.keys(api.metadata).sort()).toEqual(EXPECTED_METADATA_METHODS)
    expect(Object.keys(api.query).sort()).toEqual(EXPECTED_QUERY_METHODS)
    expect(Object.keys(api.transactions).sort()).toEqual(EXPECTED_TRANSACTION_METHODS)
    for (const group of [
      api.connections,
      api.metadata,
      api.query,
      api.transactions,
      api.preferences,
      api.history,
      api.ai,
    ]) {
      for (const method of Object.values(group)) expect(method).toBeTypeOf('function')
    }
  })

  it('no expone ipcRenderer, invoke ni send en ningún nivel', () => {
    const api = createDbApi(vi.fn(), noSubscribe)
    const serialized = JSON.stringify([
      Object.keys(api),
      Object.keys(api.connections),
      Object.keys(api.metadata),
      Object.keys(api.query),
      Object.keys(api.transactions),
      Object.keys(api.preferences),
      Object.keys(api.history),
      Object.keys(api.ai),
    ])

    for (const forbidden of ['ipcRenderer', 'invoke', 'send', 'on']) {
      expect(serialized).not.toContain(`"${forbidden}"`)
    }
    expect(api).not.toHaveProperty('ipcRenderer')
  })

  it('cada método usa su canal del catálogo de contracts y pasa el payload tal cual', async () => {
    const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>(async () => ({
      ok: true,
      data: null,
    }))
    const { connections } = createDbApi(invoke, noSubscribe)
    const payload = { profileId: 'p1' }

    await connections.list()
    await connections.create({ engine: 'sqlite', name: 'n', readOnly: false, filePath: '/a.db' })
    await connections.update({
      id: 'p1',
      engine: 'sqlite',
      name: 'n',
      readOnly: false,
      filePath: '/a.db',
    })
    await connections.delete(payload)
    await connections.test({ engine: 'sqlite', name: 'n', readOnly: false, filePath: '/a.db' })
    await connections.connect(payload)
    await connections.disconnect({ sessionId: 's1' })
    await connections.pickSqliteFile()

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      IPC_CHANNELS.connections.list,
      IPC_CHANNELS.connections.create,
      IPC_CHANNELS.connections.update,
      IPC_CHANNELS.connections.delete,
      IPC_CHANNELS.connections.test,
      IPC_CHANNELS.connections.connect,
      IPC_CHANNELS.connections.disconnect,
      IPC_CHANNELS.connections.pickSqliteFile,
    ])
    expect(invoke.mock.calls[3]).toEqual([IPC_CHANNELS.connections.delete, payload])
  })

  it('cada método de metadata usa su canal del catálogo y pasa el payload tal cual', async () => {
    const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>(async () => ({
      ok: true,
      data: [],
    }))
    const { metadata } = createDbApi(invoke, noSubscribe)
    const table = { schema: 'public', name: 'users' }

    await metadata.listSchemas({ sessionId: 's1' })
    await metadata.listTables({ sessionId: 's1', schema: 'public' })
    await metadata.describeTable({ sessionId: 's1', table })

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.metadata.schemas, { sessionId: 's1' }],
      [IPC_CHANNELS.metadata.tables, { sessionId: 's1', schema: 'public' }],
      [IPC_CHANNELS.metadata.describe, { sessionId: 's1', table }],
    ])
  })

  it('query y transactions usan sus canales del catálogo y pasan el payload tal cual', async () => {
    const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>(async () => ({
      ok: true,
      data: undefined,
    }))
    const { query, transactions } = createDbApi(invoke, noSubscribe)
    const request = { requestId: 'r1', sessionId: 's1', sql: 'SELECT 1' }
    const ack = { requestId: 'r1', statementIndex: 0, chunkIndex: 2 }

    await query.execute(request)
    await query.cancel({ requestId: 'r1' })
    await query.ack(ack)
    await transactions.begin({ sessionId: 's1' })
    await transactions.commit({ sessionId: 's1' })
    await transactions.rollback({ sessionId: 's1' })

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.query.execute, request],
      [IPC_CHANNELS.query.cancel, { requestId: 'r1' }],
      [IPC_CHANNELS.query.ack, ack],
      [IPC_CHANNELS.transaction.begin, { sessionId: 's1' }],
      [IPC_CHANNELS.transaction.commit, { sessionId: 's1' }],
      [IPC_CHANNELS.transaction.rollback, { sessionId: 's1' }],
    ])
  })

  it('preferences e history usan sus canales del catálogo y pasan el payload tal cual', async () => {
    const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>(async () => ({
      ok: true,
      data: null,
    }))
    const { preferences, history } = createDbApi(invoke, noSubscribe)
    const patch = { history: { retentionDays: 90 as const } }
    const list = { search: 'select', limit: 10 }

    await preferences.get()
    await preferences.update(patch)
    await history.list(list)
    await history.delete({ id: 'h1' })
    await history.clear()

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.preferences.get, undefined],
      [IPC_CHANNELS.preferences.update, patch],
      [IPC_CHANNELS.history.list, list],
      [IPC_CHANNELS.history.delete, { id: 'h1' }],
      [IPC_CHANNELS.history.clear, undefined],
    ])
  })

  it('ai usa sus canales del catálogo y pasa el payload tal cual', async () => {
    const invoke = vi.fn<(channel: string, payload?: unknown) => Promise<unknown>>(async () => ({
      ok: true,
      data: null,
    }))
    const { ai } = createDbApi(invoke, noSubscribe)
    const generate = { requestId: 'r1', sessionId: 's1', question: 'How many users?' }
    const pull = { requestId: 'r2', model: 'qwen3:14b' }

    await ai.status()
    await ai.listModels({})
    await ai.generateSql(generate)
    await ai.pullModel(pull)
    await ai.cancel({ requestId: 'r1' })

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.ai.status, undefined],
      [IPC_CHANNELS.ai.listModels, {}],
      [IPC_CHANNELS.ai.generateSql, generate],
      [IPC_CHANNELS.ai.pullModel, pull],
      [IPC_CHANNELS.ai.cancel, { requestId: 'r1' }],
    ])
  })

  describe('onEvent', () => {
    function setup() {
      const listeners = new Map<string, Set<(payload: unknown) => void>>()
      const subscribe = vi.fn((channel: string, listener: (payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set()
        listeners.set(channel, set)
        set.add(listener)
        return () => {
          set.delete(listener)
        }
      })
      const emit = (channel: string, payload: unknown) =>
        listeners.get(channel)?.forEach((listener) => listener(payload))
      return { api: createDbApi(vi.fn(), subscribe), subscribe, emit, listeners }
    }

    it('escucha solo el canal de eventos y entrega el payload, nunca el evento crudo de Electron', () => {
      const { api, subscribe, emit } = setup()
      const callback = vi.fn()

      api.query.onEvent(callback)
      const event = { type: 'done', requestId: 'r1' }
      emit(IPC_CHANNELS.query.event, event)

      expect(subscribe.mock.calls.map(([channel]) => channel)).toEqual([IPC_CHANNELS.query.event])
      expect(callback).toHaveBeenCalledExactlyOnceWith(event)
    })

    it('history.onChange escucha solo el canal de cambios del historial y entrega el payload tal cual', () => {
      const { api, subscribe, emit } = setup()
      const callback = vi.fn()

      api.history.onChange(callback)
      const change = { type: 'removed', id: 'h1' }
      emit(IPC_CHANNELS.history.changed, change)
      emit(IPC_CHANNELS.query.event, { type: 'done' })

      expect(subscribe.mock.calls.map(([channel]) => channel)).toEqual([
        IPC_CHANNELS.history.changed,
      ])
      expect(callback).toHaveBeenCalledExactlyOnceWith(change)
    })

    it('history.onChange devuelve su propia desuscripción', () => {
      const { api, emit } = setup()
      const first = vi.fn()
      const second = vi.fn()

      const unsubscribeFirst = api.history.onChange(first)
      api.history.onChange(second)
      unsubscribeFirst()
      emit(IPC_CHANNELS.history.changed, { type: 'cleared' })

      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledOnce()
    })

    it('ai.onPullProgress escucha solo el canal de avance y devuelve su propia desuscripción', () => {
      const { api, subscribe, emit } = setup()
      const first = vi.fn()
      const second = vi.fn()

      const unsubscribeFirst = api.ai.onPullProgress(first)
      api.ai.onPullProgress(second)
      const progress = {
        requestId: 'r1',
        model: 'qwen3:14b',
        status: 'pulling',
        completed: 1,
        total: 2,
      }
      emit(IPC_CHANNELS.ai.pullProgress, progress)
      emit(IPC_CHANNELS.history.changed, { type: 'cleared' })
      unsubscribeFirst()
      emit(IPC_CHANNELS.ai.pullProgress, progress)

      expect([...new Set(subscribe.mock.calls.map(([channel]) => channel))]).toEqual([
        IPC_CHANNELS.ai.pullProgress,
      ])
      expect(first).toHaveBeenCalledExactlyOnceWith(progress)
      expect(second).toHaveBeenCalledTimes(2)
    })

    it('cada listener devuelve su propia desuscripción', () => {
      const { api, emit } = setup()
      const first = vi.fn()
      const second = vi.fn()

      const unsubscribeFirst = api.query.onEvent(first)
      api.query.onEvent(second)
      unsubscribeFirst()
      emit(IPC_CHANNELS.query.event, { type: 'done' })

      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledOnce()
    })
  })
})
