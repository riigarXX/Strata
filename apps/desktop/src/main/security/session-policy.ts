import type { Session } from 'electron'
import { installCsp } from './csp'
import { installRequestFilter } from './request-filter'

type PolicySession = Pick<
  Session,
  | 'setPermissionRequestHandler'
  | 'setPermissionCheckHandler'
  | 'setDevicePermissionHandler'
  | 'setDisplayMediaRequestHandler'
  | 'webRequest'
>

export interface SessionPolicyOptions {
  /** Solo desarrollo: relaja la CSP. `undefined` en un build empaquetado. */
  devServerUrl: string | undefined
}

/**
 * Política de una sesión: CSP y denegación de todos los permisos del navegador (cámara, micro, geolocalización,
 * notificaciones, dispositivos, captura de pantalla, portapapeles de lectura…). La app no necesita ninguno:
 * la copia del grid usa `execCommand('copy')` y un gesto del usuario, que no pasa por el sistema de permisos.
 * Además cancela toda petición `file:`. Se aplica a `session.defaultSession` y a toda sesión que se cree después.
 */
export function hardenSession(
  session: PolicySession,
  { devServerUrl }: SessionPolicyOptions,
): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  // Un callback sin `video` ni `audio` rechaza la captura.
  session.setDisplayMediaRequestHandler((_request, callback) => {
    callback({})
  })
  installCsp(session, devServerUrl)
  installRequestFilter(session)
}
