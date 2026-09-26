import type { AiModelInfo } from '@strata/contracts'
import {
  DEFAULT_PROVIDER_TIMEOUTS,
  isRecord,
  MAX_MODELS,
  toModelInfo,
  type AiProvider,
  type ProviderTimeouts,
} from './ai-provider'
import { endpointUrl } from './endpoint'
import { aiError } from './errors'
import type { AiHttp } from './http'

const MAX_JSON_BYTES = 2_000_000

// Qwen3 razona por defecto. `/no_think` en el mensaje de sistema no basta en Ollama (`/v1`): sigue generando cientos de tokens
// de razonamiento aparte (35 s en lugar de 1,4 s, medido con qwen3:14b) que además gastan `max_tokens`; lo apaga `reasoning_effort`.
// En otros modelos ambas cosas serían ruido o un valor inválido, así que solo se aplican a los Qwen3.
const THINKING_SWITCH = /qwen3/i

/**
 * API compatible con OpenAI (`/v1/models`, `/v1/chat/completions`): LM Studio, llama.cpp y similares.
 * Si la dirección ya termina en `/v1` no se repite. No descarga modelos: se gestionan en la propia aplicación del servidor.
 */
export function createOpenAiCompatibleProvider(
  base: URL,
  http: AiHttp,
  timeouts: ProviderTimeouts = DEFAULT_PROVIDER_TIMEOUTS,
): AiProvider {
  const prefix = /\/v1\/$/.test(base.pathname) ? '' : 'v1/'
  const url = (path: string): URL => endpointUrl(base, `${prefix}${path}`)

  return {
    async probe(signal) {
      try {
        await http.json({
          url: url('models'),
          method: 'GET',
          timeoutMs: timeouts.probeMs,
          maxBytes: MAX_JSON_BYTES,
          signal,
        })
        return { reachable: true, version: null }
      } catch {
        return { reachable: false, version: null }
      }
    },

    async listModels(signal) {
      const data = await http.json({
        url: url('models'),
        method: 'GET',
        timeoutMs: timeouts.listMs,
        maxBytes: MAX_JSON_BYTES,
        signal,
      })
      const models = isRecord(data) && Array.isArray(data['data']) ? data['data'] : []
      return models.slice(0, MAX_MODELS).flatMap((model): AiModelInfo[] => {
        const info = isRecord(model) ? toModelInfo(model['id'], undefined) : undefined
        return info ? [info] : []
      })
    },

    async generate(request, signal) {
      const qwen3 = THINKING_SWITCH.test(request.model)
      const system = qwen3 ? `${request.system}\n/no_think` : request.system
      const data = await http.json({
        url: url('chat/completions'),
        method: 'POST',
        body: {
          model: request.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: request.user },
          ],
          stream: false,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          ...(qwen3 && { reasoning_effort: 'none' }),
        },
        timeoutMs: timeouts.generateMs,
        maxBytes: MAX_JSON_BYTES,
        signal,
      })
      const choices = isRecord(data) ? data['choices'] : undefined
      const first: unknown = Array.isArray(choices) ? choices[0] : undefined
      const message = isRecord(first) ? first['message'] : undefined
      // `reasoning_content` (LM Studio con razonamiento separado) se ignora a propósito: solo cuenta la respuesta.
      const content = isRecord(message) ? message['content'] : undefined
      if (typeof content !== 'string') {
        throw aiError('connection_failed', 'The AI server sent an unexpected response', false)
      }
      return content
    },
  }
}
