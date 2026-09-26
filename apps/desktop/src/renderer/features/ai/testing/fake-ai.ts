import {
  AI_DEFAULT_BASE_URLS,
  normalizeAiBaseUrl,
  type AiGenerateSqlRequest,
  type AiGenerateSqlResult,
  type AiModelInfo,
  type AiProvider,
  type AiProviderStatus,
  type NormalizedError,
} from '@strata/contracts'
import { ipcFail, ipcOk, type IpcResult } from '../../../../shared/ipc-result'
import type { createFakeDb } from '../../connections/testing/fake-db'

export const QWEN: AiModelInfo = { name: 'qwen3:14b', sizeBytes: 9_276_000_000, embedding: false }
export const EMBEDDINGS: AiModelInfo = {
  name: 'nomic-embed-text',
  sizeBytes: 274_000_000,
  embedding: true,
}
export const LM_STUDIO_MODEL: AiModelInfo = {
  name: 'qwen/qwen3.8-27b',
  sizeBytes: null,
  embedding: false,
}

export const CONNECTION_ERROR: NormalizedError = {
  code: 'connection_failed',
  message: 'Could not reach the local AI server',
  retryable: true,
}

export const CANCELLED_ERROR: NormalizedError = {
  code: 'cancelled',
  message: 'The request was cancelled',
  retryable: false,
}

export const PULL_FAILED_ERROR: NormalizedError = {
  code: 'connection_failed',
  message: 'The model download failed',
  retryable: false,
}

export interface FakeServer {
  reachable: boolean
  version: string | null
  models: AiModelInfo[]
  /** Si se define, `listModels` responde con este error aunque el servidor esté en marcha. */
  listError?: NormalizedError
}

export interface FakeAiOptions {
  /** Ollama en el puerto por defecto: en marcha, con `qwen3:14b` y un modelo de embeddings. */
  ollama?: Partial<FakeServer>
  /** LM Studio en el puerto por defecto: apagado salvo que se indique. */
  lmstudio?: Partial<FakeServer>
}

type FakeDb = Pick<ReturnType<typeof createFakeDb>, 'ai' | 'storedPreferences' | 'emitPullProgress'>

interface ActivePull {
  requestId: string
  model: string
  settle: (result: IpcResult<{ requestId: string; model: string }>) => void
}

/**
 * Servidores de modelos en memoria detrás de `window.db.ai`, con las reglas visibles de main: `status` sondea
 * los puertos por defecto y el servidor guardado, `listModels` usa las preferencias si la petición no dice
 * nada, y `pullModel` exige el asistente activado y Ollama. La descarga queda abierta hasta que el test la
 * termina (`pull.finish`), la hace fallar (`pull.fail`) o la cancela.
 */
