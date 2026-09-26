import type { ErrorCode } from '@strata/contracts'
import {
  AdapterError,
  createNormalizedError,
  DEFAULT_ERROR_MESSAGES,
  isAdapterError,
  type RedactionContext,
} from '../normalization'

interface Mapping {
  readonly code: ErrorCode
  // Fixed message: nothing from the driver reaches the renderer for codes that do not need it.
  readonly message?: string
  readonly retryable?: boolean
}

// SQLite result codes come as SQLITE_<PRIMARY> or SQLITE_<PRIMARY>_<EXTENDED>; only the primary one decides the mapping.
const MAPPINGS: Readonly<Record<string, Mapping>> = {
  SQLITE_CANTOPEN: { code: 'connection_failed', message: 'Could not open the database file' },
  SQLITE_NOTADB: { code: 'connection_failed', message: 'The file is not a valid SQLite database' },
  SQLITE_CORRUPT: { code: 'internal_error', message: 'The database file appears to be corrupted' },
  SQLITE_READONLY: { code: 'read_only_violation', message: 'The database is read-only' },
  SQLITE_PERM: { code: 'permission_denied' },
  SQLITE_AUTH: { code: 'permission_denied' },
  SQLITE_BUSY: {
    code: 'busy',
    message: 'The database is locked by another connection or process',
  },
  SQLITE_LOCKED: {
    code: 'busy',
    message: 'The database is locked by another connection or process',
  },
  SQLITE_INTERRUPT: { code: 'cancelled' },
  SQLITE_FULL: { code: 'internal_error', message: 'The disk is full' },
  SQLITE_IOERR: { code: 'internal_error', message: 'A disk I/O error occurred' },
}

// These carry the user's own diagnostic (constraint name, type mismatch...) and never the file path, so the message is kept.
const VALIDATION_CODES: ReadonlySet<string> = new Set([
  'SQLITE_MISMATCH',
  'SQLITE_TOOBIG',
  'SQLITE_RANGE',
  'SQLITE_FORMAT',
])

const SYNTAX_MESSAGE = /syntax error|incomplete input|unrecognized token/i
// SQLite reports a missing table, view or attached database as a generic SQLITE_ERROR, so only the message tells it apart.
const NOT_FOUND_MESSAGE = /^(no such (table|view)|unknown database)\b/i

function primaryCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }
  const { code } = error
  if (typeof code !== 'string' || !code.startsWith('SQLITE_')) {
    return undefined
  }
  return code.split('_').slice(0, 2).join('_')
}

function classifyGenericError(message: string): ErrorCode {
  if (SYNTAX_MESSAGE.test(message)) return 'syntax_error'
  return NOT_FOUND_MESSAGE.test(message) ? 'not_found' : 'validation_failed'
}

function driverMessage(error: unknown): string {
  return error instanceof Error ? error.message : ''
}

// Never reads a message from an unrecognized error: `fallback` covers anything that is not a SQLite result code.
export function toAdapterError(
  error: unknown,
  context: RedactionContext,
  fallback: ErrorCode = 'internal_error',
): AdapterError {
  if (isAdapterError(error)) {
    return error
  }

  const code = primaryCode(error)
  if (code === undefined) {
    return new AdapterError(createNormalizedError(fallback, DEFAULT_ERROR_MESSAGES[fallback]))
  }

  const mapping = MAPPINGS[code]
  if (mapping) {
    return new AdapterError(
      createNormalizedError(mapping.code, mapping.message ?? DEFAULT_ERROR_MESSAGES[mapping.code], {
        context,
        retryable: mapping.retryable,
      }),
    )
  }

  if (code === 'SQLITE_CONSTRAINT') {
    return new AdapterError(
      createNormalizedError('constraint_violation', driverMessage(error), { context }),
    )
  }

  if (VALIDATION_CODES.has(code)) {
    return new AdapterError(
      createNormalizedError('validation_failed', driverMessage(error), { context }),
    )
  }

  if (code === 'SQLITE_ERROR') {
    const message = driverMessage(error)
    const errorCode = classifyGenericError(message)
    return new AdapterError(createNormalizedError(errorCode, message, { context }))
  }

  return new AdapterError(
    createNormalizedError('internal_error', DEFAULT_ERROR_MESSAGES.internal_error),
  )
}
