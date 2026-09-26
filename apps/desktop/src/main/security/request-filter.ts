import type { Session } from 'electron'
import { APP_HOST, APP_SCHEME } from './app-origin'

/**
 * El renderer se sirve por `app://`, no por `file:`: ninguna petición `file:` (`fetch`, `<script src>`, `<img>`,
 * subframes…) tiene motivo legítimo, así que se cancelan todas. Del esquema propio solo se acepta el host de la app.
 * El resto de esquemas (http del dev server, `data:`, `blob:`, `devtools:`) los gobiernan la CSP y los guards de navegación.
 */
export function isRequestAllowed(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol === 'file:') return false
  if (url.protocol === `${APP_SCHEME}:`) return url.host === APP_HOST
  return true
}

export function installRequestFilter(session: Pick<Session, 'webRequest'>): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isRequestAllowed(details.url) })
  })
}
