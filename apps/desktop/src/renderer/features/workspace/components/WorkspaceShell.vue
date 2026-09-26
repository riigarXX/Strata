<script setup lang="ts">
import { computed, ref } from 'vue'
import ResizeSeparator from '../../../components/ResizeSeparator.vue'
import { AskDialog } from '../../ai'
import { CommandPalette, useGlobalShortcuts } from '../../command-palette'
import { ConnectionsSidebar } from '../../connections'
import { useExecutionLifecycle, useLastQueryDuration } from '../../execution'
import { HistoryDialog, useHistoryFeed } from '../../history'
import { SchemaBrowser } from '../../schema-browser'
import { SettingsDialog } from '../../settings'
import { clampSize, paneLimits } from '../composables/pane-limits'
import { useActiveConnection } from '../composables/use-active-connection'
import { useElementSize } from '../composables/use-element-size'
import { useTabActions } from '../composables/use-tab-actions'
import { useTabSessionBinding } from '../composables/use-tab-session-binding'
import { SIDEBAR_SIZE, useLayoutStore } from '../stores/layout'
import { useWorkspaceStore } from '../stores/workspace'
import StatusBar from './StatusBar.vue'
import TabPanel from './TabPanel.vue'
import TabStrip from './TabStrip.vue'

// Espacio mínimo que se le deja siempre a la zona de pestañas al agrandar la sidebar.
const CENTER_MIN_SIZE = 360
const SIDEBAR_ID = 'strata-sidebar'

const workspace = useWorkspaceStore()
const layout = useLayoutStore()
const activeConnection = useActiveConnection()
useTabSessionBinding()
useExecutionLifecycle()
useHistoryFeed()
const lastQueryDuration = useLastQueryDuration()

const body = ref<HTMLElement | null>(null)
const { width } = useElementSize(body)

const sidebarLimits = computed(() => paneLimits(SIDEBAR_SIZE, width.value, CENTER_MIN_SIZE + 1))
const sidebarSize = computed(() => clampSize(layout.sidebarSize, sidebarLimits.value))

const { newTab } = useTabActions()

// Todos los atajos (pestañas, ejecución, paleta…) los resuelve el registro de comandos.
useGlobalShortcuts()
</script>

<template>
  <div class="shell">
    <header class="shell__titlebar">
      <h1 class="shell__title">Strata</h1>
    </header>

    <div ref="body" class="shell__body" :style="{ '--sidebar-size': `${sidebarSize}px` }">
      <aside :id="SIDEBAR_ID" class="shell__sidebar" aria-label="Barra lateral">
        <ConnectionsSidebar />
        <section
          class="shell__schema"
          aria-label="Explorador de esquema"
          data-region="schema-explorer"
        >
          <SchemaBrowser />
        </section>
      </aside>

      <ResizeSeparator
        :model-value="sidebarSize"
        :min="sidebarLimits.min"
        :max="sidebarLimits.max"
        orientation="vertical"
        label="Redimensionar barra lateral"
        :controls="SIDEBAR_ID"
        @update:model-value="layout.sidebarSize = $event"
      />

      <main class="shell__main">
        <TabStrip
          :tabs="workspace.tabs"
          :active-tab-id="workspace.activeTabId"
          @activate="workspace.activateTab"
          @close="workspace.closeTab"
          @new="newTab"
        />
        <TabPanel v-if="workspace.activeTab" :tab="workspace.activeTab" />
        <div v-else class="shell__empty" data-region="no-tabs">
          <p class="shell__empty-title">No hay pestañas abiertas</p>
          <p class="placeholder">Pulsa «Nueva pestaña SQL» o Cmd/Ctrl+T para abrir una consulta.</p>
        </div>
      </main>
    </div>

    <StatusBar :connection="activeConnection" :last-query-duration="lastQueryDuration" />
    <CommandPalette />
    <SettingsDialog />
    <HistoryDialog />
    <AskDialog />
  </div>
</template>

<style scoped>
/* `position: relative` hace del shell el bloque contenedor de los `.visually-hidden` (absolutos): sin él
   escapan al recorte del `overflow: hidden` y el documento gana una barra de desplazamiento. */
.shell {
  position: relative;
  display: grid;
  grid-template-rows: var(--spacing-header) minmax(0, 1fr) auto;
  height: 100vh;
  overflow: hidden;
}

/* Zona arrastrable de la ventana; en macOS los semáforos (hiddenInset) quedan a la izquierda y este
   margen impide que nada interactivo se sitúe bajo ellos. */
.shell__titlebar {
  --window-controls-inset: 80px;
  display: flex;
  align-items: center;
  padding: 0 var(--spacing-4) 0 var(--window-controls-inset);
  border-bottom: 1px solid var(--sidebar-border);
  background: var(--sidebar-bg);
  -webkit-app-region: drag;
  user-select: none;
}

.shell__title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-md);
  letter-spacing: 0.02em;
}

.shell__body {
  display: grid;
  grid-template-columns: var(--sidebar-size) auto minmax(0, 1fr);
  min-height: 0;
}

.shell__sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--sidebar-bg);
}

/* Las conexiones ocupan lo que necesitan (con tope) y el explorador de esquema se queda con el resto. */
.shell__sidebar > :first-child {
  flex: 0 1 auto;
  max-height: 45%;
}

.shell__schema {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 0;
  padding: var(--spacing-3);
  overflow: auto;
  border-top: 1px solid var(--sidebar-border);
}

.shell__main {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}

.shell__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-2);
  padding: var(--spacing-6);
  text-align: center;
}

.shell__empty-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  line-height: var(--font-line-height-lg);
}
</style>
