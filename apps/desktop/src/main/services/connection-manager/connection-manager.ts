import { randomUUID } from 'node:crypto'
import {
  ConnectionProfileSchema,
  SessionSchema,
  TestConnectionResultSchema,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionProfileUpdate,
  type ConnectRequest,
  type DeleteProfileRequest,
  type DescribeTableRequest,
  type DisconnectRequest,
  type ListSchemasRequest,
  type ListTablesRequest,
  type SchemaInfo,
  type Session,
  type SessionId,
  type TableDetails,
  type TableInfo,
  type TestConnectionRequest,
  type TestConnectionResult,
  type TransactionRequest,
  type TransactionResult,
  type TransactionState,
} from '@strata/contracts'
import {
  AdapterError,
  redactionContextFromProfile,
  type AdapterRegistry,
  type DatabaseAdapter,
  type RedactionContext,
  type ResolvedConnectionProfile,
} from '@strata/db-core'
import type { CredentialStore } from '../credential-store'
import { isSamePath, type ApprovedSqlitePaths } from './approved-sqlite-paths'
import { managerError, redactNormalizedError, toAdapterError, toNormalizedError } from './errors'
import type { ProfileStore } from './profile-store'
import { withTimeout } from './with-timeout'

type PostgresProfile = Extract<ConnectionProfile, { engine: 'postgres' }>
type ProfileDraft = ConnectionProfileInput | ConnectionProfileUpdate

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_DISCONNECT_TIMEOUT_MS = 5_000
// Perfil provisional para probar una conexión que aún no está guardada.
const DRAFT_PROFILE_ID = 'draft'

export interface ConnectionManagerDependencies {
  profileStore: ProfileStore
  credentialStore: Pick<CredentialStore, 'save' | 'get' | 'delete'>
  adapters: AdapterRegistry
  approvedSqlitePaths: ApprovedSqlitePaths
  generateProfileId?: () => string
  connectTimeoutMs?: number
  disconnectTimeoutMs?: number
  /** Se espera antes de cerrar cualquier sesión (desconexión, cambio de perfil, salida): p. ej. para cancelar su ejecución en curso. Sus fallos se ignoran. */
  beforeSessionClose?: (sessionId: SessionId) => Promise<void>
}

/** Lo que necesita el ejecutor de consultas de una sesión abierta; nunca cruza IPC. */
export interface SessionRuntime {
  session: Session
  // Nombre del perfil al abrir la sesión: el historial lo conserva aunque el perfil se renombre o se borre.
  profileName: string
  adapter: DatabaseAdapter
  // Host, usuario, ruta y password para redactar los errores posteriores a la conexión.
  redaction: RedactionContext
}

/**
 * Único propietario de perfiles y sesiones en main. Todos los métodos rechazan con `AdapterError`
 * (un `NormalizedError` ya redactado); nada de lo que devuelve contiene passwords ni secretos.
 */
export interface ConnectionManager {
  listProfiles(): Promise<ConnectionProfile[]>
  createProfile(input: ConnectionProfileInput): Promise<ConnectionProfile>
  updateProfile(input: ConnectionProfileUpdate): Promise<ConnectionProfile>
  deleteProfile(request: DeleteProfileRequest): Promise<void>
  /** Los fallos de la prueba en sí se devuelven como `{ ok: false }`; los previos a probar, como rechazo. */
  testConnection(request: TestConnectionRequest): Promise<TestConnectionResult>
  connect(request: ConnectRequest): Promise<Session>
  disconnect(request: DisconnectRequest): Promise<void>
  /** Desconecta la sesión activa del perfil (si la hay) y vuelve a conectar. */
  reconnect(request: ConnectRequest): Promise<Session>
  /** Punto de partida de la futura ejecución de consultas: `readOnly` lo fijó main desde el perfil. */
  getSession(sessionId: SessionId): Session | undefined
  /** Sesión, adapter y contexto de redacción para ejecutar consultas; `undefined` si no existe o ya se cerró. */
  getSessionRuntime(sessionId: SessionId): SessionRuntime | undefined
  hasActiveSessions(): boolean
  /** Estado de transacción real que reporta el adapter; `undefined` si la sesión no existe o ya se cerró. */
  transactionState(sessionId: SessionId): TransactionState | undefined
  /** Introspección de la sesión activa; `no_session` si no existe o ya se cerró. Los nombres se validan contra el catálogo en el adapter. */
  listSchemas(request: ListSchemasRequest): Promise<SchemaInfo[]>
  listTables(request: ListTablesRequest): Promise<TableInfo[]>
  describeTable(request: DescribeTableRequest): Promise<TableDetails>
  /** Transacciones explícitas (ADR 0004); devuelven el estado real que reporta el adapter. `busy` mientras hay una consulta en curso. */
  begin(request: TransactionRequest): Promise<TransactionResult>
  commit(request: TransactionRequest): Promise<TransactionResult>
  rollback(request: TransactionRequest): Promise<TransactionResult>
  /** Cierra todas las sesiones sin fallar (para `before-quit`). */
  closeAll(): Promise<void>
}

