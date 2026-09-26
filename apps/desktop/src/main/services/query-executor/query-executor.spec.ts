// @vitest-environment node
import type { ChunkAck, QueryRequest, Session } from '@strata/contracts'
import { AdapterError, AdapterRegistry, createNormalizedError } from '@strata/db-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createApprovedSqlitePaths,
  createConnectionManager,
  createProfileStore,
} from '../connection-manager'
import { createFakeCredentialStore, createMemoryFileSystem } from '../connection-manager/testing'
import { createQueryExecutor, type QueryExecutor } from './query-executor'
import {
  createFakeSink,
  createSessionRuntime,
  createStreamingAdapter,
  REDACTION,
  until,
  type StreamingAdapterOptions,
} from './testing'

const request = (overrides: Partial<QueryRequest> = {}): QueryRequest => ({
  requestId: 'req-1',
  sessionId: 'session-1',
  sql: 'SELECT n FROM t',
  ...overrides,
})

function setup(
  adapterOptions: StreamingAdapterOptions = {},
  session: Partial<Session> = {},
  executorOptions: { ackTimeoutMs?: number; cancelGraceMs?: number } = {},
) {
  const adapter = createStreamingAdapter(adapterOptions)
  const runtime = createSessionRuntime(adapter, session)
  const executor: QueryExecutor = createQueryExecutor({
    getSessionRuntime: (id) => (id === runtime.session.sessionId ? runtime : undefined),
    ...executorOptions,
  })
  const owner = {}
  const sink = createFakeSink(owner)
  const ack = (event: { statementIndex: number; chunkIndex: number }, requestId = 'req-1') =>
    executor.ack(
      { requestId, statementIndex: event.statementIndex, chunkIndex: event.chunkIndex },
      owner,
    )
  const ackAllReceived = (): number => {
    let acked = 0
    for (const chunk of sink.ofType('chunk')) {
      ack(chunk)
      acked++
    }
    return acked
  }
  const terminal = () =>
    sink.events.filter((e) => e.type === 'done' || e.type === 'error' || e.type === 'cancelled')
  return { adapter, runtime, executor, owner, sink, ack, ackAllReceived, terminal }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('QueryExecutor: ejecución', () => {
  it('reenvía todos los eventos al solicitante, con un único evento terminal', async () => {
    const { executor, sink, adapter, ack, terminal } = setup({ chunks: 3 })

    executor.execute(request({ chunkSize: 2 }), sink)
    // Con ventana suficiente no hace falta confirmar para terminar.
    await until(() => terminal().length > 0)

    expect(sink.events.map((e) => e.type)).toEqual([
      'chunk',
      'chunk',
      'chunk',
      'statement_done',
      'done',
    ])
    expect(sink.ofType('chunk')[0]?.rows).toHaveLength(2)
    expect(terminal()).toHaveLength(1)
    expect(adapter.open).toBe(0)
    for (const chunk of sink.ofType('chunk')) ack(chunk)
  })

  it('responde de inmediato: nada se emite antes de que termine el turno actual', () => {
    const { executor, sink } = setup()
    executor.execute(request(), sink)
    expect(sink.events).toEqual([])
  })

  it('deja la sesión libre para otra ejecución en cuanto llega el evento terminal', async () => {
    const { executor, sink, terminal } = setup({ chunks: 1 })
    executor.execute(request(), sink)
    await until(() => terminal().length > 0)

    const second = createFakeSink(sink.owner)
    expect(() => executor.execute(request({ requestId: 'req-2' }), second)).not.toThrow()
    await until(() => second.events.some((e) => e.type === 'done'))
  })

  it('pasa al adapter los límites recortados a los topes, no lo que pide el renderer', async () => {
    const { executor, sink, adapter, terminal } = setup({ chunks: 1 })
    executor.execute(
      request({ maxRows: 10_000_000, timeoutMs: 3_600_000, chunkSize: 10_000 }),
      sink,
    )
    await until(() => terminal().length > 0)

    expect(adapter.executed[0]).toMatchObject({
      maxRows: 100_000,
      timeoutMs: 300_000,
      chunkSize: 1_000,
    })
  })

  it('aplica los valores por defecto cuando no se piden límites', async () => {
    const { executor, sink, adapter, terminal } = setup({ chunks: 1 })
    executor.execute(request(), sink)
    await until(() => terminal().length > 0)

    expect(adapter.executed[0]).toMatchObject({
      maxRows: 10_000,
      timeoutMs: 30_000,
      chunkSize: 500,
    })
  })

  it('el estado de transacción de done es el que reporta el adapter', async () => {
    const { executor, sink, terminal } = setup({ chunks: 1, transaction: 'active' })
    executor.execute(request(), sink)
    await until(() => terminal().length > 0)
    expect(sink.ofType('done')[0]?.transaction).toBe('active')
  })
})

describe('QueryExecutor: rechazos previos al arranque', () => {
  it('no_session si la sesión no existe o se cerró', () => {
    const { executor, sink } = setup()
    expect(() => executor.execute(request({ sessionId: 'other' }), sink)).toThrow(
      expect.objectContaining({ normalized: expect.objectContaining({ code: 'no_session' }) }),
    )
  })

  it('busy si ya hay una ejecución en curso en la sesión, sin emitir eventos ni tocar el adapter', async () => {
    const { executor, sink, adapter } = setup({ chunks: 10 })
    executor.execute(request(), sink)

    const second = createFakeSink()
    let error: unknown
    try {
      executor.execute(request({ requestId: 'req-2' }), second)
    } catch (reason) {
      error = reason
    }
    expect(error).toBeInstanceOf(AdapterError)
    expect((error as AdapterError).normalized).toMatchObject({ code: 'busy', retryable: true })
    await until(() => sink.events.length >= 4)
    expect(second.events).toEqual([])
    expect(adapter.executed.map((r) => r.requestId)).toEqual(['req-1'])
  })

  it('rechaza reutilizar el id de una petición en curso', async () => {
    const { executor, sink } = setup({ chunks: 10 })
    executor.execute(request(), sink)
    expect(() => executor.execute(request({ sessionId: 'session-1' }), createFakeSink())).toThrow()
    await until(() => sink.events.length > 0)
  })
})

describe('QueryExecutor: backpressure', () => {
  it('no consume del adapter más allá de la ventana de 4 chunks sin confirmar', async () => {
    const { executor, sink, adapter } = setup({ chunks: 20 })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)
    // Margen para que un consumo indebido tuviera tiempo de ocurrir.
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve))

    expect(adapter.pulled).toBe(4)
    expect(sink.ofType('chunk')).toHaveLength(4)
  })

  it('cada ack repone exactamente un crédito y la ejecución avanza hasta terminar', async () => {
    const { executor, sink, adapter, ack, terminal } = setup({ chunks: 12 })
    executor.execute(request(), sink)

    let acked = 0
    while (terminal().length === 0) {
      await until(() => sink.ofType('chunk').length > acked || terminal().length > 0)
      // Nunca hay más de 4 chunks sin confirmar.
      expect(sink.ofType('chunk').length - acked).toBeLessThanOrEqual(4)
      expect(adapter.pulled - acked).toBeLessThanOrEqual(4)
      const next = sink.ofType('chunk')[acked]
      if (next) {
        ack(next)
        acked++
      }
    }
    expect(sink.ofType('chunk')).toHaveLength(12)
    expect(sink.ofType('done')).toHaveLength(1)
  })

  it('confirmar dos veces el mismo chunk, uno inexistente o de otra petición no amplía la ventana', async () => {
    const { executor, sink, adapter, ack } = setup({ chunks: 20 })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)

    const first = sink.ofType('chunk')[0]!
    ack(first)
    await until(() => sink.ofType('chunk').length === 5)
    for (let i = 0; i < 5; i++) ack(first)
    ack({ statementIndex: 0, chunkIndex: 999 })
    ack({ statementIndex: 7, chunkIndex: 0 })
    ack(first, 'other-request')
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve))

    expect(adapter.pulled).toBe(5)
  })

  it('un ack de otro solicitante se ignora', async () => {
    const { executor, sink, adapter } = setup({ chunks: 20 })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)

    const intruder: ChunkAck = { requestId: 'req-1', statementIndex: 0, chunkIndex: 0 }
    executor.ack(intruder, {})
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve))

    expect(adapter.pulled).toBe(4)
  })

  it('cancela y libera recursos si el renderer deja de confirmar', async () => {
    vi.useFakeTimers()
    const { executor, sink, adapter } = setup(
      { chunks: 50, transaction: 'active' },
      {},
      {
        ackTimeoutMs: 10_000,
      },
    )
    executor.execute(request(), sink)
    await vi.advanceTimersByTimeAsync(1)
    expect(sink.ofType('chunk')).toHaveLength(4)

    await vi.advanceTimersByTimeAsync(9_000)
    expect(adapter.cancelled).toEqual([])
    await vi.advanceTimersByTimeAsync(1_500)

    expect(adapter.cancelled).toEqual(['req-1'])
    expect(adapter.pulled).toBe(4)
    expect(adapter.open).toBe(0)
    const [event] = sink.ofType('error')
    expect(event).toMatchObject({
      requestId: 'req-1',
      error: { code: 'timeout', retryable: false },
      transaction: 'active',
    })
    expect(sink.ofType('cancelled')).toEqual([])
    // Y la sesión queda libre.
    expect(() => executor.execute(request({ requestId: 'req-2' }), createFakeSink())).not.toThrow()
  })

  it('un ack a tiempo reinicia el plazo', async () => {
    vi.useFakeTimers()
    const { executor, sink, adapter, ack } = setup({ chunks: 8 }, {}, { ackTimeoutMs: 10_000 })
    executor.execute(request(), sink)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(8_000)
    ack(sink.ofType('chunk')[0]!)
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(8_000)

    expect(adapter.cancelled).toEqual([])
  })
})

