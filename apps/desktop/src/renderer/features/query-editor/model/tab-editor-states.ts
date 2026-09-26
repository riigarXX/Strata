import type { EditorState, StateEffect } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export interface SavedEditor {
  state: EditorState
  /** Efecto que restaura el scroll; `EditorState` no lo guarda. */
  scroll: StateEffect<unknown>
}

/** Estado de CodeMirror (documento, historial, selección) y scroll de cada pestaña, no reactivo. */
export class TabEditorStates {
  private readonly saved = new Map<string, SavedEditor>()

  save(tabId: string, view: EditorView): void {
    this.saved.set(tabId, { state: view.state, scroll: view.scrollSnapshot() })
  }

  get(tabId: string): SavedEditor | undefined {
    return this.saved.get(tabId)
  }

  /** Olvida las pestañas que ya no existen. */
  prune(liveTabIds: ReadonlySet<string>): void {
    for (const tabId of this.saved.keys()) {
      if (!liveTabIds.has(tabId)) this.saved.delete(tabId)
    }
  }
}
