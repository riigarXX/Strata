import { z } from 'zod'
import { SessionIdSchema, TransactionStateSchema } from './connections'

export const RequestIdSchema = z.string().min(1).max(128)
export type RequestId = z.infer<typeof RequestIdSchema>

// No read-only flag here on purpose: the renderer is untrusted, so main derives it from the Session (ADR 0004).
export const QueryRequestSchema = z.strictObject({
  requestId: RequestIdSchema,
  sessionId: SessionIdSchema,
  sql: z
    .string()
    .max(2_000_000)
    .refine((sql) => sql.trim().length > 0, { message: 'SQL must not be blank' }),
  timeoutMs: z.int().positive().max(3_600_000).optional(),
  maxRows: z.int().positive().max(10_000_000).optional(),
  chunkSize: z.int().positive().max(10_000).optional(),
  // Opt-out of the query history for this execution (ADR 0005); omitted means it is saved, unless history is disabled in preferences.
  saveToHistory: z.boolean().optional(),
  // Restrict-only: asks main to run the request as a pure read (ADR 0012, automatic execution of AI-generated SQL). It can
  // never relax anything: main applies the read-only guard whatever the profile says, and PostgreSQL runs it inside a
  // READ ONLY transaction that is always rolled back. `false` is not accepted, so the flag cannot be read as a way to opt out.
  enforceReadOnly: z.literal(true).optional(),
})
export type QueryRequest = z.infer<typeof QueryRequestSchema>

export const CancelRequestSchema = z.strictObject({ requestId: RequestIdSchema })
export type CancelRequest = z.infer<typeof CancelRequestSchema>

export const CancelResultSchema = z.strictObject({
  requestId: RequestIdSchema,
  outcome: z.enum(['requested', 'not_running']),
})
export type CancelResult = z.infer<typeof CancelResultSchema>

// Shared by begin, commit and rollback.
export const TransactionRequestSchema = z.strictObject({ sessionId: SessionIdSchema })
export type TransactionRequest = z.infer<typeof TransactionRequestSchema>

export const TransactionResultSchema = z.strictObject({
  sessionId: SessionIdSchema,
  transaction: TransactionStateSchema,
})
export type TransactionResult = z.infer<typeof TransactionResultSchema>

// Backpressure (ADR 0010): the renderer confirms consumed chunks so main can stop running ahead.
export const ChunkAckSchema = z.strictObject({
  requestId: RequestIdSchema,
  statementIndex: z.int().nonnegative(),
  chunkIndex: z.int().nonnegative(),
})
export type ChunkAck = z.infer<typeof ChunkAckSchema>
