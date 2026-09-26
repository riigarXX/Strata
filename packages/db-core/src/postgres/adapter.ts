import { randomUUID } from 'node:crypto'
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
import type { Client, ClientConfig } from 'pg'
import type {
  AdapterCapabilities,
  DatabaseAdapter,
  ResolvedConnectionProfile,
  ResolvedPostgresProfile,
} from '../adapter'
import { analyzeSql } from '../analysis'
import {
  AdapterError,
  createNormalizedError,
  DEFAULT_ERROR_MESSAGES,
  normalizeUnknownError,
} from '../normalization'
import {
  clientConfigFor,
  closeClient,
  openClient,
  POSTGRES_MINIMUM_MAJOR_VERSION,
  redactionContextForPostgres,
  withAuxiliaryClient,
} from './connection'
import { toAdapterError, type PostgresRedactionContext } from './errors'
import { createExecutionRun, executeDocument, interruptRun, type ExecutionRun } from './execution'
import * as introspection from './introspection'

export interface PostgresAdapterOptions {
  readonly minimumMajorVersion?: number
}

// pg_cancel_backend interrupts a running statement from a second connection, so cancel does not wait for a chunk boundary.
const CAPABILITIES: AdapterCapabilities = {
  cancellation: true,
  cancellationMode: 'immediate',
  schemas: true,
  explain: false,
  transactions: true,
  readOnlyMode: true,
}

interface PostgresSession {
  readonly sessionId: SessionId
  readonly client: Client
  readonly backendPid: number
  readonly config: ClientConfig
  readonly context: PostgresRedactionContext
  // Names of non-built-in types (enums, extensions...) already looked up in pg_type.
  readonly typeNames: Map<number, string>
  activeRun: ExecutionRun | undefined
}

function invalid(message: string): AdapterError {
  return new AdapterError(createNormalizedError('validation_failed', message))
}

function busy(message: string): AdapterError {
  return new AdapterError(createNormalizedError('busy', message))
}

function assertPostgresProfile(
  profile: ResolvedConnectionProfile,
): asserts profile is ResolvedPostgresProfile {
  if (profile.engine !== 'postgres') {
    throw invalid('The profile is not a PostgreSQL profile')
  }
}

