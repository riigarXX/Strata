import { homedir } from 'node:os'
import { redactSensitive } from '@strata/db-core'

export interface LogSink {
  warn(line: string): void
  error(line: string): void
}

export interface Logger {
  warn(message: string, reason?: unknown): void
  error(message: string, reason?: unknown): void
}

export interface LoggerOptions {
  sink?: LogSink
  /** Rutas del sistema que nunca deben aparecer en una línea (perfil del usuario, `userData`…). */
  paths?: readonly string[]
}

const MAX_LINE_LENGTH = 300
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/
const ERROR_CODE = /^[A-Z0-9_]{2,40}$/

function codeOf(reason: object): string | undefined {
  const code = 'code' in reason ? reason.code : undefined
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined
}

/**
 * De una causa solo se describe su clase y su código (`ECONNREFUSED`, `ENOENT`, un SQLSTATE): nunca su
 * mensaje, su pila ni sus propiedades, que pueden traer host, usuario, cadena de conexión, rutas o passwords.
 */
function describeReason(reason: unknown): string {
  if (reason === undefined) return ''
  const name = reason instanceof Error && ERROR_NAME.test(reason.name) ? reason.name : typeof reason
  const code = typeof reason === 'object' && reason !== null ? codeOf(reason) : undefined
  return ` [${code ? `${name} ${code}` : name}]`
}

/** Registro con redacción obligatoria: el texto lo escribe el desarrollador y la causa se reduce a clase y código. */
export function createLogger({ sink = console, paths = [homedir()] }: LoggerOptions = {}): Logger {
  const format = (message: string, reason: unknown): string => {
    let text = message
    for (const filePath of paths) {
      if (filePath.length > 1) text = redactSensitive(text, { filePath })
    }
    return `[strata] ${text.replace(/\s+/g, ' ').trim()}${describeReason(reason)}`.slice(
      0,
      MAX_LINE_LENGTH,
    )
  }

  return {
    warn: (message, reason) => sink.warn(format(message, reason)),
    error: (message, reason) => sink.error(format(message, reason)),
  }
}

export const logger: Logger = createLogger()
