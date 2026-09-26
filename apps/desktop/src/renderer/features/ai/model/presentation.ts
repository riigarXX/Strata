import {
  AI_DEFAULT_MODEL,
  type AiModelInfo,
  type AiProvider,
  type NormalizedError,
} from '@strata/contracts'
import type { PullProgressState, PullStage } from './pull-progress'

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'Personalizado (compatible con OpenAI)',
}

/** Nombre corto para frases («No se pudo conectar con Ollama»). */
export const PROVIDER_SHORT_LABELS: Record<AiProvider, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  custom: 'el servidor',
}

export const RECOMMENDED_MODEL = { name: AI_DEFAULT_MODEL, approxSize: '9 GB' } as const

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

const NUMBER_1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 })
const NUMBER_0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 })

/** Tamaños decimales (1 GB = 10^9 bytes) como los muestran Ollama y macOS: «9,3 GB». */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const text =
    unit === 0 ? String(Math.round(value)) : (value < 100 ? NUMBER_1 : NUMBER_0).format(value)
  return `${text} ${UNITS[unit]}`
}

export function formatPercent(percent: number): string {
  return `${Math.min(100, Math.max(0, Math.round(percent)))} %`
}

export function modelOptionLabel(model: AiModelInfo): string {
  return model.sizeBytes === null ? model.name : `${model.name} · ${formatBytes(model.sizeBytes)}`
}

export const PULL_STAGE_LABELS: Record<PullStage, string> = {
  preparing: 'Preparando la descarga…',
  downloading: 'Descargando',
  verifying: 'Verificando la descarga…',
  finishing: 'Terminando…',
}

/** Texto único del avance, sin depender del color: etapa, porcentaje y bytes («Descargando 45 % · 4,2 GB de 9,3 GB»). */
export function describePullProgress(progress: PullProgressState): string {
  const stage = PULL_STAGE_LABELS[progress.stage]
  if (progress.percent === null || progress.total === null) return stage
  if (progress.stage !== 'downloading') return `${stage} ${formatPercent(progress.percent)}`
  return `${stage} ${formatPercent(progress.percent)} · ${formatBytes(progress.completed)} de ${formatBytes(progress.total)}`
}

export type AiErrorContext = 'connect' | 'models' | 'pull'

/**
 * Mensajes propios de la interfaz según el código: main solo envía frases fijas en inglés y de un servidor que
 * no controlamos, así que nada de lo que llega se muestra tal cual. Un servidor caído y un disco lleno se
 * distinguen mal desde aquí (el contrato no lo separa), por eso el mensaje de descarga menciona ambos.
 */
export function describeAiError(error: NormalizedError, context: AiErrorContext): string {
  switch (error.code) {
    case 'cancelled':
      return 'Descarga cancelada.'
    case 'timeout':
      return context === 'pull'
        ? 'La descarga se detuvo: el servidor dejó de responder. Vuelve a intentarlo; lo ya descargado se conserva.'
        : 'El servidor tardó demasiado en responder.'
    case 'connection_failed':
      return context === 'pull'
        ? 'No se pudo completar la descarga. Comprueba que Ollama sigue en marcha y que hay espacio libre en el disco.'
        : 'No se pudo conectar con el servidor. Comprueba que está en marcha y que la dirección es correcta.'
    case 'not_found':
      return context === 'pull'
        ? 'Ollama no encuentra ese modelo en su biblioteca.'
        : 'El servidor no ofrece la lista de modelos en esa dirección.'
    case 'permission_denied':
      return context === 'pull'
        ? 'Activa la IA local para poder descargar modelos.'
        : 'El servidor rechazó la petición.'
    case 'busy':
      return context === 'pull'
        ? 'Ya hay una descarga en curso.'
        : 'El servidor está ocupado. Inténtalo de nuevo en unos segundos.'
    case 'validation_failed':
      return context === 'pull'
        ? 'Este servidor no descarga modelos desde Strata: instálalos desde su propia aplicación.'
        : 'La dirección o el servidor no son válidos.'
    default:
      return 'Ha ocurrido un error inesperado. Vuelve a intentarlo.'
  }
}

export const START_HINTS: Record<AiProvider, string> = {
  ollama: 'Abre la aplicación de Ollama o ejecuta «ollama serve» en una terminal.',
  lmstudio: 'Inicia el servidor local de LM Studio (pestaña Developer) y carga un modelo.',
  custom: 'Comprueba que el servidor compatible con OpenAI está en marcha en esa dirección.',
}
