<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { shortcutHint } from '../../command-palette/composables/use-shortcut-hints'
import { tabDomId, tabPanelDomId } from '../model/tab-ids'
import type { SqlTab } from '../stores/workspace'

const props = defineProps<{
  tabs: readonly SqlTab[]
  activeTabId: string | null
}>()

const emit = defineEmits<{
  activate: [tabId: string]
  close: [tabId: string]
  new: []
}>()

const root = ref<HTMLElement | null>(null)
const newTabShortcut = shortcutHint('tab.new')
const closeTabShortcut = shortcutHint('tab.close')

function tabButton(tabId: string): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(`#${tabDomId(tabId)}`) ?? null
}

/** Enfoca la pestaña activa o, si ya no queda ninguna, el botón de nueva pestaña. */
function focusActive(): void {
  const target = props.activeTabId === null ? null : tabButton(props.activeTabId)
  const fallback = root.value?.querySelector<HTMLElement>('[data-action="new-tab"]')
  ;(target ?? fallback)?.focus()
}

defineExpose({ focusActive })

function tabindexOf(tab: SqlTab, index: number): 0 | -1 {
  const active = props.activeTabId === null ? index === 0 : tab.id === props.activeTabId
  return active ? 0 : -1
}

function moveTo(index: number): void {
  const target = props.tabs[index]
  if (!target) return
  emit('activate', target.id)
  tabButton(target.id)?.focus()
}

// Patrón WAI-ARIA con activación automática: el foco y la selección se mueven juntos y el cambio
// de contenido es instantáneo. Intro/Espacio no hacen falta (el botón ya activa con `click`).
function onKeydown(event: KeyboardEvent, index: number, tab: SqlTab): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const last = props.tabs.length - 1
  switch (event.key) {
    case 'ArrowRight':
      moveTo(index === last ? 0 : index + 1)
      break
    case 'ArrowLeft':
      moveTo(index === 0 ? last : index - 1)
      break
    case 'Home':
      moveTo(0)
      break
    case 'End':
      moveTo(last)
      break
    case 'Delete':
      closeTab(tab.id)
      break
    default:
      return
  }
  event.preventDefault()
}

function closeTab(tabId: string): void {
  emit('close', tabId)
  void nextTick(focusActive)
}

function closeActive(): void {
  if (props.activeTabId !== null) closeTab(props.activeTabId)
}

watch(
  () => props.activeTabId,
  (tabId) => {
    if (tabId !== null)
      void nextTick(() => tabButton(tabId)?.scrollIntoView?.({ inline: 'nearest' }))
  },
  { flush: 'post' },
)
</script>

<template>
  <div ref="root" class="tabstrip">
    <div
      class="tabstrip__list"
      role="tablist"
      aria-label="Pestañas SQL"
      aria-orientation="horizontal"
    >
      <button
        v-for="(tab, index) in tabs"
        :id="tabDomId(tab.id)"
        :key="tab.id"
        type="button"
        role="tab"
        class="tab"
        :data-tab-id="tab.id"
        :aria-selected="tab.id === activeTabId ? 'true' : 'false'"
        :aria-controls="tab.id === activeTabId ? tabPanelDomId(tab.id) : undefined"
        :tabindex="tabindexOf(tab, index)"
        @click="emit('activate', tab.id)"
        @keydown="onKeydown($event, index, tab)"
      >
        <span class="tab__title">{{ tab.title }}</span>
        <!-- Solo ratón: el cierre por teclado/AT es Supr sobre la pestaña o el botón «Cerrar pestaña activa». -->
        <span class="tab__close" aria-hidden="true" @click.stop="closeTab(tab.id)">×</span>
      </button>
    </div>

    <div class="tabstrip__actions">
      <button
        type="button"
        class="btn btn--ghost tabstrip__action"
        data-action="new-tab"
        aria-label="Nueva pestaña SQL"
        :aria-keyshortcuts="newTabShortcut?.aria"
        @click="emit('new')"
      >
        <span aria-hidden="true">+</span>
      </button>
      <button
        type="button"
        class="btn btn--ghost tabstrip__action"
        data-action="close-active-tab"
        aria-label="Cerrar pestaña activa"
        :aria-keyshortcuts="closeTabShortcut?.aria"
        :disabled="activeTabId === null"
        @click="closeActive"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tabstrip {
  display: flex;
  align-items: stretch;
  min-width: 0;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--sidebar-bg);
}

.tabstrip__list {
  display: flex;
  flex: 0 1 auto;
  min-width: 0;
  min-height: 36px;
  overflow-x: auto;
  scrollbar-width: none;
}

.tabstrip__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--spacing-1);
  padding-inline: var(--spacing-2);
}

.tab {
  display: inline-flex;
  flex: 0 1 12rem;
  align-items: center;
  gap: var(--spacing-2);
  min-width: 6rem;
  min-height: 36px;
  padding: 0 var(--spacing-3);
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--tab-fg);
  font-size: var(--font-size-sm);
  line-height: var(--font-line-height-sm);
  cursor: pointer;
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-out),
    color var(--motion-duration-fast) var(--motion-easing-out);
}

.tab:hover:not([aria-selected='true']) {
  background: var(--surface-muted);
  color: var(--tab-fg-active);
}

/* El contenedor con scroll recortaría un anillo externo: el foco se dibuja hacia dentro. */
.tab:focus-visible {
  outline-offset: -2px;
}

.tab[aria-selected='true'] {
  border-bottom-color: var(--tab-indicator);
  background: var(--tab-bg-active);
  color: var(--tab-fg-active);
}

.tab__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-align: start;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab__close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  border-radius: var(--radius-xs);
  transition: background-color var(--motion-duration-fast) var(--motion-easing-out);
}

.tab__close:hover {
  background: var(--surface-secondary);
  box-shadow: inset 0 0 0 1px var(--border-strong);
  color: var(--text-on-secondary);
}

.tabstrip__action:disabled {
  color: var(--text-muted);
  cursor: default;
}
</style>
