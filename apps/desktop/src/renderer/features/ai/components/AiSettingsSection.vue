<script setup lang="ts">
import { AI_PROVIDERS, normalizeAiBaseUrl, type AiProvider } from '@strata/contracts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import FormField from '../../../components/FormField.vue'
import { usePreferencesStore } from '../../preferences'
import { parseBaseUrl } from '../model/base-url'
import {
  describeAiError,
  modelOptionLabel,
  PROVIDER_LABELS,
  PROVIDER_SHORT_LABELS,
  START_HINTS,
} from '../model/presentation'
import { useAiStore } from '../stores/ai'
import AiModelDownload from './AiModelDownload.vue'

const preferences = usePreferencesStore()
const ai = useAiStore()

const uid = useId()
const enabledHintId = `${uid}-enabled-hint`

const baseUrlInput = ref<HTMLInputElement | null>(null)
const modelSelect = ref<HTMLSelectElement | null>(null)

const provider = computed(() => preferences.ai.provider)
const enabled = computed(() => preferences.ai.enabled)

// La dirección se edita como texto y solo llega a main cuando es válida (misma regla que el contrato).
const baseUrl = ref('')
const baseUrlError = ref<string | undefined>()

function syncBaseUrl(): void {
  baseUrl.value = preferences.ai.baseUrl
  baseUrlError.value = undefined
}
watch(() => preferences.ai.baseUrl, syncBaseUrl, { immediate: true })

function commitBaseUrl(): string | undefined {
  const parsed = parseBaseUrl(baseUrl.value)
  baseUrlError.value = parsed.ok ? undefined : parsed.error
  if (!parsed.ok) return undefined
  baseUrl.value = parsed.value
  if (parsed.value !== normalizeAiBaseUrl(preferences.ai.baseUrl)) {
    void preferences.setAiBaseUrl(parsed.value)
  }
  return parsed.value
}

// Una vez señalado un error, se reevalúa al teclear para que desaparezca en cuanto la dirección es válida.
function revalidateBaseUrl(): void {
  if (baseUrlError.value === undefined) return
  const parsed = parseBaseUrl(baseUrl.value)
  baseUrlError.value = parsed.ok ? undefined : parsed.error
}

// Lo comprobado deja de valer al cambiar de servidor o desactivar la IA; con ella activa se vuelve a mirar
// sin que el usuario tenga que pedirlo (solo direcciones de bucle local, y el resultado no se anuncia).
watch(
  () => [preferences.ai.enabled, preferences.ai.provider, preferences.ai.baseUrl] as const,
  ([isEnabled, kind, url]) => {
    if (!isEnabled) {
      ai.reset()
      return
    }
    void ai.check({ provider: kind, baseUrl: url })
  },
  { immediate: true },
)

// Mientras los ajustes están abiertos (esta sección solo existe entonces) se escucha el avance de descargas.
onMounted(() => {
  ai.clearFinishedPull()
  ai.attach()
})
onBeforeUnmount(() => ai.detach())

const announcement = ref('')
async function announce(message: string): Promise<void> {
  announcement.value = ''
  await nextTick()
  announcement.value = message
}

const connection = computed(() => {
  const state = ai.connection
  const url = ai.checkedTarget?.baseUrl ?? preferences.ai.baseUrl
  switch (state.phase) {
    case 'checking':
      return { state: 'checking', text: 'Comprobando…' }
    case 'reachable': {
      const version = state.version ? ` · versión ${state.version}` : ''
      const count = ai.modelsStatus === 'ready' ? ` · ${describeCount(ai.models.length)}` : ''
      return { state: 'reachable', text: `Alcanzable en ${url}${version}${count}.` }
    }
    case 'unreachable':
      return {
        state: 'unreachable',
        text: `No alcanzable en ${url}. ${START_HINTS[ai.checkedTarget?.provider ?? provider.value]}`,
      }
    case 'error':
      return { state: 'unreachable', text: describeAiError(state.error, 'connect') }
    default:
      return { state: 'idle', text: 'Sin comprobar.' }
  }
})

function describeCount(count: number): string {
  if (count === 0) return 'sin modelos'
  return count === 1 ? '1 modelo' : `${count} modelos`
}

