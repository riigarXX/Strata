import { describe, expect, it } from 'vitest'
import { AdapterError, REDACTED } from '../normalization'
import { isCancellation, isServerStatementTimeout, sqlState, toAdapterError } from './errors'

function serverError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' })
}

function nodeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const context = {
  host: 'db.internal.example',
  user: 'alice',
  database: 'payroll',
  secrets: ['s3cret-pass'],
}

describe('toAdapterError', () => {
  it.each([
    ['28P01', 'password authentication failed for user "alice"', 'authentication_failed'],
    [
      '28000',
      'no pg_hba.conf entry for host "10.1.2.3", user "alice", database "payroll"',
      'authentication_failed',
    ],
    ['3D000', 'database "payroll" does not exist', 'connection_failed'],
    ['08006', 'connection failure', 'connection_failed'],
    ['08001', 'unable to connect', 'connection_failed'],
    ['57P01', 'terminating connection due to administrator command', 'connection_failed'],
    ['57P03', 'the database system is starting up', 'connection_failed'],
    ['53300', 'sorry, too many clients already', 'connection_failed'],
    ['25P03', 'terminating connection due to idle-in-transaction timeout', 'connection_failed'],
    ['42601', 'syntax error at or near "SELEC"', 'syntax_error'],
    ['42501', 'permission denied for table people', 'permission_denied'],
    ['25006', 'cannot execute INSERT in a read-only transaction', 'read_only_violation'],
    ['57014', 'canceling statement due to user request', 'cancelled'],
    ['57014', 'canceling statement due to statement timeout', 'timeout'],
    ['55P03', 'could not obtain lock on row', 'busy'],
    ['40P01', 'deadlock detected', 'busy'],
    ['40001', 'could not serialize access', 'busy'],
    [
      '23505',
      'duplicate key value violates unique constraint "people_name_key"',
      'constraint_violation',
    ],
    ['23503', 'insert or update violates foreign key constraint "fk"', 'constraint_violation'],
    ['23502', 'null value in column "x" violates not-null constraint', 'constraint_violation'],
    ['23514', 'new row violates check constraint "c"', 'constraint_violation'],
    ['42P01', 'relation "nope" does not exist', 'not_found'],
    ['42703', 'column "x" does not exist', 'validation_failed'],
    ['3F000', 'schema "nope" does not exist', 'not_found'],
    ['22012', 'division by zero', 'validation_failed'],
    [
      '25P02',
      'current transaction is aborted, commands ignored until end of transaction block',
      'validation_failed',
    ],
    ['P0001', 'raised by the user', 'validation_failed'],
    [
      '08P01',
      'bind message supplies 0 parameters, but prepared statement "" requires 1',
      'validation_failed',
    ],
    ['53100', 'could not extend file', 'internal_error'],
    ['53200', 'out of memory', 'internal_error'],
    ['XX000', 'internal error', 'internal_error'],
    ['ZZ999', 'never heard of it', 'internal_error'],
  ])('maps SQLSTATE %s (%s) to %s', (code, message, expected) => {
    expect(toAdapterError(serverError(code, message), context).normalized.code).toBe(expected)
  })

  it.each([
    ['ECONNREFUSED', 'connect ECONNREFUSED 10.1.2.3:5432'],
    ['ETIMEDOUT', 'connect ETIMEDOUT 10.1.2.3:5432'],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND db.internal.example'],
    ['EAI_AGAIN', 'getaddrinfo EAI_AGAIN db.internal.example'],
    ['EHOSTUNREACH', 'connect EHOSTUNREACH 10.1.2.3:5432'],
    ['ECONNRESET', 'read ECONNRESET'],
    ['EPIPE', 'write EPIPE'],
  ])('maps the network error %s to connection_failed', (code, message) => {
    expect(toAdapterError(nodeError(code, message), context).normalized.code).toBe(
      'connection_failed',
    )
  })

  it('marks contention as retryable busy and constraint violations as not retryable', () => {
    for (const state of ['55P03', '40P01', '40001']) {
      expect(toAdapterError(serverError(state, 'x'), context).normalized).toMatchObject({
        code: 'busy',
        retryable: true,
      })
    }
    expect(toAdapterError(serverError('23505', 'x'), context).normalized).toMatchObject({
      code: 'constraint_violation',
      retryable: false,
    })
  })

  it('marks transient connection failures as retryable', () => {
    expect(toAdapterError(nodeError('ECONNREFUSED', 'x'), context).normalized.retryable).toBe(true)
    expect(toAdapterError(nodeError('ENOTFOUND', 'x'), context).normalized.retryable).toBe(false)
    expect(toAdapterError(serverError('28P01', 'x'), context).normalized.retryable).toBe(false)
  })

  it.each([
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'],
    ['CERT_HAS_EXPIRED', 'certificate has expired'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate'],
    [
      'ERR_TLS_CERT_ALTNAME_INVALID',
      "Hostname/IP does not match certificate's altnames: db.internal.example",
    ],
  ])('maps the TLS failure %s to connection_failed with a fixed message', (code, message) => {
    const { normalized } = toAdapterError(nodeError(code, message), context)
    expect(normalized).toMatchObject({
      code: 'connection_failed',
      message: 'The TLS certificate of the database server could not be verified',
    })
  })

  it.each([
    ['Connection terminated unexpectedly', 'connection_failed'],
    ['Connection terminated due to connection timeout', 'connection_failed'],
    ['timeout expired', 'connection_failed'],
    ['The server does not support SSL connections', 'connection_failed'],
    ['Client has encountered a connection error and is not queryable', 'connection_failed'],
    ['SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string', 'authentication_failed'],
  ])('maps the driver failure "%s" to %s', (message, expected) => {
    expect(toAdapterError(new Error(message), context).normalized.code).toBe(expected)
  })

  it('never reads a message from an unrecognized error', () => {
    const { normalized } = toAdapterError(new Error('password=s3cret-pass user=alice'), context)
    expect(normalized).toEqual({
      code: 'internal_error',
      message: 'An unexpected internal error occurred',
      retryable: false,
    })
    expect(toAdapterError('a string', context).normalized.code).toBe('internal_error')
    expect(toAdapterError(undefined, context).normalized.code).toBe('internal_error')
  })

  it('uses the fallback code for unrecognized errors when asked to', () => {
    expect(toAdapterError(new Error('???'), context, 'connection_failed').normalized).toMatchObject(
      {
        code: 'connection_failed',
        message: 'Could not connect to the database',
      },
    )
  })

  it('returns an AdapterError untouched', () => {
    const original = toAdapterError(serverError('28P01', 'x'), context)
    expect(toAdapterError(original, context)).toBe(original)
    expect(original).toBeInstanceOf(AdapterError)
  })

  describe('redaction', () => {
    const everything = [context.host, context.user, context.database, context.secrets[0] ?? '']

    it.each([
      ['28P01', 'password authentication failed for user "alice"'],
      [
        '28000',
        'no pg_hba.conf entry for host "10.1.2.3", user "alice", database "payroll", SSL off',
      ],
      ['3D000', 'database "payroll" does not exist'],
      ['08006', 'could not connect to server at db.internal.example port 5432'],
      ['57P01', 'terminating connection for user alice'],
    ])('never lets connection data through a fixed message (%s)', (code, message) => {
      const text = JSON.stringify(toAdapterError(serverError(code, message), context).normalized)
      for (const secret of [...everything, '10.1.2.3']) {
        expect(text).not.toContain(secret)
      }
    })

    it('never lets connection data through network or TLS errors', () => {
      const messages = [
        nodeError('ECONNREFUSED', 'connect ECONNREFUSED db.internal.example:5432'),
        nodeError('ENOTFOUND', 'getaddrinfo ENOTFOUND db.internal.example'),
        nodeError('ERR_TLS_CERT_ALTNAME_INVALID', 'Host: db.internal.example. is not in the cert'),
      ]
      for (const error of messages) {
        expect(JSON.stringify(toAdapterError(error, context).normalized)).not.toContain(
          'db.internal.example',
        )
      }
    })

    it('redacts host, user, address, password and quoted database from messages it keeps', () => {
      const error = serverError(
        '42501',
        'permission denied for database "payroll": user alice at db.internal.example (10.1.2.3) password=s3cret-pass',
      )
      const { message } = toAdapterError(error, context).normalized
      for (const secret of [...everything, '10.1.2.3']) {
        expect(message).not.toContain(secret)
      }
      expect(message).toContain(REDACTED)
      expect(message).toContain('permission denied')
    })

    it('keeps the user-facing diagnostic of syntax and constraint errors', () => {
      expect(
        toAdapterError(serverError('42601', 'syntax error at or near "SELEC"'), context).normalized
          .message,
      ).toBe('syntax error at or near "SELEC"')
      expect(
        toAdapterError(
          serverError('23505', 'duplicate key value violates unique constraint "people_name_key"'),
          context,
        ).normalized.message,
      ).toContain('people_name_key')
    })

    it('keeps messages within the contract limit', () => {
      const { message } = toAdapterError(serverError('42601', 'x'.repeat(2000)), context).normalized
      expect(message.length).toBeLessThanOrEqual(500)
    })
  })
})

describe('SQLSTATE helpers', () => {
  it('only takes five-character codes that are not Node system errors as SQLSTATE', () => {
    expect(sqlState(serverError('42601', ''))).toBe('42601')
    expect(sqlState(serverError('P0001', ''))).toBe('P0001')
    expect(sqlState(nodeError('EPIPE', ''))).toBeUndefined()
    expect(sqlState(nodeError('ECONNREFUSED', ''))).toBeUndefined()
    expect(sqlState(new Error('no code'))).toBeUndefined()
    expect(sqlState(null)).toBeUndefined()
  })

  it('tells a cancel request from the server statement_timeout by message', () => {
    const cancelled = serverError('57014', 'canceling statement due to user request')
    const timedOut = serverError('57014', 'canceling statement due to statement timeout')
    expect(isCancellation(cancelled)).toBe(true)
    expect(isCancellation(timedOut)).toBe(true)
    expect(isServerStatementTimeout(cancelled)).toBe(false)
    expect(isServerStatementTimeout(timedOut)).toBe(true)
    expect(isCancellation(serverError('42601', ''))).toBe(false)
  })
})