describe('QueryExecutor: cancelación', () => {
  it('cancela a mitad, emite cancelled con el estado de transacción y libera al adapter', async () => {
    const { executor, sink, adapter, owner, terminal } = setup({
      chunks: 50,
      transaction: 'active',
    })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)

    await expect(executor.cancel('req-1', owner)).resolves.toEqual({
      requestId: 'req-1',
      outcome: 'requested',
    })
    await until(() => terminal().length > 0)

    expect(sink.ofType('cancelled')).toEqual([
      { type: 'cancelled', requestId: 'req-1', statementIndex: 0, transaction: 'active' },
    ])
    expect(sink.ofType('chunk')).toHaveLength(4)
    expect(adapter.cancelled).toEqual(['req-1'])
    expect(adapter.open).toBe(0)
  })

  it('cancela una lectura en vuelo (cancelación inmediata del motor)', async () => {
    const { executor, sink, adapter, owner, terminal } = setup({
      chunks: 5,
      hangAfterChunk: 1,
      transaction: 'aborted',
    })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 1)

    await executor.cancel('req-1', owner)
    await until(() => terminal().length > 0)

    expect(sink.ofType('cancelled')[0]).toMatchObject({ transaction: 'aborted' })
    expect(adapter.open).toBe(0)
  })

  it('cancelar antes de que arranque el adapter emite cancelled sin ejecutar nada', async () => {
    const { executor, sink, adapter, owner, terminal } = setup()
    executor.execute(request(), sink)
    await executor.cancel('req-1', owner)
    await until(() => terminal().length > 0)

    expect(adapter.executed).toEqual([])
    expect(sink.events.map((e) => e.type)).toEqual(['cancelled'])
  })

  it('cancelar una petición inexistente o de otro solicitante es idempotente', async () => {
    const { executor, sink, owner, terminal } = setup({ chunks: 50 })
    await expect(executor.cancel('nope', owner)).resolves.toEqual({
      requestId: 'nope',
      outcome: 'not_running',
    })

    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)
    await expect(executor.cancel('req-1', {})).resolves.toMatchObject({ outcome: 'not_running' })
    expect(sink.ofType('cancelled')).toEqual([])

    await executor.cancel('req-1', owner)
    await executor.cancel('req-1', owner)
    await until(() => terminal().length > 0)
    await expect(executor.cancel('req-1', owner)).resolves.toMatchObject({ outcome: 'not_running' })
    expect(terminal()).toHaveLength(1)
  })

  it('tras cancelar solo se envía el evento terminal', async () => {
    const { executor, sink, owner, terminal } = setup({ chunks: 50 })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)
    await executor.cancel('req-1', owner)
    await until(() => terminal().length > 0)

    expect(sink.events.slice(4).map((e) => e.type)).toEqual(['cancelled'])
  })

  it('tras cancelar sí se envían los avisos del adapter, antes del evento terminal', async () => {
    const { executor, sink, owner, terminal } = setup({
      chunks: 50,
      noticeBeforeCancelled: 'The transaction was rolled back',
    })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)
    await executor.cancel('req-1', owner)
    await until(() => terminal().length > 0)

    expect(sink.events.slice(4).map((e) => e.type)).toEqual(['notice', 'cancelled'])
  })
})

