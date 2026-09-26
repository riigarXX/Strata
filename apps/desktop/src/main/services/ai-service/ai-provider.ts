import type { AiModelInfo } from '@strata/contracts'

export interface GenerateRequest {
  model: string
  system: string
  user: string
  maxTokens: number
  temperature: number
  /** Ventana de contexto que se le pide al servidor; sin ella algunos usan una por defecto más corta que el prompt. */
  contextTokens: number
}

export interface PullProgress {
  status: string
  completed: number | null
  total: number | null
}

export interface ProviderProbe {
  reachable: boolean
  version: string | null
}

/** Un servidor local de modelos. Todas las llamadas son a la dirección de bucle local con la que se construyó. */
export interface AiProvider {
  probe(signal?: AbortSignal): Promise<ProviderProbe>
  listModels(signal?: AbortSignal): Promise<AiModelInfo[]>
  /** Devuelve el texto que respondió el modelo, sin tratar. */
  generate(request: GenerateRequest, signal?: AbortSignal): Promise<string>
  /** `undefined` si el servidor no descarga modelos (LM Studio y compatibles: se gestionan en su propia aplicación). */
  pullModel?(
    model: string,
    onProgress: (progress: PullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void>
}

export interface ProviderTimeouts {
  probeMs: number
  listMs: number
  generateMs: number
  pullIdleMs: number
}

export const DEFAULT_PROVIDER_TIMEOUTS: ProviderTimeouts = {
  probeMs: 1_500,
  listMs: 5_000,
  // Incluye cargar el modelo en memoria la primera vez.
  generateMs: 120_000,
  // Sin recibir ni una línea de progreso.
  pullIdleMs: 120_000,
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/

// Ni LM Studio ni los servidores compatibles con OpenAI dicen qué modelos son de embeddings: solo queda el nombre.
const EMBEDDING_NAME = /embed/i
// Familias de arquitectura de solo codificador que Ollama reporta para modelos de embeddings (`nomic-bert`, `bert`, `jina-bert-v2`…).
const EMBEDDING_FAMILY = /bert/i

/** Solo se ofrecen nombres que el usuario podrá guardar como preferencia. */
export function toModelInfo(
  name: unknown,
  size: unknown,
  embedding: boolean = typeof name === 'string' && EMBEDDING_NAME.test(name),
): AiModelInfo | undefined {
  if (typeof name !== 'string' || !MODEL_NAME.test(name)) return undefined
  const sizeBytes =
    typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : null
  return { name, sizeBytes, embedding }
}

/**
 * Un modelo de `/api/tags` de Ollama. Las versiones recientes lo dicen en `capabilities`; en las que no traen
 * ese campo se recurre a la familia (`bert`) y al nombre. Si `capabilities` existe, manda: un modelo que declara
 * `completion` no es de embeddings aunque su nombre lo sugiera.
 */
export function isOllamaEmbedding(model: Record<string, unknown>): boolean {
  const { capabilities, details, name } = model
  if (Array.isArray(capabilities)) return capabilities.includes('embedding')
  const families: unknown[] = []
  if (isRecord(details)) {
    families.push(details['family'])
    if (Array.isArray(details['families'])) families.push(...details['families'])
  }
  return (
    families.some((family) => typeof family === 'string' && EMBEDDING_FAMILY.test(family)) ||
    (typeof name === 'string' && EMBEDDING_NAME.test(name))
  )
}

export const MAX_MODELS = 500
