import { ariaKeyShortcut, detectPlatform, formatShortcut, parseShortcut } from '@strata/commands'
import { APP_COMMANDS } from '../commands'

export interface ShortcutHint {
  /** Texto para mostrar (`⌘↵`, `Ctrl+Enter`). */
  display: string
  /** Valor de `aria-keyshortcuts`. */
  aria: string
}

/** Plataforma del sistema en este momento (se lee al llamar: los tests cambian el user agent). */
export function currentPlatform() {
  return detectPlatform(navigator.userAgent)
}

/**
 * Primer atajo declarado para el comando, formateado para la plataforma. Sale del mismo registro que
 * atiende el teclado, así que un botón nunca anuncia un atajo distinto del que funciona.
 */
export function shortcutHint(commandId: string): ShortcutHint | null {
  const declared = APP_COMMANDS.find((command) => command.id === commandId)?.shortcuts?.[0]
  if (declared === undefined) return null
  const chord = parseShortcut(declared)
  const platform = currentPlatform()
  return { display: formatShortcut(chord, platform), aria: ariaKeyShortcut(chord, platform) }
}