describe('QueryExecutor: solicitante que desaparece', () => {
  it('cancela, cierra el iterable y no envía nada al cerrarse el webContents', async () => {
    const { executor, sink, adapter } = setup({ chunks: 50 })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)

    sink.disappear()
    await until(() => adapter.open === 0)

    expect(adapter.cancelled).toEqual(['req-1'])
    expect(sink.events.map((e) => e.type)).toEqual(['chunk', 'chunk', 'chunk', 'chunk'])
    expect(sink.goneListeners).toBe(0)
    const fresh = createFakeSink()
    expect(() => executor.execute(request({ requestId: 'req-2' }), fresh)).not.toThrow()
  })

  it('si desaparece con una lectura en vuelo también libera la sesión', async () => {
    const { executor, sink, adapter } = setup({ chunks: 5, hangAfterChunk: 0 })
    executor.execute(request(), sink)
    await until(() => adapter.open === 1)

    sink.disappear()
    await until(() => adapter.open === 0)
    expect(adapter.cancelled).toEqual(['req-1'])
  })

  it('un sink que deja de estar vivo entre eventos cancela sin lanzar', async () => {
    const { executor, sink, adapter } = setup({ chunks: 50 })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)
    sink.alive = false
    executor.ack({ requestId: 'req-1', statementIndex: 0, chunkIndex: 0 }, sink.owner)
    await until(() => adapter.open === 0)
    expect(adapter.cancelled).toEqual(['req-1'])
  })
})

