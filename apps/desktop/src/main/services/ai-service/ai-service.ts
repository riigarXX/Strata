import {
  AI_DEFAULT_BASE_URLS,
  normalizeAiBaseUrl,
  type AiGenerateSqlRequest,
  type AiGenerateSqlResult,
  type AiListModelsRequest,
  type AiModelInfo,
  type AiProvider as AiProviderKind,
  type AiPullModelRequest,
  type AiPullProgress,
  type AiPullResult,
  type AiStatus,
  type AiProviderStatus,
  type AiWarning,
  type CancelResult,
  type Preferences,
  type RequestId,
} from '@strata/contracts'
import type { ConnectionManager } from '../connection-manager'
import type { PreferencesStore } from '../preferences-store'
import { DEFAULT_PROVIDER_TIMEOUTS, type AiProvider, type ProviderTimeouts } from './ai-provider'
import { resolveAiEndpoint } from './endpoint'
import { aiError } from './errors'
import { createAiHttp, type AiHttp } from './http'
import { createOllamaProvider } from './ollama-provider'
import { createOpenAiCompatibleProvider } from './openai-provider'
import { buildSystemPrompt, buildUserPrompt, GENERATION_LIMITS } from './prompt'
import {
  buildSchemaContext,
  DEFAULT_SCHEMA_LIMITS,
  type SchemaLimits,
  type SchemaSource,
} from './schema-context'
import { classifySql, extractSql } from './sql-output'

export interface AiServiceDependencies {
  preferences: Pick<PreferencesStore, 'get'>
  connections: Pick<ConnectionManager, 'getSession' | 'transactionState'> & SchemaSource
  /** `fetch` de Node: nunca la pila de red del renderer. Inyectable en los tests. */
  fetch?: typeof fetch
  timeouts?: ProviderTimeouts
  schemaLimits?: SchemaLimits
  /** Dónde se busca cada servidor por defecto; los tests lo apuntan a servidores falsos para no sondear puertos reales. */
  defaultBaseUrls?: Readonly<Record<AiProviderKind, string>>
}

/**
 * Asistente de IA local (ADR 0012). Habla solo con un servidor de modelos en el bucle local y no ejecuta nada:
 * devuelve una sentencia saneada y clasificada; decide el renderer, que la ejecuta por el flujo normal.
 * Nunca escribe en el registro ni la pregunta, ni el esquema, ni la respuesta del modelo.
 */
export interface AiService {
  /** Sondea los puertos por defecto de Ollama y LM Studio y, si es otra, la dirección configurada. */
  status(): Promise<AiStatus>
  listModels(request: AiListModelsRequest): Promise<AiModelInfo[]>
  generateSql(request: AiGenerateSqlRequest): Promise<AiGenerateSqlResult>
  /** Resuelve al terminar la descarga; el avance sale por `subscribePullProgress`. */
  pullModel(request: AiPullModelRequest): Promise<AiPullResult>
  /** Cancela una generación o una descarga; idempotente. */
  cancel(requestId: RequestId): CancelResult
  subscribePullProgress(listener: (progress: AiPullProgress) => void): () => void
  /** Cancela todo lo que esté en curso (al cerrar la aplicación). */
  dispose(): void
}

const MAX_CONCURRENT_GENERATIONS = 2
const MAX_CONCURRENT_PULLS = 1
// El avance de una descarga son cientos de líneas por segundo: al renderer llega una fracción.
const PROGRESS_MIN_INTERVAL_MS = 200

type Operation = 'generate' | 'pull'
type AiPreferences = Preferences['ai']

