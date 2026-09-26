import type {
  CancelResult,
  ConnectionProfile,
  Engine,
  QueryEvent,
  QueryRequest,
  RequestId,
  SchemaInfo,
  Session,
  SessionId,
  TableDetails,
  TableInfo,
  TableRef,
  TestConnectionResult,
  TransactionResult,
  TransactionState,
} from '@strata/contracts'

type PostgresProfile = Extract<ConnectionProfile, { engine: 'postgres' }>
type SqliteProfile = Extract<ConnectionProfile, { engine: 'sqlite' }>

// Exists only in main, never crosses IPC: the public profile plus its secret already fetched from CredentialStore (ADR 0009).
export type ResolvedPostgresProfile = Omit<PostgresProfile, 'secretRef'> & {
  readonly password?: string
}
export type ResolvedSqliteProfile = SqliteProfile
export type ResolvedConnectionProfile = ResolvedPostgresProfile | ResolvedSqliteProfile

// The UI must not assume every engine supports the same features (plan, section 5).
export interface AdapterCapabilities {
  readonly cancellation: boolean
  // 'cooperative': cancel is only observed between chunks and statements, so one step of a heavy query cannot be interrupted; 'immediate': the running statement is interrupted server-side.
  readonly cancellationMode?: 'cooperative' | 'immediate'
  readonly schemas: boolean
  readonly explain: boolean
  readonly transactions: boolean
  // Driver-level read-only as defense in depth; main/ConnectionManager remains the enforcer (ADR 0004).
  readonly readOnlyMode: boolean
}

// Methods reject with an AdapterError (see normalization.ts) so main can forward a NormalizedError untouched.
export interface DatabaseAdapter {
  readonly engine: Engine
  readonly capabilities: AdapterCapabilities

  testConnection(profile: ResolvedConnectionProfile): Promise<TestConnectionResult>
  connect(profile: ResolvedConnectionProfile): Promise<Session>
  disconnect(sessionId: SessionId): Promise<void>

  // Failures and cancellation are reported as terminal events, not by throwing (ADR 0010).
  execute(request: QueryRequest): AsyncIterable<QueryEvent>
  cancel(requestId: RequestId): Promise<CancelResult>

  listSchemas(sessionId: SessionId): Promise<SchemaInfo[]>
  listTables(sessionId: SessionId, schema?: string): Promise<TableInfo[]>
  describeTable(sessionId: SessionId, table: TableRef): Promise<TableDetails>

  begin(sessionId: SessionId): Promise<TransactionResult>
  commit(sessionId: SessionId): Promise<TransactionResult>
  rollback(sessionId: SessionId): Promise<TransactionResult>

  // Read from the driver's own state, so a BEGIN/COMMIT typed in the editor is reflected too. Throws an AdapterError ('no_session') synchronously.
  transactionState(sessionId: SessionId): TransactionState
}