type ActiveSession = SessionRuntime

async function guarded<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (reason) {
    throw reason instanceof AdapterError ? reason : toAdapterError(reason)
  }
}

// El secreto guardado solo se reutiliza contra el mismo destino de red: si no, un renderer comprometido
// podría redirigir el perfil a un servidor propio y recibir la password guardada.
function sameNetworkIdentity(stored: PostgresProfile, draft: ProfileDraft): boolean {
  return (
    draft.engine === 'postgres' &&
    stored.host.toLowerCase() === draft.host.toLowerCase() &&
    stored.port === draft.port &&
    stored.user === draft.user
  )
}

function buildProfile(
  id: string,
  draft: ProfileDraft,
  secretRef: string | undefined,
): ConnectionProfile {
  if (draft.engine === 'sqlite') {
    return {
      id,
      engine: 'sqlite',
      name: draft.name,
      readOnly: draft.readOnly,
      filePath: draft.filePath,
    }
  }
  return {
    id,
    engine: 'postgres',
    name: draft.name,
    readOnly: draft.readOnly,
    host: draft.host,
    port: draft.port,
    user: draft.user,
    database: draft.database,
    ssl: draft.ssl,
    ...(secretRef === undefined ? {} : { secretRef }),
  }
}

function buildResolved(
  id: string,
  draft: ProfileDraft,
  password: string | undefined,
): ResolvedConnectionProfile {
  const profile = buildProfile(id, draft, undefined)
  if (profile.engine === 'sqlite' || password === undefined) return profile
  return { ...profile, password }
}

function comparableFields(profile: ConnectionProfile): string {
  return JSON.stringify(
    Object.entries({ ...profile, name: '' }).sort(([a], [b]) => a.localeCompare(b)),
  )
}

// Cambiar solo el nombre no afecta a una sesión abierta; cualquier otra cosa sí.
function affectsOpenSession(stored: ConnectionProfile, next: ConnectionProfile): boolean {
  return comparableFields(stored) !== comparableFields(next)
}

