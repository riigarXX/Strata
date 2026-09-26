<script setup lang="ts">
import { formatShortcut, parseShortcut } from '@strata/commands'
import { AI_QUESTION_MAX_LENGTH } from '@strata/contracts'
import { computed, nextTick, ref, useId, watch } from 'vue'
import FormField from '../../../components/FormField.vue'
import ModalDialog from '../../../components/ModalDialog.vue'
import { currentPlatform } from '../../command-palette/composables/use-shortcut-hints'
import { useQueryEditor } from '../../query-editor'
import { useSettingsStore } from '../../settings/stores/settings'
import {
  BLOCKED_MESSAGE,
  describeAskError,
  describeAutoRun,
  describeReady,
  PREREQUISITE_MESSAGES,
  RISK_PRESENTATION,
  visibleWarnings,
} from '../model/ask'
import { useAskStore } from '../stores/ask'

const ask = useAskStore()
const settings = useSettingsStore()
const editor = useQueryEditor()

const uid = useId()
const titleId = `${uid}-title`
const descriptionId = `${uid}-description`

const question = ref('')
const announcement = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const content = ref<HTMLElement | null>(null)

const generating = computed(() => ask.phase === 'generating')
const canSubmit = computed(() => question.value.trim() !== '' && !generating.value)
const prerequisite = computed(() =>
  ask.prerequisite === null ? null : PREREQUISITE_MESSAGES[ask.prerequisite],
)
const failure = computed(() => (ask.error ? describeAskError(ask.error) : null))
const outcome = computed(() => ask.outcome)
const runMessage = computed(() =>
  outcome.value
    ? describeAutoRun(outcome.value.decision, outcome.value.risk, outcome.value.tabTitle)
    : '',
)
const warnings = computed(() => (outcome.value ? visibleWarnings(outcome.value.warnings) : []))
const runTone = computed(() => {
  if (!outcome.value) return 'warning'
  if (outcome.value.blocked) return 'error'
  return outcome.value.decision.run ? 'success' : 'warning'
})

const sendShortcut = computed(() => formatShortcut(parseShortcut('Mod+Enter'), currentPlatform()))
const hint = computed(
  () =>
    `${question.value.length} / ${AI_QUESTION_MAX_LENGTH} · ${sendShortcut.value} para preguntar`,
)

async function announce(message: string): Promise<void> {
  announcement.value = ''
  await nextTick()
  announcement.value = message
}

function statusMessage(): string {
  switch (ask.phase) {
    case 'generating':
      return 'Generando la consulta…'
    case 'ready':
      return outcome.value
        ? describeReady(outcome.value.risk, outcome.value.decision, outcome.value.tabTitle)
        : ''
    case 'error':
      return failure.value?.message ?? ''
    case 'cancelled':
      return 'Generación cancelada.'
    default:
      return ''
  }
}

watch(
  () => [ask.phase, ask.outcome, ask.error] as const,
  () => void announce(statusMessage()),
)

function focusInitial(): void {
  const target = content.value?.querySelector<HTMLElement>('[data-initial-focus]')
  ;(target ?? textarea.value)?.focus()
}

// Cada apertura parte de cero: la pregunta no se recuerda de una vez a otra.
watch(
  () => ask.isOpen,
  async () => {
    question.value = ''
    announcement.value = ''
    if (!ask.isOpen) return
    await nextTick()
    focusInitial()
  },
  { immediate: true },
)

// El editor vive en un shadow root: el diálogo no puede devolverle el foco por sí solo.
function close(): void {
  ask.close()
  void nextTick(() => editor.focusEditor())
}

// Esc: primero abandona la generación en curso (el texto se conserva para corregirlo) y, con nada en marcha, cierra.
function onDialogClose(): void {
  if (generating.value) {
    ask.cancel()
    return
  }
  close()
}

async function cancelGeneration(): Promise<void> {
  ask.cancel()
  await nextTick()
  textarea.value?.focus()
}

async function send(): Promise<void> {
  if (!canSubmit.value) return
  await ask.submit(question.value)
  if (!ask.isOpen || (ask.phase !== 'error' && ask.phase !== 'cancelled')) return
  await nextTick()
  textarea.value?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.isComposing || event.altKey || event.shiftKey) return
  const modifier = currentPlatform() === 'mac' ? event.metaKey : event.ctrlKey
  if (!modifier) return
  event.preventDefault()
  void send()
}

async function openAiSettings(): Promise<void> {
  ask.close()
  await nextTick()
  settings.open('ai')
}
</script>

