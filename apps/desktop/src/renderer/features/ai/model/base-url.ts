import { AI_MIN_PORT, AiBaseUrlSchema, normalizeAiBaseUrl } from '@strata/contracts'

export type ParsedBaseUrl = { ok: true; value: string } | { ok: false; error: string }

const EXAMPLE = 'http://127.0.0.1:11434'

/**
 * Valida con la misma regla que main (`AiBaseUrlSchema`) y devuelve la forma canónica. El schema decide;
 * el motivo del rechazo solo sirve para explicárselo al usuario.
 */
export function parseBaseUrl(input: string): ParsedBaseUrl {
  const text = input.trim()
  if (text === '')
    return { ok: false, error: `Escribe la dirección del servidor, por ejemplo ${EXAMPLE}.` }

  const parsed = AiBaseUrlSchema.safeParse(text)
  const canonical = parsed.success ? normalizeAiBaseUrl(parsed.data) : undefined
  if (canonical !== undefined) return { ok: true, value: canonical }
  return { ok: false, error: explain(text) }
}

function explain(text: string): string {
  if (!/^https?:\/\//i.test(text)) return `Empieza por http:// o https://, por ejemplo ${EXAMPLE}.`
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i.test(text)) {
    return 'Solo se admiten direcciones de este equipo: 127.0.0.1, localhost o [::1].'
  }
  const port = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)(?=[/?#\\]|$)/i.exec(text)?.[1]
  if (port === undefined) return `Indica el puerto, por ejemplo ${EXAMPLE}.`
  if (Number(port) < AI_MIN_PORT || Number(port) > 65535) {
    return `El puerto debe estar entre ${AI_MIN_PORT} y 65535.`
  }
  return `La dirección no es válida: usa solo http(s), el host, el puerto y, si hace falta, una ruta sencilla, por ejemplo ${EXAMPLE}.`
}
