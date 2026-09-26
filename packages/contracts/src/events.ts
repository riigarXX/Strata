import { z } from 'zod'
import { NormalizedErrorSchema } from './errors'
import { TransactionStateSchema } from './connections'
import { RequestIdSchema } from './queries'

// Adapters serialize values that JSON/structured clone cannot carry faithfully (bigint, decimal, dates, binary, json) as strings.
export const CellValueSchema = z.union([z.null(), z.boolean(), z.number(), z.string()])
export type CellValue = z.infer<typeof CellValueSchema>

export const ColumnKindSchema = z.enum([
  'number',
  'text',
  'boolean',
  'datetime',
  'uuid',
  'binary',
  'json',
  'array',
  'other',
])
export type ColumnKind = z.infer<typeof ColumnKindSchema>

export const ResultColumnSchema = z.strictObject({
  name: z.string().max(256),
  dataType: z.string().min(1).max(256),
  kind: ColumnKindSchema,
})
export type ResultColumn = z.infer<typeof ResultColumnSchema>

const statementIndex = z.int().nonnegative()

// A cell cut to the adapters' per-cell byte cap: `row` is relative to the chunk and `originalBytes` is the value's size before the cut.
export const TruncatedCellSchema = z.strictObject({
  row: z.int().nonnegative(),
  column: z.int().nonnegative(),
  originalBytes: z.int().positive(),
})
export type TruncatedCell = z.infer<typeof TruncatedCellSchema>

// A statement that returns a result set emits at least one chunk (possibly with no rows) so the columns are always known.
// `truncated` is omitted when no cell of the chunk was cut, so the shape of `rows` never changes.
const ChunkEventSchema = z.strictObject({
  type: z.literal('chunk'),
  requestId: RequestIdSchema,
  statementIndex,
  chunkIndex: z.int().nonnegative(),
  columns: z.array(ResultColumnSchema),
  rows: z.array(z.array(CellValueSchema)),
  truncated: z.array(TruncatedCellSchema).optional(),
})

const NoticeEventSchema = z.strictObject({
  type: z.literal('notice'),
  requestId: RequestIdSchema,
  statementIndex,
  level: z.enum(['info', 'warning']),
  message: z.string().max(2000),
  // Stable identifier so the UI can localize a notice whose `message` is in English.
  code: z.enum(['transaction_lost']).optional(),
})

// One per statement of a multi-statement document (ADR 0004).
const StatementDoneEventSchema = z.strictObject({
  type: z.literal('statement_done'),
  requestId: RequestIdSchema,
  statementIndex,
  command: z.string().max(64),
  rowsReturned: z.int().nonnegative(),
  rowsAffected: z.int().nonnegative().nullable(),
  durationMs: z.number().nonnegative(),
  truncated: z.boolean(),
})

// Terminal events: done, error and cancelled each end the request; a failed or cancelled statement stops the ones after it.
// `transaction` is the session's state once the request finished, so the status bar needs no extra call (ADR 0004).
const DoneEventSchema = z.strictObject({
  type: z.literal('done'),
  requestId: RequestIdSchema,
  statementCount: z.int().nonnegative(),
  durationMs: z.number().nonnegative(),
  transaction: TransactionStateSchema,
})

// statementIndex is absent when the failure happened before any statement started.
// `transaction` is optional because it is main that fills it in, by asking the adapter after the failure (PostgreSQL leaves an open transaction 'aborted'); it is omitted when the session is gone.
const ErrorEventSchema = z.strictObject({
  type: z.literal('error'),
  requestId: RequestIdSchema,
  statementIndex: statementIndex.optional(),
  error: NormalizedErrorSchema,
  transaction: TransactionStateSchema.optional(),
})

// Same optional `transaction` as error: a cancelled request can leave a transaction open, or aborted.
const CancelledEventSchema = z.strictObject({
  type: z.literal('cancelled'),
  requestId: RequestIdSchema,
  statementIndex: statementIndex.optional(),
  transaction: TransactionStateSchema.optional(),
})

export const QueryEventSchema = z.discriminatedUnion('type', [
  ChunkEventSchema,
  NoticeEventSchema,
  StatementDoneEventSchema,
  DoneEventSchema,
  ErrorEventSchema,
  CancelledEventSchema,
])
export type QueryEvent = z.infer<typeof QueryEventSchema>
export type QueryEventType = QueryEvent['type']

// Closed catalog of IPC channels (ADR 0008): a new channel is added here first. Convention: db:<domain>:<action> (action may be kebab-case).
export const IPC_CHANNELS = {
  connections: {
    list: 'db:connections:list',
    create: 'db:connections:create',
    update: 'db:connections:update',
    delete: 'db:connections:delete',
    test: 'db:connections:test',
    connect: 'db:connections:connect',
    disconnect: 'db:connections:disconnect',
    // Opens the native file dialog in main; only paths returned by it may be registered in SQLite profiles.
    pickSqliteFile: 'db:connections:pick-sqlite-file',
  },
  query: {
    execute: 'db:query:execute',
    cancel: 'db:query:cancel',
    ack: 'db:query:ack',
    // main -> renderer push; carries every QueryEvent variant, not only chunks.
    event: 'db:query:event',
  },
  metadata: {
    schemas: 'db:metadata:schemas',
    tables: 'db:metadata:tables',
    describe: 'db:metadata:describe',
  },
  transaction: {
    begin: 'db:transaction:begin',
    commit: 'db:transaction:commit',
    rollback: 'db:transaction:rollback',
  },
  preferences: {
    get: 'db:preferences:get',
    update: 'db:preferences:update',
  },
  history: {
    list: 'db:history:list',
    delete: 'db:history:delete',
    clear: 'db:history:clear',
    // main -> renderer push to the main window only; carries every HistoryChange variant.
    changed: 'db:history:changed',
  },
  ai: {
    // Probes the default Ollama and LM Studio ports (and the configured server) on loopback.
    status: 'db:ai:status',
    listModels: 'db:ai:list-models',
    // Question in, one classified SQL statement out; main never executes it (ADR 0012).
    generateSql: 'db:ai:generate-sql',
    // Resolves when the download ends; progress goes out on `pullProgress` meanwhile.
    pullModel: 'db:ai:pull-model',
    // Cancels a generation or a download by its requestId.
    cancel: 'db:ai:cancel',
    // main -> renderer push to the main window only; carries AiPullProgress.
    pullProgress: 'db:ai:pull-progress',
  },
} as const

type ValuesOf<T> = T[keyof T]

export type IpcChannel = ValuesOf<{
  [Domain in keyof typeof IPC_CHANNELS]: ValuesOf<(typeof IPC_CHANNELS)[Domain]>
}>

export const IPC_CHANNEL_LIST: readonly IpcChannel[] = Object.values(IPC_CHANNELS).flatMap(
  (domain) => Object.values(domain),
)

const knownChannels: ReadonlySet<string> = new Set(IPC_CHANNEL_LIST)

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && knownChannels.has(value)
}
