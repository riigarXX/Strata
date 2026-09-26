import { AiPullProgressSchema, IPC_CHANNELS, type AiPullProgress } from '@strata/contracts'
import type { AppOrigin } from '../security/app-origin'
import type { AiService } from '../services/ai-service'
import type { HistoryEventWindow } from './history-events'

export interface AiEventsDependencies {
  aiService: Pick<AiService, 'subscribePullProgress'>
  getMainWindow: () => HistoryEventWindow | null
  appOrigin: AppOrigin
}

/**
 * Empuja el avance de las descargas de modelos a la ventana principal y a nadie más, y solo si su frame
 * principal sigue siendo el de la app. El payload se valida con el mismo schema que revalida el renderer.
 * Devuelve la función que deja de publicar.
 */
export function publishAiProgress({
  aiService,
  getMainWindow,
  appOrigin,
}: AiEventsDependencies): () => void {
  function publish(progress: AiPullProgress): void {
    const contents = getMainWindow()?.webContents
    if (!contents || contents.isDestroyed()) return
    try {
      if (!appOrigin.isAllowedUrl(contents.mainFrame.url)) return
      contents.send(IPC_CHANNELS.ai.pullProgress, AiPullProgressSchema.parse(progress))
    } catch {
      // Un destinatario que desaparece a mitad del envío equivale a no haber destinatario.
    }
  }

  return aiService.subscribePullProgress(publish)
}
