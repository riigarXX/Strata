<script setup lang="ts">
import { computed, ref } from 'vue'
import ResizeSeparator from '../../../components/ResizeSeparator.vue'
import { ExecutionToolbar, ResultsPanel } from '../../execution'
import { SqlEditor } from '../../query-editor'
import { clampSize, paneLimits } from '../composables/pane-limits'
import { useElementSize } from '../composables/use-element-size'
import { useLiveConnections } from '../composables/use-active-connection'
import { tabDomId, tabPanelDomId } from '../model/tab-ids'
import { PANEL_SIZE, useLayoutStore } from '../stores/layout'
import type { SqlTab } from '../stores/workspace'

const props = defineProps<{ tab: SqlTab }>()

// Espacio mínimo que se le deja siempre al editor al agrandar el panel de resultados.
const EDITOR_MIN_SIZE = 120
const RESULTS_ID = 'strata-results-panel'

const layout = useLayoutStore()
const live = useLiveConnections()
// Motor de la sesión de la pestaña: decide el dialecto del editor; sin conexión, SQL estándar.
const engine = computed(
  () =>
    live.value.find((entry) => entry.session.sessionId === props.tab.sessionId)?.session.engine ??
    null,
)
const panel = ref<HTMLElement | null>(null)
const toolbar = ref<HTMLElement | null>(null)
const { height } = useElementSize(panel)
const { height: toolbarHeight } = useElementSize(toolbar)

// La barra de herramientas puede partirse en varias líneas en ventanas estrechas: su alto sale del
// espacio repartible, o el editor quedaría reducido a una franja.
const limits = computed(() =>
  paneLimits(PANEL_SIZE, height.value, toolbarHeight.value + EDITOR_MIN_SIZE + 1),
)
const size = computed(() => clampSize(layout.panelSize, limits.value))
</script>

<template>
  <div
    :id="tabPanelDomId(tab.id)"
    ref="panel"
    class="tab-panel"
    role="tabpanel"
    tabindex="0"
    :aria-labelledby="tabDomId(tab.id)"
    :style="{ '--results-size': `${size}px` }"
  >
    <div ref="toolbar">
      <ExecutionToolbar :tab="tab" />
    </div>

    <section class="tab-panel__editor" aria-label="Editor SQL" data-region="editor">
      <SqlEditor :tab="tab" :engine="engine" />
    </section>

    <ResizeSeparator
      :model-value="size"
      :min="limits.min"
      :max="limits.max"
      orientation="horizontal"
      inverted
      label="Redimensionar panel de resultados"
      :controls="RESULTS_ID"
      @update:model-value="layout.panelSize = $event"
    />

    <section
      :id="RESULTS_ID"
      class="tab-panel__results"
      aria-label="Resultados, mensajes y plan de ejecución"
      data-region="results"
    >
      <ResultsPanel :tab="tab" />
    </section>
  </div>
</template>

<style scoped>
.tab-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto var(--results-size);
  min-height: 0;
  min-width: 0;
}

/* El panel entero es enfocable (tabindex 0): el anillo se dibuja hacia dentro para no recortarse. */
.tab-panel:focus-visible {
  outline-offset: -2px;
}

.tab-panel__editor,
.tab-panel__results {
  min-height: 0;
  min-width: 0;
}

.tab-panel__results {
  overflow: auto;
}

/* El editor gestiona su propio scroll (fino, por herencia de base.css) y su relleno: las líneas llevan su
   sangría y el resto se pinta hasta el borde. */
.tab-panel__editor {
  position: relative;
  isolation: isolate;
  padding: 0;
  overflow: hidden;
  background: var(--editor-bg);
  color: var(--editor-fg);
}

/* Anillo de foco superpuesto: por encima de las canaletas y sin recortarse. */
.tab-panel__editor::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 300;
  pointer-events: none;
  outline-offset: -2px;
}

.tab-panel__editor:focus-within::after {
  outline: 2px solid var(--focus-ring);
}
</style>
