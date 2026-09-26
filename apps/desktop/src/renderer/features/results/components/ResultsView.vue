<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { formatDuration, formatRows, formatRowsAs } from '../../execution/model/presentation'
import { useResultBuffers } from '../../execution/model/result-buffers'
import { useExecutionStore } from '../../execution/stores/execution'
import type { SqlTab } from '../../workspace/stores/workspace'
import { buildResultItems, defaultItem, type ResultItem } from '../model/result-items'
import ResultsGrid from './ResultsGrid.vue'

const props = defineProps<{ tab: SqlTab }>()

const uid = useId()
const execution = useExecutionStore()
const buffers = useResultBuffers()
const root = ref<HTMLElement | null>(null)

const state = computed(() => execution.stateOf(props.tab.id))
const snapshot = computed(() => buffers.snapshot(props.tab.id))
const running = computed(() => state.value.status !== 'idle')
const items = computed(() => buildResultItems(snapshot.value.sets, state.value.statements))

// La elección manual solo vale para la ejecución en la que se hizo: con otra se vuelve a la sentencia por defecto.
const picked = ref<{ generation: number; statementIndex: number } | null>(null)
watch(
  () => snapshot.value.generation,
  () => {
    picked.value = null
  },
)

const active = computed<ResultItem | null>(() => {
  const choice = picked.value
  const chosen =
    choice && choice.generation === snapshot.value.generation
      ? items.value.find((item) => item.statementIndex === choice.statementIndex)
      : undefined
  return chosen ?? defaultItem(items.value)
})

// Con grid, el resumen va en su barra de herramientas: así el panel, ya bajo, no pierde una línea entera.
const caption = computed(() => {
  const current = active.value
  if (!current?.set) return ''
  if (running.value) {
    const verb = state.value.status === 'cancelling' ? 'Cancelando…' : 'Ejecutando…'
    return `${verb} ${formatRowsAs(state.value.rowsReceived, 'recibida', 'recibidas')}.`
  }
  if (items.value.length > 1 && current.summary) {
    return `Sentencia n.º ${current.statementIndex + 1} · ${current.summary.command} · ${formatDuration(current.summary.durationMs)}`
  }
  if (state.value.durationMs === null) return ''
  return `${formatRowsAs(state.value.rowsReceived, 'recibida', 'recibidas')} en ${formatDuration(state.value.durationMs)}.`
})

const empty = computed(() => {
  const { status, outcome } = state.value
  if (items.value.length > 0 || status !== 'idle') return null
  if (outcome === 'done') return 'La ejecución no devolvió ninguna tabla de resultados.'
  if (outcome === null) return 'Ejecuta una consulta para ver aquí sus resultados.'
  return null
})

const tabDomId = (item: ResultItem): string => `${uid}-tab-${item.statementIndex}`
const panelDomId = `${uid}-panel`

function affectedText(item: ResultItem): string {
  const affected = item.summary?.rowsAffected ?? null
  if (affected !== null) return formatRowsAs(affected, 'afectada', 'afectadas')
  return 'sin filas'
}

function tabSummary(item: ResultItem): string {
  if (item.set) return formatRows(item.set.rows.length)
  return affectedText(item)
}

function limited(item: ResultItem): boolean {
  return (
    (item.summary?.truncated ?? false) ||
    (item.set ? item.set.rowsReceived > item.set.rows.length : false)
  )
}

function select(index: number): void {
  const target = items.value[(index + items.value.length) % items.value.length]
  if (!target) return
  picked.value = { generation: snapshot.value.generation, statementIndex: target.statementIndex }
  root.value?.querySelector<HTMLElement>(`#${tabDomId(target)}`)?.focus()
}

// Mismo patrón WAI-ARIA con activación automática que el resto de pestañas de la aplicación.
function onTabKeydown(event: KeyboardEvent, index: number): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const moves: Record<string, number> = {
    ArrowRight: index + 1,
    ArrowLeft: index - 1,
    Home: 0,
    End: items.value.length - 1,
  }
  const next = moves[event.key]
  if (next === undefined) return
  event.preventDefault()
  select(next)
}
</script>

