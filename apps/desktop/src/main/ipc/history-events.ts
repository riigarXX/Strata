import { HistoryChangeSchema, IPC_CHANNELS, type HistoryChange } from '@strata/contracts'
import type { AppOrigin } from '../security/app-origin'
import type { HistoryStore } from '../services/history-store'

/** Lo mínimo de la ventana principal que necesita la publicación; `BrowserWindow` real lo cumple. */
export interface HistoryEventWindow {
  webContents: {
    send(channel: string, payload: unknown): void
    isDestroyed(): boolean
    mainFrame: { url: string }
  }
}

export interface HistoryEventsDependencies {
  historyStore: Pick<HistoryStore, 'subscribe'>
  getMainWindow: () => HistoryEventWindow | null
  appOrigin: AppOrigin
}

/**
 * Empuja cada cambio del historial a la ventana principal y a nadie más: el texto SQL solo llega a un frame
 * que sigue siendo el de la app (si el frame navegó a otro origen, el cambio se descarta). El payload se
 * valida con el mismo schema que revalida el renderer. Devuelve la función que deja de publicar.
 */
export function publishHistoryChanges({
  historyStore,
  getMainWindow,
  appOrigin,
}: HistoryEventsDependencies): () => void {
  function publish(change: HistoryChange): void {
    const contents = getMainWindow()?.webContents
    if (!contents || contents.isDestroyed()) return
    try {
      if (!appOrigin.isAllowedUrl(contents.mainFrame.url)) return
      contents.send(IPC_CHANNELS.history.changed, HistoryChangeSchema.parse(change))
    } catch {
      // Un destinatario que desaparece a mitad del envío equivale a no haber destinatario.
    }
  }

  return historyStore.subscribe(publish)
}