describe('QueryExecutor: errores del motor', () => {
  it('añade el estado de transacción al error y redacta host, usuario y password', async () => {
    const leaky = createNormalizedError(
      'syntax_error',
      `syntax error near ${REDACTION.host} for ${REDACTION.user} using ${REDACTION.secrets[0]}`,
    )
    const { executor, sink, terminal } = setup({
      chunks: 1,
      failWith: { ...leaky },
      transaction: 'aborted',
    })
    executor.execute(request(), sink)
    await until(() => terminal().length > 0)

    const [event] = sink.ofType('error')
    expect(event?.transaction).toBe('aborted')
    const serialized = JSON.stringify(sink.events)
    for (const secret of [REDACTION.host, REDACTION.user, REDACTION.secrets[0]!]) {
      expect(serialized).not.toContain(secret)
    }
    expect(event?.error.code).toBe('syntax_error')
  })

  it('un iterable que lanza produce un error normalizado sin filtrar el mensaje del fallo', async () => {
    const { executor, sink, adapter, terminal } = setup({ chunks: 3, throwAtRead: 1 })
    executor.execute(request(), sink)
    await until(() => terminal().length > 0)

    const [event] = sink.ofType('error')
    expect(event?.error).toMatchObject({ code: 'internal_error' })
    expect(JSON.stringify(sink.events)).not.toContain('secret-host')
    expect(adapter.open).toBe(0)
  })

  it('un iterable que termina sin evento terminal produce un error interno', async () => {
    const { executor, sink, terminal } = setup({ chunks: 1, endWithoutTerminal: true })
    executor.execute(request(), sink)
    await until(() => terminal().length > 0)
    expect(sink.ofType('error')[0]?.error.code).toBe('internal_error')
  })

  it('omite el estado de transacción si el adapter ya no conoce la sesión', async () => {
    const { executor, sink, adapter, terminal } = setup({ chunks: 1 })
    adapter.transactionState = () => {
      throw new AdapterError(createNormalizedError('no_session', 'gone'))
    }
    adapter.execute = async function* (req) {
      yield { type: 'error', requestId: req.requestId, error: createNormalizedError('busy', 'x') }
    }
    executor.execute(request(), sink)
    await until(() => terminal().length > 0)
    expect(sink.ofType('error')[0]).not.toHaveProperty('transaction')
  })
})

