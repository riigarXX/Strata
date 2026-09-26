import {
  HistoryDeleteRequestSchema,
  HistoryDeleteResultSchema,
  HistoryListRequestSchema,
  HistoryPageSchema,
  IPC_CHANNELS,
} from '@strata/contracts'
import type { HistoryStore } from '../services/history-store'
import {
  createSecureHandlerFactory,
  nothing,
  type IpcHandler,
  type SecureHandlerDependencies,
} from './secure-handler'

export interface HistoryHandlersDependencies extends SecureHandlerDependencies {
  historyStore: Pick<HistoryStore, 'list' | 'delete' | 'clear'>
}

/** Lo único que sale hacia el renderer es el texto SQL que escribió el usuario y metadatos de la ejecución. */
export function createHistoryHandlers({
  historyStore,
  ...security
}: HistoryHandlersDependencies): Readonly<Record<string, IpcHandler>> {
  const channels = IPC_CHANNELS.history
  const secure = createSecureHandlerFactory(security)

  return {
    [channels.list]: secure({
      input: HistoryListRequestSchema,
      output: HistoryPageSchema,
      run: (request) => historyStore.list(request),
    }),
    [channels.delete]: secure({
      input: HistoryDeleteRequestSchema,
      output: HistoryDeleteResultSchema,
      run: async ({ id }) => ({ deleted: await historyStore.delete(id) }),
    }),
    [channels.clear]: secure({
      input: nothing,
      output: HistoryDeleteResultSchema,
      run: async () => ({ deleted: await historyStore.clear() }),
    }),
  }
}
