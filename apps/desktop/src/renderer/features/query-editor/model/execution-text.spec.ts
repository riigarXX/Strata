import { EditorSelection, EditorState, type SelectionRange } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { selectionOrDocument, wholeDocument } from './execution-text'

const doc = 'select 1;\nselect 2;'

function stateWith(...ranges: SelectionRange[]): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(ranges),
    extensions: EditorState.allowMultipleSelections.of(true),
  })
}

describe('execution text', () => {
  it('uses the whole document when the selection is empty', () => {
    const state = stateWith(EditorSelection.cursor(4))
    expect(selectionOrDocument(state)).toEqual({ text: doc, scope: 'document' })
  })

  it('uses the selection when it is not empty', () => {
    const state = stateWith(EditorSelection.range(10, 19))
    expect(selectionOrDocument(state)).toEqual({ text: 'select 2;', scope: 'selection' })
  })

  it('joins several selected ranges with line breaks and skips the empty ones', () => {
    const state = stateWith(
      EditorSelection.range(0, 8),
      EditorSelection.cursor(9),
      EditorSelection.range(10, 18),
    )
    expect(selectionOrDocument(state)).toEqual({ text: 'select 1\nselect 2', scope: 'selection' })
  })

  it('wholeDocument ignores the selection', () => {
    const state = stateWith(EditorSelection.range(0, 6))
    expect(wholeDocument(state)).toEqual({ text: doc, scope: 'document' })
  })
})