describe('QueryExecutor: cancelSession', () => {
  it('cancela la ejecución de la sesión y espera a que termine', async () => {
    const { executor, sink, adapter } = setup({ chunks: 50 })
    executor.execute(request(), sink)
    await until(() => sink.ofType('chunk').length === 4)

    await executor.cancelSession('session-1')

    expect(adapter.open).toBe(0)
    expect(sink.ofType('cancelled')).toHaveLength(1)
  })

  it('sin ejecución en curso no hace nada', async () => {
    const { executor } = setup()
    await expect(executor.cancelSession('session-1')).resolves.toBeUndefined()
  })

  it('no espera indefinidamente a un adapter que no responde a la cancelación', async () => {
    vi.useFakeTimers()
    const { executor, sink, adapter } = setup(
      { chunks: 5, hangAfterChunk: 0 },
      {},
      {
        cancelGraceMs: 2_000,
      },
    )
    adapter.cancel = async (requestId) => ({ requestId, outcome: 'requested' })
    executor.execute(request(), sink)
    await vi.advanceTimersByTimeAsync(1)

    const done = vi.fn()
    void executor.cancelSession('session-1').then(done)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(done).toHaveBeenCalled()
  })

  it('con el ConnectionManager real, desconectar y cerrar todo cancelan la ejecución antes de cerrar la sesión', async () => {
    const adapter = createStreamingAdapter({ chunks: 50, transaction: 'active' })
    const disconnectedWhileOpen: number[] = []
    adapter.connect = async (profile) => ({
      sessionId: 'session-1',
      profileId: profile.id,
      engine: 'sqlite',
      serverVersion: '3.46.0',
      readOnly: false,
      transaction: 'none',
    })
    adapter.disconnect = async () => {
      disconnectedWhileOpen.push(adapter.open)
    }
    const registry = new AdapterRegistry()
    registry.register(adapter)
    const approved = createApprovedSqlitePaths()
    approved.approve('/tmp/disconnect.db')
    approved.approve('/tmp/closeAll.db')
    const memory = createMemoryFileSystem()
    const manager = createConnectionManager({
      profileStore: createProfileStore({
        fileSystem: memory.fileSystem,
        filePath: '/ud/connections.json',
      }),
      credentialStore: createFakeCredentialStore().store,
      adapters: registry,
      approvedSqlitePaths: approved,
      beforeSessionClose: (id) => executor.cancelSession(id),
    })
    const executor = createQueryExecutor({
      getSessionRuntime: (id) => manager.getSessionRuntime(id),
    })

    for (const close of ['disconnect', 'closeAll'] as const) {
      const profile = await manager.createProfile({
        engine: 'sqlite',
        name: close,
        readOnly: false,
        filePath: `/tmp/${close}.db`,
      })
      const session = await manager.connect({ profileId: profile.id })
      const sink = createFakeSink()
      executor.execute(request({ requestId: `req-${close}`, sessionId: session.sessionId }), sink)
      await until(() => sink.ofType('chunk').length === 4)

      if (close === 'disconnect') await manager.disconnect({ sessionId: session.sessionId })
      else await manager.closeAll()

      expect(sink.ofType('cancelled')).toHaveLength(1)
      expect(adapter.open).toBe(0)
      expect(manager.getSessionRuntime(session.sessionId)).toBeUndefined()
    }
    // El adapter solo se desconecta cuando la ejecución ya estaba cerrada.
    expect(disconnectedWhileOpen).toEqual([0, 0])
  })
})

