import { logger } from '../../logging/logger'
import type { QueryHistoryRecorder } from '../query-executor'
import type { HistoryStore } from './history-store'

export interface HistoryRecorderDependencies {
  store: Pick<HistoryStore, 'add'>
  /** `history.enabled` de las preferencias, consultado en cada registro para respetar un cambio al instante. */
  isEnabled(): Promise<boolean>
  /** Recibe un aviso fijo, nunca la causa: el fallo de un almacén local no es asunto de quien ejecuta. */
  onError?: () => void
}

const warn = (): void => {
  logger.warn('History: a query could not be saved')
}

/**
 * Adaptador entre el ejecutor de consultas y el `HistoryStore`. `record` no espera a nada ni lanza:
 * el registro ocurre en segundo plano y cualquier fallo (E/S, preferencias ilegibles, entrada inválida)
 * se absorbe, de modo que el historial nunca puede hacer fallar ni retrasar una ejecución.
 */
export function createHistoryRecorder({
  store,
  isEnabled,
  onError = warn,
}: HistoryRecorderDependencies): QueryHistoryRecorder {
  return {
    record(entry, context) {
      void (async () => {
        try {
          if (await isEnabled()) await store.add(entry, context)
        } catch {
          try {
            onError()
          } catch {
            // El aviso tampoco puede afectar a la ejecución.
          }
        }
      })()
    },
  }
}
