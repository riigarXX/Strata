import {
  ConnectionProfileListSchema,
  ConnectionProfileSchema,
  PickSqliteFileResultSchema,
  SessionSchema,
  TestConnectionResultSchema,
} from '@strata/contracts'
import type { DbApi } from '../../../../shared/db-api'
import { acceptAnything, settleIpc as settle } from '../../../composables/settle-ipc'

export type ConnectionsApi = DbApi['connections']

/**
 * Envuelve `window.db.connections`: ningún método lanza (una excepción de IPC, como un remitente
 * rechazado, o una respuesta malformada se convierten en un `NormalizedError`) y las respuestas
 * se revalidan con los schemas de `@strata/contracts`.
 */
export function useConnectionsApi(): ConnectionsApi {
  const db = () => window.db.connections

  return {
    list: () => settle(() => db().list(), ConnectionProfileListSchema),
    create: (input) => settle(() => db().create(input), ConnectionProfileSchema),
    update: (input) => settle(() => db().update(input), ConnectionProfileSchema),
    delete: (request) => settle(() => db().delete(request), acceptAnything),
    test: (request) => settle(() => db().test(request), TestConnectionResultSchema),
    connect: (request) => settle(() => db().connect(request), SessionSchema),
    disconnect: (request) => settle(() => db().disconnect(request), acceptAnything),
    pickSqliteFile: () => settle(() => db().pickSqliteFile(), PickSqliteFileResultSchema),
  }
}
