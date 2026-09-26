import type { AppOrigin } from './app-origin'

interface SenderFrame {
  url: string
}

export interface IpcSenderLike {
  sender: { mainFrame: SenderFrame }
  senderFrame: SenderFrame | null
}

/**
 * Acepta solo mensajes del frame principal de la ventana principal y con URL de origen permitido.
 * Rechaza subframes, frames destruidos (`senderFrame` nulo) y cualquier otra ventana.
 */
export function isTrustedSender(
  event: IpcSenderLike,
  mainWindowWebContents: object | null,
  appOrigin: AppOrigin,
): boolean {
  if (!mainWindowWebContents || event.sender !== mainWindowWebContents) return false
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false
  return appOrigin.isAllowedUrl(event.senderFrame.url)
}

export function assertTrustedSender(
  event: IpcSenderLike,
  mainWindowWebContents: object | null,
  appOrigin: AppOrigin,
): void {
  if (!isTrustedSender(event, mainWindowWebContents, appOrigin)) {
    throw new Error('IPC sender not allowed')
  }
}
