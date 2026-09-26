import type { EditorState } from '@codemirror/state'

export type ExecutionScope = 'selection' | 'document'

export interface ExecutionText {
  text: string
  scope: ExecutionScope
}

/** Documento completo, con independencia de la selección. */
export function wholeDocument(state: EditorState): ExecutionText {
  return { text: state.doc.toString(), scope: 'document' }
}

/** La selección si no está vacía (varios rangos se unen con saltos de línea); si no, el documento. */
export function selectionOrDocument(state: EditorState): ExecutionText {
  const selected = state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => state.sliceDoc(range.from, range.to))
  if (selected.length === 0) return wholeDocument(state)
  return { text: selected.join(state.lineBreak), scope: 'selection' }
}