export function createConnectionManager({
  profileStore,
  credentialStore,
  adapters,
  approvedSqlitePaths,
  generateProfileId = randomUUID,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  disconnectTimeoutMs = DEFAULT_DISCONNECT_TIMEOUT_MS,
  beforeSessionClose,
}: ConnectionManagerDependencies): ConnectionManager {
  const sessions = new Map<SessionId, ActiveSession>()
  const pendingConnects = new Map<string, Promise<Session>>()

  async function requireProfile(profileId: string): Promise<ConnectionProfile> {
    const profile = await profileStore.get(profileId)
    if (!profile) throw managerError('validation_failed', 'The connection profile does not exist')
    return profile
  }

  function requireAdapter(profile: { engine: ConnectionProfile['engine'] }): DatabaseAdapter {
    if (!adapters.has(profile.engine)) {
      throw managerError(
        'connection_failed',
        `No database driver is available for the "${profile.engine}" engine`,
        false,
      )
    }
    return adapters.get(profile.engine)
  }

  function assertSqlitePathAllowed(
    draft: ProfileDraft,
    stored: ConnectionProfile | undefined,
  ): void {
    if (draft.engine !== 'sqlite') return
    if (stored?.engine === 'sqlite' && isSamePath(stored.filePath, draft.filePath)) return
    if (approvedSqlitePaths.isApproved(draft.filePath)) return
    throw managerError('permission_denied', 'The SQLite file must be chosen with the file picker')
  }

  function assertStoredSecretReusable(
    draft: ProfileDraft,
    stored: ConnectionProfile | undefined,
  ): void {
    if (stored?.engine !== 'postgres' || !stored.secretRef) return
    if (
      draft.engine === 'postgres' &&
      draft.password === undefined &&
      !sameNetworkIdentity(stored, draft)
    ) {
      throw managerError(
        'validation_failed',
        'Enter the password again when changing the host, port or user',
      )
    }
  }

  async function resolveStored(profile: ConnectionProfile): Promise<ResolvedConnectionProfile> {
    if (profile.engine === 'sqlite') return profile
    const { secretRef, ...rest } = profile
    if (secretRef === undefined) return rest
    const password = await credentialStore.get(secretRef)
    if (password === undefined) {
      throw managerError(
        'authentication_failed',
        'The saved password is missing. Edit the connection and enter it again',
      )
    }
    return { ...rest, password }
  }

  function findByProfile(profileId: string): ActiveSession | undefined {
    return [...sessions.values()].find((active) => active.session.profileId === profileId)
  }

  async function closeActive(active: ActiveSession): Promise<void> {
    await beforeSessionClose?.(active.session.sessionId).catch(() => undefined)
    sessions.delete(active.session.sessionId)
    await withTimeout(
      active.adapter.disconnect(active.session.sessionId),
      disconnectTimeoutMs,
      'Closing the connection timed out',
    )
  }

  async function withSession<T>(
    sessionId: SessionId,
    operation: (active: ActiveSession) => Promise<T>,
  ): Promise<T> {
    const active = sessions.get(sessionId)
    if (!active) throw managerError('no_session', 'The session does not exist or was closed')
    try {
      return await operation(active)
    } catch (reason) {
      throw new AdapterError(redactNormalizedError(toNormalizedError(reason), active.redaction))
    }
  }

  async function closeProfileSessions(profileId: string): Promise<void> {
    const active = [...sessions.values()].filter((entry) => entry.session.profileId === profileId)
    await Promise.allSettled(active.map(closeActive))
  }

  async function openSession(profile: ConnectionProfile): Promise<Session> {
    const existing = findByProfile(profile.id)
    if (existing) return existing.session

    const adapter = requireAdapter(profile)
    const resolved = await resolveStored(profile)
    try {
      const opened = await withTimeout(
        adapter.connect(resolved),
        connectTimeoutMs,
        'Connecting to the database timed out',
        (late) => void adapter.disconnect(late.sessionId).catch(() => undefined),
      )
      // `readOnly` lo decide main desde el perfil, nunca el adapter ni el renderer (ADR 0004).
      const parsed = SessionSchema.safeParse({
        ...opened,
        profileId: profile.id,
        engine: profile.engine,
        readOnly: profile.readOnly,
      })
      if (!parsed.success) {
        await adapter.disconnect(opened.sessionId).catch(() => undefined)
        throw managerError('internal_error', 'The database driver returned an invalid session')
      }
      if (sessions.has(parsed.data.sessionId)) {
        throw managerError('internal_error', 'The database driver returned a duplicate session id')
      }
      sessions.set(parsed.data.sessionId, {
        session: parsed.data,
        profileName: profile.name,
        adapter,
        redaction: redactionContextFromProfile(resolved),
      })
      return parsed.data
    } catch (reason) {
      throw toAdapterError(reason, resolved)
    }
  }

  function connectProfile(profileId: string): Promise<Session> {
    const pending = pendingConnects.get(profileId)
    if (pending) return pending
    const attempt = requireProfile(profileId)
      .then(openSession)
      .finally(() => pendingConnects.delete(profileId))
    pendingConnects.set(profileId, attempt)
    return attempt
  }

  return {
    listProfiles: () => guarded(() => profileStore.list()),

    createProfile: (input) =>
      guarded(async () => {
        assertSqlitePathAllowed(input, undefined)
        const id = generateProfileId()
        const secretRef =
          input.engine === 'postgres' && input.password !== undefined
            ? await credentialStore.save(input.password)
            : undefined
        const profile = ConnectionProfileSchema.parse(buildProfile(id, input, secretRef))
        try {
          await profileStore.save(profile)
        } catch (reason) {
          if (secretRef !== undefined)
            await credentialStore.delete(secretRef).catch(() => undefined)
          throw reason
        }
        return profile
      }),

    updateProfile: (input) =>
      guarded(async () => {
        const stored = await requireProfile(input.id)
        assertSqlitePathAllowed(input, stored)
        assertStoredSecretReusable(input, stored)

        let secretRef = stored.engine === 'postgres' ? stored.secretRef : undefined
        if (input.engine === 'postgres') {
          if (input.password !== undefined) {
            secretRef = await credentialStore.save(input.password, secretRef)
          }
        } else if (secretRef !== undefined) {
          await credentialStore.delete(secretRef)
          secretRef = undefined
        }

        const profile = ConnectionProfileSchema.parse(buildProfile(stored.id, input, secretRef))
        await profileStore.save(profile)
        const passwordChanged = input.engine === 'postgres' && input.password !== undefined
        if (passwordChanged || affectsOpenSession(stored, profile)) {
          await closeProfileSessions(profile.id)
        }
        return profile
      }),

    deleteProfile: ({ profileId }) =>
      guarded(async () => {
        const stored = await requireProfile(profileId)
        await closeProfileSessions(profileId)
        // Primero el secreto: si falla, el perfil sigue y se puede reintentar; al revés quedaría huérfano.
        if (stored.engine === 'postgres' && stored.secretRef !== undefined) {
          await credentialStore.delete(stored.secretRef)
        }
        await profileStore.remove(profileId)
      }),

    testConnection: (request) =>
      guarded(async () => {
        const stored = 'id' in request ? await requireProfile(request.id) : undefined
        assertSqlitePathAllowed(request, stored)
        assertStoredSecretReusable(request, stored)

        let resolved: ResolvedConnectionProfile | undefined
        try {
          const adapter = requireAdapter(request)
          let password = request.engine === 'postgres' ? request.password : undefined
          if (
            password === undefined &&
            stored?.engine === 'postgres' &&
            stored.secretRef !== undefined
          ) {
            password = await credentialStore.get(stored.secretRef)
          }
          resolved = buildResolved(stored?.id ?? DRAFT_PROFILE_ID, request, password)
          const result = await withTimeout(
            adapter.testConnection(resolved),
            connectTimeoutMs,
            'Testing the connection timed out',
          )
          const parsed = TestConnectionResultSchema.parse(result)
          return parsed.ok
            ? parsed
            : { ok: false, error: toNormalizedError(new AdapterError(parsed.error), resolved) }
        } catch (reason) {
          return { ok: false, error: toNormalizedError(reason, resolved) }
        }
      }),

    connect: ({ profileId }) => guarded(() => connectProfile(profileId)),

    disconnect: ({ sessionId }) =>
      guarded(async () => {
        const active = sessions.get(sessionId)
        if (!active) throw managerError('no_session', 'The session does not exist or was closed')
        await closeActive(active)
      }),

    reconnect: ({ profileId }) =>
      guarded(async () => {
        await closeProfileSessions(profileId)
        return connectProfile(profileId)
      }),

    getSession: (sessionId) => sessions.get(sessionId)?.session,

    getSessionRuntime: (sessionId) => sessions.get(sessionId),

    hasActiveSessions: () => sessions.size > 0,

    transactionState: (sessionId) => {
      const active = sessions.get(sessionId)
      if (!active) return undefined
      try {
        return active.adapter.transactionState(sessionId)
      } catch {
        return undefined
      }
    },

    listSchemas: ({ sessionId }) =>
      withSession(sessionId, ({ adapter }) => adapter.listSchemas(sessionId)),

    listTables: ({ sessionId, schema }) =>
      withSession(sessionId, ({ adapter }) => adapter.listTables(sessionId, schema)),

    describeTable: ({ sessionId, table }) =>
      withSession(sessionId, ({ adapter }) => adapter.describeTable(sessionId, table)),

    begin: ({ sessionId }) => withSession(sessionId, ({ adapter }) => adapter.begin(sessionId)),
    commit: ({ sessionId }) => withSession(sessionId, ({ adapter }) => adapter.commit(sessionId)),
    rollback: ({ sessionId }) =>
      withSession(sessionId, ({ adapter }) => adapter.rollback(sessionId)),

    async closeAll() {
      await Promise.allSettled([...sessions.values()].map(closeActive))
    },
  }
}
