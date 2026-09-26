<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import type { SqlTab } from '../../workspace/stores/workspace'
import { ResultsView } from '../../results'
import { useExecutionStore } from '../stores/execution'
import ExecutionMessages from './ExecutionMessages.vue'

const props = defineProps<{ tab: SqlTab }>()

type Pane = 'results' | 'messages' | 'plan'

const PANES: readonly { id: Pane; label: string }[] = [
  { id: 'results', label: 'Resultados' },
  { id: 'messages', label: 'Mensajes' },
  { id: 'plan', label: 'Plan' },
]

const uid = useId()
const execution = useExecutionStore()
const active = ref<Pane>('results')
const root = ref<HTMLElement | null>(null)

const messageCount = computed(() => execution.stateOf(props.tab.id).messages.length)

const tabDomId = (pane: Pane): string => `${uid}-tab-${pane}`
const panelDomId = (pane: Pane): string => `${uid}-panel-${pane}`

function select(index: number): void {
  const target = PANES[(index + PANES.length) % PANES.length]
  if (!target) return
  active.value = target.id
  root.value?.querySelector<HTMLElement>(`#${tabDomId(target.id)}`)?.focus()
}

// Patrón WAI-ARIA con activación automática, igual que las pestañas de consulta.
function onKeydown(event: KeyboardEvent, index: number): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const moves: Record<string, number> = {
    ArrowRight: index + 1,
    ArrowLeft: index - 1,
    Home: 0,
    End: PANES.length - 1,
  }
  const next = moves[event.key]
  if (next === undefined) return
  event.preventDefault()
  select(next)
}
</script>

<template>
  <div ref="root" class="results-panel">
    <div class="results-panel__tabs" role="tablist" aria-label="Resultados, mensajes y plan">
      <button
        v-for="(pane, index) in PANES"
        :id="tabDomId(pane.id)"
        :key="pane.id"
        type="button"
        role="tab"
        class="btn btn--ghost results-panel__tab"
        :data-pane="pane.id"
        :aria-selected="active === pane.id"
        :aria-controls="panelDomId(pane.id)"
        :tabindex="active === pane.id ? 0 : -1"
        @click="active = pane.id"
        @keydown="onKeydown($event, index)"
      >
        {{ pane.label
        }}<span v-if="pane.id === 'messages' && messageCount > 0" class="results-panel__count">
          ({{ messageCount }})</span
        >
      </button>
    </div>

    <div
      v-for="pane in PANES"
      v-show="active === pane.id"
      :id="panelDomId(pane.id)"
      :key="pane.id"
      class="results-panel__body"
      role="tabpanel"
      tabindex="0"
      :aria-labelledby="tabDomId(pane.id)"
      :data-pane-content="pane.id"
    >
      <ResultsView v-if="pane.id === 'results'" :tab="tab" />
      <ExecutionMessages v-else-if="pane.id === 'messages'" :tab="tab" />
      <p v-else class="placeholder results-panel__empty" data-part="plan-placeholder">
        El plan de ejecución no está disponible en el MVP.
      </p>
    </div>
  </div>
</template>

<style scoped>
.results-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* Misma anatomía que las pestañas de consulta: barra tenue, pestaña activa elevada y un indicador de acento. */
.results-panel__tabs {
  display: flex;
  flex: none;
  min-width: 0;
  overflow-x: auto;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--sidebar-bg);
  scrollbar-width: none;
}

.results-panel__tab {
  flex: none;
  gap: var(--spacing-2);
  min-height: 32px;
  padding: 0 var(--spacing-4);
  border-width: 0 0 2px;
  border-radius: 0;
  color: var(--tab-fg);
  white-space: nowrap;
}

.results-panel__tab:hover:not([aria-selected='true']) {
  background: var(--surface-muted);
  color: var(--tab-fg-active);
}

/* La barra recorta con su scroll: el anillo de foco se dibuja hacia dentro. */
.results-panel__tab:focus-visible {
  outline-offset: -2px;
}

.results-panel__tab[aria-selected='true'] {
  border-bottom-color: var(--tab-indicator);
  background: var(--tab-bg-active);
  color: var(--tab-fg-active);
}

.results-panel__count {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.results-panel__tab[aria-selected='true'] .results-panel__count {
  color: inherit;
}

.results-panel__body {
  flex: 1 1 0;
  min-height: 0;
  padding: var(--spacing-3);
  overflow: auto;
}

.results-panel__empty {
  padding: var(--spacing-4);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-sm);
  text-align: center;
}
</style>
