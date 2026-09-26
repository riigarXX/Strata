<script setup lang="ts">
import { HISTORY_LIMITS, type HistoryEntry, type HistoryStatus } from '@strata/contracts'
import { computed, nextTick, ref, useId, watch } from 'vue'
import FormField from '../../../components/FormField.vue'
import ModalDialog from '../../../components/ModalDialog.vue'
import { usePaletteStore } from '../../command-palette/stores/palette'
import { useConnectionsStore } from '../../connections'
import { describeError, ENGINE_LABELS } from '../../connections/model/presentation'
import { usePreferencesStore } from '../../preferences'
import { useQueryEditor } from '../../query-editor'
import { useSettingsStore } from '../../settings/stores/settings'
import { useReopenEntry } from '../composables/use-reopen-entry'
import {
  DATE_PROBLEM_MESSAGES,
  describeCleared,
  describeCount,
  HISTORY_STATUS_LABELS,
} from '../model/presentation'
import { describeReopen } from '../model/reopen'
import { useHistoryPanelStore } from '../stores/history-panel'
import { useHistoryStore } from '../stores/history'
import ClearHistoryDialog from './ClearHistoryDialog.vue'
import HistoryEntryRow from './HistoryEntryRow.vue'

const panel = useHistoryPanelStore()
const history = useHistoryStore()
const preferences = usePreferencesStore()
const settings = useSettingsStore()
const connections = useConnectionsStore()
const palette = usePaletteStore()
const editor = useQueryEditor()
const reopen = useReopenEntry()

const uid = useId()
const titleId = `${uid}-title`
const descriptionId = `${uid}-description`

const STATUS_CHOICES = Object.keys(HISTORY_STATUS_LABELS) as HistoryStatus[]
const ENGINE_CHOICES = Object.entries(ENGINE_LABELS) as [keyof typeof ENGINE_LABELS, string][]

const list = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

const activeId = ref<string | null>(null)
const announcement = ref('')
const clearOpen = ref(false)
const clearError = ref('')
const removing = new Set<string>()

const view = computed<'error' | 'loading' | 'empty' | 'list'>(() => {
  if (history.entries.length > 0) return 'list'
  if (history.status === 'error') return 'error'
  return history.status === 'ready' ? 'empty' : 'loading'
})
const tabbableId = computed(() =>
  history.entries.some((entry) => entry.id === activeId.value)
    ? activeId.value
    : (history.entries[0]?.id ?? null),
)
const nothingToClear = computed(() => view.value === 'empty' && !history.filtered)
// El mensaje cuelga del campo que el usuario debe corregir: un rango invertido se corrige en «Hasta».
const fromError = computed(() =>
  history.dateProblem === 'invalid-from' ? DATE_PROBLEM_MESSAGES['invalid-from'] : undefined,
)
const toError = computed(() =>
  history.dateProblem === 'invalid-to' || history.dateProblem === 'inverted'
    ? DATE_PROBLEM_MESSAGES[history.dateProblem]
    : undefined,
)

async function announce(message: string): Promise<void> {
  announcement.value = ''
  await nextTick()
  announcement.value = message
}

function rowButtons(): HTMLElement[] {
  return [...(list.value?.querySelectorAll<HTMLElement>('[data-part="entry"]') ?? [])]
}

function focusRowAt(index: number): void {
  const buttons = rowButtons()
  buttons[Math.min(Math.max(index, 0), buttons.length - 1)]?.focus()
}

function focusRowOf(id: string): void {
  focusRowAt(history.entries.findIndex((entry) => entry.id === id))
}

function focusSearch(): void {
  searchInput.value?.focus()
}

function move(id: string, direction: 'previous' | 'next' | 'first' | 'last'): void {
  const index = history.entries.findIndex((entry) => entry.id === id)
  const target = {
    previous: index - 1,
    next: index + 1,
    first: 0,
    last: history.entries.length - 1,
  }[direction]
  focusRowAt(target)
}

// Desde la lista, «/» lleva a la búsqueda como en otros paneles con filtro.
function onListKeydown(event: KeyboardEvent): void {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
  event.preventDefault()
  focusSearch()
}

