import type {
  ConnectionProfile,
  ConnectionProfileInput,
  AiPullProgress,
  HistoryChange,
  NormalizedError,
  QueryEvent,
  Session,
  TableDetails,
  TableInfo,
} from '@strata/contracts'
import { applyPreferencesPatch, DEFAULT_PREFERENCES, type Preferences } from '@strata/contracts'
import { vi } from 'vitest'
import type { DbApi } from '../../../../shared/db-api'
import { ipcFail, ipcOk, type IpcResult } from '../../../../shared/ipc-result'

type Connections = DbApi['connections']
type Metadata = DbApi['metadata']

export const NO_ADAPTER_ERROR: NormalizedError = {
  code: 'connection_failed',
  message: 'No database driver is available for the "sqlite" engine',
  retryable: false,
}

export const NO_SESSION_ERROR: NormalizedError = {
  code: 'no_session',
  message: 'There is no open session for this request',
  retryable: false,
}

export const PASSWORD_REQUIRED_ERROR: NormalizedError = {
  code: 'validation_failed',
  message: 'Enter the password again when changing the host, port or user',
  retryable: false,
}

/** Catálogo que sirve `window.db.metadata`: schemas, tablas por schema y detalle por tabla. */
export interface FakeCatalog {
  schemas: string[]
  tables: Record<string, TableInfo[]>
  details: TableDetails[]
}

export interface FakeDbOptions {
  profiles?: ConnectionProfile[]
  pickedPath?: string | null
  /** Sin valor: no hay adapter registrado, que es lo que devuelve main hoy. */
  connectResult?: IpcResult<Session>
  /** Sin catálogo, la introspección responde vacío (y `describeTable`, `no_session`). */
  catalog?: FakeCatalog
  /** Preferencias guardadas al empezar; por defecto, las de fábrica. */
  preferences?: Preferences
}

const NOT_FOUND_ERROR: NormalizedError = {
  code: 'not_found',
  message: 'The table does not exist',
  retryable: false,
}

function toProfile(id: string, input: ConnectionProfileInput): ConnectionProfile {
  const { name, readOnly } = input
  if (input.engine === 'sqlite') {
    return { id, engine: 'sqlite', name, readOnly, filePath: input.filePath }
  }
  return {
    id,
    engine: 'postgres',
    name,
    readOnly,
    host: input.host,
    port: input.port,
    user: input.user,
    database: input.database,
    ssl: input.ssl,
    ...(input.password === undefined ? {} : { secretRef: `secret-${id}` }),
  }
}

