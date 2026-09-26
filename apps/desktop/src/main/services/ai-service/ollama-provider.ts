import type { AiModelInfo } from '@strata/contracts'
import {
  DEFAULT_PROVIDER_TIMEOUTS,
  isOllamaEmbedding,
  isRecord,
  MAX_MODELS,
  toModelInfo,
  type AiProvider,
  type PullProgress,
  type ProviderTimeouts,
} from './ai-provider'
import { endpointUrl } from './endpoint'
import { aiError } from './errors'
import type { AiHttp } from './http'

const MAX_JSON_BYTES = 2_000_000
// Un `pull` de varios GB son miles de líneas de progreso de ~150 bytes.
const MAX_PULL_BYTES = 64 * 1024 * 1024
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g

const asCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

function pullFailure(message: string): Error {
  return /not found|does not exist|no such/i.test(message)
    ? aiError('not_found', 'The model was not found in the Ollama library', false)
    : aiError('connection_failed', 'The model download failed', false)
}

/** API nativa de Ollama: `/api/version`, `/api/tags`, `/api/chat` y `/api/pull`. */
export function createOllamaProvider(
  base: URL,
  http: AiHttp,
  timeouts: ProviderTimeouts = DEFAULT_PROVIDER_TIMEOUTS,
): AiProvider {
  return {
    async probe(signal) {
      try {
        const data = await http.json({
          url: endpointUrl(base, 'api/version'),
          method: 'GET',
          timeoutMs: timeouts.probeMs,
          maxBytes: MAX_JSON_BYTES,
          signal,
        })
        const version = isRecord(data) ? data['version'] : undefined
        return {
          reachable: true,
          version: typeof version === 'string' && VERSION.test(version) ? version : null,
        }
      } catch {
        return { reachable: false, version: null }
      }
    },

    async listModels(signal) {
      const data = await http.json({
        url: endpointUrl(base, 'api/tags'),
        method: 'GET',
        timeoutMs: timeouts.listMs,
        maxBytes: MAX_JSON_BYTES,
        signal,
      })
      const models = isRecord(data) && Array.isArray(data['models']) ? data['models'] : []
      return models.slice(0, MAX_MODELS).flatMap((model): AiModelInfo[] => {
        const info = isRecord(model)
          ? toModelInfo(model['name'], model['size'], isOllamaEmbedding(model))
          : undefined
        return info ? [info] : []
      })
    },

    async generate(request, signal) {
      const data = await http.json({
        url: endpointUrl(base, 'api/chat'),
        method: 'POST',
        body: {
          model: request.model,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          stream: false,
          // Qwen3 y otros razonan con <think> por defecto; el servidor lo desactiva y el saneado descarta lo que aparezca igualmente.
          think: false,
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens,
            num_ctx: request.contextTokens,
          },
        },
        timeoutMs: timeouts.generateMs,
        maxBytes: MAX_JSON_BYTES,
        signal,
      })
      const message = isRecord(data) ? data['message'] : undefined
      const content = isRecord(message) ? message['content'] : undefined
      if (typeof content !== 'string') {
        throw aiError('connection_failed', 'The AI server sent an unexpected response', false)
      }
      return content
    },

    async pullModel(model, onProgress: (progress: PullProgress) => void, signal) {
      let finished = false
      await http.ndjson(
        {
          url: endpointUrl(base, 'api/pull'),
          method: 'POST',
          body: { model, stream: true },
          timeoutMs: timeouts.pullIdleMs,
          maxBytes: MAX_PULL_BYTES,
          signal,
        },
        (line) => {
          if (!isRecord(line)) return
          if (typeof line['error'] === 'string') throw pullFailure(line['error'])
          const status =
            typeof line['status'] === 'string'
              ? line['status'].replace(CONTROL_CHARACTERS, ' ').trim().slice(0, 100)
              : ''
          if (status === '') return
          if (status === 'success') finished = true
          onProgress({
            status,
            completed: asCount(line['completed']),
            total: asCount(line['total']),
          })
        },
      )
      if (!finished) {
        throw aiError('connection_failed', 'The model download ended before it finished', true)
      }
    },
  }
}