function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    void history.load()
  } else if (event.key === 'ArrowDown' && history.entries.length > 0) {
    event.preventDefault()
    focusRowAt(0)
  }
}

function onSearchInput(event: Event): void {
  history.setSearch((event.target as HTMLInputElement).value)
}

function onStatusChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  void history.setStatus(STATUS_CHOICES.find((choice) => choice === value) ?? null)
}

function onEngineChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  void history.setEngine(ENGINE_CHOICES.find(([engine]) => engine === value)?.[0] ?? null)
}

function onProfileChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  void history.setProfile(value === '' ? null : value)
}

function onFromChange(event: Event): void {
  void history.setFrom((event.target as HTMLInputElement).value)
}

function onToChange(event: Event): void {
  void history.setTo((event.target as HTMLInputElement).value)
}

async function clearFilters(): Promise<void> {
  history.resetFilters()
  await history.load()
  focusSearch()
}

async function reopenEntry(entry: HistoryEntry): Promise<void> {
  const outcome = reopen(entry)
  panel.close()
  await nextTick()
  editor.focusEditor()
  void palette.announce(describeReopen(outcome))
}

async function removeEntry(entry: HistoryEntry): Promise<void> {
  if (removing.has(entry.id)) return
  removing.add(entry.id)
  const index = history.entries.findIndex((candidate) => candidate.id === entry.id)
  const neighbour = history.entries[index + 1] ?? history.entries[index - 1]
  const removed = await history.remove(entry.id)
  removing.delete(entry.id)

  if (!removed) {
    void announce(
      `No se pudo borrar la consulta. ${history.actionError ? describeError(history.actionError) : ''}`,
    )
    return
  }
  void announce('Consulta eliminada del historial')
  await nextTick()
  if (neighbour && history.entries.some((candidate) => candidate.id === neighbour.id)) {
    focusRowOf(neighbour.id)
  } else {
    focusSearch()
  }
}

async function loadMore(): Promise<void> {
  const before = history.entries.length
  await history.loadMore()
  const added = history.entries.length - before
  if (history.moreError || added === 0) return
  void announce(
    `${added} consultas más cargadas. ${describeCount(history.entries.length, history.hasMore)}`,
  )
  // Si ya no quedan páginas el botón desaparece: el foco pasa a la primera consulta nueva.
  if (!history.hasMore) {
    await nextTick()
    focusRowAt(before)
  }
}

async function confirmClear(): Promise<void> {
  clearError.value = ''
  const result = await history.clear()
  if (!result.ok) {
    clearError.value = result.error.message
    return
  }
  clearOpen.value = false
  void announce(describeCleared(result.data.deleted))
}

function openClear(): void {
  if (nothingToClear.value) return
  clearError.value = ''
  clearOpen.value = true
}

// Cada apertura parte de cero: sin filtros ni fila activa, con la primera página al día.
watch(
  () => panel.isOpen,
  async (open) => {
    history.resetFilters()
    activeId.value = null
    announcement.value = ''
    clearOpen.value = false
    clearError.value = ''
    if (!open) {
      history.discard()
      return
    }
    void history.load()
    history.startClock()
    await nextTick()
    focusSearch()
  },
  { immediate: true },
)

watch(
  () => history.dateProblem,
  (problem) => {
    if (problem && panel.isOpen) void announce(DATE_PROBLEM_MESSAGES[problem])
  },
)

// Una consulta ejecutada con el panel abierto entra sola en la lista: se anuncia sin mover el foco.
watch(
  () => history.arrivals,
  () => {
    if (panel.isOpen) void announce('Consulta nueva añadida al historial')
  },
)

watch(
  () => history.status,
  (status) => {
    if (status === 'ready' && panel.isOpen) {
      void announce(describeCount(history.entries.length, history.hasMore))
    }
  },
)
</script>

