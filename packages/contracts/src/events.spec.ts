import { describe, expect, it } from 'vitest'
import { IPC_CHANNEL_LIST, IPC_CHANNELS, QueryEventSchema, isIpcChannel } from './events'

const error = { code: 'syntax_error', message: 'Syntax error near "selec"', retryable: false }

const events = {
  chunk: {
    type: 'chunk',
    requestId: 'r1',
    statementIndex: 0,
    chunkIndex: 0,
    columns: [{ name: 'id', dataType: 'int4', kind: 'number' }],
    rows: [[1], [null], ['x'], [true]],
  },
  notice: {
    type: 'notice',
    requestId: 'r1',
    statementIndex: 1,
    level: 'warning',
    message: 'table does not exist, skipping',
  },
  statement_done: {
    type: 'statement_done',
    requestId: 'r1',
    statementIndex: 0,
    command: 'SELECT',
    rowsReturned: 4,
    rowsAffected: null,
    durationMs: 3.2,
    truncated: false,
  },
  done: {
    type: 'done',
    requestId: 'r1',
    statementCount: 2,
    durationMs: 10,
    transaction: 'none',
  },
  error: { type: 'error', requestId: 'r1', statementIndex: 1, error },
  cancelled: { type: 'cancelled', requestId: 'r1', statementIndex: 0 },
} as const

describe('QueryEventSchema', () => {
  for (const [type, event] of Object.entries(events)) {
    it(`parses the ${type} variant`, () => {
      expect(QueryEventSchema.parse(event)).toEqual(event)
    })
  }

  it('covers every variant of the union', () => {
    expect(Object.keys(events).sort()).toEqual(
      QueryEventSchema.options.map((option) => option.shape.type.value).sort(),
    )
  })

  it('accepts error and cancelled without a statement index', () => {
    expect(QueryEventSchema.safeParse({ type: 'error', requestId: 'r1', error }).success).toBe(true)
    expect(QueryEventSchema.safeParse({ type: 'cancelled', requestId: 'r1' }).success).toBe(true)
  })

  it('rejects an unknown variant', () => {
    expect(QueryEventSchema.safeParse({ type: 'progress', requestId: 'r1' }).success).toBe(false)
    expect(QueryEventSchema.safeParse({ requestId: 'r1' }).success).toBe(false)
  })

  it('rejects malformed payloads of known variants', () => {
    expect(QueryEventSchema.safeParse({ ...events.chunk, rows: [[{ nested: 1 }]] }).success).toBe(
      false,
    )
    expect(
      QueryEventSchema.safeParse({ ...events.chunk, columns: [{ name: 'id', dataType: 'int4' }] })
        .success,
    ).toBe(false)
    expect(QueryEventSchema.safeParse({ ...events.done, statementCount: -1 }).success).toBe(false)
    expect(QueryEventSchema.safeParse({ ...events.done, extra: 1 }).success).toBe(false)
  })

  it('requires the resulting transaction state on done', () => {
    expect(QueryEventSchema.safeParse({ ...events.done, transaction: undefined }).success).toBe(
      false,
    )
    expect(QueryEventSchema.safeParse({ ...events.done, transaction: 'aborted' }).success).toBe(
      true,
    )
    expect(QueryEventSchema.safeParse({ ...events.done, transaction: 'pending' }).success).toBe(
      false,
    )
  })

  it('carries an optional transaction state on error and cancelled', () => {
    for (const type of ['error', 'cancelled'] as const) {
      for (const transaction of ['none', 'active', 'aborted']) {
        expect(QueryEventSchema.safeParse({ ...events[type], transaction }).success).toBe(true)
      }
      expect(QueryEventSchema.safeParse(events[type]).success).toBe(true)
      expect(QueryEventSchema.safeParse({ ...events[type], transaction: 'pending' }).success).toBe(
        false,
      )
    }
  })

  it('carries an optional list of truncated cells on chunk, without changing rows', () => {
    const truncated = [{ row: 1, column: 0, originalBytes: 5_000_000 }]
    const chunk = { ...events.chunk, truncated }
    expect(QueryEventSchema.parse(chunk)).toEqual(chunk)
    expect(QueryEventSchema.parse({ ...chunk, truncated: [] })).toMatchObject({ truncated: [] })
    expect(QueryEventSchema.parse(events.chunk)).not.toHaveProperty('truncated')
  })

  it('rejects malformed truncated cells', () => {
    const cell = { row: 0, column: 0, originalBytes: 10 }
    for (const truncated of [
      [{ ...cell, row: -1 }],
      [{ ...cell, column: 0.5 }],
      [{ ...cell, originalBytes: 0 }],
      [{ row: 0, column: 0 }],
      [{ ...cell, extra: true }],
      { row: 0, column: 0, originalBytes: 10 },
    ]) {
      expect(QueryEventSchema.safeParse({ ...events.chunk, truncated }).success).toBe(false)
    }
  })

  it('accepts the uuid and array column kinds', () => {
    for (const kind of ['uuid', 'array']) {
      const chunk = { ...events.chunk, columns: [{ name: 'c', dataType: 'x', kind }] }
      expect(QueryEventSchema.safeParse(chunk).success).toBe(true)
    }
  })

  it('rejects an error event whose payload is not a normalized error', () => {
    expect(
      QueryEventSchema.safeParse({
        ...events.error,
        error: { ...error, code: 'driver_specific' },
      }).success,
    ).toBe(false)
    expect(
      QueryEventSchema.safeParse({ ...events.error, error: { ...error, host: 'db.internal' } })
        .success,
    ).toBe(false)
  })
})

describe('IPC channel catalog', () => {
  it('follows the db:<domain>:<action> convention with no duplicates', () => {
    for (const channel of IPC_CHANNEL_LIST) {
      expect(channel).toMatch(/^db:[a-z]+:[a-z]+(-[a-z]+)*$/)
    }
    expect(new Set(IPC_CHANNEL_LIST).size).toBe(IPC_CHANNEL_LIST.length)
  })

  it('keeps the surface from the plan and no bootstrap placeholder', () => {
    expect(IPC_CHANNELS.connections.list).toBe('db:connections:list')
    expect(IPC_CHANNELS.connections.pickSqliteFile).toBe('db:connections:pick-sqlite-file')
    expect(IPC_CHANNEL_LIST).not.toContain('db:app:ping')
    expect(IPC_CHANNELS.query.execute).toBe('db:query:execute')
    expect(IPC_CHANNELS.query.cancel).toBe('db:query:cancel')
    expect(IPC_CHANNELS.query.event).toBe('db:query:event')
    expect(IPC_CHANNELS.preferences).toEqual({
      get: 'db:preferences:get',
      update: 'db:preferences:update',
    })
    expect(IPC_CHANNELS.history).toEqual({
      list: 'db:history:list',
      delete: 'db:history:delete',
      clear: 'db:history:clear',
      changed: 'db:history:changed',
    })
    expect(IPC_CHANNELS.ai).toEqual({
      status: 'db:ai:status',
      listModels: 'db:ai:list-models',
      generateSql: 'db:ai:generate-sql',
      pullModel: 'db:ai:pull-model',
      cancel: 'db:ai:cancel',
      pullProgress: 'db:ai:pull-progress',
    })
  })

  it('recognizes only catalogued channels', () => {
    expect(isIpcChannel('db:query:execute')).toBe(true)
    expect(isIpcChannel('db:invoke')).toBe(false)
    expect(isIpcChannel(42)).toBe(false)
  })
})
