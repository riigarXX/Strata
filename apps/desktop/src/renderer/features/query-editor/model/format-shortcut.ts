export interface KeyEventLike {
  key: string
  code: string
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  repeat: boolean
}

/**
 * `Shift+Alt+F`. En macOS Option+Shift+F produce «Ï» como `key`, y el keymap de CodeMirror no prueba
 * la tecla física con Alt en Mac, por eso se reconoce aquí por `code` además de por `key`.
 */
export function isFormatShortcut(event: KeyEventLike): boolean {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || event.repeat)
    return false
  return event.code === 'KeyF' || event.key.toLowerCase() === 'f'
}
