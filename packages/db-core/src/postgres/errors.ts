import type { ErrorCode } from '@strata/contracts'
import {
  AdapterError,
  createNormalizedError,
  DEFAULT_ERROR_MESSAGES,
  isAdapterError,
  REDACTED,
  type RedactionContext,
} from '../normalization'

// The database name is not part of the shared RedactionContext; PostgreSQL quotes it in its own messages.
export interface PostgresRedactionContext extends RedactionContext {
  readonly database?: string
}

interface Mapping {
  readonly code: ErrorCode
  // Fixed message: the server's own text often names the user, the database or the client address.
  readonly message: string
  readonly retryable?: boolean
}

const AUTHENTICATION: Mapping = { code: 'authentication_failed', message: 'Authentication failed' }
const CONNECTION_LOST: Mapping = {
  code: 'connection_failed',
  message: 'The connection to the database was lost',
  retryable: true,
}
const CONNECTION_TIMEOUT: Mapping = {
  code: 'connection_failed',
  message: 'Timed out while connecting to the database server',
  retryable: true,
}
const TLS_FAILURE: Mapping = {
  code: 'connection_failed',
  message: 'The TLS certificate of the database server could not be verified',
  retryable: false,
}
// Lock, deadlock and serialization failures are transient contention: the same statement or transaction may succeed if retried.
const BUSY = (message: string): Mapping => ({ code: 'busy', message, retryable: true })

// Exact SQLSTATE codes first; classes (first two characters) are the fallback.
const SQLSTATE_MAPPINGS: Readonly<Record<string, Mapping>> = {
  '28000': AUTHENTICATION,
  '28P01': AUTHENTICATION,
  '3D000': { code: 'connection_failed', message: 'The database does not exist', retryable: false },
  '53300': {
    code: 'connection_failed',
    message: 'The server has too many connections',
    retryable: true,
  },
  '57P01': CONNECTION_LOST,
  '57P02': CONNECTION_LOST,
  '57P03': {
    code: 'connection_failed',
    message: 'The database server is not accepting connections',
    retryable: true,
  },
  '25P03': CONNECTION_LOST,
  '55P03': BUSY('Could not obtain a lock on the resource'),
  '40P01': BUSY('The transaction was aborted because of a deadlock'),
  '40001': BUSY('The transaction could not be serialized; retry it'),
  '53100': { code: 'internal_error', message: 'The database server ran out of disk space' },
  '53200': { code: 'internal_error', message: 'The database server ran out of memory' },
}

// These carry the user's own diagnostic (constraint or relation names, offending type...) and no connection detail, so the message is kept.
const USER_DIAGNOSTIC_CLASSES: ReadonlySet<string> = new Set([
  '22', // data exception
  '25', // invalid transaction state, including 25P02 (aborted transaction)
  '2B',
  '2D',
  '26',
  '27',
  '34',
  '3B',
  '42',
  '44',
  '0A',
  'P0', // errors raised by PL/pgSQL
])

// A missing table or schema: the same notion as describing an unknown table, so both surface as not_found.
const NOT_FOUND_STATES: ReadonlySet<string> = new Set(['42P01', '3F000'])

const NETWORK_ERROR = /^E[A-Z]+$/
const TLS_ERROR =
  /^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL|ERR_OSSL|HOSTNAME_MISMATCH)/
const SQLSTATE = /^[0-9A-Z]{5}$/

const NETWORK_MAPPINGS: Readonly<Record<string, Mapping>> = {
  ECONNREFUSED: {
    code: 'connection_failed',
    message: 'The database server refused the connection',
    retryable: true,
  },
  ENOTFOUND: {
    code: 'connection_failed',
    message: 'The database host could not be resolved',
    retryable: false,
  },
  EAI_AGAIN: {
    code: 'connection_failed',
    message: 'The database host could not be resolved',
    retryable: true,
  },
  ETIMEDOUT: CONNECTION_TIMEOUT,
  EHOSTUNREACH: {
    code: 'connection_failed',
    message: 'The database host is unreachable',
    retryable: true,
  },
  ENETUNREACH: {
    code: 'connection_failed',
    message: 'The database host is unreachable',
    retryable: true,
  },
}

