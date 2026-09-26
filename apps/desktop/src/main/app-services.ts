import { AdapterRegistry } from '@strata/db-core'
import { createPostgresAdapter } from '@strata/db-core/postgres'
import { createSqliteAdapter } from '@strata/db-core/sqlite'
import { join } from 'node:path'
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import { createAiService, type AiService } from './services/ai-service'
import {
  connectionsFilePath,
  createApprovedSqlitePaths,
  createConnectionManager,
  createNodeProfileFileSystem,
  createProfileStore,
  createSqliteFilePicker,
  type ConnectionManager,
  type SqliteFilePicker,
} from './services/connection-manager'
import {
  createHistoryRecorder,
  createHistoryStore,
  HISTORY_FILE_NAME,
  type HistoryStore,
} from './services/history-store'
import { createNodeStorageFileSystem } from './services/local-storage'
import {
  createPreferencesStore,
  PREFERENCES_FILE_NAME,
  type PreferencesStore,
} from './services/preferences-store'
import { createQueryExecutor, type QueryExecutor } from './services/query-executor'
import {
  createCredentialStore,
  createLazyCredentialStore,
  createNodeCredentialFileSystem,
  credentialsFilePath,
  type SafeStorageLike,
} from './services/credential-store'

export interface AppServicesOptions {
  userDataPath: string
  safeStorage: SafeStorageLike
  // Compiled worker that hosts better-sqlite3 (see index.ts); the adapter only spawns it on the first SQLite connection.
  sqliteWorkerPath: string
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
}

export interface AppServices {
  adapters: AdapterRegistry
  connectionManager: ConnectionManager
  queryExecutor: QueryExecutor
  preferencesStore: PreferencesStore
  historyStore: HistoryStore
  aiService: AiService
  sqliteFilePicker: SqliteFilePicker
}

export function createAppServices({
  userDataPath,
  safeStorage,
  sqliteWorkerPath,
  showOpenDialog,
}: AppServicesOptions): AppServices {
  const adapters = new AdapterRegistry()
  adapters.register(createPostgresAdapter())
  adapters.register(createSqliteAdapter({ workerPath: sqliteWorkerPath }))
  const approvedSqlitePaths = createApprovedSqlitePaths()

  // Perezoso: `safeStorage` (y con él el diálogo de Keychain) solo se toca al guardar o leer una password.
  const credentialStore = createLazyCredentialStore(() =>
    createCredentialStore({
      safeStorage,
      fileSystem: createNodeCredentialFileSystem(),
      filePath: credentialsFilePath(userDataPath),
    }),
  )

  // Tres archivos independientes en `userData` (ADR 0009): perfiles, preferencias e historial no se importan entre sí.
  const storageFileSystem = createNodeStorageFileSystem()
  const preferencesStore = createPreferencesStore({
    fileSystem: storageFileSystem,
    filePath: join(userDataPath, PREFERENCES_FILE_NAME),
  })
  const historyStore = createHistoryStore({
    fileSystem: storageFileSystem,
    filePath: join(userDataPath, HISTORY_FILE_NAME),
    getRetentionDays: async () => (await preferencesStore.get()).history.retentionDays,
  })
  // Cambiar la retención purga al instante, sin esperar a la purga diaria.
  preferencesStore.subscribe((next, previous) => {
    if (next.history.retentionDays !== previous.history.retentionDays) {
      void historyStore.purge().catch(() => undefined)
    }
  })

  // Dependencia circular resuelta con cierres: el ejecutor pide sesiones al manager y el manager cancela en el ejecutor antes de cerrar una sesión.
  const queryExecutor = createQueryExecutor({
    getSessionRuntime: (sessionId) => connectionManager.getSessionRuntime(sessionId),
    history: createHistoryRecorder({
      store: historyStore,
      isEnabled: async () => (await preferencesStore.get()).history.enabled,
    }),
  })
  const connectionManager = createConnectionManager({
    profileStore: createProfileStore({
      fileSystem: createNodeProfileFileSystem(),
      filePath: connectionsFilePath(userDataPath),
    }),
    credentialStore,
    adapters,
    approvedSqlitePaths,
    beforeSessionClose: (sessionId) => queryExecutor.cancelSession(sessionId),
  })

  // Lee las preferencias del almacén real en cada petición: activar el asistente o cambiar de modelo no exige reiniciar.
  const aiService = createAiService({
    preferences: preferencesStore,
    connections: connectionManager,
  })

  return {
    adapters,
    connectionManager,
    queryExecutor,
    preferencesStore,
    historyStore,
    aiService,
    sqliteFilePicker: createSqliteFilePicker({
      showOpenDialog,
      approvedPaths: approvedSqlitePaths,
    }),
  }
}
