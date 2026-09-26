import { undo } from '@codemirror/commands'
import { language } from '@codemirror/language'
import { PostgreSQL, SQLite, StandardSQL } from '@codemirror/lang-sql'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorExtensions, createEditorState, engineFacet } from './editor-state'

const extensions = () =>
  createEditorExtensions({
    label: () => 'Editor',
    onFormat: () => undefined,
    onEdit: () => undefined,
  })

describe('editor state', () => {
  it.each([
    ['postgres', PostgreSQL],
    ['sqlite', SQLite],
    [null, StandardSQL],
  ] as const)('configures the %s dialect', (engine, dialect) => {
    const state = createEditorState('select 1', engine, extensions())
    expect(state.facet(engineFacet)).toBe(engine)
    expect(state.facet(language)).toBe(dialect.language)
  })
})

describe('typing over a selection', () => {
  const views: EditorView[] = []

  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy())
    document.getSelection()?.removeAllRanges()
    document.body.innerHTML = ''
  })

  function mountView(doc: string, extra: Extension[] = []) {
    const state = createEditorState(doc, null, [...extensions(), ...extra])
    const view = new EditorView({ state, parent: document.body })
    views.push(view)
    return view
  }

  /** Selección del DOM, que es la que Chromium usa al insertar (la del estado se sincroniza después). */
  function selectInDom(view: EditorView, from: number, to: number): void {
    const start = view.domAtPos(from)
    const end = view.domAtPos(to)
    document.getSelection()!.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
  }

  function beforeInput(view: EditorView, init: InputEventInit): InputEvent {
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, ...init })
    view.contentDOM.dispatchEvent(event)
    return event
  }

  it('replaces the DOM selection in CodeMirror and cancels the native edit', () => {
    const view = mountView('select 1')
    selectInDom(view, 0, 8)
    const event = beforeInput(view, { inputType: 'insertText', data: 'x' })

    expect(event.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('x')
    expect(view.state.selection.main.head).toBe(1)
  })

  it('replaces only the selected part', () => {
    const view = mountView('select 1')
    selectInDom(view, 7, 8)
    beforeInput(view, { inputType: 'insertText', data: '2' })

    expect(view.state.doc.toString()).toBe('select 2')
  })

  it('trusts the DOM selection when the editor state has not caught up with it yet', () => {
    const view = mountView('select 1')
    view.dispatch({ selection: EditorSelection.cursor(8) })
    selectInDom(view, 0, 8)
    const event = beforeInput(view, { inputType: 'insertText', data: 'x' })

    expect(event.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe('x')
  })

  it('leaves a collapsed DOM cursor to the browser', () => {
    const view = mountView('select 1')
    view.dispatch({ selection: EditorSelection.single(0, 8) })
    selectInDom(view, 3, 3)
    const event = beforeInput(view, { inputType: 'insertText', data: 'x' })

    expect(event.defaultPrevented).toBe(false)
    expect(view.state.doc.toString()).toBe('select 1')
  })

  it('leaves a selection outside the editor to the browser', () => {
    const view = mountView('select 1')
    const outside = document.createElement('p')
    outside.textContent = 'fuera'
    document.body.append(outside)
    document.getSelection()!.setBaseAndExtent(outside.firstChild!, 0, outside.firstChild!, 5)
    const event = beforeInput(view, { inputType: 'insertText', data: 'x' })

    expect(event.defaultPrevented).toBe(false)
    expect(view.state.doc.toString()).toBe('select 1')
  })

  it.each([
    ['composition', { inputType: 'insertCompositionText', data: 'x' }],
    ['a composing insertText', { inputType: 'insertText', data: 'x', isComposing: true }],
    ['a paste', { inputType: 'insertFromPaste', data: 'x' }],
    ['a null payload', { inputType: 'insertText', data: null }],
  ] as [string, InputEventInit][])('does not intercept %s', (_name, init) => {
    const view = mountView('select 1')
    selectInDom(view, 0, 8)
    const event = beforeInput(view, init)

    expect(event.defaultPrevented).toBe(false)
    expect(view.state.doc.toString()).toBe('select 1')
  })

  it('does not intercept several ranges', () => {
    const view = mountView('select 1', [EditorState.allowMultipleSelections.of(true)])
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(4, 6)]),
    })
    selectInDom(view, 0, 3)
    const event = beforeInput(view, { inputType: 'insertText', data: 'x' })

    expect(event.defaultPrevented).toBe(false)
    expect(view.state.doc.toString()).toBe('select 1')
  })

  it('goes through the input handlers before the default insertion', () => {
    const handler = vi.fn(() => true)
    const view = mountView('select 1', [EditorView.inputHandler.of(handler)])
    selectInDom(view, 0, 6)
    beforeInput(view, { inputType: 'insertText', data: '(' })

    expect(handler).toHaveBeenCalledWith(view, 0, 6, '(', expect.any(Function))
    expect(view.state.doc.toString()).toBe('select 1')
  })

  it('records a single undoable input.type transaction', () => {
    const view = mountView('select 1')
    selectInDom(view, 0, 8)
    beforeInput(view, { inputType: 'insertText', data: 'x' })

    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('select 1')
  })
})
