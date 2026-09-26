import { PreferencesSchema } from '@strata/contracts'
import type { DbApi } from '../../../../shared/db-api'
import { settleIpc } from '../../../composables/settle-ipc'

export type PreferencesApi = DbApi['preferences']

/**
 * Envuelve `window.db.preferences`: ningún método lanza (una excepción de IPC o una respuesta malformada
 * se convierten en un `NormalizedError`) y lo que llega se revalida con el schema de `@strata/contracts`.
 */
export function usePreferencesApi(): PreferencesApi {
  const db = () => window.db.preferences

  return {
    get: () => settleIpc(() => db().get(), PreferencesSchema),
    update: (patch) => settleIpc(() => db().update(patch), PreferencesSchema),
  }
}
