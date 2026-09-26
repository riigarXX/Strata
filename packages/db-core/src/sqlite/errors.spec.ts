import { describe, expect, it } from 'vitest'
import { AdapterError } from '../normalization'
import { toAdapterError } from './errors'

function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('toAdapterError', () => {
  const context = { filePath: '/private/data/secret.db' }

  it.each([
    ['SQLITE_ERROR', 'near "selec": syntax error', 'syntax_error'],
    ['SQLITE_ERROR', 'incomplete input', 'syntax_error'],
    ['SQLITE_ERROR', 'no such table: nope', 'not_found'],
    ['SQLITE_ERROR', 'no such view: nope', 'not_found'],
    ['SQLITE_ERROR', 'unknown database other', 'not_found'],
    ['SQLITE_ERROR', 'no such column: nope', 'validation_failed'],
    ['SQLITE_READONLY', 'attempt to write a readonly database', 'read_only_violation'],
    ['SQLITE_READONLY_DBMOVED', 'moved', 'read_only_violation'],
    ['SQLITE_CANTOPEN', 'unable to open database file', 'connection_failed'],
    ['SQLITE_NOTADB', 'file is not a database', 'connection_failed'],
    ['SQLITE_PERM', 'access permission denied', 'permission_denied'],
    ['SQLITE_AUTH', 'not authorized', 'permission_denied'],
    ['SQLITE_BUSY', 'database is locked', 'busy'],
    ['SQLITE_BUSY_SNAPSHOT', 'busy', 'busy'],
    ['SQLITE_LOCKED', 'table is locked', 'busy'],
    ['SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: u.n', 'constraint_violation'],
    ['SQLITE_CONSTRAINT', 'FOREIGN KEY constraint failed', 'constraint_violation'],
    ['SQLITE_MISMATCH', 'datatype mismatch', 'validation_failed'],
    ['SQLITE_INTERRUPT', 'interrupted', 'cancelled'],
    ['SQLITE_CORRUPT', 'database disk image is malformed', 'internal_error'],
    ['SQLITE_IOERR_READ', 'disk I/O error', 'internal_error'],
    ['SQLITE_WHATEVER', 'unmapped', 'internal_error'],
  ])('maps %s (%s) to %s', (code, message, expected) => {
    expect(toAdapterError(sqliteError(code, message), context).normalized.code).toBe(expected)
  })

  it('marks busy and locked as retryable', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_LOCKED']) {
      expect(toAdapterError(sqliteError(code, 'x'), context).normalized).toMatchObject({
        code: 'busy',
        retryable: true,
      })
    }
  })

  it('does not mark a constraint violation as retryable and keeps its diagnostic', () => {
    expect(
      toAdapterError(
        sqliteError('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: u.n'),
        context,
      ).normalized,
    ).toEqual({
      code: 'constraint_violation',
      message: 'UNIQUE constraint failed: u.n',
      retryable: false,
    })
  })

  it('redacts the profile path from messages taken from the driver', () => {
    const error = toAdapterError(
      sqliteError('SQLITE_ERROR', 'cannot attach /private/data/secret.db: no such table'),
      context,
    )
    expect(error.normalized.message).not.toContain('/private/data/secret.db')
  })

  it('never surfaces the message of an error that is not a SQLite result code', () => {
    const error = toAdapterError(new Error('leaked /private/data/secret.db'), context)
    expect(error.normalized).toEqual({
      code: 'internal_error',
      message: 'An unexpected internal error occurred',
      retryable: false,
    })
    expect(toAdapterError(new TypeError('x'), context, 'connection_failed').normalized.code).toBe(
      'connection_failed',
    )
  })

  it('passes an AdapterError through untouched', () => {
    const original = new AdapterError({ code: 'no_session', message: 'x', retryable: false })
    expect(toAdapterError(original, context)).toBe(original)
  })
})