<template>
  <ModalDialog
    :open="ask.isOpen"
    :labelledby="titleId"
    :describedby="descriptionId"
    class="ask-dialog"
    data-dialog="ask"
    @close="onDialogClose"
    @focus-lost="editor.focusEditor()"
  >
    <div v-if="ask.isOpen" ref="content" class="ask-dialog__content">
      <h2 :id="titleId" class="ask-dialog__title">Preguntar a la base</h2>
      <p :id="descriptionId" class="placeholder">
        Escribe lo que quieres saber en lenguaje natural. Al modelo, que corre en este equipo, solo
        le llegan el esquema de la conexión y tu pregunta. La consulta se abre en una pestaña nueva
        y solo se ejecuta sola si únicamente lee datos.
      </p>

      <div
        v-if="prerequisite"
        class="callout callout--warning callout--with-action"
        data-part="ask-prerequisite"
        :data-reason="ask.prerequisite"
      >
        <p>
          <strong>{{ prerequisite.title }}.</strong> {{ prerequisite.detail }}
        </p>
        <button
          v-if="ask.prerequisite === 'disabled'"
          type="button"
          class="btn btn--secondary"
          data-action="open-ai-settings"
          data-initial-focus
          @click="openAiSettings"
        >
          Abrir ajustes de IA
        </button>
      </div>

      <div v-else class="ask-dialog__form">
        <FormField label="Tu pregunta" :hint="hint" v-slot="{ id, describedBy }">
          <textarea
            :id="id"
            ref="textarea"
            v-model="question"
            name="question"
            rows="3"
            class="ask-dialog__question"
            :maxlength="AI_QUESTION_MAX_LENGTH"
            :readonly="generating"
            :aria-describedby="describedBy"
            autocomplete="off"
            spellcheck="false"
            @keydown="onKeydown"
          ></textarea>
        </FormField>

        <div class="ask-dialog__actions">
          <button
            type="button"
            class="btn btn--primary"
            data-action="submit-ask"
            :aria-disabled="canSubmit ? undefined : 'true'"
            @click="send"
          >
            Preguntar
          </button>
          <button
            v-if="generating"
            type="button"
            class="btn btn--secondary"
            data-action="cancel-ask"
            @click="cancelGeneration"
          >
            Cancelar generación
          </button>
        </div>
      </div>

      <p class="visually-hidden" role="status" aria-live="polite" data-part="ask-status">
        {{ announcement }}
      </p>

      <p
        v-if="generating"
        class="callout callout--running"
        data-state="generating"
        aria-busy="true"
      >
        Generando la consulta… Un modelo local puede tardar unos segundos, y más la primera vez
        mientras se carga en memoria.
      </p>

      <div
        v-else-if="ask.phase === 'error' && failure"
        class="callout callout--error callout--with-action"
        data-state="error"
      >
        <p>{{ failure.message }}</p>
        <button
          v-if="failure.settings"
          type="button"
          class="btn btn--secondary"
          data-action="open-ai-settings"
          @click="openAiSettings"
        >
          Abrir ajustes de IA
        </button>
      </div>

      <p v-else-if="ask.phase === 'cancelled'" class="placeholder" data-state="cancelled">
        Generación cancelada. No se ha abierto ni ejecutado nada.
      </p>

      <section
        v-else-if="ask.phase === 'ready' && outcome"
        class="ask-result"
        data-state="ready"
        aria-label="Consulta generada"
      >
        <p class="ask-result__meta">
          <span class="ask-result__risk" data-part="risk-chip" :data-risk="outcome.risk"
            ><span aria-hidden="true">{{ RISK_PRESENTATION[outcome.risk].glyph }}</span> Riesgo:
            {{ RISK_PRESENTATION[outcome.risk].label }}</span
          >
          <span class="placeholder">Abierta en la pestaña «{{ outcome.tabTitle }}»</span>
        </p>
        <pre
          class="mono ask-result__sql"
          data-part="generated-sql"
          role="region"
          aria-label="SQL generado"
          tabindex="0"
          >{{ outcome.sql }}</pre>
        <p class="callout" :class="`callout--${runTone}`" data-part="run-outcome">
          {{ runMessage }}
          <span v-if="outcome.blocked" data-part="blocked-reason">{{ BLOCKED_MESSAGE }}</span>
        </p>
        <ul v-if="warnings.length > 0" class="ask-result__warnings" data-part="ask-warnings">
          <li v-for="warning in warnings" :key="warning" class="callout callout--warning">
            {{ warning }}
          </li>
        </ul>
      </section>

      <div class="ask-dialog__footer">
        <span class="placeholder">{{
          generating ? 'Esc cancela la generación.' : 'Esc cierra y vuelve al editor.'
        }}</span>
        <button
          type="button"
          class="btn btn--secondary"
          data-action="close-ask"
          :data-initial-focus="prerequisite && ask.prerequisite !== 'disabled' ? '' : undefined"
          @click="close"
        >
          Cerrar
        </button>
      </div>
    </div>
  </ModalDialog>
