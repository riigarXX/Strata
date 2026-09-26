import type { SessionId } from '@strata/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Pestaña SQL. Solo guarda lo que el usuario escribe y una referencia a la sesión: los resultados de
 * las consultas y cualquier secreto quedan fuera de Pinia (threat-model.md, invariantes 2 y 4).
 */
export interface SqlTab {
  id: string
  title: string
  content: string
  sessionId: SessionId | null
  /** Opt-out del historial por pestaña (ADR 0005): `false` hace que sus ejecuciones no se registren. */
  saveToHistory: boolean
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const tabs = ref<SqlTab[]>([])
  const activeTabId = ref<string | null>(null)
  // Contador monótono: cerrar una pestaña no reutiliza su título ni su id.
  const created = ref(0)
  // Textos pendientes de insertar en el cursor de cada pestaña; el editor los vacía con `takeInserts`.
  const insertQueues = ref<Record<string, string[]>>({})

  const activeIndex = computed(() => tabs.value.findIndex((tab) => tab.id === activeTabId.value))
  const activeTab = computed(() => tabs.value[activeIndex.value] ?? null)

  function createTab(sessionId: SessionId | null = null): SqlTab {
    created.value += 1
    const tab: SqlTab = {
      id: `tab-${created.value}`,
      title: `Consulta ${created.value}`,
      content: '',
      sessionId,
      saveToHistory: true,
    }
    tabs.value.push(tab)
    activeTabId.value = tab.id
    return tab
  }

  function activateTab(tabId: string): void {
    if (tabs.value.some((tab) => tab.id === tabId)) activeTabId.value = tabId
  }

  /** Índice 0-based; fuera de rango se ignora. */
  function activateAt(index: number): void {
    const tab = tabs.value[index]
    if (tab) activeTabId.value = tab.id
  }

  function activateLast(): void {
    activateAt(tabs.value.length - 1)
  }

  /** Recorre las pestañas de forma circular; `delta` es +1 (siguiente) o -1 (anterior). */
  function activateRelative(delta: 1 | -1): void {
    const count = tabs.value.length
    if (count === 0) return
    const from = activeIndex.value < 0 ? 0 : activeIndex.value
    activateAt((from + delta + count) % count)
  }

  /** Cierra sin confirmar. Si era la activa, pasa a la vecina de la derecha o, en su defecto, a la izquierda. */
  function closeTab(tabId: string): void {
    const index = tabs.value.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const wasActive = tabs.value[index]?.id === activeTabId.value
    tabs.value.splice(index, 1)
    delete insertQueues.value[tabId]
    if (wasActive) activeTabId.value = (tabs.value[index] ?? tabs.value[index - 1])?.id ?? null
  }

  function closeActiveTab(): void {
    if (activeTabId.value !== null) closeTab(activeTabId.value)
  }

  function setContent(tabId: string, content: string): void {
    const tab = tabs.value.find((entry) => entry.id === tabId)
    if (tab) tab.content = content
  }

  function setTitle(tabId: string, title: string): void {
    const tab = tabs.value.find((entry) => entry.id === tabId)
    if (tab) tab.title = title
  }

  function setSaveToHistory(tabId: string, value: boolean): void {
    const tab = tabs.value.find((entry) => entry.id === tabId)
    if (tab) tab.saveToHistory = value
  }

  /** Pide insertar `text` en el cursor de la pestaña activa (reemplaza la selección) y enfocar el editor. */
  function requestInsert(text: string): void {
    const tabId = activeTabId.value
    if (tabId === null || text === '') return
    ;(insertQueues.value[tabId] ??= []).push(text)
  }

  /** Consume las peticiones pendientes de la pestaña: una segunda llamada devuelve una lista vacía. */
  function takeInserts(tabId: string): string[] {
    const pending = insertQueues.value[tabId]
    if (!pending) return []
    delete insertQueues.value[tabId]
    return [...pending]
  }

  function setSession(tabId: string, sessionId: SessionId | null): void {
    const tab = tabs.value.find((entry) => entry.id === tabId)
    if (tab) tab.sessionId = sessionId
  }

  /** Desasocia las pestañas cuya sesión ya no está abierta. */
  function detachClosedSessions(liveSessionIds: ReadonlySet<SessionId>): void {
    for (const tab of tabs.value) {
      if (tab.sessionId !== null && !liveSessionIds.has(tab.sessionId)) tab.sessionId = null
    }
  }

  return {
    tabs,
    activeTabId,
    activeIndex,
    activeTab,
    insertQueues,
    createTab,
    activateTab,
    activateAt,
    activateLast,
    activateRelative,
    closeTab,
    closeActiveTab,
    setContent,
    setTitle,
    setSaveToHistory,
    requestInsert,
    takeInserts,
    setSession,
    detachClosedSessions,
  }
})
