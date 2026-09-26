import { shallowRef } from 'vue'
import type { ExecutionText } from '../model/execution-text'

/** Operaciones del editor de la pestaña activa que se exponen al resto de la app. */
export interface EditorHandle {
  executionText(): ExecutionText
  documentText(): ExecutionText
  focus(): void
  format(): Promise<boolean>
}

// Solo hay un editor montado a la vez (el de la pestaña activa): un único registro basta.
const current = shallowRef<EditorHandle | null>(null)

/** Lo llama el editor al montarse; devuelve la función que lo retira. */
export function registerEditor(handle: EditorHandle): () => void {
  current.value = handle
  return () => {
    if (current.value === handle) current.value = null
  }
}

/**
 * API del editor para atajos, paleta y schema browser. Sin pestaña activa, `null`/`false`.
 * `Cmd+Enter` usará `getExecutionText` y `Shift+Cmd+Enter` `getDocumentText`; `Cmd/Ctrl+L`, `focusEditor`.
 */
export function useQueryEditor() {
  return {
    /** ¿Hay un editor montado (pestaña activa)? Reactivo. */
    isAvailable: (): boolean => current.value !== null,
    /** Selección actual si no está vacía; si no, el documento completo. */
    getExecutionText: (): ExecutionText | null => current.value?.executionText() ?? null,
    /** Documento completo de la pestaña activa, con independencia de la selección. */
    getDocumentText: (): ExecutionText | null => current.value?.documentText() ?? null,
    focusEditor: (): boolean => {
      if (!current.value) return false
      current.value.focus()
      return true
    },
    /** Formatea el documento con el dialecto de la sesión; `false` si no hay editor o el SQL no es válido. */
    formatDocument: (): Promise<boolean> => current.value?.format() ?? Promise.resolve(false),
  }
}
