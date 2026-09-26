// @vitest-environment node
import type { HistoryEntry, QueryRequest, Session } from '@strata/contracts'
import { createNormalizedError } from '@strata/db-core'
import { describe, expect, it, vi } from 'vitest'
import { createHistoryRecorder, createHistoryStore } from '../history-store'
import { createMemoryStorage } from '../local-storage/testing'
import {
  createQueryExecutor,
  type QueryExecutor,
  type QueryHistoryRecorder,
} from './query-executor'
import {
  createFakeSink,
  createSessionRuntime,
  createStreamingAdapter,
  REDACTION,
  until,
  type StreamingAdapterOptions,
} from './testing'

const START = Date.parse('2026-09-20T10:00:00.000Z')

const request = (overrides: Partial<QueryRequest> = {}): QueryRequest => ({
  requestId: 'req-1',
  sessionId: 'session-1',
  sql: 'SELECT n FROM t WHERE tag = 1',
  ...overrides,
})

type Recorded = Omit<HistoryEntry, 'id'>

function setup(adapterOptions: StreamingAdapterOptions = {}, session: Partial<Session> = {}) {
  const adapter = createStreamingAdapter(adapterOptions)
  const runtime = createSessionRuntime(adapter, session)
  const recorded: Recorded[] = []
  const contexts: { requestId: string }[] = []
  const recorder: QueryHistoryRecorder = {
    record: (entry, context) => {
      recorded.push(entry)
      contexts.push(context)
    },
  }
  const clock = { time: START }
  const executor: QueryExecutor = createQueryExecutor({
    getSessionRuntime: (id) => (id === runtime.session.sessionId ? runtime : undefined),
    history: recorder,
    now: () => clock.time,
  })
  const owner = {}
  const sink = createFakeSink(owner)
  const terminal = () =>
    sink.events.filter((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')
  return { adapter, runtime, executor, owner, sink, recorded, contexts, clock, terminal }
}

describe('QueryExecutor: registro en el historial', () => {
  it('entrega junto a la entrada la petición que la originó, sin incluirla en la entrada', async () => {
    const { executor, sink, recorded, contexts, terminal } = setup()

    executor.execute(request({ requestId: 'req-42' }), sink)
    await until(() => terminal().length > 0)

    expect(contexts).toEqual([{ requestId: 'req-42' }])
    expect(recorded[0]).not.toHaveProperty('requestId')
  })

  it('registra una entrada por petición con el SQL completo, motor, perfil, duración y estado', async () => {
    const { executor, sink, recorded, terminal } = setup({ chunks: 2 })

    executor.execute(request(), sink)
    await until(() => terminal().length > 0)

    expect(recorded).toEqual([
      {
        sql: 'SELECT n FROM t WHERE tag = 1',
        engine: 'sqlite',
        profileId: 'profile-1',
        profileName: 'Local profile',
        executedAt: '2026-09-20T10:00:00.000Z',
        durationMs: 2,
        status: 'ok',
        rowCount: 2,
      },
    ])
  })

  it('registra el texto tal como se envió, sin recortar ni normalizar', async () => {
    const { executor, sink, recorded, terminal } = setup()
    const sql = `  SELECT 1;\n\n-- comentario\nSELECT '${'x'.repeat(50_000)}'  `

    executor.execute(request({ sql }), sink)
    await until(() => terminal().length > 0)

    expect(recorded[0]?.sql).toBe(sql)
  })

  it('registra el error con su código y sin mensaje', async () => {
    const { executor, sink, recorded, terminal } = setup({
      failWith: createNormalizedError(
        'syntax_error',
        'syntax error near "secret-token-in-message"',
      ),
    })

    executor.execute(request(), sink)
    await until(() => terminal().length > 0)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ status: 'error', errorCode: 'syntax_error' })
    expect(JSON.stringify(recorded)).not.toContain('secret-token-in-message')
  })

  it('registra un fallo del driver como error interno, sin el texto del driver', async () => {
    const { executor, sink, recorded, terminal } = setup({ throwAtRead: 0 })

    executor.execute(request(), sink)
    await until(() => terminal().length > 0)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ status: 'error', errorCode: 'internal_error' })
    expect(JSON.stringify(recorded)).not.toContain('secret-host')
    expect(recorded[0]).not.toHaveProperty('rowCount')
  })

  it('registra una cancelación pedida por el usuario con la duración medida hasta ese momento', async () => {
    const { executor, sink, recorded, owner, clock, terminal } = setup({
      chunks: 5,
      hangAfterChunk: 1,
    })

    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 1)
    clock.time += 1_500
    await executor.cancel('req-1', owner)
    await until(() => terminal().length > 0)

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ status: 'cancelled', durationMs: 1_500 })
    expect(recorded[0]).not.toHaveProperty('errorCode')
  })

  it('cuenta como cancelada la ejecución cuyo solicitante desaparece', async () => {
    const { executor, sink, recorded, adapter } = setup({ chunks: 5, hangAfterChunk: 0 })

    executor.execute(request(), sink)
    await until(() => adapter.open === 1)
    sink.disappear()
    await until(() => recorded.length === 1)

    expect(recorded[0]).toMatchObject({ status: 'cancelled' })
  })

  it('registra la cancelación por desconexión de la sesión', async () => {
    const { executor, sink, recorded, adapter } = setup({ chunks: 5, hangAfterChunk: 0 })

    executor.execute(request(), sink)
    await until(() => adapter.open === 1)
    await executor.cancelSession('session-1')
    await until(() => recorded.length === 1)

    expect(recorded[0]).toMatchObject({ status: 'cancelled' })
  })

  it('registra cada petición por separado, con su propia fecha', async () => {
    const { executor, sink, recorded, clock, terminal } = setup()

    executor.execute(request({ requestId: 'a', sql: 'SELECT 1' }), sink)
    await until(() => terminal().length === 1)
    clock.time += 60_000
    executor.execute(request({ requestId: 'b', sql: 'SELECT 2' }), sink)
    await until(() => terminal().length === 2)

    expect(recorded.map(({ sql, executedAt }) => [sql, executedAt])).toEqual([
      ['SELECT 1', '2026-09-20T10:00:00.000Z'],
      ['SELECT 2', '2026-09-20T10:01:00.000Z'],
    ])
  })

  it('suma filas devueltas o afectadas de las sentencias terminadas', async () => {
    const { executor, sink, recorded, adapter, terminal } = setup({ chunks: 2 })
    const original = adapter.execute.bind(adapter)
    adapter.execute = async function* (req) {
      for await (const event of original(req)) {
        if (event.type === 'statement_done') {
          yield { ...event, statementIndex: 0, rowsReturned: 0, rowsAffected: 7 }
          yield { ...event, statementIndex: 1, rowsReturned: 5, rowsAffected: null }
        } else yield event
      }
    }

    executor.execute(request(), sink)
    await until(() => terminal().length > 0)

    expect(recorded[0]?.rowCount).toBe(12)
  })

  describe('lo que no se registra', () => {
    it('una petición con saveToHistory: false', async () => {
      const { executor, sink, recorded, terminal } = setup()

      executor.execute(request({ saveToHistory: false }), sink)
      await until(() => terminal().length > 0)

      expect(recorded).toEqual([])
    })

    it('una petición con saveToHistory: true o sin el campo sí se registra', async () => {
      const { executor, sink, recorded, terminal } = setup()

      executor.execute(request({ requestId: 'a', saveToHistory: true }), sink)
      await until(() => terminal().length === 1)
      executor.execute(request({ requestId: 'b' }), sink)
      await until(() => terminal().length === 2)

      expect(recorded).toHaveLength(2)
    })

    it('la petición no altera lo que recibe el adapter por llevar saveToHistory', async () => {
      const { executor, sink, adapter, terminal } = setup()

      executor.execute(request({ saveToHistory: false }), sink)
      await until(() => terminal().length > 0)

      expect(adapter.executed[0]?.sql).toBe('SELECT n FROM t WHERE tag = 1')
    })

    it('una petición rechazada antes de arrancar por no haber sesión', () => {
      const { executor, sink, recorded } = setup()

      expect(() => executor.execute(request({ sessionId: 'nope' }), sink)).toThrow()
      expect(recorded).toEqual([])
    })

    it('una petición rechazada por estar la sesión ocupada, y solo se registra la que corre', async () => {
      const { executor, sink, recorded, adapter, owner, terminal } = setup({
        chunks: 5,
        hangAfterChunk: 0,
      })
      executor.execute(request({ requestId: 'first' }), sink)
      await until(() => adapter.open === 1)

      expect(() => executor.execute(request({ requestId: 'second' }), sink)).toThrow(
        /already running/,
      )
      await executor.cancel('first', owner)
      await until(() => terminal().length > 0)

      expect(recorded).toHaveLength(1)
    })

    it('una escritura rechazada por el modo solo lectura', () => {
      const { executor, sink, recorded } = setup({}, { readOnly: true })

      expect(() => executor.execute(request({ sql: 'DELETE FROM t' }), sink)).toThrow()
      expect(recorded).toEqual([])
    })

    it('nada si no se inyectó un recorder', async () => {
      const adapter = createStreamingAdapter()
      const runtime = createSessionRuntime(adapter)
      const executor = createQueryExecutor({ getSessionRuntime: () => runtime })
      const sink = createFakeSink()

      executor.execute(request(), sink)
      await until(() => sink.events.some(({ type }) => type === 'done'))
    })
  })

  describe('un fallo del historial no afecta a la ejecución', () => {
    it('un recorder que lanza de forma síncrona no impide el evento terminal ni la liberación de la sesión', async () => {
      const adapter = createStreamingAdapter()
      const runtime = createSessionRuntime(adapter)
      const executor = createQueryExecutor({
        getSessionRuntime: () => runtime,
        history: {
          record: () => {
            throw new Error('recorder exploded')
          },
        },
      })
      const sink = createFakeSink()

      executor.execute(request({ requestId: 'a' }), sink)
      await until(() => sink.ofType('done').length === 1)
      executor.execute(request({ requestId: 'b' }), sink)
      await until(() => sink.ofType('done').length === 2)

      expect(sink.ofType('error')).toEqual([])
    })

    it('un almacén que falla al escribir no cambia los eventos ni retrasa el terminal', async () => {
      const memory = createMemoryStorage()
      memory.hooks.failWrite = true
      const onError = vi.fn()
      const store = createHistoryStore({
        fileSystem: memory.fileSystem,
        filePath: '/user-data/history.json',
        getRetentionDays: async () => 30,
      })
      const adapter = createStreamingAdapter({ chunks: 2 })
      const runtime = createSessionRuntime(adapter)
      const executor = createQueryExecutor({
        getSessionRuntime: () => runtime,
        history: createHistoryRecorder({ store, isEnabled: async () => true, onError }),
      })
      const sink = createFakeSink()

      executor.execute(request(), sink)
      await until(() => sink.ofType('done').length === 1)
      await until(() => onError.mock.calls.length === 1)

      expect(sink.events.map(({ type }) => type)).toEqual([
        'chunk',
        'chunk',
        'statement_done',
        'done',
      ])
      expect(adapter.open).toBe(0)
    })

    it('un recorder que nunca termina no retrasa el evento terminal', async () => {
      const adapter = createStreamingAdapter()
      const runtime = createSessionRuntime(adapter)
      const recorder: QueryHistoryRecorder = createHistoryRecorder({
        store: { add: () => new Promise<never>(() => undefined) },
        isEnabled: async () => true,
      })
      const executor = createQueryExecutor({ getSessionRuntime: () => runtime, history: recorder })
      const sink = createFakeSink()

      executor.execute(request(), sink)
      await until(() => sink.ofType('done').length === 1)
    })
  })

  describe('privacidad: nunca resultados ni secretos en disco', () => {
    const CELL = 'RESULT-CELL-SENTINEL-7c1e'
    const ROW_TEXT = 'ROW-TEXT-SENTINEL-51ab'

    function setupWithStore(adapterOptions: StreamingAdapterOptions = {}) {
      const memory = createMemoryStorage()
      const store = createHistoryStore({
        fileSystem: memory.fileSystem,
        filePath: '/user-data/history.json',
        getRetentionDays: async () => 30,
      })
      const adapter = createStreamingAdapter({ chunks: 2, ...adapterOptions })
      const original = adapter.execute.bind(adapter)
      adapter.execute = async function* (req) {
        for await (const event of original(req)) {
          if (event.type === 'chunk') {
            yield {
              ...event,
              columns: [{ name: 'secretcolumn', dataType: 'text', kind: 'text' }],
              rows: [[CELL, ROW_TEXT, REDACTION.secrets[0] ?? '']],
            }
          } else yield event
        }
      }
      const runtime = createSessionRuntime(adapter)
      const executor = createQueryExecutor({
        getSessionRuntime: () => runtime,
        history: createHistoryRecorder({ store, isEnabled: async () => true }),
      })
      const sink = createFakeSink()
      return { memory, store, executor, sink }
    }

    it.each([
      ['una consulta correcta', {}],
      [
        'una consulta con error del motor',
        {
          failWith: createNormalizedError(
            'constraint_violation',
            `duplicate key value (${'RESULT-CELL-SENTINEL-7c1e'}) host=${REDACTION.host}`,
          ),
        },
      ],
    ])(
      'el archivo y la respuesta de list no contienen resultados ni secretos en %s',
      async (_name, options) => {
        const { memory, store, executor, sink } = setupWithStore(options)

        executor.execute(request(), sink)
        await until(() => sink.events.some(({ type }) => type === 'done' || type === 'error'))
        await until(() => memory.files.has('/user-data/history.json'))

        const onDisk = [...memory.files.values()].join('\n')
        const listed = JSON.stringify(await store.list({}))
        for (const text of [onDisk, listed]) {
          expect(text).not.toContain(CELL)
          expect(text).not.toContain(ROW_TEXT)
          expect(text).not.toContain('secretcolumn')
          expect(text).not.toContain(REDACTION.secrets[0])
          expect(text).not.toContain(REDACTION.host)
          expect(text).not.toContain(REDACTION.user)
          expect(text).not.toContain('"rows"')
          expect(text).not.toContain('"columns"')
          expect(text).toContain('SELECT n FROM t WHERE tag = 1')
        }
        expect(Object.keys(JSON.parse(onDisk).entries[0]).sort()).toEqual(
          [
            'id',
            'sql',
            'engine',
            'profileId',
            'profileName',
            'executedAt',
            'durationMs',
            'status',
            'rowCount',
            ...(sink.ofType('error').length ? ['errorCode'] : []),
          ].sort(),
        )
      },
    )
  })
})
