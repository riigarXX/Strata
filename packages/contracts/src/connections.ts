import { z } from 'zod'
import { NormalizedErrorSchema } from './errors'

// ResolvedConnectionProfile (profile with its secret resolved) exists only inside main and is defined with DatabaseAdapter in db-core.

export const ProfileIdSchema = z.string().min(1).max(128)
export type ProfileId = z.infer<typeof ProfileIdSchema>

export const SessionIdSchema = z.string().min(1).max(128)
export type SessionId = z.infer<typeof SessionIdSchema>

export const EngineSchema = z.enum(['postgres', 'sqlite'])
export type Engine = z.infer<typeof EngineSchema>

export const SslModeSchema = z.enum(['disable', 'require', 'verify-full'])
export type SslMode = z.infer<typeof SslModeSchema>

const ProfileNameSchema = z.string().trim().min(1).max(100)

// Rejects characters that would let a host smuggle URL/connection-string syntax.
const HostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[^\s/\\@?#]+$/)

const PortSchema = z.int().min(1).max(65535)

const SqliteFilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => path.startsWith('/') && !path.includes('\0'), {
    message: 'Must be an absolute path',
  })

const postgresParams = {
  engine: z.literal('postgres'),
  host: HostSchema,
  port: PortSchema,
  user: z.string().min(1).max(128),
  database: z.string().min(1).max(128),
  ssl: SslModeSchema,
}

const sqliteParams = {
  engine: z.literal('sqlite'),
  filePath: SqliteFilePathSchema,
}

const commonParams = {
  name: ProfileNameSchema,
  readOnly: z.boolean(),
}

// Public profile (main -> renderer). Strict so a profile carrying a password fails to serialize instead of leaking.
export const PostgresProfileSchema = z.strictObject({
  id: ProfileIdSchema,
  ...commonParams,
  ...postgresParams,
  secretRef: z.string().min(1).max(128).optional(),
})
export const SqliteProfileSchema = z.strictObject({
  id: ProfileIdSchema,
  ...commonParams,
  ...sqliteParams,
})
export const ConnectionProfileSchema = z.discriminatedUnion('engine', [
  PostgresProfileSchema,
  SqliteProfileSchema,
])
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>

export const ConnectionProfileListSchema = z.array(ConnectionProfileSchema)
export type ConnectionProfileList = z.infer<typeof ConnectionProfileListSchema>

// Write-only input (renderer -> main). The password is optional and never echoed back; on update, omitting it keeps the stored secret.
const PasswordSchema = z.string().min(1).max(1024)

const PostgresProfileInputSchema = z.strictObject({
  ...commonParams,
  ...postgresParams,
  password: PasswordSchema.optional(),
})
const SqliteProfileInputSchema = z.strictObject({
  ...commonParams,
  ...sqliteParams,
})

export const ConnectionProfileInputSchema = z.discriminatedUnion('engine', [
  PostgresProfileInputSchema,
  SqliteProfileInputSchema,
])
export type ConnectionProfileInput = z.infer<typeof ConnectionProfileInputSchema>

export const ConnectionProfileUpdateSchema = z.discriminatedUnion('engine', [
  PostgresProfileInputSchema.extend({ id: ProfileIdSchema }),
  SqliteProfileInputSchema.extend({ id: ProfileIdSchema }),
])
export type ConnectionProfileUpdate = z.infer<typeof ConnectionProfileUpdateSchema>

export const DeleteProfileRequestSchema = z.strictObject({ profileId: ProfileIdSchema })
export type DeleteProfileRequest = z.infer<typeof DeleteProfileRequestSchema>

// Testing an unsaved profile, or a saved one (with id) so an omitted password reuses the stored secret.
export const TestConnectionRequestSchema = z.union([
  ConnectionProfileInputSchema,
  ConnectionProfileUpdateSchema,
])
export type TestConnectionRequest = z.infer<typeof TestConnectionRequestSchema>

export const TestConnectionResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    serverVersion: z.string().min(1).max(200),
    latencyMs: z.number().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: NormalizedErrorSchema,
  }),
])
export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>

export const ConnectRequestSchema = z.strictObject({ profileId: ProfileIdSchema })
export type ConnectRequest = z.infer<typeof ConnectRequestSchema>

// Main opens the native dialog; null means the user cancelled. Main remembers the returned path as approved (see ConnectionManager).
export const PickSqliteFileResultSchema = z.strictObject({
  filePath: SqliteFilePathSchema.nullable(),
})
export type PickSqliteFileResult = z.infer<typeof PickSqliteFileResultSchema>

export const DisconnectRequestSchema = z.strictObject({ sessionId: SessionIdSchema })
export type DisconnectRequest = z.infer<typeof DisconnectRequestSchema>

export const ConnectionStatusSchema = z.enum(['disconnected', 'connecting', 'connected', 'failed'])
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>

export const ConnectionStateSchema = z.strictObject({
  profileId: ProfileIdSchema,
  status: ConnectionStatusSchema,
  sessionId: SessionIdSchema.optional(),
  error: NormalizedErrorSchema.optional(),
})
export type ConnectionState = z.infer<typeof ConnectionStateSchema>

// 'aborted' is a transaction that failed and only accepts a rollback (PostgreSQL); SQLite never reaches it.
export const TransactionStateSchema = z.enum(['none', 'active', 'aborted'])
export type TransactionState = z.infer<typeof TransactionStateSchema>

export const SessionSchema = z.strictObject({
  sessionId: SessionIdSchema,
  profileId: ProfileIdSchema,
  engine: EngineSchema,
  serverVersion: z.string().min(1).max(200),
  readOnly: z.boolean(),
  transaction: TransactionStateSchema,
})
export type Session = z.infer<typeof SessionSchema>
