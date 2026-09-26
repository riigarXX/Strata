import { CancelResultSchema, QueryEventSchema, TransactionResultSchema } from '@strata/contracts'
import type { DbApi } from '../../../../shared/db-api'
import { acceptAnything, settleIpc } from '../../../composables/settle-ipc'

export interface QueryApi {
  execute: DbApi['query']['execute']
  cancel: DbApi['query']['cancel']
  ack: DbApi['query']['ack']
  /** Solo entrega eventos válidos según el contrato: lo que llega por IPC no es de confianza. */
  onEvent: DbApi['query']['onEvent']
  transactions: DbApi['transactions']
}

/**
 * Envuelve `window.db.query` y `window.db.transactions`: ningún método lanza (excepciones y respuestas
 * malformadas pasan a ser un `NormalizedError`) y los eventos y resultados se revalidan con `@strata/contracts`.
 */
export function useQueryApi(): QueryApi {
  const query = () => window.db.query
  const transactions = () => window.db.transactions

  return {
    execute: (request) => settleIpc(() => query().execute(request), acceptAnything),
    cancel: (request) => settleIpc(() => query().cancel(request), CancelResultSchema),
    ack: (ack) => settleIpc(() => query().ack(ack), acceptAnything),
    onEvent: (callback) =>
      query().onEvent((event) => {
        const parsed = QueryEventSchema.safeParse(event)
        if (parsed.success) callback(parsed.data)
      }),
    transactions: {
      begin: (request) => settleIpc(() => transactions().begin(request), TransactionResultSchema),
      commit: (request) => settleIpc(() => transactions().commit(request), TransactionResultSchema),
      rollback: (request) =>
        settleIpc(() => transactions().rollback(request), TransactionResultSchema),
    },
  }
}
