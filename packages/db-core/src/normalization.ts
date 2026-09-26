import type { ErrorCode, NormalizedError } from '@strata/contracts'
import type { ResolvedConnectionProfile } from './adapter'

export const REDACTED = '[redacted]'

// Mirrors NormalizedErrorSchema.message.max().
const MAX_MESSAGE_LENGTH = 500

export interface RedactionContext {
  readonly host?: string
  readonly user?: string
  readonly filePath?: string
  readonly secrets?: readonly string[]
}

export const DEFAULT_ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  connection_failed: 'Could not connect to the database',
  authentication_failed: 'Authentication failed',
  timeout: 'The operation timed out',
  cancelled: 'The operation was cancelled',
  syntax_error: 'The statement has a syntax error',
  permission_denied: 'Permission denied',
  read_only_violation: 'The connection is read-only',
  unsupported_version: 'The database version is not supported',
  no_session: 'There is no active session',
  validation_failed: 'The request is not valid',
  not_found: 'The requested object was not found',
  constraint_violation: 'A database constraint was violated',
  busy: 'The database is busy',
  internal_error: 'An unexpected internal error occurred',
  cannot_answer: 'The model could not answer with the available schema',
  transaction_aborted: 'The transaction is aborted and only accepts a rollback',
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set([
  'connection_failed',
  'timeout',
  'busy',
])

export interface NormalizedErrorOptions {
  readonly retryable?: boolean
  readonly context?: RedactionContext
}

// Carries only the normalized error: never the driver error as `cause`, which could hold host, user or secrets.
export class AdapterError extends Error {
  readonly normalized: NormalizedError

  constructor(normalized: NormalizedError) {
    super(normalized.message)
    this.name = 'AdapterError'
    this.normalized = normalized
  }
}

export function isAdapterError(value: unknown): value is AdapterError {
  return value instanceof AdapterError
}

export function redactionContextFromProfile(profile: ResolvedConnectionProfile): RedactionContext {
  if (profile.engine === 'sqlite') {
    return { filePath: profile.filePath }
  }
  return {
    host: profile.host,
    user: profile.user,
    secrets: profile.password === undefined ? [] : [profile.password],
  }
}

const CONNECTION_URI = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi
const KEY_VALUE_PAIR =
  /\b(password|passwd|pwd|sslpassword|user|username|host|hostaddr)\s*=\s*('(?:[^'\\]|\\.)*'|"[^"]*"|[^\s,;]+)/gi
const IPV4_ADDRESS = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g
const IPV6_BRACKETED = /\[[0-9a-f:.]*:[0-9a-f:.]*\](?::\d{1,5})?/gi
const IPV6_BARE =
  /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])[0-9a-f:]*::[0-9a-f:]*(?![\w:])/gi

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function longestFirst(values: readonly (string | undefined)[]): string[] {
  const unique = new Set(values.filter((value): value is string => !!value))
  return [...unique].sort((a, b) => b.length - a.length)
}

// Redaction is best effort on free text: adapters should still map driver errors to fixed messages when they can.
export function redactSensitive(text: string, context: RedactionContext = {}): string {
  let result = text

  // A secret is replaced as a plain substring: word boundaries would let one starting or ending with punctuation slip through.
  for (const secret of longestFirst(context.secrets ?? [])) {
    result = result.split(secret).join(REDACTED)
  }

  result = result.replace(CONNECTION_URI, REDACTED).replace(KEY_VALUE_PAIR, `$1=${REDACTED}`)

  for (const known of longestFirst([context.host, context.user, context.filePath])) {
    result = result.replace(new RegExp(`(?<!\\w)${escapeRegExp(known)}(?!\\w)`, 'gi'), REDACTED)
  }

  return result
    .replace(IPV6_BRACKETED, REDACTED)
    .replace(IPV4_ADDRESS, REDACTED)
    .replace(IPV6_BARE, REDACTED)
}

export function createNormalizedError(
  code: ErrorCode,
  message: string,
  options: NormalizedErrorOptions = {},
): NormalizedError {
  const clean = redactSensitive(message, options.context).replace(/\s+/g, ' ').trim()
  return {
    code,
    message: clean.length > 0 ? clean.slice(0, MAX_MESSAGE_LENGTH) : DEFAULT_ERROR_MESSAGES[code],
    retryable: options.retryable ?? RETRYABLE_BY_DEFAULT.has(code),
  }
}

// The unknown reason is deliberately never read for its message: an unrecognized error could carry anything.
export function normalizeUnknownError(reason: unknown): NormalizedError {
  if (isAdapterError(reason)) {
    return reason.normalized
  }
  return createNormalizedError('internal_error', DEFAULT_ERROR_MESSAGES.internal_error)
}
