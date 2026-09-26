import type { App } from 'electron'
import type { AppOrigin } from './app-origin'
import { hardenWebContents } from './navigation-guard'
import { hardenSession } from './session-policy'

type PolicyApp = Pick<App, 'on'>

export interface AppPolicyOptions {
  appOrigin: AppOrigin
  /** Solo desarrollo: relaja la CSP de las sesiones. `undefined` en un build empaquetado. */
  devServerUrl: string | undefined
}

/**
 * Política global: se registra antes de que exista ninguna ventana, de modo que ningún `webContents`
 * (ventana principal, DevTools, popups, subframes) ni ninguna sesión se libre de ella.
 * La sesión por defecto se endurece aparte con `hardenSession` una vez lista la app.
 */
export function installAppPolicy(
  app: PolicyApp,
  { appOrigin, devServerUrl }: AppPolicyOptions,
): void {
  app.on('web-contents-created', (_event, webContents) => {
    hardenWebContents(webContents, appOrigin)
  })

  app.on('session-created', (session) => {
    hardenSession(session, { devServerUrl })
  })

  // Sin excepciones: un certificado inválido nunca se acepta ni se «recuerda».
  app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault()
    callback(false)
  })

  // Sin este listener Chromium elegiría por su cuenta el primer certificado de cliente disponible.
  app.on('select-client-certificate', (event, _webContents, _url, _certificates, callback) => {
    event.preventDefault()
    callback()
  })
}
