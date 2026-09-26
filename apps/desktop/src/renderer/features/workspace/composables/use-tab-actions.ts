import { nextTick } from 'vue'
import { useQueryEditor } from '../../query-editor'
import { tabDomId } from '../model/tab-ids'
import { useWorkspaceStore } from '../stores/workspace'
import { useActiveConnection } from './use-active-connection'

/** Pone el foco en la pestaña activa o, si ya no queda ninguna, en el botón de nueva pestaña. */
export function focusActiveTab(activeTabId: string | null): void {
  const tab = activeTabId === null ? null : document.getElementById(tabDomId(activeTabId))
  const fallback = document.querySelector<HTMLElement>('[data-action="new-tab"]')
  ;(tab ?? fallback)?.focus()
}

/** Acciones de pestañas compartidas por los botones y por los comandos (atajos y paleta). */
export function useTabActions() {
  const workspace = useWorkspaceStore()
  const activeConnection = useActiveConnection()
  const editor = useQueryEditor()

  // App keyboard-first: la pestaña nueva es para escribir, así que el foco va a su editor (el mismo
  // comportamiento por atajo, botón «+» y paleta). Las flechas del tablist no pasan por aquí: no roban el foco.
  function newTab(): void {
    workspace.createTab(activeConnection.value?.session.sessionId ?? null)
    void nextTick(() => {
      if (!editor.focusEditor()) focusActiveTab(workspace.activeTabId)
    })
  }

  // Tras cerrar, si el foco estaba en la pestaña eliminada se ha perdido: se recoloca.
  function closeActiveTab(): void {
    workspace.closeActiveTab()
    void nextTick(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        focusActiveTab(workspace.activeTabId)
      }
    })
  }

  return { newTab, closeActiveTab }
}
