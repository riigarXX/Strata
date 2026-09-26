import { describe, expect, it } from 'vitest'
import {
  ConnectionProfileInputSchema,
  ConnectionProfileSchema,
  ConnectionProfileUpdateSchema,
  PickSqliteFileResultSchema,
  SessionSchema,
  TestConnectionRequestSchema,
  TestConnectionResultSchema,
} from './connections'

const pgInput = {
  engine: 'postgres',
  name: 'Local PG',
  readOnly: false,
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  database: 'app',
  ssl: 'require',
} as const

const sqliteInput = {
  engine: 'sqlite',
  name: 'Local file',
  readOnly: true,
  filePath: '/Users/me/data.db',
} as const

describe('ConnectionProfileSchema (public)', () => {
  it('accepts valid profiles for each engine', () => {
    expect(ConnectionProfileSchema.parse({ id: 'p1', ...pgInput, secretRef: 'ref-1' }).engine).toBe(
      'postgres',
    )
    expect(ConnectionProfileSchema.parse({ id: 'p2', ...sqliteInput }).engine).toBe('sqlite')
  })

  it('accepts a postgres profile without a secret reference', () => {
    expect(ConnectionProfileSchema.safeParse({ id: 'p1', ...pgInput }).success).toBe(true)
  })

  it('does not accept a password or any secret-like key', () => {
    for (const key of ['password', 'secret', 'connectionString']) {
      expect(
        ConnectionProfileSchema.safeParse({ id: 'p1', ...pgInput, [key]: 'hunter2' }).success,
      ).toBe(false)
    }
    expect(
      ConnectionProfileSchema.safeParse({ id: 'p2', ...sqliteInput, password: 'x' }).success,
    ).toBe(false)
  })

  it('has no password field in any engine variant', () => {
    for (const option of ConnectionProfileSchema.options) {
      expect(Object.keys(option.shape)).not.toContain('password')
    }
  })

  it('rejects an unknown engine and a missing id', () => {
    expect(
      ConnectionProfileSchema.safeParse({ id: 'p1', ...pgInput, engine: 'mysql' }).success,
    ).toBe(false)
    expect(ConnectionProfileSchema.safeParse(pgInput).success).toBe(false)
  })
})

describe('ConnectionProfileInputSchema (renderer -> main)', () => {
  it('accepts valid inputs, with and without password', () => {
    expect(ConnectionProfileInputSchema.safeParse(pgInput).success).toBe(true)
    expect(ConnectionProfileInputSchema.safeParse({ ...pgInput, password: 's3cret' }).success).toBe(
      true,
    )
    expect(ConnectionProfileInputSchema.safeParse(sqliteInput).success).toBe(true)
  })

  it('rejects invalid postgres parameters', () => {
    const invalid = [
      { port: 0 },
      { port: 70000 },
      { port: 54.5 },
      { host: '' },
      { host: 'db.example.com/../x' },
      { host: 'db@evil' },
      { host: 'db?sslmode=disable' },
      { user: '' },
      { database: '' },
      { ssl: 'maybe' },
      { name: '   ' },
      { readOnly: 'yes' },
      { password: '' },
    ]
    for (const patch of invalid) {
      expect(ConnectionProfileInputSchema.safeParse({ ...pgInput, ...patch }).success).toBe(false)
    }
  })

  it('rejects invalid sqlite parameters', () => {
    for (const filePath of ['', 'relative.db', '/tmp/a\0b.db']) {
      expect(ConnectionProfileInputSchema.safeParse({ ...sqliteInput, filePath }).success).toBe(
        false,
      )
    }
  })

  it('rejects fields of the other engine', () => {
    expect(
      ConnectionProfileInputSchema.safeParse({ ...sqliteInput, host: 'localhost' }).success,
    ).toBe(false)
    expect(ConnectionProfileInputSchema.safeParse({ ...pgInput, filePath: '/a.db' }).success).toBe(
      false,
    )
    expect(ConnectionProfileInputSchema.safeParse({ ...sqliteInput, password: 'x' }).success).toBe(
      false,
    )
  })

  it('rejects unknown keys, including client-supplied id and secretRef', () => {
    expect(ConnectionProfileInputSchema.safeParse({ ...pgInput, extra: 1 }).success).toBe(false)
    expect(ConnectionProfileInputSchema.safeParse({ ...pgInput, id: 'p1' }).success).toBe(false)
    expect(ConnectionProfileInputSchema.safeParse({ ...pgInput, secretRef: 'r' }).success).toBe(
      false,
    )
  })
})

describe('ConnectionProfileUpdateSchema', () => {
  it('requires an id and rejects unknown keys', () => {
    expect(ConnectionProfileUpdateSchema.safeParse({ id: 'p1', ...pgInput }).success).toBe(true)
    expect(ConnectionProfileUpdateSchema.safeParse(pgInput).success).toBe(false)
    expect(
      ConnectionProfileUpdateSchema.safeParse({ id: 'p1', ...pgInput, extra: 1 }).success,
    ).toBe(false)
  })
})

describe('TestConnectionRequestSchema', () => {
  it('accepts an unsaved profile and a saved one', () => {
    expect(TestConnectionRequestSchema.safeParse(pgInput).success).toBe(true)
    expect(TestConnectionRequestSchema.safeParse({ id: 'p1', ...pgInput }).success).toBe(true)
    expect(TestConnectionRequestSchema.safeParse({ ...pgInput, extra: 1 }).success).toBe(false)
  })
})

describe('TestConnectionResultSchema', () => {
  it('parses success and failure variants', () => {
    expect(
      TestConnectionResultSchema.safeParse({ ok: true, serverVersion: '16.2', latencyMs: 12 })
        .success,
    ).toBe(true)
    expect(
      TestConnectionResultSchema.safeParse({
        ok: false,
        error: {
          code: 'unsupported_version',
          message: 'PostgreSQL 13+ required',
          retryable: false,
        },
      }).success,
    ).toBe(true)
  })

  it('rejects a failure carrying connection details', () => {
    expect(
      TestConnectionResultSchema.safeParse({
        ok: false,
        error: { code: 'connection_failed', message: 'x', retryable: true, host: 'db.internal' },
      }).success,
    ).toBe(false)
  })
})

describe('SessionSchema', () => {
  const session = {
    sessionId: 's1',
    profileId: 'p1',
    engine: 'postgres',
    serverVersion: '16.2',
    readOnly: false,
    transaction: 'none',
  }

  it('accepts every transaction state and rejects others', () => {
    expect(SessionSchema.safeParse(session).success).toBe(true)
    expect(SessionSchema.safeParse({ ...session, transaction: 'active' }).success).toBe(true)
    expect(SessionSchema.safeParse({ ...session, transaction: 'aborted' }).success).toBe(true)
    expect(SessionSchema.safeParse({ ...session, transaction: 'pending' }).success).toBe(false)
  })
})

describe('PickSqliteFileResultSchema', () => {
  it('accepts an absolute path or null when the dialog was cancelled', () => {
    expect(PickSqliteFileResultSchema.safeParse({ filePath: '/Users/me/data.db' }).success).toBe(
      true,
    )
    expect(PickSqliteFileResultSchema.safeParse({ filePath: null }).success).toBe(true)
  })

  it('rejects relative paths, missing keys and unknown keys', () => {
    expect(PickSqliteFileResultSchema.safeParse({ filePath: 'data.db' }).success).toBe(false)
    expect(PickSqliteFileResultSchema.safeParse({}).success).toBe(false)
    expect(
      PickSqliteFileResultSchema.safeParse({ filePath: '/Users/me/data.db', extra: 1 }).success,
    ).toBe(false)
  })
})