// Otros servidores de este equipo que sí responden: útil cuando el elegido no lo hace.
const alsoRunning = computed(() => {
  if (ai.connection.phase !== 'unreachable') return ''
  const target = ai.checkedTarget
  const others = ai.detected.filter(
    (server) =>
      server.reachable &&
      !(server.provider === target?.provider && server.baseUrl === target.baseUrl),
  )
  if (others.length === 0) return ''
  return `También responde ${others.map((server) => `${PROVIDER_SHORT_LABELS[server.provider]} (${server.baseUrl})`).join(' y ')}.`
})

const checking = computed(() => ai.connection.phase === 'checking')

let announceProbe = false
watch(
  () => ai.connection,
  (state) => {
    if (!announceProbe || state.phase === 'checking' || state.phase === 'idle') return
    announceProbe = false
    void announce(connection.value.text)
  },
)

function probe(): void {
  if (checking.value) return
  const url = commitBaseUrl()
  if (url === undefined) {
    baseUrlInput.value?.focus()
    return
  }
  announceProbe = true
  void ai.check({ provider: provider.value, baseUrl: url })
}

function onProviderChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  const chosen = AI_PROVIDERS.find((candidate) => candidate === value)
  if (chosen) void preferences.setAiProvider(chosen)
}

function onModelChange(event: Event): void {
  void preferences.setAiModel((event.target as HTMLSelectElement).value)
}

// Los modelos de embeddings no generan SQL: no se ofrecen. Si el guardado es uno de ellos se conserva a la vista
// (con su motivo) para que el selector no muestre otro modelo distinto del que se usa de verdad.
const generationModels = computed(() => ai.models.filter((model) => !model.embedding))

const modelOptions = computed(() => {
  const saved = preferences.ai.model
  const options = generationModels.value.map((model) => ({
    value: model.name,
    label: modelOptionLabel(model),
  }))
  if (!options.some((option) => option.value === saved)) {
    const isEmbedding = ai.models.some((model) => model.name === saved && model.embedding)
    const note = isEmbedding
      ? ' · es de embeddings: no genera SQL'
      : ai.modelsStatus === 'ready'
        ? ' · no está en este servidor'
        : ''
    options.unshift({ value: saved, label: `${saved}${note}` })
  }
  return options
})

const modelHint = computed(() => {
  const saved = preferences.ai.model
  switch (ai.modelsStatus) {
    case 'loading':
      return 'Buscando los modelos del servidor…'
    case 'error':
      return ''
    case 'ready':
      if (generationModels.value.length === 0) {
        return provider.value === 'ollama'
          ? 'El servidor no tiene modelos de texto instalados. Descarga el recomendado más abajo.'
          : 'El servidor no tiene modelos de texto instalados.'
      }
      if (generationModels.value.some((model) => model.name === saved)) return ''
      return ai.models.some((model) => model.name === saved && model.embedding)
        ? `«${saved}» es un modelo de embeddings y no genera SQL: elige otro de la lista.`
        : `«${saved}» no está en este servidor: elige otro de la lista.`
    default:
      return 'Pulsa «Probar conexión» para ver los modelos instalados.'
  }
})
const modelError = computed(() =>
  ai.modelsStatus === 'error' && ai.modelsError
    ? describeAiError(ai.modelsError, 'models')
    : undefined,
)

function focusModel(focusFree: boolean): void {
  if (focusFree) void nextTick(() => modelSelect.value?.focus())
}

const providerHint = computed(() =>
  provider.value === 'custom'
    ? 'Cualquier servidor compatible con OpenAI que escuche en este equipo.'
    : 'Ollama y LM Studio se detectan solos si están en marcha.',
)
</script>

