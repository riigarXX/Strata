import type { Session } from 'electron'

const BASE_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-src': ["'none'"],
  'frame-ancestors': ["'none'"],
} satisfies Record<string, string[]>

/**
 * Con `devServerUrl` (solo dev) se relaja lo mínimo que exige Vite: estilos inline
 * inyectados por el HMR y el websocket del dev server. Sin él, política de producción.
 */
export function buildCsp(devServerUrl?: string): string {
  const directives: Record<string, string[]> = { ...BASE_DIRECTIVES }

  if (devServerUrl) {
    const { host } = new URL(devServerUrl)
    directives['style-src'] = ["'self'", "'unsafe-inline'"]
    directives['connect-src'] = ["'self'", `ws://${host}`]
  }

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ')
}

export function installCsp(session: Pick<Session, 'webRequest'>, devServerUrl?: string): void {
  const policy = buildCsp(devServerUrl)

  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(
        ([name]) => name.toLowerCase() !== 'content-security-policy',
      ),
    )
    responseHeaders['Content-Security-Policy'] = [policy]
    callback({ responseHeaders })
  })
}
