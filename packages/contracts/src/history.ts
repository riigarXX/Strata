import { z } from 'zod'
import { EngineSchema, ProfileIdSchema } from './connections'
import { ErrorCodeSchema } from './errors'
import { RequestIdSchema } from './queries'

// Bounds that keep the local history from growing without limit (ADR 0005). Results are never stored.
export const HISTORY_LIMITS = {
  /** Longest SQL text kept per entry; longer text is cut and ends with a marker line. */
  maxSqlChars: 20_000,
  /** Entries kept; the oldest ones go first. */
  maxEntries: 5_000,
  pageSize: { default: 50, max: 200 },
  searchMaxChars: 500,
} as const

// Room for the marker line appended when the text was cut.
const MARKER_ROOM = 200

export const HistoryStatusSchema = z.enum(['ok', 'error', 'cancelled'])
export type HistoryStatus = z.infer<typeof HistoryStatusSchema>

export const HistoryEntryIdSchema = z.string().min(1).max(128)

// ISO 8601 UTC ('Z'): the store normalizes to millisecond precision so text order matches time order.
const IsoDateSchema = z.iso.datetime()

export const HistoryEntrySchema = z.strictObject({
  id: HistoryEntryIdSchema,
  sql: z.string().max(HISTORY_LIMITS.maxSqlChars + MARKER_ROOM),
  engine: EngineSchema,
  profileId: ProfileIdSchema,
  // Name at the moment of the execution: it stays readable after the profile is renamed or deleted.
  profileName: z.string().max(100),
  executedAt: IsoDateSchema,
  durationMs: z.number().nonnegative(),
  status: HistoryStatusSchema,
  // Rows returned (or affected, for statements that do not return any) summed over the finished statements; a count, never the rows.
  rowCount: z.int().nonnegative().optional(),
  // Only the closed error code: the error message may quote data, so it is not stored.
  errorCode: ErrorCodeSchema.optional(),
})
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>

// Position after which a page continues: (time, id) of the last entry seen, in descending order.
const CURSOR_PATTERN = /^(\d{1,16})\.(.{1,128})$/

export function encodeHistoryCursor(position: { time: number; id: string }): string {
  return `${position.time}.${position.id}`
}

export function decodeHistoryCursor(cursor: string): { time: number; id: string } | undefined {
  const match = CURSOR_PATTERN.exec(cursor)
  if (!match) return undefined
  const time = Number(match[1])
  return Number.isSafeInteger(time) ? { time, id: match[2] as string } : undefined
}

export const HistoryCursorSchema = z
  .string()
  .max(256)
  .refine((cursor) => decodeHistoryCursor(cursor) !== undefined, { message: 'Invalid cursor' })

export const HistoryListRequestSchema = z.strictObject({
  /** Case-insensitive substring of the SQL text. */
  search: z.string().max(HISTORY_LIMITS.searchMaxChars).optional(),
  engine: EngineSchema.optional(),
  status: HistoryStatusSchema.optional(),
  profileId: ProfileIdSchema.optional(),
  /** Inclusive bounds on `executedAt`. */
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  cursor: HistoryCursorSchema.optional(),
  limit: z.int().min(1).max(HISTORY_LIMITS.pageSize.max).optional(),
})
export type HistoryListRequest = z.infer<typeof HistoryListRequestSchema>

export const HistoryPageSchema = z.strictObject({
  entries: z.array(HistoryEntrySchema).max(HISTORY_LIMITS.pageSize.max),
  /** Pass it back as `cursor` for the next page; null when there are no more entries. */
  nextCursor: HistoryCursorSchema.nullable(),
})
export type HistoryPage = z.infer<typeof HistoryPageSchema>

export const HistoryDeleteRequestSchema = z.strictObject({ id: HistoryEntryIdSchema })
export type HistoryDeleteRequest = z.infer<typeof HistoryDeleteRequestSchema>

export const HistoryDeleteResultSchema = z.strictObject({ deleted: z.int().nonnegative() })
export type HistoryDeleteResult = z.infer<typeof HistoryDeleteResultSchema>

// Push from main to the renderer (never a request): what changed in the history, so an open list stays current without polling.
// `added` carries the stored entry and the request that produced it; `purged` means retention removed entries whose ids are not listed, so the list should be read again.
export const HistoryChangeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('added'),
    entry: HistoryEntrySchema,
    requestId: RequestIdSchema.optional(),
  }),
  z.strictObject({ type: z.literal('removed'), id: HistoryEntryIdSchema }),
  z.strictObject({ type: z.literal('cleared') }),
  z.strictObject({ type: z.literal('purged') }),
])
export type HistoryChange = z.infer<typeof HistoryChangeSchema>
