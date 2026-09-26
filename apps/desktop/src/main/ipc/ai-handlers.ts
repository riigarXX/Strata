import {
  AiGenerateSqlRequestSchema,
  AiGenerateSqlResultSchema,
  AiListModelsRequestSchema,
  AiModelInfoSchema,
  AiPullModelRequestSchema,
  AiPullResultSchema,
  AiStatusSchema,
  CancelRequestSchema,
  CancelResultSchema,
  IPC_CHANNELS,
} from '@strata/contracts'
import type { AiService } from '../services/ai-service'
import {
  arrayOf,
  createSecureHandlerFactory,
  nothing,
  type IpcHandler,
  type SecureHandlerDependencies,
} from './secure-handler'

export interface AiHandlersDependencies extends SecureHandlerDependencies {
  aiService: Pick<AiService, 'status' | 'listModels' | 'generateSql' | 'pullModel' | 'cancel'>
}

/**
 * Ninguno de estos canales ejecuta SQL: `generateSql` solo devuelve la sentencia clasificada. La pregunta
 * y lo que responde el modelo pasan por aquí sin registrarse. El avance de las descargas sale por
 * `IPC_CHANNELS.ai.pullProgress` (`ai-events.ts`).
 */
export function createAiHandlers({
  aiService,
  ...security
}: AiHandlersDependencies): Readonly<Record<string, IpcHandler>> {
  const channels = IPC_CHANNELS.ai
  const secure = createSecureHandlerFactory(security)

  return {
    [channels.status]: secure({
      input: nothing,
      output: AiStatusSchema,
      run: () => aiService.status(),
    }),
    [channels.listModels]: secure({
      input: AiListModelsRequestSchema,
      output: arrayOf(AiModelInfoSchema),
      run: (request) => aiService.listModels(request),
    }),
    [channels.generateSql]: secure({
      input: AiGenerateSqlRequestSchema,
      output: AiGenerateSqlResultSchema,
      run: (request) => aiService.generateSql(request),
    }),
    [channels.pullModel]: secure({
      input: AiPullModelRequestSchema,
      output: AiPullResultSchema,
      run: (request) => aiService.pullModel(request),
    }),
    [channels.cancel]: secure({
      input: CancelRequestSchema,
      output: CancelResultSchema,
      run: async ({ requestId }) => aiService.cancel(requestId),
    }),
  }
}
