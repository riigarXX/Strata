import { randomUUID } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import type {
  CancelResult,
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
import Database from 'better-sqlite3'
import type {
  AdapterCapabilities,
  DatabaseAdapter,
  ResolvedConnectionProfile,
  ResolvedSqliteProfile,
} from '../adapter'
import {
  AdapterError,
  createNormalizedError,
  DEFAULT_ERROR_MESSAGES,
  normalizeUnknownError,
  redactionContextFromProfile,
  type RedactionContext,
} from '../normalization'
import { toAdapterError } from './errors'
import { executeDocument, type ExecutionRun } from './execution'
import * as introspection from './introspection'

// ADR 0003: RETURNING and the rest of what the adapter relies on arrive in 3.35.
export const SQLITE_MINIMUM_VERSION = '3.35.0'

export interface SqliteEngineOptions {
  readonly minimumVersion?: string
  // The worker reopening a session after being replaced must keep the id the caller already holds.
  readonly newSessionId?: () => SessionId
}

// The engine runs inside the worker, where better-sqlite3 stays synchronous: cancel is honored between chunks and statements, and the adapter in the main thread enforces it immediately (see adapter.ts).
const CAPABILITIES: AdapterCapabilities = {
  cancellation: true,
  cancellationMode: 'cooperative',
  schemas: false,
  explain: false,
  transactions: true,
  readOnlyMode: true,
}

interface ActiveRun extends ExecutionRun {
  readonly sessionId: SessionId
}

interface SqliteSession {
  readonly sessionId: SessionId
  readonly db: Database.Database
  readonly context: RedactionContext
  activeRun: ActiveRun | undefined
}

function versionParts(version: string): number[] | undefined {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  return parts.length >= 2 && parts.every((part) => Number.isInteger(part) && part >= 0)
    ? parts
    : undefined
}

export function isSupportedSqliteVersion(
  version: string,
  minimum: string = SQLITE_MINIMUM_VERSION,
): boolean {
  const actual = versionParts(version)
  const required = versionParts(minimum)
  if (!actual || !required) {
    return false
  }
  for (let i = 0; i < Math.max(actual.length, required.length); i++) {
    const difference = (actual[i] ?? 0) - (required[i] ?? 0)
    if (difference !== 0) {
      return difference > 0
    }
  }
  return true
}

function invalid(message: string): AdapterError {
  return new AdapterError(createNormalizedError('validation_failed', message))
}

function busy(message: string): AdapterError {
  return new AdapterError(createNormalizedError('busy', message))
}

function assertSqliteProfile(
  profile: ResolvedConnectionProfile,
): asserts profile is ResolvedSqliteProfile {
  if (profile.engine !== 'sqlite') {
    throw invalid('The profile is not a SQLite profile')
  }
  if (!isAbsolute(profile.filePath) || profile.filePath.includes('\0')) {
    throw invalid('The database file path must be absolute')
  }
}

// Checked ahead of the driver, which reports every open failure as the same SQLITE_CANTOPEN.
function assertReadable(filePath: string, context: RedactionContext): void {
  try {
    accessSync(filePath, constants.R_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new AdapterError(
        createNormalizedError('connection_failed', 'The database file does not exist', { context }),
      )
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AdapterError(
        createNormalizedError('permission_denied', 'Permission denied reading the database file', {
          context,
        }),
      )
    }
    throw toAdapterError(error, context, 'connection_failed')
  }
}

// fileMustExist: a typo in the path must not silently create an empty database.
function openDatabase(
  filePath: string,
  readonly: boolean,
  minimumVersion: string,
  context: RedactionContext,
): { db: Database.Database; version: string } {
  assertReadable(filePath, context)
  let db: Database.Database | undefined
  try {
    db = new Database(filePath, { readonly, fileMustExist: true })
    const version = db.prepare('SELECT sqlite_version()').pluck().get() as string
    // sqlite_version() never touches the file; reading the schema makes a non-SQLite file fail here instead of later.
    db.prepare('SELECT count(*) FROM sqlite_master').pluck().get()
    if (!isSupportedSqliteVersion(version, minimumVersion)) {
      throw new AdapterError(
        createNormalizedError(
          'unsupported_version',
          `SQLite ${version} is not supported; version ${minimumVersion} or later is required`,
        ),
      )
    }
    return { db, version }
  } catch (error) {
    db?.close()
    throw toAdapterError(error, context, 'connection_failed')
  }
}

export function createSqliteEngine(options: SqliteEngineOptions = {}): DatabaseAdapter {
  const minimumVersion = options.minimumVersion ?? SQLITE_MINIMUM_VERSION
  const newSessionId = options.newSessionId ?? randomUUID
  const sessions = new Map<SessionId, SqliteSession>()
  const runs = new Map<RequestId, ActiveRun>()

  function requireSession(sessionId: SessionId): SqliteSession {
    const session = sessions.get(sessionId)
    if (!session) {
      throw new AdapterError(createNormalizedError('no_session', DEFAULT_ERROR_MESSAGES.no_session))
    }
    return session
  }

  // SQLite has no failed-transaction state: an error inside a transaction leaves it open and usable.
  const stateOf = (session: SqliteSession): TransactionState =>
    session.db.inTransaction ? 'active' : 'none'

  async function inSession<T>(
    sessionId: SessionId,
    work: (session: SqliteSession) => T,
  ): Promise<T> {
    const session = requireSession(sessionId)
    try {
      return work(session)
    } catch (error) {
      throw toAdapterError(error, session.context)
    }
  }

  // The driver refuses statements while a cursor is open, so transaction control waits for the query to finish.
  function assertIdle(session: SqliteSession): void {
    if (session.activeRun) {
      throw busy('A query is running on this session')
    }
  }

  // Idempotent: the state converges even when the UI is stale after a manual BEGIN/COMMIT.
  function transaction(
    sessionId: SessionId,
    command: 'BEGIN' | 'COMMIT' | 'ROLLBACK',
  ): Promise<TransactionResult> {
    return inSession(sessionId, (session) => {
      assertIdle(session)
      const wanted: TransactionState = command === 'BEGIN' ? 'active' : 'none'
      if (stateOf(session) !== wanted) {
        session.db.exec(command)
      }
      return { sessionId, transaction: stateOf(session) }
    })
  }

  async function* execute(request: QueryRequest): AsyncGenerator<QueryEvent, void> {
    const { requestId } = request
    const rejected = (error: AdapterError): QueryEvent => ({
      type: 'error',
      requestId,
      error: error.normalized,
    })

    const session = sessions.get(request.sessionId)
    if (!session) {
      yield rejected(
        new AdapterError(createNormalizedError('no_session', DEFAULT_ERROR_MESSAGES.no_session)),
      )
      return
    }
    if (session.activeRun || runs.has(requestId)) {
      yield rejected(busy('A query is already running on this session'))
      return
    }

    const run: ActiveRun = {
      sessionId: session.sessionId,
      cancelRequested: false,
      closeCursor: undefined,
    }
    session.activeRun = run
    runs.set(requestId, run)
    try {
      yield* executeDocument({
        requestId,
        db: session.db,
        transactionState: () => stateOf(session),
        run,
        sql: request.sql,
        context: session.context,
        timeoutMs: request.timeoutMs,
        maxRows: request.maxRows,
        chunkSize: request.chunkSize,
      })
    } finally {
      run.closeCursor?.()
      session.activeRun = undefined
      runs.delete(requestId)
    }
  }

  return {
    engine: 'sqlite',
    capabilities: CAPABILITIES,

    testConnection(profile): Promise<TestConnectionResult> {
      const startedAt = performance.now()
      try {
        assertSqliteProfile(profile)
        // Read-only regardless of the profile: testing must never touch the file.
        const { db, version } = openDatabase(
          profile.filePath,
          true,
          minimumVersion,
          redactionContextFromProfile(profile),
        )
        db.close()
        return Promise.resolve({
          ok: true,
          serverVersion: version,
          latencyMs: performance.now() - startedAt,
        })
      } catch (error) {
        return Promise.resolve({ ok: false, error: normalizeUnknownError(error) })
      }
    },

    connect(profile): Promise<Session> {
      try {
        assertSqliteProfile(profile)
        const context = redactionContextFromProfile(profile)
        const { db, version } = openDatabase(
          profile.filePath,
          profile.readOnly,
          minimumVersion,
          context,
        )
        const sessionId = newSessionId()
        sessions.set(sessionId, { sessionId, db, context, activeRun: undefined })
        return Promise.resolve({
          sessionId,
          profileId: profile.id,
          engine: 'sqlite',
          serverVersion: version,
          readOnly: profile.readOnly,
          transaction: 'none',
        })
      } catch (error) {
        return Promise.reject(toAdapterError(error, {}))
      }
    },

    disconnect(sessionId): Promise<void> {
      const session = sessions.get(sessionId)
      if (!session) {
        return Promise.resolve()
      }
      sessions.delete(sessionId)
      try {
        if (session.activeRun) {
          session.activeRun.cancelRequested = true
          session.activeRun.closeCursor?.()
        }
        session.db.close()
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(toAdapterError(error, session.context))
      }
    },

    execute,

    cancel(requestId): Promise<CancelResult> {
      const run = runs.get(requestId)
      if (!run) {
        return Promise.resolve({ requestId, outcome: 'not_running' })
      }
      run.cancelRequested = true
      return Promise.resolve({ requestId, outcome: 'requested' })
    },

    listSchemas(sessionId): Promise<SchemaInfo[]> {
      return inSession(sessionId, (session) => introspection.listSchemas(session.db))
    },

    listTables(sessionId, schema): Promise<TableInfo[]> {
      return inSession(sessionId, (session) => introspection.listTables(session.db, schema))
    },

    describeTable(sessionId, table: TableRef): Promise<TableDetails> {
      return inSession(sessionId, (session) => introspection.describeTable(session.db, table))
    },

    begin: (sessionId) => transaction(sessionId, 'BEGIN'),
    commit: (sessionId) => transaction(sessionId, 'COMMIT'),
    rollback: (sessionId) => transaction(sessionId, 'ROLLBACK'),

    transactionState(sessionId): TransactionState {
      return stateOf(requireSession(sessionId))
    },
  }
}