<template>
  <section class="settings-section" data-section="ai" :aria-labelledby="`${uid}-title`">
    <h3 :id="`${uid}-title`" class="settings-section__title">IA local</h3>

    <div class="form-field form-field--checkbox">
      <label class="form-field__label">
        <input
          type="checkbox"
          role="switch"
          name="aiEnabled"
          data-initial-focus
          :checked="enabled"
          :aria-describedby="enabledHintId"
          @change="preferences.setAiEnabled(($event.target as HTMLInputElement).checked)"
        />
        Activar el asistente de IA local
      </label>
      <p :id="enabledHintId" class="form-field__hint">
        Al modelo solo le llegan el esquema y tu pregunta, nunca los resultados, y todo ocurre en
        este equipo, sin salir a internet.
      </p>
    </div>

    <FormField label="Servidor de modelos" :hint="providerHint" v-slot="{ id, describedBy }">
      <select :id="id" name="aiProvider" :aria-describedby="describedBy" @change="onProviderChange">
        <option
          v-for="choice in AI_PROVIDERS"
          :key="choice"
          :value="choice"
          :selected="choice === provider"
        >
          {{ PROVIDER_LABELS[choice as AiProvider] }}
        </option>
      </select>
    </FormField>

    <FormField
      label="Dirección del servidor"
      :error="baseUrlError"
      hint="Solo direcciones de este equipo (127.0.0.1, localhost o [::1]) con puerto."
      v-slot="{ id, describedBy, invalid }"
    >
      <input
        :id="id"
        ref="baseUrlInput"
        v-model="baseUrl"
        type="text"
        name="aiBaseUrl"
        autocomplete="off"
        spellcheck="false"
        :aria-describedby="describedBy"
        :aria-invalid="invalid ? 'true' : undefined"
        @input="revalidateBaseUrl"
        @change="commitBaseUrl"
        @keydown.enter.prevent="commitBaseUrl"
      />
    </FormField>

    <div class="ai-probe">
      <button
        type="button"
        class="btn btn--secondary"
        data-action="probe-ai"
        :aria-disabled="checking ? 'true' : undefined"
        @click="probe"
      >
        {{ checking ? 'Comprobando…' : 'Probar conexión' }}
      </button>
      <p class="ai-probe__result" data-part="connection" :data-state="connection.state">
        {{ connection.text }}
      </p>
      <p v-if="alsoRunning" class="form-field__hint" data-part="also-running">{{ alsoRunning }}</p>
    </div>

    <FormField
      class="ai-model-field"
      label="Modelo"
      :hint="modelHint || undefined"
      :error="modelError"
      v-slot="{ id, describedBy }"
    >
      <select
        :id="id"
        ref="modelSelect"
        name="aiModel"
        :aria-describedby="describedBy"
        :aria-busy="ai.modelsStatus === 'loading' ? 'true' : undefined"
        @change="onModelChange"
      >
        <option
          v-for="option in modelOptions"
          :key="option.value"
          :value="option.value"
          :selected="option.value === preferences.ai.model"
        >
          {{ option.label }}
        </option>
      </select>
    </FormField>

    <AiModelDownload @announce="announce" @finished="focusModel" />

    <p class="ai-live" role="status" aria-live="polite" data-part="ai-live">{{ announcement }}</p>
  </section>
</template>

<style scoped>
/* El interruptor ocupa toda su fila: 24 px de alto como mínimo (WCAG 2.5.8) sin agrandar la casilla. */
.form-field--checkbox .form-field__label {
  min-height: 24px;
}

/* La dirección se lee mejor en la fuente del código: los puertos y los ceros no se confunden. */
input[name='aiBaseUrl'] {
  font-family: var(--font-family-mono);
  font-size: var(--font-size-sm);
}

.ai-probe {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-2) var(--spacing-3);
}

/* «Probar conexión» y «Comprobando…» ocupan lo mismo: el resultado de al lado no salta al pulsarlo. */
.ai-probe > .btn {
  min-width: 9rem;
}

.ai-probe__result {
  flex: 1 1 14rem;
  min-width: 0;
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  overflow-wrap: anywhere;
}

.ai-probe__result[data-state='idle'] {
  color: var(--text-muted);
}

.ai-probe__result[data-state='idle']::before {
  content: var(--status-glyph-inactive);
  margin-inline-end: var(--spacing-1);
}

.ai-probe__result[data-state='reachable']::before {
  content: var(--status-glyph-success);
  margin-inline-end: var(--spacing-1);
  color: var(--status-success);
}

.ai-probe__result[data-state='unreachable']::before {
  content: var(--status-glyph-error);
  margin-inline-end: var(--spacing-1);
  color: var(--status-error);
}

.ai-probe__result[data-state='checking']::before {
  content: var(--query-glyph-running);
  display: inline-block;
  margin-inline-end: var(--spacing-1);
  color: var(--query-running);
  animation: spin var(--motion-duration-spin) var(--motion-easing-linear)
    var(--motion-iteration-loop);
}

.ai-probe > .form-field__hint {
  flex-basis: 100%;
}

/* Con una descarga en curso, el consejo de elegir otro modelo o de descargar el recomendado sobra: lo que ocurre lo
   cuenta el bloque de descarga. Se aparta de la vista sin quitarlo de la descripción accesible del selector. */
.settings-section:has([data-part='progress']) .ai-model-field :deep(.form-field__hint) {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Región de avisos para tecnologías de apoyo: existe siempre, pero no ocupa sitio. */
.ai-live {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
