import { join } from 'node:path'
import themeTokens from '@strata/design-tokens/tokens.json'
import { BrowserWindow, nativeTheme } from 'electron'
import { APP_ENTRY_URL } from '../security/app-origin'
import { createWebPreferences } from '../security/web-preferences'
import { resolveWindowBackground, themeMode, trafficLightPosition } from './window-background'

/**
 * Tamaño mínimo de la ventana, medido sobre el build con la barra lateral por defecto (240 px): con 692 px de ancho
 * la barra del editor aún cabe en 2 líneas y a 688 «Historial» cae a una tercera, así que 720 deja 28 px de margen.
 * De alto, 560 px dejan unos 240 px al panel de resultados (a 480 quedan 160, con el grid reducido a la cabecera
 * y poco más).
 */
export const MIN_WINDOW_WIDTH = 720
export const MIN_WINDOW_HEIGHT = 560

export interface MainWindowOptions {
  devServerUrl: string | undefined
}

function currentBackground(): string {
  return resolveWindowBackground(themeTokens, themeMode(nativeTheme.shouldUseDarkColors))
}

export function createMainWindow({ devServerUrl }: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    // Barra de título integrada: el renderer dibuja la barra superior y deja libre el hueco de los semáforos.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: trafficLightPosition(themeTokens),
    backgroundColor: currentBackground(),
    webPreferences: createWebPreferences(join(__dirname, '../preload/index.js')),
  })

  // El fondo sigue al tema del sistema para que no haya destello claro/oscuro antes del primer pintado.
  const syncBackground = (): void => window.setBackgroundColor(currentBackground())
  nativeTheme.on('updated', syncBackground)
  window.once('closed', () => nativeTheme.off('updated', syncBackground))

  // La navegación, `window.open` y `<webview>` los cierra `installAppPolicy` para todo `webContents`, este incluido.
  window.once('ready-to-show', () => window.show())

  void window.loadURL(devServerUrl ?? APP_ENTRY_URL)

  return window
}