<template>
  <ModalDialog
    :open="panel.isOpen"
    wide
    :labelledby="titleId"
    :describedby="descriptionId"
    class="history-dialog"
    data-dialog="history"
    @close="panel.close()"
    @focus-lost="editor.focusEditor()"
  >
    <div v-if="panel.isOpen" class="history-dialog__content">
      <h2 :id="titleId" class="history-dialog__title">Historial de consultas</h2>
      <p :id="descriptionId" class="placeholder">
        Solo se guardan el texto de la consulta y los datos de su ejecución, nunca los resultados.
        Flechas para moverte por la lista, Intro para reabrir la consulta en una pestaña nueva, Supr
        para borrarla y «/» para buscar.
      </p>

      <div
        v-if="!preferences.historyEnabled"
        class="callout callout--warning callout--with-action"
        role="status"
        data-part="history-disabled"
      >
        <p>
          <strong>El historial está desactivado.</strong> Las consultas nuevas no se guardan; las
          que ya había se conservan hasta que caduquen o las vacíes.
        </p>
        <button
          type="button"
          class="btn btn--secondary"
          data-action="open-history-settings"
          @click="settings.open('history')"
        >
          Abrir ajustes
        </button>
      </div>

      <div class="history-dialog__filters" role="search" aria-label="Filtrar el historial">
        <FormField label="Buscar en las consultas" v-slot="{ id }">
          <input
            :id="id"
            ref="searchInput"
            type="search"
            name="search"
            autocomplete="off"
            :maxlength="HISTORY_LIMITS.searchMaxChars"
            :value="history.filters.search"
            @input="onSearchInput"
            @keydown="onSearchKeydown"
          />
        </FormField>
        <FormField label="Estado" v-slot="{ id }">
          <select
            :id="id"
            name="status"
            :value="history.filters.status ?? ''"
            @change="onStatusChange"
          >
            <option value="">Todos</option>
            <option v-for="choice in STATUS_CHOICES" :key="choice" :value="choice">
              {{ HISTORY_STATUS_LABELS[choice] }}
            </option>
          </select>
        </FormField>
        <FormField label="Motor" v-slot="{ id }">
          <select
            :id="id"
            name="engine"
            :value="history.filters.engine ?? ''"
            @change="onEngineChange"
          >
            <option value="">Todos</option>
            <option v-for="[engine, label] in ENGINE_CHOICES" :key="engine" :value="engine">
              {{ label }}
            </option>
          </select>
        </FormField>
        <FormField label="Conexión" v-slot="{ id }">
          <select
            :id="id"
            name="profile"
            :value="history.filters.profileId ?? ''"
            @change="onProfileChange"
          >
            <option value="">Todas</option>
            <option v-for="profile in connections.profiles" :key="profile.id" :value="profile.id">
              {{ profile.name }}
            </option>
          </select>
        </FormField>
        <FormField
          label="Desde (hora local)"
          :error="fromError"
          v-slot="{ id, describedBy, invalid }"
        >
          <input
            :id="id"
            type="date"
            name="from"
            :max="history.filters.to || undefined"
            :value="history.filters.from"
            :aria-describedby="describedBy"
            :aria-invalid="invalid ? 'true' : undefined"
            @change="onFromChange"
          />
        </FormField>
        <FormField
          label="Hasta (hora local)"
          :error="toError"
          v-slot="{ id, describedBy, invalid }"
        >
          <input
            :id="id"
            type="date"
            name="to"
            :min="history.filters.from || undefined"
            :value="history.filters.to"
            :aria-describedby="describedBy"
            :aria-invalid="invalid ? 'true' : undefined"
            @change="onToChange"
          />
        </FormField>
      </div>

      <p class="visually-hidden" role="status" aria-live="polite" data-part="history-status">
        {{ announcement }}
      </p>

      <div
        class="history-dialog__body"
        :aria-busy="history.status === 'loading' ? 'true' : undefined"
      >
        <p v-if="view === 'loading'" class="callout callout--running" data-state="loading">
          Cargando historial…
        </p>

        <div
          v-else-if="view === 'error'"
          class="callout callout--error callout--with-action"
          role="alert"
          data-state="error"
        >
          <p>
            <strong>No se pudo leer el historial.</strong>
            {{ history.error ? describeError(history.error) : '' }}
          </p>
          <button
            type="button"
            class="btn btn--secondary"
            data-action="retry-history"
            @click="history.load()"
          >
            Reintentar
          </button>
        </div>

        <div v-else-if="view === 'empty'" class="history-dialog__empty" data-state="empty">
          <template v-if="history.filtered">
            <p>Ninguna consulta coincide con la búsqueda y los filtros.</p>
            <button
              type="button"
              class="btn btn--secondary"
              data-action="clear-filters"
              @click="clearFilters"
            >
              Quitar filtros
            </button>
          </template>
          <p v-else class="placeholder">
            Todavía no hay consultas en el historial. Aparecerán aquí al ejecutarlas.
          </p>
        </div>

        <ul
          v-else
          ref="list"
          class="history-list"
          aria-label="Consultas del historial"
          @keydown="onListKeydown"
        >
          <HistoryEntryRow
            v-for="entry in history.entries"
            :key="entry.id"
            :entry="entry"
            :now="history.now"
            :tabbable="entry.id === tabbableId"
            @activate="activeId = entry.id"
            @reopen="reopenEntry(entry)"
            @delete="removeEntry(entry)"
            @move="move(entry.id, $event)"
          />
        </ul>

        <div v-if="view === 'list' && history.hasMore" class="history-dialog__more">
          <button
            type="button"
            class="btn btn--secondary"
            data-action="load-more"
            :aria-disabled="history.loadingMore ? 'true' : undefined"
            @click="!history.loadingMore && loadMore()"
          >
            {{ history.loadingMore ? 'Cargando…' : 'Cargar más' }}
          </button>
        </div>
        <p
          v-if="history.moreError"
          class="callout callout--error"
          role="alert"
          data-part="more-error"
        >
          <strong>No se pudieron cargar más consultas.</strong>
          {{ describeError(history.moreError) }}
        </p>
        <p
          v-if="history.actionError"
          class="callout callout--error"
          role="alert"
          data-part="action-error"
        >
          <strong>No se pudo borrar la consulta.</strong> {{ describeError(history.actionError) }}
        </p>
      </div>

      <div class="history-dialog__footer">
        <button
          type="button"
          class="btn btn--secondary btn--danger"
          data-action="clear-history"
          :aria-disabled="nothingToClear ? 'true' : undefined"
          @click="openClear"
        >
          Vaciar historial…
        </button>
        <button
          type="button"
          class="btn btn--secondary"
          data-action="close-history"
          @click="panel.close()"
        >
          Cerrar
        </button>
      </div>
    </div>

    <ClearHistoryDialog
      :open="clearOpen"
      :busy="history.clearing"
      :error="clearError"
      @confirm="confirmClear"
      @close="clearOpen = false"
      @focus-lost="clearOpen = false"
    />
  </ModalDialog>