</template>

<style scoped>
.ask-dialog {
  width: min(40rem, calc(100vw - 2 * var(--spacing-4)));
}

.ask-dialog__content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  padding: var(--spacing-6);
}

.ask-dialog__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}

.ask-dialog__form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
}

.ask-dialog__question {
  width: 100%;
  min-height: 5rem;
  max-height: 14rem;
  padding: var(--spacing-2) var(--spacing-3);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background-color: var(--input-bg);
  color: var(--input-fg);
  font: inherit;
  resize: vertical;
  transition: border-color var(--motion-duration-fast) var(--motion-easing-out);
}

.ask-dialog__question:focus-visible {
  border-color: var(--input-border-focus);
  outline-offset: 0;
}

/* Mientras el modelo genera la pregunta no se edita: se ve como los campos de solo lectura. */
.ask-dialog__question[readonly] {
  background-color: var(--surface-card);
  cursor: default;
}

.ask-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-2);
}

/* Sin texto no hay nada que enviar (no permitido); con el modelo trabajando, el botón espera (en curso). */
.ask-dialog__actions .btn[aria-disabled='true'] {
  cursor: not-allowed;
}

.ask-dialog__content:has([data-state='generating'])
  .ask-dialog__actions
  .btn[aria-disabled='true'] {
  cursor: progress;
}

/* Cancelada: nada se abrió ni se ejecutó. Glifo de «inactivo» y trazo discontinuo, como los controles no disponibles. */
.ask-dialog__content > [data-state='cancelled'] {
  padding: var(--spacing-2) var(--spacing-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
}

.ask-dialog__content > [data-state='cancelled']::before {
  content: var(--status-glyph-inactive);
  margin-inline-end: var(--spacing-2);
}

.ask-dialog__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-2);
  padding-block-start: var(--spacing-4);
  border-top: 1px solid var(--border-subtle);
}

/* Lo generado se separa del formulario igual que las secciones de Ajustes: filete y el mismo aire. */
.ask-result {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
  min-width: 0;
  padding-block-start: var(--spacing-4);
  border-top: 1px solid var(--border-subtle);
}

.ask-result__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-2) var(--spacing-3);
}

/* Riesgo: glifo, texto y trazo distinto por nivel; el color solo refuerza. Lectura (trazo continuo), escritura y
   desconocida (discontinuo, como el aviso) y destructiva (relleno, como el botón destructivo). */
.ask-result__risk {
  --risk-color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-1);
  min-height: 24px;
  padding: 0 var(--spacing-2);
  border: 1px solid var(--risk-color);
  border-radius: var(--radius-xs);
  color: var(--risk-color);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-sm);
  white-space: nowrap;
}

.ask-result__risk > [aria-hidden='true'] {
  min-width: 1em;
  text-align: center;
}

.ask-result__risk[data-risk='read'] {
  --risk-color: var(--status-success);
  border-style: var(--status-outline-success);
}

.ask-result__risk[data-risk='write'],
.ask-result__risk[data-risk='unknown'] {
  --risk-color: var(--status-warning);
  border-style: var(--status-outline-warning);
}

.ask-result__risk[data-risk='destructive'] {
  --risk-color: var(--button-destructive-bg);
  background: var(--button-destructive-bg);
  color: var(--button-destructive-fg);
}

/* El SQL se lee y se copia entero: se ajusta al ancho del diálogo (nunca lo desborda) y solo se desplaza en vertical. */
.ask-result__sql {
  max-height: 14rem;
  margin: 0;
  padding: var(--spacing-3);
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--editor-bg);
  color: var(--editor-fg);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  overflow-wrap: anywhere;
  tab-size: 2;
  white-space: pre-wrap;
  cursor: text;
  user-select: text;
}

.ask-result__sql::selection {
  background: var(--editor-selection-bg);
  color: var(--editor-fg);
}

.ask-result [data-part='blocked-reason'] {
  display: block;
  margin-block-start: var(--spacing-1);
  text-indent: 0;
}

.ask-result__warnings {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