describe('QueryExecutor: read-only aplicado en main', () => {
  const READ_ONLY = { readOnly: true }

  it('rechaza las escrituras antes de llegar al adapter, con read_only_violation y sin citar el SQL', () => {
    const { executor, sink, adapter } = setup({}, READ_ONLY)
    const sql = "INSERT INTO users(password) VALUES ('hunter2-secret')"

    let error: unknown
    try {
      executor.execute(request({ sql }), sink)
    } catch (reason) {
      error = reason
    }

    expect(error).toBeInstanceOf(AdapterError)
    const { normalized } = error as AdapterError
    expect(normalized.code).toBe('read_only_violation')
    expect(JSON.stringify(normalized)).not.toContain('hunter2')
    expect(JSON.stringify(normalized)).not.toContain('users')
    expect(adapter.executed).toEqual([])
    expect(sink.events).toEqual([])
  })

  const BLOCKED: Record<string, string[]> = {
    sqlite: [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1',
      'DELETE FROM t',
      'DROP TABLE t',
      'CREATE TABLE x (a)',
      'REPLACE INTO t VALUES (1)',
      'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
      'SELECT 1; INSERT INTO t VALUES (1)',
      "SELECT 'a;b'; DELETE FROM t",
      '/* SELECT */ DELETE FROM t',
      'PRAGMA journal_mode = wal',
      'PRAGMA query_only = 0',
      'PRAGMA writable_schema = 1',
      "ATTACH DATABASE '/tmp/x.db' AS x",
      'BEGIN IMMEDIATE',
      'VACUUM',
      'FROBNICATE',
    ],
    postgres: [
      'INSERT INTO t VALUES (1)',
      'WITH i AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM i',
      'SELECT * INTO copy FROM t',
      "COPY t FROM '/tmp/x'",
      'EXPLAIN ANALYZE DELETE FROM t',
      'SET default_transaction_read_only = off',
      'RESET ALL',
      'SET TRANSACTION READ WRITE',
      'BEGIN READ WRITE',
      "SELECT set_config('default_transaction_read_only', 'off', false)",
      'ALTER SYSTEM SET x = 1',
      'DO $$ BEGIN DELETE FROM t; END $$',
      'SELECT 1; SET default_transaction_read_only = off; INSERT INTO t VALUES (1)',
      'SELECT * FROM t FOR UPDATE',
      "SELECT nextval('s')",
      'TRUNCATE t',
    ],
  }

  for (const [engine, statements] of Object.entries(BLOCKED)) {
    it.each(statements)(`${engine}: bloquea %s`, (sql) => {
      const { executor, sink, adapter } = setup({}, { ...READ_ONLY, engine: engine as 'sqlite' })
      expect(() => executor.execute(request({ sql }), sink)).toThrow(
        expect.objectContaining({
          normalized: expect.objectContaining({ code: 'read_only_violation' }),
        }),
      )
      expect(adapter.executed).toEqual([])
    })
  }

  const ALLOWED: Record<string, string[]> = {
    sqlite: [
      'SELECT * FROM t',
      "SELECT 'INSERT INTO t' AS s -- DROP TABLE t",
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT * FROM n',
      'EXPLAIN QUERY PLAN SELECT * FROM t',
      'PRAGMA table_info(t)',
      "SELECT replace(a, 'x', 'y') FROM t",
      'BEGIN; SELECT 1; ROLLBACK',
      '/* c */ select 1;',
    ],
    postgres: [
      'SELECT * FROM t',
      'SELECT $$DROP TABLE t; INSERT$$',
      'EXPLAIN SELECT * FROM t',
      'EXPLAIN (ANALYZE) SELECT * FROM t',
      'SHOW default_transaction_read_only',
      'BEGIN READ ONLY; SELECT 1; COMMIT',
      'SELECT pg_sleep(0.1)',
      "SELECT 'x', E'it\\'s; DELETE'",
    ],
  }

  for (const [engine, statements] of Object.entries(ALLOWED)) {
    it.each(statements)(`${engine}: permite %s`, async (sql) => {
      const { executor, sink, terminal } = setup(
        { chunks: 1 },
        { ...READ_ONLY, engine: engine as 'sqlite' },
      )
      executor.execute(request({ sql }), sink)
      await until(() => terminal().length > 0)
      expect(sink.ofType('done')).toHaveLength(1)
    })
  }

  it('sin read-only las escrituras llegan al adapter', async () => {
    const { executor, sink, adapter, terminal } = setup({ chunks: 1 })
    executor.execute(request({ sql: 'DELETE FROM t' }), sink)
    await until(() => terminal().length > 0)
    expect(adapter.executed).toHaveLength(1)
  })

  it('el read-only lo decide la sesión: la petición no puede desactivarlo', () => {
    const { executor, sink } = setup({}, READ_ONLY)
    const forged = { ...request({ sql: 'DELETE FROM t' }), readOnly: false } as QueryRequest
    expect(() => executor.execute(forged, sink)).toThrow()
  })
})

