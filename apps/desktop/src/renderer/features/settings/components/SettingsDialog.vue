<script setup lang="ts">
import {
  HISTORY_RETENTION_OPTIONS,
  THEME_OPTIONS,
  type HistoryRetentionDays,
} from '@strata/contracts'
import { computed, nextTick, reactive, ref, useId, watch } from 'vue'
import FormField from '../../../components/FormField.vue'
import ModalDialog from '../../../components/ModalDialog.vue'
import {
  EXECUTION_LIMITS,
  parseLimit,
  usePreferencesStore,
  type LimitField,
} from '../../preferences'
import { useQueryEditor } from '../../query-editor'
import { AiSettingsSection } from '../../ai'
import { ClearHistoryDialog, describeCleared, useHistoryApi } from '../../history'
import { retentionLabel, retentionToValue, THEME_LABELS } from '../model/labels'
import { useSettingsStore } from '../stores/settings'

const settings = useSettingsStore()
const preferences = usePreferencesStore()
const historyApi = useHistoryApi()
const editor = useQueryEditor()

const uid = useId()
const titleId = `${uid}-title`
const descriptionId = `${uid}-description`
const themeHintId = `${uid}-theme-hint`
const confirmHintId = `${uid}-confirm-hint`
const historyHintId = `${uid}-history-hint`

const content = ref<HTMLElement | null>(null)

const RETENTION_CHOICES: readonly HistoryRetentionDays[] = [...HISTORY_RETENTION_OPTIONS, null]
const LIMIT_LABELS: Record<LimitField, string> = {
  timeoutSeconds: 'Tiempo máximo',
  maxRows: 'Máximo de filas',
}

// Los campos numéricos se editan como texto y solo llegan a main cuando son válidos.
const draft = reactive({ timeoutSeconds: '', maxRows: '' })
const errors = reactive<Partial<Record<LimitField, string>>>({})

function syncDraft(field: LimitField): void {
  draft[field] = String(preferences[field])
  errors[field] = undefined
}

// Cualquier cambio del valor guardado (confirmado, deshecho tras un fallo o recién cargado) manda sobre el borrador.
watch(
  () => preferences.timeoutSeconds,
  () => syncDraft('timeoutSeconds'),
)
watch(
  () => preferences.maxRows,
  () => syncDraft('maxRows'),
)

const clearNotice = ref('')
const clearOpen = ref(false)
const clearBusy = ref(false)
const clearError = ref('')

function focusInitial(): void {
  const section = settings.section
  const scope = section
    ? content.value?.querySelector(`[data-section="${section}"]`)
    : content.value
  scope?.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
}

// Cada apertura parte de lo guardado: un borrador descartado no se conserva. El foco se fija después de
// que `ModalDialog` haga `showModal()`, que por su cuenta lo llevaría al primer control.
watch(
  () => settings.isOpen,
  async (open) => {
    preferences.dismissFeedback()
    clearNotice.value = ''
    clearOpen.value = false
    clearError.value = ''
    if (!open) return
    syncDraft('timeoutSeconds')
    syncDraft('maxRows')
    await nextTick()
    focusInitial()
  },
  { immediate: true },
)

watch(
  () => preferences.saveStatus,
  (status) => {
    if (status === 'saving') clearNotice.value = ''
  },
)

function commitLimit(field: LimitField): void {
  const parsed = parseLimit(field, draft[field])
  errors[field] = parsed.ok ? undefined : parsed.error
  if (!parsed.ok) return
  if (parsed.value === preferences[field]) {
    draft[field] = String(parsed.value)
    return
  }
  void preferences.update({
    execution:
      field === 'timeoutSeconds' ? { timeoutSeconds: parsed.value } : { maxRows: parsed.value },
  })
}

// Una vez señalado un error, se reevalúa al teclear para que desaparezca en cuanto el valor es válido.
function revalidate(field: LimitField): void {
  if (errors[field] === undefined) return
  const parsed = parseLimit(field, draft[field])
  errors[field] = parsed.ok ? undefined : parsed.error
}

function onRetentionChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  const days = RETENTION_CHOICES.find((choice) => retentionToValue(choice) === value)
  if (days !== undefined) void preferences.setHistoryRetentionDays(days)
}

async function confirmClear(): Promise<void> {
  if (clearBusy.value) return
  clearBusy.value = true
  clearError.value = ''
  const result = await historyApi.clear()
  clearBusy.value = false
  if (!result.ok) {
    clearError.value = result.error.message
    return
  }
  clearOpen.value = false
  clearNotice.value = describeCleared(result.data.deleted)
}

const firstInvalid = computed(() => {
  const field = (Object.keys(LIMIT_LABELS) as LimitField[]).find((name) => errors[name])
  return field ? `${LIMIT_LABELS[field]}: ${errors[field]}` : ''
})

