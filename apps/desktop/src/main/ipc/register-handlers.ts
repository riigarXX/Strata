import { ipcMain, type BrowserWindow } from 'electron'
import type { AppOrigin } from '../security/app-origin'
import type { AiService } from '../services/ai-service'
import type { ConnectionManager, SqliteFilePicker } from '../services/connection-manager'
import type { HistoryStore } from '../services/history-store'
import type { PreferencesStore } from '../services/preferences-store'
import type { QueryExecutor } from '../services/query-executor'
import { createAiHandlers } from './ai-handlers'
import { createConnectionsHandlers } from './connections-handlers'
import { createHistoryHandlers } from './history-handlers'
import { createMetadataHandlers } from './metadata-handlers'
import { createPreferencesHandlers } from './preferences-handlers'
import { createQueryHandlers } from './query-handlers'
import { createTransactionHandlers } from './transaction-handlers'

export interface IpcDependencies {
  getMainWindow: () => BrowserWindow | null
  appOrigin: AppOrigin
  connectionManager: ConnectionManager
  sqliteFilePicker: SqliteFilePicker
  queryExecutor: QueryExecutor
  preferencesStore: PreferencesStore
  historyStore: HistoryStore
  aiService: AiService
}

export function registerIpcHandlers({
  getMainWindow,
  appOrigin,
  connectionManager,
  sqliteFilePicker,
  queryExecutor,
  preferencesStore,
  historyStore,
  aiService,
}: IpcDependencies): void {
  const handlers = {
    ...createConnectionsHandlers({ connectionManager, sqliteFilePicker, getMainWindow, appOrigin }),
    ...createMetadataHandlers({ connectionManager, getMainWindow, appOrigin }),
    ...createQueryHandlers({ queryExecutor, getMainWindow, appOrigin }),
    ...createTransactionHandlers({ connectionManager, getMainWindow, appOrigin }),
    ...createPreferencesHandlers({ preferencesStore, getMainWindow, appOrigin }),
    ...createHistoryHandlers({ historyStore, getMainWindow, appOrigin }),
    ...createAiHandlers({ aiService, getMainWindow, appOrigin }),
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, payload: unknown) => handler(event, payload))
  }
}