export function createAiService({
  preferences,
  connections,
  fetch: fetchImpl,
  timeouts = DEFAULT_PROVIDER_TIMEOUTS,
  schemaLimits = DEFAULT_SCHEMA_LIMITS,
  defaultBaseUrls = AI_DEFAULT_BASE_URLS,
}: AiServiceDependencies): AiService {
  const http: AiHttp = createAiHttp(fetchImpl)
  const running = new Map<RequestId, { operation: Operation; controller: AbortController }>()
  const progressListeners = new Set<(progress: AiPullProgress) => void>()

  function createProvider(kind: AiProviderKind, baseUrl: string): AiProvider {
    const base = resolveAiEndpoint(baseUrl)
    return kind === 'ollama'
      ? createOllamaProvider(base, http, timeouts)
      : createOpenAiCompatibleProvider(base, http, timeouts)
  }

  // Lo que la petición no dice sale de las preferencias; otro proveedor sin dirección usa la suya por defecto.
  function endpointFor(saved: AiPreferences, request: AiListModelsRequest) {
    const provider = request.provider ?? saved.provider
    const baseUrl =
      request.baseUrl ?? (provider === saved.provider ? saved.baseUrl : defaultBaseUrls[provider])
    return { provider, baseUrl }
  }

  async function requireEnabled(): Promise<AiPreferences> {
    const { ai } = await preferences.get()
    if (!ai.enabled) throw aiError('permission_denied', 'The local AI assistant is disabled', false)
    return ai
  }

  function begin(requestId: RequestId, operation: Operation): AbortController {
    const limit = operation === 'pull' ? MAX_CONCURRENT_PULLS : MAX_CONCURRENT_GENERATIONS
    const sameKind = [...running.values()].filter((entry) => entry.operation === operation)
    if (running.has(requestId) || sameKind.length >= limit) {
      throw aiError('busy', 'The AI assistant is already working on another request', true)
    }
    const controller = new AbortController()
    running.set(requestId, { operation, controller })
    return controller
  }

  function publishProgress(progress: AiPullProgress): void {
    for (const listener of [...progressListeners]) {
      try {
        listener(progress)
      } catch {
        // Un oyente defectuoso no debe cortar la descarga ni a los demás.
      }
    }
  }

  return {
    async status() {
      const saved = (await preferences.get()).ai
      const savedUrl = normalizeAiBaseUrl(saved.baseUrl) ?? saved.baseUrl
      const candidates: { provider: AiProviderKind; baseUrl: string }[] = [
        { provider: 'ollama', baseUrl: defaultBaseUrls.ollama },
        { provider: 'lmstudio', baseUrl: defaultBaseUrls.lmstudio },
      ]
      if (!candidates.some((candidate) => candidate.baseUrl === savedUrl)) {
        candidates.push({ provider: saved.provider, baseUrl: savedUrl })
      }
      const providers = await Promise.all(
        candidates.map(async ({ provider, baseUrl }): Promise<AiProviderStatus> => {
          const probe = await createProvider(provider, baseUrl).probe()
          return { provider, baseUrl, ...probe }
        }),
      )
      return { providers }
    },

    async listModels(request) {
      const { provider, baseUrl } = endpointFor((await preferences.get()).ai, request)
      return createProvider(provider, baseUrl).listModels()
    },

    async generateSql({ requestId, sessionId, question }) {
      const saved = await requireEnabled()
      const session = connections.getSession(sessionId)
      if (!session) throw aiError('no_session', 'The session does not exist or was closed', false)

      // PostgreSQL rechaza hasta las lecturas del catálogo (25P02) en una transacción abortada: se avisa antes de
      // armar el esquema, que de otro modo sale como «salida no válida del modelo». Una transacción abierta sí se lee.
      if (connections.transactionState(sessionId) === 'aborted') {
        throw aiError(
          'transaction_aborted',
          'The transaction is aborted: roll it back before asking',
          false,
        )
      }

      const controller = begin(requestId, 'generate')
      try {
        const provider = createProvider(saved.provider, saved.baseUrl)
        const schema = await buildSchemaContext(
          connections,
          session,
          question,
          controller.signal,
          schemaLimits,
        )
        const answer = await provider.generate(
          {
            model: saved.model,
            system: buildSystemPrompt(session),
            user: buildUserPrompt(schema.text, question),
            ...GENERATION_LIMITS,
          },
          controller.signal,
        )

        const classified = classifySql(session.engine, extractSql(answer))
        const warnings: AiWarning[] = schema.truncated
          ? [...classified.warnings, 'schema_truncated']
          : classified.warnings
        const blocked = session.readOnly && classified.risk !== 'read'
        return {
          requestId,
          sql: classified.sql,
          risk: classified.risk,
          statementType: classified.statementType,
          warnings: blocked ? [...warnings, 'read_only_blocked'] : warnings,
          ...(blocked && { blocked: true }),
        }
      } catch (reason) {
        // Una cancelación durante la lectura del esquema salta como AbortError propio, no como el del cliente HTTP.
        if (controller.signal.aborted)
          throw aiError('cancelled', 'The request was cancelled', false)
        throw reason
      } finally {
        running.delete(requestId)
      }
    },

    async pullModel({ requestId, model }) {
      const saved = await requireEnabled()
      const provider = createProvider(saved.provider, saved.baseUrl)
      if (!provider.pullModel) {
        throw aiError('validation_failed', 'This AI server does not download models', false)
      }
      const controller = begin(requestId, 'pull')
      let lastEmitted = 0
      let lastStatus = ''
      try {
        await provider.pullModel(
          model,
          (progress) => {
            const now = Date.now()
            const changed = progress.status !== lastStatus
            const complete = progress.total !== null && progress.completed === progress.total
            if (!changed && !complete && now - lastEmitted < PROGRESS_MIN_INTERVAL_MS) return
            lastEmitted = now
            lastStatus = progress.status
            publishProgress({ requestId, model, ...progress })
          },
          controller.signal,
        )
        return { requestId, model }
      } finally {
        running.delete(requestId)
      }
    },

    cancel(requestId) {
      const entry = running.get(requestId)
      if (!entry) return { requestId, outcome: 'not_running' }
      entry.controller.abort()
      return { requestId, outcome: 'requested' }
    },

    subscribePullProgress(listener) {
      progressListeners.add(listener)
      return () => {
        progressListeners.delete(listener)
      }
    },

    dispose() {
      for (const { controller } of running.values()) controller.abort()
      progressListeners.clear()
    },
  }
}