export function createPostgresAdapter(options: PostgresAdapterOptions = {}): DatabaseAdapter {
  const minimumMajor = options.minimumMajorVersion ?? POSTGRES_MINIMUM_MAJOR_VERSION
  const sessions = new Map<SessionId, PostgresSession>()
  const runs = new Map<
    RequestId,
    { readonly session: PostgresSession; readonly run: ExecutionRun }
  >()

  function requireSession(sessionId: SessionId): PostgresSession {
    const session = sessions.get(sessionId)
    if (!session) {
      throw new AdapterError(createNormalizedError('no_session', DEFAULT_ERROR_MESSAGES.no_session))
    }
    return session
  }

  // 'I' is idle, 'T' an open transaction and 'E' a failed one that only accepts a rollback.
  const stateOf = (session: PostgresSession): TransactionState => {
    const status = session.client.getTransactionStatus()
    if (status === 'T') return 'active'
    return status === 'E' ? 'aborted' : 'none'
  }

  // A session serves one request at a time: catalog reads and transaction control would queue behind an open cursor.
  function assertIdle(session: PostgresSession): void {
    if (session.activeRun) {
      throw busy('A query is running on this session')
    }
  }

  async function inIdleSession<T>(
    sessionId: SessionId,
    work: (session: PostgresSession) => Promise<T>,
  ): Promise<T> {
    const session = requireSession(sessionId)
    assertIdle(session)
    try {
      return await work(session)
    } catch (error) {
      throw toAdapterError(error, session.context)
    }
  }

  const signalBackend = (session: PostgresSession) => (): Promise<void> =>
    withAuxiliaryClient(session.config, session.context, async (auxiliary) => {
      await auxiliary.query('SELECT pg_cancel_backend($1)', [session.backendPid])
    })

  // A failed lookup only costs the type its name: it must never fail the query that needed it.
  const resolveTypeNames =
    (session: PostgresSession) =>
    async (oids: number[]): Promise<void> => {
      try {
        await withAuxiliaryClient(session.config, session.context, async (auxiliary) => {
          const { rows } = await auxiliary.query<{ oid: number; name: string }>(
            'SELECT oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])',
            [oids],
          )
          for (const row of rows) {
            session.typeNames.set(row.oid, row.name)
          }
        })
      } catch {
        // Left unresolved: the column is reported with an "unknown" type.
      }
    }

  function transaction(
    sessionId: SessionId,
    command: 'BEGIN' | 'COMMIT' | 'ROLLBACK',
  ): Promise<TransactionResult> {
    return inIdleSession(sessionId, async (session) => {
      // Idempotent: the state converges even when the UI is stale after a manual BEGIN/COMMIT.
      // An aborted transaction still counts as open for BEGIN, and COMMIT or ROLLBACK are what end it.
      const isOpen = stateOf(session) !== 'none'
      if (isOpen !== (command === 'BEGIN')) {
        await session.client.query(command)
      }
      return { sessionId, transaction: stateOf(session) }
    })
  }

  // A read-only run lives in its own READ ONLY transaction, which is always rolled back: whatever a function called
  // from a SELECT tries to write is refused by the server, and nothing (not even a set_config) outlives the run.
  // It is only sound outside a user transaction and with plain queries: a COMMIT in the text would end it early.
  function readOnlyRunRefusal(session: PostgresSession, sql: string): string | undefined {
    if (stateOf(session) !== 'none') {
      return 'A read-only run needs a session with no open transaction'
    }
    const plainQueries = analyzeSql('postgres', sql).every(
      (statement) => statement.type === 'query' && statement.allowedInReadOnly,
    )
    return plainQueries ? undefined : 'A read-only run only accepts plain queries'
  }

  async function endReadOnlyTransaction(session: PostgresSession): Promise<void> {
    try {
      if (stateOf(session) !== 'none') await session.client.query('ROLLBACK')
    } catch {
      // A dead connection has no transaction left to end.
    }
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

    const readOnlyRun = request.enforceReadOnly === true
    if (readOnlyRun) {
      const refusal = readOnlyRunRefusal(session, request.sql)
      if (refusal !== undefined) {
        yield rejected(invalid(refusal))
        return
      }
    }

    const run = createExecutionRun()
    session.activeRun = run
    runs.set(requestId, { session, run })
    try {
      if (readOnlyRun) {
        try {
          await session.client.query('BEGIN READ ONLY')
        } catch (error) {
          yield rejected(toAdapterError(error, session.context))
          return
        }
      }
      const document = executeDocument({
        requestId,
        client: session.client,
        transactionState: () => stateOf(session),
        run,
        sql: request.sql,
        context: session.context,
        timeoutMs: request.timeoutMs,
        maxRows: request.maxRows,
        chunkSize: request.chunkSize,
        signalBackend: signalBackend(session),
        typeNames: session.typeNames,
        resolveTypeNames: resolveTypeNames(session),
      })
      for await (const event of document) {
        if (
          !readOnlyRun ||
          (event.type !== 'done' && event.type !== 'error' && event.type !== 'cancelled')
        ) {
          yield event
          continue
        }
        // The terminal event reports the state the session is left in: the run's own transaction is over by then.
        await endReadOnlyTransaction(session)
        yield event.type === 'done' ? { ...event, transaction: stateOf(session) } : event
      }
    } finally {
      if (readOnlyRun) await endReadOnlyTransaction(session)
      session.activeRun = undefined
      runs.delete(requestId)
    }
  }

  return {
    engine: 'postgres',
    capabilities: CAPABILITIES,

    async testConnection(profile): Promise<TestConnectionResult> {
      const startedAt = performance.now()
      try {
        assertPostgresProfile(profile)
        const connected = await openClient(
          clientConfigFor(profile, { readOnly: false }),
          redactionContextForPostgres(profile),
          minimumMajor,
        )
        await closeClient(connected.client)
        return {
          ok: true,
          serverVersion: connected.serverVersion,
          latencyMs: performance.now() - startedAt,
        }
      } catch (error) {
        return { ok: false, error: normalizeUnknownError(error) }
      }
    },

    async connect(profile): Promise<Session> {
      try {
        assertPostgresProfile(profile)
        const context = redactionContextForPostgres(profile)
        const config = clientConfigFor(profile, { readOnly: profile.readOnly })
        const { client, serverVersion, backendPid } = await openClient(
          config,
          context,
          minimumMajor,
        )

        const session: PostgresSession = {
          sessionId: randomUUID(),
          client,
          backendPid,
          config,
          context,
          typeNames: new Map(),
          activeRun: undefined,
        }
        client.on('notice', (notice) => {
          session.activeRun?.notices.push({
            severity: notice.severity,
            code: notice.code,
            message: notice.message,
          })
        })
        sessions.set(session.sessionId, session)
        return {
          sessionId: session.sessionId,
          profileId: profile.id,
          engine: 'postgres',
          serverVersion,
          readOnly: profile.readOnly,
          transaction: 'none',
        }
      } catch (error) {
        throw toAdapterError(error, {}, 'connection_failed')
      }
    },

    async disconnect(sessionId): Promise<void> {
      const session = sessions.get(sessionId)
      if (!session) {
        return
      }
      sessions.delete(sessionId)
      const { activeRun } = session
      if (activeRun) {
        activeRun.cancelRequested = true
        await interruptRun(activeRun, signalBackend(session))
      }
      await closeClient(session.client)
    },

    execute,

    async cancel(requestId): Promise<CancelResult> {
      const active = runs.get(requestId)
      if (!active) {
        return { requestId, outcome: 'not_running' }
      }
      active.run.cancelRequested = true
      await interruptRun(active.run, signalBackend(active.session))
      return { requestId, outcome: 'requested' }
    },

    listSchemas: (sessionId): Promise<SchemaInfo[]> =>
      inIdleSession(sessionId, (session) => introspection.listSchemas(session.client)),

    listTables: (sessionId, schema): Promise<TableInfo[]> =>
      inIdleSession(sessionId, (session) => introspection.listTables(session.client, schema)),

    describeTable: (sessionId, table: TableRef): Promise<TableDetails> =>
      inIdleSession(sessionId, (session) => introspection.describeTable(session.client, table)),

    begin: (sessionId) => transaction(sessionId, 'BEGIN'),
    commit: (sessionId) => transaction(sessionId, 'COMMIT'),
    rollback: (sessionId) => transaction(sessionId, 'ROLLBACK'),

    transactionState: (sessionId): TransactionState => stateOf(requireSession(sessionId)),
  }
}
