import {
  HistoryChangeSchema,
  HistoryDeleteResultSchema,
  HistoryPageSchema,
} from '@strata/contracts'
import type { DbApi } from '../../../../shared/db-api'
import { settleIpc } from '../../../composables/settle-ipc'

export type HistoryApi = DbApi['history']

/**
 * Envuelve `window.db.history`: ningún método lanza (una excepción de IPC o una respuesta malformada se
 * convierten en un `NormalizedError`) y lo que llega (respuestas y cambios
 * empujados por main) se revalida con los schemas de `@strata/contracts`.
 */
export function useHistoryApi(): HistoryApi {
  const db = () => window.db.history

  return {
    list: (request) => settleIpc(() => db().list(request), HistoryPageSchema),
    delete: (request) => settleIpc(() => db().delete(request), HistoryDeleteResultSchema),
    clear: () => settleIpc(() => db().clear(), HistoryDeleteResultSchema),
    /** Solo entrega cambios válidos según el contrato: lo que llega por IPC no es de confianza. */
    onChange: (callback) =>
      db().onChange((change) => {
        const parsed = HistoryChangeSchema.safeParse(change)
        if (parsed.success) callback(parsed.data)
      }),
  }
}
