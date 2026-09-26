import {
  IPC_CHANNELS,
  type AiPullProgress,
  type HistoryChange,
  type QueryEvent,
} from '@strata/contracts'
import type { DbApi } from '../shared/db-api'

type Invoke = (channel: string, payload?: unknown) => Promise<unknown>
// Entrega solo el payload (nunca el `event` crudo de Electron) y devuelve la desuscripción de ese listener.
export type Subscribe = (channel: string, listener: (payload: unknown) => void) => () => void

/**
 * Mapeo mecánico método -> canal, sin lógica de negocio: main revalida todo (ADR 0008).
 * `invoke` y `subscribe` se inyectan para que `ipcRenderer` nunca forme parte de lo que se expone al renderer.
 */
export function createDbApi(invoke: Invoke, subscribe: Subscribe): DbApi {
  const channels = IPC_CHANNELS.connections
  const metadata = IPC_CHANNELS.metadata
  const query = IPC_CHANNELS.query
  const transaction = IPC_CHANNELS.transaction
  const preferences = IPC_CHANNELS.preferences
  const history = IPC_CHANNELS.history
  const ai = IPC_CHANNELS.ai
  const call = <T>(channel: string, payload?: unknown) => invoke(channel, payload) as Promise<T>

  return {
    connections: {
      list: () => call(channels.list),
      create: (input) => call(channels.create, input),
      update: (input) => call(channels.update, input),
      delete: (request) => call(channels.delete, request),
      test: (request) => call(channels.test, request),
      connect: (request) => call(channels.connect, request),
      disconnect: (request) => call(channels.disconnect, request),
      pickSqliteFile: () => call(channels.pickSqliteFile),
    },
    metadata: {
      listSchemas: (request) => call(metadata.schemas, request),
      listTables: (request) => call(metadata.tables, request),
      describeTable: (request) => call(metadata.describe, request),
    },
    query: {
      execute: (request) => call(query.execute, request),
      cancel: (request) => call(query.cancel, request),
      ack: (ack) => call(query.ack, ack),
      onEvent: (callback) =>
        subscribe(query.event, (payload) => {
          callback(payload as QueryEvent)
        }),
    },
    transactions: {
      begin: (request) => call(transaction.begin, request),
      commit: (request) => call(transaction.commit, request),
      rollback: (request) => call(transaction.rollback, request),
    },
    preferences: {
      get: () => call(preferences.get),
      update: (patch) => call(preferences.update, patch),
    },
    history: {
      list: (request) => call(history.list, request),
      delete: (request) => call(history.delete, request),
      clear: () => call(history.clear),
      onChange: (callback) =>
        subscribe(history.changed, (payload) => {
          callback(payload as HistoryChange)
        }),
    },
    ai: {
      status: () => call(ai.status),
      listModels: (request) => call(ai.listModels, request),
      generateSql: (request) => call(ai.generateSql, request),
      pullModel: (request) => call(ai.pullModel, request),
      cancel: (request) => call(ai.cancel, request),
      onPullProgress: (callback) =>
        subscribe(ai.pullProgress, (payload) => {
          callback(payload as AiPullProgress)
        }),
    },
  }
}
