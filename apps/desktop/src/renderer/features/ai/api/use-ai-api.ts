import {
  AiGenerateSqlResultSchema,
  AiModelInfoSchema,
  AiPullProgressSchema,
  AiPullResultSchema,
  AiStatusSchema,
  CancelResultSchema,
  type AiModelInfo,
} from '@strata/contracts'
import type { DbApi } from '../../../../shared/db-api'
import { settleIpc, type Parser } from '../../../composables/settle-ipc'

export type AiApi = DbApi['ai']

const modelList: Parser<AiModelInfo[]> = {
  safeParse(value) {
    if (!Array.isArray(value)) return { success: false }
    const models: AiModelInfo[] = []
    for (const item of value) {
      const parsed = AiModelInfoSchema.safeParse(item)
      if (!parsed.success) return { success: false }
      models.push(parsed.data)
    }
    return { success: true, data: models }
  },
}

/**
 * Envuelve `window.db.ai` (ADR 0012): ningún método lanza (una excepción de IPC o una respuesta malformada se
 * convierten en un `NormalizedError`) y lo que llega (respuestas y avances de descarga empujados por main) se
 * revalida con los schemas de `@strata/contracts`. Lo comparten los ajustes y el panel «Preguntar».
 */
export function useAiApi(): AiApi {
  const db = () => window.db.ai

  return {
    status: () => settleIpc(() => db().status(), AiStatusSchema),
    listModels: (request) => settleIpc(() => db().listModels(request), modelList),
    generateSql: (request) => settleIpc(() => db().generateSql(request), AiGenerateSqlResultSchema),
    pullModel: (request) => settleIpc(() => db().pullModel(request), AiPullResultSchema),
    cancel: (request) => settleIpc(() => db().cancel(request), CancelResultSchema),
    /** Solo entrega avances válidos según el contrato: lo que llega por IPC no es de confianza. */
    onPullProgress: (callback) =>
      db().onPullProgress((progress) => {
        const parsed = AiPullProgressSchema.safeParse(progress)
        if (parsed.success) callback(parsed.data)
      }),
  }
}
