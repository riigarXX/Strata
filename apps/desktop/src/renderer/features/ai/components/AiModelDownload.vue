<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { usePreferencesStore } from '../../preferences'
import {
  describeAiError,
  describePullProgress,
  PROVIDER_SHORT_LABELS,
  RECOMMENDED_MODEL,
} from '../model/presentation'
import { useAiStore } from '../stores/ai'

const emit = defineEmits<{
  /** Resultado que conviene anunciar a las tecnologías de apoyo (una sola vez por hito). */
  announce: [message: string]
  /** La descarga terminó y el botón ya no existe. `focusFree`: el foco no está en ningún control útil, así que puede moverse. */
  finished: [focusFree: boolean]
}>()

const ai = useAiStore()
const preferences = usePreferencesStore()

const uid = useId()
const titleId = `${uid}-title`
const hintId = `${uid}-hint`
const progressLabelId = `${uid}-progress-label`

const root = ref<HTMLElement | null>(null)

const model = RECOMMENDED_MODEL.name
const isOllama = computed(() => preferences.ai.provider === 'ollama')
const running = computed(() => ai.pull.phase === 'running' || ai.pull.phase === 'cancelling')
// Recién descargado ya está instalado, aunque la lista de modelos aún se esté refrescando.
const installed = computed(
  () => ai.pull.phase === 'done' || ai.models.some((candidate) => candidate.name === model),
)
const percent = computed(() => ai.pull.progress.percent)
const progressText = computed(() => describePullProgress(ai.pull.progress))

// Main solo descarga con lo que tiene guardado: hasta que el guardado termina, el botón espera.
const blockedReason = computed(() => {
  if (!preferences.ai.enabled) return 'Activa la IA local para poder descargar modelos.'
  return preferences.saveStatus === 'saving' ? 'Guardando los ajustes…' : ''
})

const problem = computed(() =>
  ai.pull.phase === 'error' && ai.pull.error ? describeAiError(ai.pull.error, 'pull') : '',
)

function download(): void {
  if (blockedReason.value) return
  void ai.startPull(model, { provider: preferences.ai.provider, baseUrl: preferences.ai.baseUrl })
}

// El foco solo se mueve si se quedó sin sitio (se quitó el botón que lo tenía) o está aquí dentro: nunca se le roba
// a quien ya está escribiendo o eligiendo en otro control.
function focusIsFree(): boolean {
  const active = document.activeElement
  return (
    !active ||
    active === document.body ||
    active.tagName === 'DIALOG' ||
    !!root.value?.contains(active)
  )
}

function focusIfFree(selector: string): void {
  if (focusIsFree()) root.value?.querySelector<HTMLElement>(selector)?.focus()
}

// Al empezar el botón de descargar desaparece y el foco pasa al de cancelar; al terminar, a lo que quede útil.
watch(
  () => ai.pull.phase,
  async (phase, previous) => {
    if (phase === 'running' && previous !== 'cancelling') {
      emit('announce', `Descargando ${ai.pull.model ?? model}…`)
      await nextTick()
      focusIfFree('[data-action="cancel-pull"]')
    } else if (phase === 'done') {
      emit('announce', `${ai.pull.model ?? model} descargado.`)
      emit('finished', focusIsFree())
    } else if (phase === 'cancelled') {
      emit('announce', 'Descarga cancelada.')
      await nextTick()
      focusIfFree('[data-action="download-model"]')
    } else if (phase === 'error' && ai.pull.error) {
      emit('announce', describeAiError(ai.pull.error, 'pull'))
      await nextTick()
      focusIfFree('[data-action="download-model"]')
    }
  },
)
</script>