describe('QueryExecutor: ejecución de pura lectura pedida por la petición', () => {
  const pure = (sql: string) => request({ sql, enforceReadOnly: true })

  it.each([
    'INSERT INTO t VALUES (1)',
    'DELETE FROM t',
    'SELECT 1; DROP TABLE t',
    'BEGIN',
    'SELECT 1; COMMIT',
    'PRAGMA journal_mode = wal',
  ])('sqlite: rechaza %s aunque el perfil no sea de solo lectura', (sql) => {
    const { executor, sink, adapter } = setup()
    expect(() => executor.execute(pure(sql), sink)).toThrow(
      expect.objectContaining({
        normalized: expect.objectContaining({ code: 'read_only_violation' }),
      }),
    )
    expect(adapter.executed).toEqual([])
    expect(sink.events).toEqual([])
  })

  it.each([
    "SELECT nextval('s')",
    "SELECT set_config('default_transaction_read_only', 'off', false)",
    'SELECT pg_terminate_backend(1)',
    'SELECT * FROM t FOR UPDATE',
    'BEGIN READ ONLY; SELECT 1; COMMIT',
    'ROLLBACK',
    'SET search_path = public',
  ])('postgres: rechaza %s', (sql) => {
    const { executor, sink, adapter } = setup({}, { engine: 'postgres' })
    expect(() => executor.execute(pure(sql), sink)).toThrow(
      expect.objectContaining({
        normalized: expect.objectContaining({ code: 'read_only_violation' }),
      }),
    )
    expect(adapter.executed).toEqual([])
  })

  it.each([
    ['sqlite', 'SELECT * FROM t'],
    ['sqlite', 'WITH a AS (SELECT 1) SELECT * FROM a'],
    ['sqlite', 'EXPLAIN QUERY PLAN SELECT * FROM t'],
    ['sqlite', 'PRAGMA table_info(t)'],
    ['postgres', 'SELECT * FROM t'],
    ['postgres', 'EXPLAIN SELECT * FROM t'],
    ['postgres', 'SHOW server_version'],
  ] as const)('%s: deja pasar %s y llega al adapter con la marca', async (engine, sql) => {
    const { executor, sink, adapter, terminal } = setup({ chunks: 1 }, { engine })
    executor.execute(pure(sql), sink)
    await until(() => terminal().length > 0)
    expect(adapter.executed).toHaveLength(1)
    expect(adapter.executed[0]?.enforceReadOnly).toBe(true)
  })

  it('sin la marca, una escritura sigue llegando al adapter (la marca solo restringe)', async () => {
    const { executor, sink, adapter, terminal } = setup({ chunks: 1 })
    executor.execute(request({ sql: 'DELETE FROM t' }), sink)
    await until(() => terminal().length > 0)
    expect(adapter.executed).toHaveLength(1)
  })
})