const statusText = computed(() => {
  if (clearNotice.value) return clearNotice.value
  if (firstInvalid.value) return ''
  if (preferences.saveStatus === 'saving') return 'Guardando…'
  if (preferences.saveStatus === 'saved') return 'Guardado'
  return ''
})

const statusState = computed(() => {
  if (clearNotice.value) return 'notice'
  return firstInvalid.value ? 'idle' : preferences.saveStatus
})

const problem = computed(() => {
  if (preferences.saveStatus === 'error' && preferences.error) {
    return `No se pudo guardar el cambio: ${preferences.error.message}`
  }
  return firstInvalid.value ? `No se ha guardado. ${firstInvalid.value}` : ''
})
</script>

<template>
  <ModalDialog
    :open="settings.isOpen"
    :labelledby="titleId"
    :describedby="descriptionId"
    class="settings-dialog"
    data-dialog="settings"
    @close="settings.close()"
    @focus-lost="editor.focusEditor()"
  >
    <div v-if="settings.isOpen" ref="content" class="settings-dialog__content">
      <h2 :id="titleId" class="settings-dialog__title">Ajustes</h2>
      <p :id="descriptionId" class="placeholder">
        Los cambios se aplican y se guardan al momento. Main aplica además sus propios topes.
      </p>

      <div
        v-if="preferences.status === 'error'"
        class="callout callout--error callout--with-action"
        role="alert"
        data-part="load-error"
      >
        <p>
          <strong>No se pudieron leer los ajustes guardados.</strong> Se muestran los valores por
          defecto.
        </p>
        <button
          type="button"
          class="btn btn--secondary"
          data-action="retry-load"
          @click="preferences.load()"
        >
          Reintentar
        </button>
      </div>

      <section
        class="settings-section"
        data-section="appearance"
        :aria-labelledby="`${uid}-appearance`"
      >
        <h3 :id="`${uid}-appearance`" class="settings-section__title">Apariencia</h3>
        <fieldset class="settings-fieldset" :aria-describedby="themeHintId">
          <legend class="form-field__label">Tema</legend>
          <div class="settings-choices">
            <label v-for="option in THEME_OPTIONS" :key="option" class="settings-choice">
              <input
                type="radio"
                name="theme"
                :value="option"
                :checked="preferences.theme === option"
                :data-initial-focus="preferences.theme === option ? '' : undefined"
                @change="preferences.setTheme(option)"
              />
              {{ THEME_LABELS[option] }}
            </label>
          </div>
          <p :id="themeHintId" class="form-field__hint">
            «Sistema» sigue el aspecto de macOS y cambia con él.
          </p>
        </fieldset>
      </section>

      <section
        class="settings-section"
        data-section="execution"
        :aria-labelledby="`${uid}-execution`"
      >
        <h3 :id="`${uid}-execution`" class="settings-section__title">Ejecución</h3>

        <FormField
          label="Tiempo máximo (segundos)"
          :error="errors.timeoutSeconds"
          :hint="`Entre ${EXECUTION_LIMITS.timeoutSeconds.min} y ${EXECUTION_LIMITS.timeoutSeconds.max} s.`"
          v-slot="{ id, describedBy, invalid }"
        >
          <input
            :id="id"
            v-model="draft.timeoutSeconds"
            type="text"
            inputmode="numeric"
            name="timeoutSeconds"
            autocomplete="off"
            data-initial-focus
            :aria-describedby="describedBy"
            :aria-invalid="invalid ? 'true' : undefined"
            @input="revalidate('timeoutSeconds')"
            @change="commitLimit('timeoutSeconds')"
            @keydown.enter.prevent="commitLimit('timeoutSeconds')"
          />
        </FormField>

        <FormField
          label="Máximo de filas"
          :error="errors.maxRows"
          :hint="`Entre ${EXECUTION_LIMITS.maxRows.min} y ${EXECUTION_LIMITS.maxRows.max.toLocaleString('es-ES')} filas por ejecución; el resto se descarta.`"
          v-slot="{ id, describedBy, invalid }"
        >
          <input
            :id="id"
            v-model="draft.maxRows"
            type="text"
            inputmode="numeric"
            name="maxRows"
            autocomplete="off"
            :aria-describedby="describedBy"
            :aria-invalid="invalid ? 'true' : undefined"
            @input="revalidate('maxRows')"
            @change="commitLimit('maxRows')"
            @keydown.enter.prevent="commitLimit('maxRows')"
          />
        </FormField>

        <div class="form-field form-field--checkbox">
          <label class="form-field__label">
            <input
              type="checkbox"
              name="confirmDestructive"
              :checked="preferences.confirmDestructive"
              :aria-describedby="confirmHintId"
              @change="
                preferences.setConfirmDestructive(($event.target as HTMLInputElement).checked)
              "
            />
            Confirmar operaciones destructivas
          </label>
          <p :id="confirmHintId" class="form-field__hint">
            Pide confirmación antes de DROP, TRUNCATE y DELETE/UPDATE sin WHERE.
          </p>
        </div>
      </section>

      <section class="settings-section" data-section="history" :aria-labelledby="`${uid}-history`">
        <h3 :id="`${uid}-history`" class="settings-section__title">Historial</h3>

        <div class="form-field form-field--checkbox">
          <label class="form-field__label">
            <input
              type="checkbox"
              name="historyEnabled"
              data-initial-focus
              :checked="preferences.historyEnabled"
              :aria-describedby="historyHintId"
              @change="preferences.setHistoryEnabled(($event.target as HTMLInputElement).checked)"
            />
            Guardar el historial de consultas
          </label>
          <p :id="historyHintId" class="form-field__hint">
            Si lo desactivas no se registran las consultas nuevas; las ya guardadas se conservan
            hasta que caduquen o las vacíes.
          </p>
        </div>

        <FormField
          label="Conservar el historial durante"
          :hint="
            preferences.historyRetentionDays === null
              ? 'Sin límite: el texto de tus consultas, que puede incluir datos sensibles, no caduca nunca.'
              : 'Las consultas más antiguas se eliminan automáticamente, también al cambiar este valor.'
          "
          v-slot="{ id, describedBy }"
        >
          <select
            :id="id"
            name="historyRetentionDays"
            :aria-describedby="describedBy"
            @change="onRetentionChange"
          >
            <option
              v-for="choice in RETENTION_CHOICES"
              :key="retentionToValue(choice)"
              :value="retentionToValue(choice)"
              :selected="
                retentionToValue(preferences.historyRetentionDays) === retentionToValue(choice)
              "
            >
              {{ retentionLabel(choice) }}
            </option>
          </select>
        </FormField>

        <div>
          <button
            type="button"
            class="btn btn--secondary btn--danger"
            data-action="clear-history"
            @click="clearOpen = true"
          >
            Vaciar historial…
          </button>
        </div>
      </section>

      <AiSettingsSection />

      <div class="settings-dialog__footer">
        <p
          class="settings-dialog__status"
          role="status"
          aria-live="polite"
          data-part="settings-status"
          :data-state="statusState"
        >
          {{ statusText }}
        </p>
        <p v-if="problem" class="callout callout--error" role="alert" data-part="settings-problem">
          {{ problem }}
        </p>
        <button
          type="button"
          class="btn btn--secondary"
          data-action="close-settings"
          @click="settings.close()"
        >
          Cerrar
        </button>
      </div>
    </div>

    <ClearHistoryDialog
      :open="clearOpen"
      :busy="clearBusy"
      :error="clearError"
      @confirm="confirmClear"
      @close="clearOpen = false"
      @focus-lost="clearOpen = false"
    />
  </ModalDialog>