// pg raises some failures itself, without a code.
const DRIVER_MESSAGE_MAPPINGS: readonly (readonly [RegExp, Mapping])[] = [
  [/due to connection timeout|timeout expired/i, CONNECTION_TIMEOUT],
  [
    /does not support SSL/i,
    {
      code: 'connection_failed',
      message: 'The database server does not support SSL connections',
      retryable: false,
    },
  ],
  [/SASL|SCRAM|password must be a string|not support authentication/i, AUTHENTICATION],
  [/connection terminated|not queryable|connection error|socket hang up/i, CONNECTION_LOST],
]

const CANCELLATION_STATE = '57014'
const STATEMENT_TIMEOUT = /statement timeout/i

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const { code } = error
  return typeof code === 'string' ? code : undefined
}

function driverMessage(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

export function sqlState(error: unknown): string | undefined {
  const code = errorCode(error)
  return code !== undefined && SQLSTATE.test(code) && !NETWORK_ERROR.test(code) ? code : undefined
}

// 57014 covers a cancel request and the server's own statement_timeout; the message is the only thing that tells them apart.
export function isServerStatementTimeout(error: unknown): boolean {
  return sqlState(error) === CANCELLATION_STATE && STATEMENT_TIMEOUT.test(driverMessage(error))
}

export function isCancellation(error: unknown): boolean {
  return sqlState(error) === CANCELLATION_STATE
}

function redactDatabase(message: string, database: string | undefined): string {
  return database ? message.split(`"${database}"`).join(`"${REDACTED}"`) : message
}

function build(mapping: Mapping, context: PostgresRedactionContext): AdapterError {
  return new AdapterError(
    createNormalizedError(mapping.code, mapping.message, {
      context,
      retryable: mapping.retryable,
    }),
  )
}

function keepMessage(
  code: ErrorCode,
  error: unknown,
  context: PostgresRedactionContext,
): AdapterError {
  const message = redactDatabase(driverMessage(error), context.database)
  return new AdapterError(createNormalizedError(code, message, { context }))
}

// Never reads a message from an unrecognized error: `fallback` covers anything that is neither a SQLSTATE nor a known driver failure.
export function toAdapterError(
  error: unknown,
  context: PostgresRedactionContext,
  fallback: ErrorCode = 'internal_error',
): AdapterError {
  if (isAdapterError(error)) {
    return error
  }

  const code = errorCode(error)
  if (code !== undefined) {
    const network = NETWORK_MAPPINGS[code]
    if (network) return build(network, context)
    if (NETWORK_ERROR.test(code)) return build(CONNECTION_LOST, context)
    if (TLS_ERROR.test(code)) return build(TLS_FAILURE, context)
  }

  const state = sqlState(error)
  if (state === undefined) {
    const known = DRIVER_MESSAGE_MAPPINGS.find(([pattern]) => pattern.test(driverMessage(error)))
    return known
      ? build(known[1], context)
      : new AdapterError(createNormalizedError(fallback, DEFAULT_ERROR_MESSAGES[fallback]))
  }

  const exact = SQLSTATE_MAPPINGS[state]
  if (exact) return build(exact, context)

  if (state === CANCELLATION_STATE) {
    return isServerStatementTimeout(error)
      ? build({ code: 'timeout', message: 'The query exceeded the server time limit' }, context)
      : build({ code: 'cancelled', message: DEFAULT_ERROR_MESSAGES.cancelled }, context)
  }
  if (NOT_FOUND_STATES.has(state)) return keepMessage('not_found', error, context)
  if (state === '42601') return keepMessage('syntax_error', error, context)
  if (state === '42501') return keepMessage('permission_denied', error, context)
  if (state === '25006') return keepMessage('read_only_violation', error, context)
  // 08P01 is what the server answers to a statement with $1-style parameters, which this adapter never binds.
  if (state === '08P01') return keepMessage('validation_failed', error, context)
  if (state.startsWith('08')) return build(CONNECTION_LOST, context)
  if (state.startsWith('23')) return keepMessage('constraint_violation', error, context)
  if (USER_DIAGNOSTIC_CLASSES.has(state.slice(0, 2))) {
    return keepMessage('validation_failed', error, context)
  }

  return new AdapterError(
    createNormalizedError('internal_error', DEFAULT_ERROR_MESSAGES.internal_error),
  )
}
