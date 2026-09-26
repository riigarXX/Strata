import { describe, expect, it } from 'vitest'
import { ERROR_CODES, NormalizedErrorSchema } from '@strata/contracts'
import type { ResolvedConnectionProfile } from './adapter'
import {
  AdapterError,
  createNormalizedError,
  normalizeUnknownError,
  redactionContextFromProfile,
  redactSensitive,
} from './normalization'

const postgresProfile: ResolvedConnectionProfile = {
  id: 'p1',
  name: 'Prod',
  readOnly: false,
  engine: 'postgres',
  host: 'db.internal.example.com',
  port: 5432,
  user: 'strata_admin',
  database: 'app',
  ssl: 'require',
  password: 'p@ss:w0rd!',
}

const context = redactionContextFromProfile(postgresProfile)

describe('redactionContextFromProfile', () => {
  it('collects host, user and password from a postgres profile', () => {
    expect(context).toEqual({
      host: 'db.internal.example.com',
      user: 'strata_admin',
      secrets: ['p@ss:w0rd!'],
    })
  })

  it('collects the file path from a sqlite profile', () => {
    expect(
      redactionContextFromProfile({
        id: 's1',
        name: 'Local',
        readOnly: true,
        engine: 'sqlite',
        filePath: '/Users/alice/data/app.db',
      }),
    ).toEqual({ filePath: '/Users/alice/data/app.db' })
  })
})

describe('redactSensitive', () => {
  it('redacts host, user and password appearing in a driver message', () => {
    const message = redactSensitive(
      'password authentication failed for user "strata_admin" at db.internal.example.com (p@ss:w0rd!)',
      context,
    )

    expect(message).not.toContain('strata_admin')
    expect(message).not.toContain('db.internal.example.com')
    expect(message).not.toContain('p@ss:w0rd!')
    expect(message).toContain('password authentication failed')
  })

  it('redacts connection strings, including their credentials', () => {
    const message = redactSensitive(
      'invalid connection postgresql://bob:hunter2@10.0.0.5:5432/app?sslmode=require failed',
    )

    expect(message).not.toMatch(/bob|hunter2|10\.0\.0\.5|postgresql:\/\//)
    expect(message).toContain('failed')
  })

  it('redacts libpq style key=value pairs', () => {
    const message = redactSensitive(
      "bad conninfo host=secret.host user=carol password='a b c' dbname=app",
    )

    expect(message).not.toMatch(/secret\.host|carol|a b c/)
    expect(message).toContain('dbname=app')
  })

  it('redacts resolved IP addresses that differ from the profile host', () => {
    expect(redactSensitive('connect ECONNREFUSED 192.168.1.20:5432')).not.toContain('192.168.1.20')
    expect(redactSensitive('connect ECONNREFUSED ::1:5432')).not.toContain('::1')
    expect(redactSensitive('connect ECONNREFUSED [fe80::1]:5432')).not.toContain('fe80')
  })

  it('redacts a secret that starts or ends with punctuation', () => {
    const message = redactSensitive('bad value !s3cret? given', { secrets: ['!s3cret?'] })

    expect(message).not.toContain('s3cret')
  })

  it('redacts the sqlite file path', () => {
    const message = redactSensitive('unable to open /Users/alice/data/app.db', {
      filePath: '/Users/alice/data/app.db',
    })

    expect(message).not.toContain('alice')
  })

  it('does not mangle unrelated words that contain a short user name', () => {
    const message = redactSensitive('database "app" does not exist for role db', { user: 'db' })

    expect(message).toContain('database "app"')
    expect(message).not.toMatch(/role db$/)
  })

  it('leaves messages without sensitive data untouched', () => {
    expect(redactSensitive('relation "users" does not exist')).toBe(
      'relation "users" does not exist',
    )
  })
})

describe('createNormalizedError', () => {
  it('builds an error that satisfies the contract schema with redacted text', () => {
    const error = createNormalizedError(
      'authentication_failed',
      'FATAL: password authentication failed for user "strata_admin"',
      { context },
    )

    expect(NormalizedErrorSchema.parse(error)).toEqual(error)
    expect(error.code).toBe('authentication_failed')
    expect(JSON.stringify(error)).not.toContain('strata_admin')
  })

  it('marks connection failures, timeouts and busy as retryable by default only', () => {
    expect(createNormalizedError('connection_failed', 'x').retryable).toBe(true)
    expect(createNormalizedError('timeout', 'x').retryable).toBe(true)
    expect(createNormalizedError('busy', 'x').retryable).toBe(true)
    expect(createNormalizedError('constraint_violation', 'x').retryable).toBe(false)
    expect(createNormalizedError('not_found', 'x').retryable).toBe(false)
    expect(createNormalizedError('syntax_error', 'x').retryable).toBe(false)
    expect(createNormalizedError('syntax_error', 'x', { retryable: true }).retryable).toBe(true)
  })

  it('falls back to a generic message when the message is blank', () => {
    const error = createNormalizedError('connection_failed', '   ')

    expect(error.message).toBe('Could not connect to the database')
    expect(NormalizedErrorSchema.safeParse(error).success).toBe(true)
  })

  it('gives every error code a default message and marks an aborted transaction as not retryable', () => {
    for (const code of ERROR_CODES) {
      const error = createNormalizedError(code, '   ')
      expect(error.message.length).toBeGreaterThan(0)
      expect(NormalizedErrorSchema.safeParse(error).success).toBe(true)
    }
    expect(createNormalizedError('transaction_aborted', 'x').retryable).toBe(false)
  })

  it('truncates messages to the contract limit', () => {
    const error = createNormalizedError('syntax_error', 'x'.repeat(2000))

    expect(error.message).toHaveLength(500)
    expect(NormalizedErrorSchema.safeParse(error).success).toBe(true)
  })
})

describe('normalizeUnknownError', () => {
  it('maps any unknown reason to a safe internal error without echoing it', () => {
    const reason = new Error('connect to postgres://bob:hunter2@10.0.0.5/app failed')

    const error = normalizeUnknownError(reason)

    expect(error).toEqual({
      code: 'internal_error',
      message: 'An unexpected internal error occurred',
      retryable: false,
    })
    expect(NormalizedErrorSchema.safeParse(error).success).toBe(true)
  })

  it.each([undefined, null, 42, 'boom', { message: 'host=secret' }])(
    'handles non-Error reason %j',
    (reason) => {
      expect(normalizeUnknownError(reason).code).toBe('internal_error')
    },
  )

  it('returns the normalized error carried by an AdapterError', () => {
    const normalized = createNormalizedError('timeout', 'Query timed out')

    expect(normalizeUnknownError(new AdapterError(normalized))).toBe(normalized)
  })
})

describe('AdapterError', () => {
  it('exposes the normalized message and no cause', () => {
    const error = new AdapterError(createNormalizedError('no_session', 'Session closed'))

    expect(error.message).toBe('Session closed')
    expect(error.cause).toBeUndefined()
  })
})
