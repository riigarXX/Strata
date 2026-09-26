import { z } from 'zod'

export const ERROR_CODES = [
  'connection_failed',
  'authentication_failed',
  'timeout',
  'cancelled',
  'syntax_error',
  'permission_denied',
  'read_only_violation',
  'unsupported_version',
  'no_session',
  'validation_failed',
  'not_found',
  'constraint_violation',
  'busy',
  'internal_error',
  // The local AI model answered `-- CANNOT_ANSWER`: the question cannot be answered with the connected schema (ADR 0012).
  'cannot_answer',
  // The session's transaction is aborted (PostgreSQL) and only accepts a rollback: the AI assistant will not read the schema through it (ADR 0012).
  'transaction_aborted',
] as const

export const ErrorCodeSchema = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

// Deliberately closed and minimal: no host, user, connection string, driver error or stack fields,
// so nothing sensitive can travel to the renderer even by accident (threat-model.md, ADR 0008).
export const NormalizedErrorSchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
})
export type NormalizedError = z.infer<typeof NormalizedErrorSchema>
