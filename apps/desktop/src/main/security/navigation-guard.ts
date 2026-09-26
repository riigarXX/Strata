import type { WebContents } from 'electron'
import type { AppOrigin } from './app-origin'

type GuardedWebContents = Pick<WebContents, 'on' | 'setWindowOpenHandler'>

export function hardenWebContents(webContents: GuardedWebContents, appOrigin: AppOrigin): void {
  webContents.on('will-navigate', (event, url) => {
    if (!appOrigin.isAllowedUrl(url)) event.preventDefault()
  })

  // Cubre también los subframes, a los que `will-navigate` no llega.
  webContents.on('will-frame-navigate', (event) => {
    if (!appOrigin.isAllowedUrl(event.url)) event.preventDefault()
  })

  webContents.on('will-redirect', (event, url) => {
    if (!appOrigin.isAllowedUrl(url)) event.preventDefault()
  })

  // Ningún destino externo está permitido en el MVP (docs/threat-model.md).
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // `webviewTag` ya está desactivado; esto lo mantiene cerrado aunque alguien lo active por error.
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}