<template>
  <div ref="root" class="results-view" data-part="results-view">
    <p v-if="state.errorSummary" class="callout callout--error" role="alert" data-part="error">
      <strong>La ejecución falló.</strong> {{ state.errorSummary }}
    </p>
    <p v-else-if="state.outcome === 'cancelled'" class="callout" data-part="cancelled">
      La ejecución se canceló.
    </p>

    <p v-if="running && !active?.set" class="callout callout--running" data-part="running">
      {{ state.status === 'cancelling' ? 'Cancelando…' : 'Ejecutando…' }}
      {{ formatRowsAs(state.rowsReceived, 'recibida', 'recibidas') }}.
    </p>
    <p
      v-else-if="!running && !active?.set && state.durationMs !== null"
      class="placeholder"
      data-part="stats"
    >
      {{ formatRowsAs(state.rowsReceived, 'recibida', 'recibidas') }} en
      {{ formatDuration(state.durationMs) }}.
    </p>

    <p v-if="empty" class="placeholder" data-part="empty">{{ empty }}</p>

    <p v-if="snapshot.evictedSets > 0" class="placeholder" data-part="evicted">
      Se descartaron {{ snapshot.evictedSets }} resultado(s) anteriores para respetar el límite de
      filas; se conservan los últimos.
    </p>

    <div
      v-if="items.length > 1"
      class="results-view__tabs"
      role="tablist"
      aria-label="Resultados por sentencia"
      data-part="result-tabs"
    >
      <button
        v-for="(item, index) in items"
        :id="tabDomId(item)"
        :key="item.statementIndex"
        type="button"
        role="tab"
        class="btn btn--ghost results-view__tab"
        :aria-selected="active?.statementIndex === item.statementIndex"
        :aria-controls="panelDomId"
        :tabindex="active?.statementIndex === item.statementIndex ? 0 : -1"
        :data-statement="item.statementIndex"
        @click="select(index)"
        @keydown="onTabKeydown($event, index)"
      >
        Sentencia n.º {{ item.statementIndex + 1 }} · {{ tabSummary(item) }}
      </button>
    </div>

    <div
      v-if="active"
      :id="panelDomId"
      class="results-view__content"
      :role="items.length > 1 ? 'tabpanel' : undefined"
      :aria-labelledby="items.length > 1 ? tabDomId(active) : undefined"
      :data-statement="active.statementIndex"
      data-part="result-content"
    >
      <template v-if="active.set">
        <ResultsGrid
          :key="`${snapshot.generation}-${active.statementIndex}`"
          :columns="active.set.columns"
          :rows="active.set.rows"
          :truncated-index="active.set.truncatedIndex"
          :version="snapshot.version"
          :busy="running"
          :caption="caption"
          :limited="limited(active)"
        />
      </template>
      <div v-else class="results-view__statement" data-part="statement-result">
        <p data-part="statement-affected">
          <template v-if="active.summary && active.summary.rowsAffected !== null">
            Sentencia n.º {{ active.statementIndex + 1 }} ({{ active.summary.command }}):
            {{ affectedText(active) }}.
          </template>
          <template v-else-if="active.summary && active.summary.rowsReturned > 0">
            Sentencia n.º {{ active.statementIndex + 1 }} ({{ active.summary.command }}): devolvió
            {{ formatRows(active.summary.rowsReturned) }}, que se descartaron para respetar el
            límite de filas.
          </template>
          <template v-else>
            Sentencia n.º {{ active.statementIndex + 1 }} ({{ active.summary?.command }}): sin
            filas.
          </template>
        </p>
        <p v-if="active.summary" class="placeholder" data-part="statement-duration">
          Duración: {{ formatDuration(active.summary.durationMs) }}.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.results-view {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  height: 100%;
  min-height: 0;
}

/* Pestañas por sentencia: fichas discretas, la activa con acento y marca de selección propia. */
.results-view__tabs {
  display: flex;
  flex: none;
  gap: var(--spacing-1);
  padding-block-end: var(--spacing-1);
  overflow-x: auto;
  border-bottom: 1px solid var(--border-subtle);
}

.results-view__tab {
  flex: none;
  min-height: 28px;
  border-color: var(--border-default);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.results-view__tab:hover:not([aria-selected='true']) {
  color: var(--text-primary);
}

.results-view__tab[aria-selected='true'] {
  border-color: var(--tab-indicator);
  background: var(--surface-secondary);
  box-shadow: inset 0 -2px 0 var(--tab-indicator);
  color: var(--text-on-secondary);
}

.results-view__content {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: var(--spacing-1);
  min-height: 0;
}

.results-view__statement {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-1);
  padding: var(--spacing-3);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-card);
}
</style>
