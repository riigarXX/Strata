/** Esquema propio con el que se sirve el renderer compilado (ADR 0011). El host es fijo y no se resuelve a nada. */
export const APP_SCHEME = 'app'
export const APP_HOST = 'strata'
/** Página que carga la ventana principal; la raíz `/` se sirve como esa misma página. */
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

export interface AppOriginConfig {
  /** Solo en desarrollo: URL del dev server de Vite. Si existe, es el único origen permitido. */
  devServerUrl?: string | undefined
}

export interface AppOrigin {
  isAllowedUrl(url: string): boolean
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Único punto donde la URL del dev server entra en la app. En un build empaquetado la variable de entorno
 * se ignora siempre; en desarrollo solo se acepta un `http(s)` de loopback, de modo que un valor arbitrario
 * en el entorno no pueda convertir en «origen de la app» una página remota.
 */
export function resolveDevServerUrl(options: {
  isPackaged: boolean
  rendererUrl: string | undefined
}): string | undefined {
  const { isPackaged, rendererUrl } = options
  if (isPackaged || !rendererUrl) return undefined

  let url: URL
  try {
    url = new URL(rendererUrl)
  } catch {
    throw new Error('ELECTRON_RENDERER_URL is not a valid URL')
  }
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:'
  if (!isHttp || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('ELECTRON_RENDERER_URL must be an http(s) loopback URL')
  }
  return rendererUrl
}

export function createAppOrigin({ devServerUrl }: AppOriginConfig = {}): AppOrigin {
  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : null

  return {
    isAllowedUrl(rawUrl) {
      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        return false
      }

      if (devOrigin) {
        // `blob:` y `filesystem:` heredan el origen de la página que los creó: solo cuentan las URL http(s) directas.
        return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === devOrigin
      }

      // Solo las dos rutas que sirven la página, con el host exacto y sin credenciales ni puerto (`host` incluye el puerto).
      // `origin` no sirve aquí: en un esquema que no es «especial» para WHATWG vale siempre `null`.
      return (
        url.protocol === `${APP_SCHEME}:` &&
        url.host === APP_HOST &&
        url.username === '' &&
        url.password === '' &&
        (url.pathname === '/' || url.pathname === '/index.html')
      )
    },
  }
}