export function stubAi(fake: FakeDb, options: FakeAiOptions = {}) {
  const server = (defaults: FakeServer, overrides: Partial<FakeServer> = {}): FakeServer => {
    const merged = { ...defaults, ...overrides }
    // Copia propia: `finish()` añade modelos y el mismo objeto de opciones se reutiliza entre tests.
    return { ...merged, models: [...merged.models] }
  }
  const servers = new Map<string, FakeServer>([
    [
      AI_DEFAULT_BASE_URLS.ollama,
      server({ reachable: true, version: '0.12.3', models: [QWEN, EMBEDDINGS] }, options.ollama),
    ],
    [
      AI_DEFAULT_BASE_URLS.lmstudio,
      server({ reachable: false, version: null, models: [LM_STUDIO_MODEL] }, options.lmstudio),
    ],
  ])
  const keyOf = (baseUrl: string) => normalizeAiBaseUrl(baseUrl) ?? baseUrl
  let active: ActivePull | undefined

  fake.ai.status.mockImplementation(async () => {
    const saved = fake.storedPreferences().ai
    const candidates: { provider: AiProvider; baseUrl: string }[] = [
      { provider: 'ollama', baseUrl: AI_DEFAULT_BASE_URLS.ollama },
      { provider: 'lmstudio', baseUrl: AI_DEFAULT_BASE_URLS.lmstudio },
    ]
    const savedUrl = keyOf(saved.baseUrl)
    if (!candidates.some((candidate) => candidate.baseUrl === savedUrl)) {
      candidates.push({ provider: saved.provider, baseUrl: savedUrl })
    }
    const providers = candidates.map(({ provider, baseUrl }): AiProviderStatus => {
      const server = servers.get(baseUrl)
      return {
        provider,
        baseUrl,
        reachable: server?.reachable ?? false,
        version: server?.reachable ? server.version : null,
      }
    })
    return ipcOk({ providers })
  })

  fake.ai.listModels.mockImplementation(async (request) => {
    const saved = fake.storedPreferences().ai
    const provider = request.provider ?? saved.provider
    const baseUrl =
      request.baseUrl ??
      (provider === saved.provider ? saved.baseUrl : AI_DEFAULT_BASE_URLS[provider])
    const server = servers.get(keyOf(baseUrl))
    if (!server?.reachable) return ipcFail(CONNECTION_ERROR)
    if (server.listError) return ipcFail(server.listError)
    return ipcOk([...server.models])
  })

  fake.ai.pullModel.mockImplementation(({ requestId, model }) => {
    const saved = fake.storedPreferences().ai
    if (!saved.enabled) {
      return Promise.resolve(
        ipcFail({ code: 'permission_denied', message: 'Disabled', retryable: false }),
      )
    }
    if (saved.provider !== 'ollama') {
      return Promise.resolve(
        ipcFail({ code: 'validation_failed', message: 'Cannot download', retryable: false }),
      )
    }
    if (active) {
      return Promise.resolve(ipcFail({ code: 'busy', message: 'Busy', retryable: true }))
    }
    return new Promise((resolve) => {
      active = { requestId, model, settle: resolve }
    })
  })

  fake.ai.cancel.mockImplementation(async ({ requestId }) => {
    if (active?.requestId !== requestId) return ipcOk({ requestId, outcome: 'not_running' })
    const { settle } = active
    active = undefined
    settle(ipcFail(CANCELLED_ERROR))
    return ipcOk({ requestId, outcome: 'requested' })
  })

  return {
    /** El servidor de esa dirección (para cambiar su estado a mitad de un test). */
    server(baseUrl: string): FakeServer {
      const existing = servers.get(keyOf(baseUrl))
      if (existing) return existing
      const created: FakeServer = { reachable: false, version: null, models: [] }
      servers.set(keyOf(baseUrl), created)
      return created
    },
    pull: {
      activeRequestId: () => active?.requestId ?? null,
      /** Avance que main empujaría al renderer para la descarga en curso. */
      emit(status: string, completed: number | null = null, total: number | null = null): void {
        if (!active) throw new Error('No hay descarga en curso')
        fake.emitPullProgress({
          requestId: active.requestId,
          model: active.model,
          status,
          completed,
          total,
        })
      },
      /** La descarga termina bien: el modelo pasa a estar instalado en Ollama. */
      finish(): void {
        if (!active) throw new Error('No hay descarga en curso')
        const { requestId, model, settle } = active
        active = undefined
        const ollama = servers.get(AI_DEFAULT_BASE_URLS.ollama)
        if (ollama && !ollama.models.some((installed) => installed.name === model)) {
          ollama.models.push({ name: model, sizeBytes: QWEN.sizeBytes, embedding: false })
        }
        settle(ipcOk({ requestId, model }))
      },
      fail(error: NormalizedError = PULL_FAILED_ERROR): void {
        if (!active) throw new Error('No hay descarga en curso')
        const { settle } = active
        active = undefined
        settle(ipcFail(error))
      },
    },
  }
}

export const CANNOT_ANSWER_ERROR: NormalizedError = {
  code: 'cannot_answer',
  message: 'The model could not answer the question with this schema',
  retryable: false,
}

interface PendingGeneration {
  request: AiGenerateSqlRequest
  settle: (result: IpcResult<AiGenerateSqlResult>) => void
}

/**
 * `generateSql` que queda abierto hasta que el test lo resuelve (`answer`), lo hace fallar (`fail`) o lo cancela: así se
 * pueden ordenar respuestas tardías. `cancel` resuelve la generación pendiente con `cancelled`, como main.
 */
export function stubGenerateSql(fake: Pick<FakeDb, 'ai'>) {
  const pending: PendingGeneration[] = []

  fake.ai.generateSql.mockImplementation(
    (request) => new Promise((resolve) => pending.push({ request, settle: resolve })),
  )
  const previousCancel = fake.ai.cancel.getMockImplementation()
  fake.ai.cancel.mockImplementation(async (request) => {
    const index = pending.findIndex((entry) => entry.request.requestId === request.requestId)
    if (index < 0)
      return previousCancel
        ? previousCancel(request)
        : ipcOk({ ...request, outcome: 'not_running' })
    const [entry] = pending.splice(index, 1)
    entry?.settle(ipcFail(CANCELLED_ERROR))
    return ipcOk({ requestId: request.requestId, outcome: 'requested' })
  })

  const take = (index: number): PendingGeneration => {
    const entry = pending[index < 0 ? pending.length + index : index]
    if (!entry) throw new Error('No hay ninguna generación pendiente')
    pending.splice(pending.indexOf(entry), 1)
    return entry
  }

  return {
    count: () => pending.length,
    /** Petición que llegó a main, sin resolverla (por defecto la última). */
    request: (index = -1): AiGenerateSqlRequest => {
      const entry = pending[index < 0 ? pending.length + index : index]
      if (!entry) throw new Error('No hay ninguna generación pendiente')
      return entry.request
    },
    /** El modelo responde; `result` completa lo que falte de una consulta de lectura. */
    answer(result: Partial<AiGenerateSqlResult> = {}, index = -1): void {
      const { request, settle } = take(index)
      settle(
        ipcOk({
          requestId: request.requestId,
          sql: 'SELECT 1',
          risk: 'read',
          statementType: 'query',
          warnings: [],
          ...result,
        }),
      )
    },
    fail(error: NormalizedError, index = -1): void {
      take(index).settle(ipcFail(error))
    },
  }
}
