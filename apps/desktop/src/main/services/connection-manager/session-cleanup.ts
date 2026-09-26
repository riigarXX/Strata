import type { ConnectionManager } from './connection-manager'

export interface AppQuitEmitter {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

/**
 * Cierra todas las sesiones antes de salir. Como el cierre es asíncrono, la primera salida se aplaza
 * (`preventDefault`) y se relanza `quit()` cuando termina; sin sesiones activas no interfiere.
 */
export function closeSessionsOnQuit(
  app: AppQuitEmitter,
  connectionManager: Pick<ConnectionManager, 'hasActiveSessions' | 'closeAll'>,
): void {
  let cleaned = false

  app.on('before-quit', (event) => {
    if (cleaned || !connectionManager.hasActiveSessions()) return
    event.preventDefault()
    cleaned = true
    void connectionManager.closeAll().finally(() => app.quit())
  })
}