</template>

<style scoped>
/* El cuerpo (la lista) es lo único que se desplaza: título, filtros y pie quedan siempre a la vista. */
.history-dialog__content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  max-height: calc(100vh - 2 * var(--spacing-6) - 2px);
  padding: var(--spacing-6);
}

.history-dialog__content > * {
  flex: none;
}

.history-dialog__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}

.history-dialog__filters {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--spacing-3);
}

/* La búsqueda ocupa dos columnas; conexión y fechas van en la segunda fila. */
.history-dialog__filters > :first-child {
  grid-column: span 2;
}

@media (max-width: 44rem) {
  .history-dialog__filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .history-dialog__filters > :first-child {
    grid-column: 1 / -1;
  }
}

.history-dialog__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--spacing-3);
  min-height: 8rem;
  padding-inline-end: var(--spacing-1);
  overflow: auto;
  overscroll-behavior: contain;
}

.history-dialog__body > * {
  flex: none;
}

.history-dialog__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-3);
  padding: var(--spacing-8) var(--spacing-4);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  text-align: center;
}

.history-dialog__empty::before {
  content: var(--status-glyph-inactive);
  color: var(--text-muted);
  font-size: var(--font-size-xl);
  line-height: var(--font-line-height-lg);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.history-dialog__more {
  display: flex;
  justify-content: center;
}

.history-dialog__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--spacing-2);
  padding-block-start: var(--spacing-4);
  border-top: 1px solid var(--border-subtle);
}
</style>