/** `window.db` falso con un almacén en memoria que imita las reglas visibles de main. */
export function createFakeDb(options: FakeDbOptions = {}) {
  const profiles = [...(options.profiles ?? [])]
  let counter = profiles.length

  const connections = {
    list: vi.fn<Connections['list']>(async () => ipcOk([...profiles])),
    create: vi.fn<Connections['create']>(async (input) => {
      counter += 1
      const profile = toProfile(`profile-${counter}`, input)
      profiles.push(profile)
      return ipcOk(profile)
    }),
    update: vi.fn<Connections['update']>(async (input) => {
      const index = profiles.findIndex((profile) => profile.id === input.id)
      const stored = profiles[index]
      if (!stored) return ipcFail(PASSWORD_REQUIRED_ERROR)
      if (
        stored.engine === 'postgres' &&
        stored.secretRef &&
        input.engine === 'postgres' &&
        input.password === undefined &&
        (stored.host !== input.host || stored.port !== input.port || stored.user !== input.user)
      ) {
        return ipcFail(PASSWORD_REQUIRED_ERROR)
      }
      const next = toProfile(input.id, input)
      if (next.engine === 'postgres' && stored.engine === 'postgres' && stored.secretRef) {
        next.secretRef = stored.secretRef
      }
      profiles[index] = next
      return ipcOk(next)
    }),
    delete: vi.fn<Connections['delete']>(async ({ profileId }) => {
      const index = profiles.findIndex((profile) => profile.id === profileId)
      if (index >= 0) profiles.splice(index, 1)
      return ipcOk(undefined)
    }),
    test: vi.fn<Connections['test']>(async () =>
      ipcOk({ ok: true, serverVersion: 'PostgreSQL 16.2', latencyMs: 12 }),
    ),
    connect: vi.fn<Connections['connect']>(
      async () => options.connectResult ?? ipcFail(NO_ADAPTER_ERROR),
    ),
    disconnect: vi.fn<Connections['disconnect']>(async () => ipcOk(undefined)),
    pickSqliteFile: vi.fn<Connections['pickSqliteFile']>(async () =>
      ipcOk({ filePath: options.pickedPath ?? null }),
    ),
  }

  const catalog = options.catalog
  const metadata = {
    listSchemas: vi.fn<Metadata['listSchemas']>(async () =>
      ipcOk((catalog?.schemas ?? []).map((name) => ({ name }))),
    ),
    listTables: vi.fn<Metadata['listTables']>(async ({ schema }) =>
      ipcOk(
        schema === undefined
          ? Object.values(catalog?.tables ?? {}).flat()
          : [...(catalog?.tables[schema] ?? [])],
      ),
    ),
    describeTable: vi.fn<Metadata['describeTable']>(async ({ table }) => {
      if (!catalog) return ipcFail(NO_SESSION_ERROR)
      const found = catalog.details.find(
        ({ table: candidate }) =>
          candidate.schema === table.schema && candidate.name === table.name,
      )
      return found ? ipcOk(found) : ipcFail(NOT_FOUND_ERROR)
    }),
  }

  // Bus de eventos de consulta: `emitQueryEvent` los entrega a los suscriptores como haría el preload.
  const queryListeners = new Set<(event: QueryEvent) => void>()
  const query = {
    execute: vi.fn<DbApi['query']['execute']>(async () => ipcOk(undefined)),
    cancel: vi.fn<DbApi['query']['cancel']>(async ({ requestId }) =>
      ipcOk({ requestId, outcome: 'not_running' }),
    ),
    ack: vi.fn<DbApi['query']['ack']>(async () => ipcOk(undefined)),
    onEvent: vi.fn<DbApi['query']['onEvent']>((callback) => {
      queryListeners.add(callback)
      return () => {
        queryListeners.delete(callback)
      }
    }),
  }
  const emitQueryEvent = (event: QueryEvent): void => {
    for (const listener of [...queryListeners]) listener(event)
  }
  const transactions = {
    begin: vi.fn<DbApi['transactions']['begin']>(async () => ipcFail(NO_SESSION_ERROR)),
    commit: vi.fn<DbApi['transactions']['commit']>(async () => ipcFail(NO_SESSION_ERROR)),
    rollback: vi.fn<DbApi['transactions']['rollback']>(async () => ipcFail(NO_SESSION_ERROR)),
  }
  // Preferencias guardadas: cada `update` las persiste (en memoria) y las devuelve completas, como main.
  let storedPreferences: Preferences = options.preferences ?? DEFAULT_PREFERENCES
  const preferences = {
    get: vi.fn<DbApi['preferences']['get']>(async () => ipcOk(storedPreferences)),
    update: vi.fn<DbApi['preferences']['update']>(async (patch) => {
      storedPreferences = applyPreferencesPatch(storedPreferences, patch)
      return ipcOk(storedPreferences)
    }),
  }
  // Bus de cambios del historial: `emitHistoryChange` los entrega como haría el preload.
  const historyListeners = new Set<(change: HistoryChange) => void>()
  const history = {
    list: vi.fn<DbApi['history']['list']>(async () => ipcOk({ entries: [], nextCursor: null })),
    delete: vi.fn<DbApi['history']['delete']>(async () => ipcOk({ deleted: 0 })),
    clear: vi.fn<DbApi['history']['clear']>(async () => ipcOk({ deleted: 0 })),
    onChange: vi.fn<DbApi['history']['onChange']>((callback) => {
      historyListeners.add(callback)
      return () => {
        historyListeners.delete(callback)
      }
    }),
  }
  const emitHistoryChange = (change: HistoryChange): void => {
    for (const listener of [...historyListeners]) listener(change)
  }
  // Asistente de IA: por defecto sin servidores; `stubAi` (features/ai/testing) le da un servidor falso con estado.
  // Bus de avances de descarga: `emitPullProgress` los entrega como haría el preload.
  const pullListeners = new Set<(progress: AiPullProgress) => void>()
  const ai = {
    status: vi.fn<DbApi['ai']['status']>(async () => ipcOk({ providers: [] })),
    listModels: vi.fn<DbApi['ai']['listModels']>(async () => ipcOk([])),
    generateSql: vi.fn<DbApi['ai']['generateSql']>(async () => ipcFail(NO_SESSION_ERROR)),
    pullModel: vi.fn<DbApi['ai']['pullModel']>(async () => ipcFail(NO_SESSION_ERROR)),
    cancel: vi.fn<DbApi['ai']['cancel']>(async ({ requestId }) =>
      ipcOk({ requestId, outcome: 'not_running' }),
    ),
    onPullProgress: vi.fn<DbApi['ai']['onPullProgress']>((callback) => {
      pullListeners.add(callback)
      return () => {
        pullListeners.delete(callback)
      }
    }),
  }
  const emitPullProgress = (progress: AiPullProgress): void => {
    for (const listener of [...pullListeners]) listener(progress)
  }

  return {
    db: {
      connections,
      metadata,
      query,
      transactions,
      preferences,
      history,
      ai,
    } satisfies DbApi,
    connections,
    metadata,
    query,
    transactions,
    emitQueryEvent,
    queryListenerCount: () => queryListeners.size,
    emitHistoryChange,
    historyListenerCount: () => historyListeners.size,
    ai,
    emitPullProgress,
    pullListenerCount: () => pullListeners.size,
    preferences,
    history,
    storedPreferences: () => storedPreferences,
    profiles,
  }
}

export function installFakeDb(db: DbApi): void {
  Object.defineProperty(window, 'db', { value: db, configurable: true, writable: true })
}