</template>

<style scoped>
.settings-dialog {
  width: min(34rem, calc(100vw - 2 * var(--spacing-4)));
}

.settings-dialog__content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-5);
  padding: var(--spacing-6);
}

.settings-dialog__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-3);
  padding-block-start: var(--spacing-4);
  border-top: 1px solid var(--border-subtle);
}

.settings-section__title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-md);
}

.settings-fieldset {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.settings-fieldset legend {
  padding: 0;
}

.settings-choices {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-2);
}

/* Opciones como fichas: la elegida lleva borde de acento además del punto del radio. */
.settings-choice {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-2);
  min-height: 32px;
  padding: 0 var(--spacing-3);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background: var(--input-bg);
  cursor: pointer;
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-out),
    border-color var(--motion-duration-fast) var(--motion-easing-out);
}

.settings-choice:hover {
  background: var(--surface-muted);
}

.settings-choice:has(input:checked) {
  border-color: var(--action-primary);
  box-shadow: var(--shadow-glow-ring);
}

.settings-choice input {
  margin: 0;
  accent-color: var(--action-primary);
  cursor: pointer;
}

.settings-dialog__footer {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--spacing-2) var(--spacing-3);
  margin: 0 calc(-1 * var(--spacing-6)) calc(-1 * var(--spacing-6));
  padding: var(--spacing-3) var(--spacing-6);
  border-top: 1px solid var(--border-subtle);
  background: var(--dialog-bg);
}

.settings-dialog__status {
  flex: 1;
  min-width: 6rem;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
}

.settings-dialog__status[data-state='saved']::before {
  content: var(--status-glyph-success);
  margin-inline-end: var(--spacing-1);
  color: var(--status-success);
}

.settings-dialog__status[data-state='saving']::before {
  content: var(--query-glyph-running);
  display: inline-block;
  margin-inline-end: var(--spacing-1);
  color: var(--query-running);
  animation: spin var(--motion-duration-spin) var(--motion-easing-linear)
    var(--motion-iteration-loop);
}

.settings-dialog__status[data-state='notice']::before {
  content: var(--status-glyph-success);
  margin-inline-end: var(--spacing-1);
  color: var(--status-success);
}
</style>
