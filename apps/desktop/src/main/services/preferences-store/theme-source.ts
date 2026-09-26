import type { ThemePreference } from '@strata/contracts'
import type { PreferencesStore } from './preferences-store'

/** Lo único que se usa de `nativeTheme` de Electron. */
export interface ThemeSourceTarget {
  themeSource: ThemePreference
}

/**
 * Hace que `nativeTheme.themeSource` siga a `appearance.theme`, ya desde el arranque (hay que esperarla
 * antes de crear la ventana) y en cada cambio persistido. Así `prefers-color-scheme` del renderer y el
 * fondo nativo de la ventana adoptan el tema desde el primer fotograma, sin atributo `data-theme` ni
 * destello, y `system` sigue al sistema operativo en tiempo real. Devuelve la función que la desengancha.
 */
export async function bindNativeThemeSource(
  store: Pick<PreferencesStore, 'get' | 'subscribe'>,
  target: ThemeSourceTarget,
): Promise<() => void> {
  const unsubscribe = store.subscribe((next, previous) => {
    if (next.appearance.theme !== previous.appearance.theme) {
      target.themeSource = next.appearance.theme
    }
  })
  try {
    target.themeSource = (await store.get()).appearance.theme
  } catch {
    // Sin preferencias legibles se sigue al sistema, que es el valor de fábrica.
  }
  return unsubscribe
}