<template>
  <div ref="root" class="ai-download" data-part="download" role="group" :aria-labelledby="titleId">
    <p :id="titleId" class="form-field__label">Modelo recomendado</p>

    <p v-if="!isOllama" class="form-field__hint" data-part="download-unavailable">
      Strata solo descarga modelos con Ollama. Con
      {{ PROVIDER_SHORT_LABELS[preferences.ai.provider] }}
      instálalos desde su propia aplicación.
    </p>

    <template v-else>
      <div v-if="running" class="ai-download__progress" data-part="progress">
        <p :id="progressLabelId" class="ai-download__label">
          {{ ai.pull.phase === 'cancelling' ? 'Cancelando la descarga de' : 'Descargando' }}
          {{ ai.pull.model }}
        </p>
        <div
          class="ai-progress"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-labelledby="progressLabelId"
          :aria-valuenow="percent ?? undefined"
          :aria-valuetext="progressText"
          :data-indeterminate="percent === null ? 'true' : undefined"
        >
          <div class="ai-progress__fill" :style="{ inlineSize: `${percent ?? 0}%` }"></div>
        </div>
        <p class="ai-download__text" data-part="progress-text">{{ progressText }}</p>
        <div class="ai-download__actions">
          <button
            type="button"
            class="btn btn--secondary"
            data-action="cancel-pull"
            :aria-disabled="ai.pull.phase === 'cancelling' ? 'true' : undefined"
            @click="ai.pull.phase === 'running' && ai.cancelPull()"
          >
            {{ ai.pull.phase === 'cancelling' ? 'Cancelando…' : 'Cancelar descarga' }}
          </button>
        </div>
        <p class="form-field__hint">Puedes cerrar los ajustes: la descarga continúa.</p>
      </div>

      <template v-else>
        <p
          v-if="ai.pull.phase === 'cancelled'"
          class="ai-download__state"
          data-state="notice"
          data-part="cancelled"
        >
          Descarga cancelada.
        </p>
        <p v-if="problem" class="callout callout--error" role="alert" data-part="download-error">
          <strong>No se pudo descargar el modelo.</strong> {{ problem }}
        </p>

        <p v-if="installed" class="ai-download__state" data-state="success" data-part="installed">
          {{ model }} está instalado.
        </p>
        <template v-else>
          <div class="ai-download__actions">
            <button
              type="button"
              class="btn btn--secondary"
              data-action="download-model"
              :aria-disabled="blockedReason ? 'true' : undefined"
              :aria-describedby="hintId"
              @click="download"
            >
              {{ ai.pull.phase === 'idle' ? 'Descargar' : 'Volver a descargar' }} {{ model }} (~{{
                RECOMMENDED_MODEL.approxSize
              }})
            </button>
          </div>
          <p :id="hintId" class="form-field__hint" data-part="download-hint">
            {{
              blockedReason ||
              `Se descarga con Ollama (unos ${RECOMMENDED_MODEL.approxSize}) y se ejecuta en este equipo.`
            }}
          </p>
        </template>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* El modelo recomendado es un bloque aparte dentro de la sección: la descarga y sus estados quedan agrupados. */
.ai-download {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  min-width: 0;
  padding: var(--spacing-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--surface-subtle);
}

.ai-download__progress {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.ai-download__label,
.ai-download__text {
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  overflow-wrap: anywhere;
}

.ai-download__label {
  color: var(--text-muted);
}

/* Etapa, porcentaje y bytes en una sola línea, en cifras de ancho fijo para que no baile al avanzar. */
.ai-download__text {
  font-variant-numeric: tabular-nums;
  font-weight: var(--font-weight-medium);
}

.ai-download__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-2);
}

.ai-progress {
  block-size: 10px;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-full);
  background: var(--surface-muted);
}

.ai-progress__fill {
  block-size: 100%;
  background: var(--action-primary);
  transition: inline-size var(--motion-duration-fast) var(--motion-easing-out);
}

/* Sin total conocido (preparando, terminando) no hay porcentaje: franjas que avanzan y, con movimiento reducido,
   quietas; la etapa la dice el texto de debajo. */
.ai-progress[data-indeterminate='true'] {
  background-image: linear-gradient(
    -45deg,
    var(--action-primary) 25%,
    transparent 25% 50%,
    var(--action-primary) 50% 75%,
    transparent 75%
  );
  background-size: 16px 16px;
  animation: ai-progress-scan var(--motion-duration-spin) var(--motion-easing-linear)
    var(--motion-iteration-loop);
}

@keyframes ai-progress-scan {
  to {
    background-position: 16px 0;
  }
}

.ai-download__state {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  line-height: var(--font-line-height-sm);
}

.ai-download__state[data-state='success']::before {
  content: var(--status-glyph-success);
  margin-inline-end: var(--spacing-1);
  color: var(--status-success);
}

.ai-download__state[data-state='notice']::before {
  content: var(--status-glyph-inactive);
  margin-inline-end: var(--spacing-1);
  color: var(--text-muted);
}
</style>
