import type { ConnectionProfile, Engine, NormalizedError, SslMode } from '@strata/contracts'

export type ConnectionUiStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export const ENGINE_LABELS: Record<Engine, string> = {
  postgres: 'PostgreSQL',
  sqlite: 'SQLite',
}

export const SSL_LABELS: Record<SslMode, string> = {
  disable: 'Desactivado',
  require: 'Requerido',
  'verify-full': 'Verificación completa',
}

// El estado siempre se comunica con texto; el glifo de refuerzo lo aporta el CSS desde los tokens
// (`connection.glyph.*`, `status.glyph.*`) en un elemento aria-hidden.
export const STATUS_PRESENTATION: Record<ConnectionUiStatus, { label: string }> = {
  disconnected: { label: 'Desconectado' },
  connecting: { label: 'Conectando' },
  connected: { label: 'Conectado' },
  error: { label: 'Error' },
}

export function describeTarget(profile: ConnectionProfile): string {
  return profile.engine === 'sqlite'
    ? profile.filePath
    : `${profile.user}@${profile.host}:${profile.port}/${profile.database}`
}

/** Cierra la frase con un punto si no termina ya en puntuación, para poder encadenar otra detrás. */
export function endSentence(text: string): string {
  const trimmed = text.trim()
  return trimmed === '' || /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

/** El punto entre las frases lo necesitan los lectores de pantalla para separarlas al leer el mensaje. */
export function describeError(error: NormalizedError): string {
  return error.retryable ? `${endSentence(error.message)} Puedes reintentarlo.` : error.message
}
