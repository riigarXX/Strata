import { language } from '@codemirror/language'
import { PostgreSQL, SQLite, StandardSQL } from '@codemirror/lang-sql'
import { undo } from '@codemirror/commands'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { useQueryEditor } from '../composables/use-query-editor'
import type { SqlEngine } from '../model/dialects'
import { engineFacet } from '../model/editor-state'
import SqlEditor from './SqlEditor.vue'

let mounted: VueWrapper | undefined

afterEach(async () => {
  // CodeMirror comprueba el foco en un timeout tras cada cambio; happy-dom falla si para entonces el
  // foco sigue en un shadow root ya desmontado. Se suelta el foco y se drenan esos timeouts.
  const host = document.querySelector('.sql-editor__host')
  ;(host?.shadowRoot?.activeElement as HTMLElement | null | undefined)?.blur()
  mounted?.unmount()
  mounted = undefined
  await new Promise((resolve) => setTimeout(resolve, 30))
  document.body.innerHTML = ''
})

/** Monta el editor con la pestaña activa del store, como hace TabPanel (una única instancia para todas). */
async function mountEditor(initialEngine: SqlEngine | null = null) {
  const pinia: Pinia = createPinia()
  const workspace = useWorkspaceStore(pinia)
  workspace.createTab()
  const engine = ref<SqlEngine | null>(initialEngine)
  const Harness = defineComponent({
    setup: () => () => h(SqlEditor, { tab: workspace.activeTab!, engine: engine.value }),
  })
  const wrapper = mount(Harness, { global: { plugins: [pinia] }, attachTo: document.body })
  mounted = wrapper
  await flushPromises()
  const shadow = () => document.querySelector<HTMLElement>('.sql-editor__host')!.shadowRoot!
  const view = () => EditorView.findFromDOM(shadow().querySelector<HTMLElement>('.cm-editor')!)!
  return { wrapper, pinia, workspace, engine, shadow, view, editor: useQueryEditor() }
}

function type(view: EditorView, text: string): void {
  const at = view.state.selection.main
  view.dispatch({
    changes: { from: at.from, to: at.to, insert: text },
    selection: EditorSelection.cursor(at.from + text.length),
    userEvent: 'input.type',
  })
}

describe('SqlEditor mounting and accessibility', () => {
  it('mounts CodeMirror in a shadow root with an accessible multiline textbox', async () => {
    const { shadow } = await mountEditor()
    const content = shadow().querySelector<HTMLElement>('.cm-content')!
    expect(content.getAttribute('role')).toBe('textbox')
    expect(content.getAttribute('aria-multiline')).toBe('true')
    expect(content.getAttribute('aria-label')).toBe('Editor SQL de Consulta 1')
    expect(content.getAttribute('aria-description')).toContain('Esc')
    expect(content.getAttribute('contenteditable')).toBe('true')
    expect(shadow().querySelector('.cm-lineNumbers')).not.toBeNull()
  })

  it('adds no <style> element to the document: styles live in the shadow root', async () => {
    const before = document.head.querySelectorAll('style').length
    await mountEditor()
    expect(document.head.querySelectorAll('style').length).toBe(before)
  })

  it('does not trap the keyboard: Tab indents and Esc then Tab is left to the browser', async () => {
    const { view } = await mountEditor()
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      keyCode: 9,
      bubbles: true,
      cancelable: true,
    })
    view().contentDOM.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(view().state.doc.toString()).toBe('  ')

    view().contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }),
    )
    const escapedTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      keyCode: 9,
      bubbles: true,
      cancelable: true,
    })
    view().contentDOM.dispatchEvent(escapedTab)
    expect(escapedTab.defaultPrevented).toBe(false)
    expect(view().state.doc.toString()).toBe('  ')
  })

  it('leaves Cmd+Enter, Cmd+L and the tab shortcuts to the app (CodeMirror does not consume them)', async () => {
    const { view } = await mountEditor()
    type(view(), 'select 1')
    for (const init of [
      { key: 'Enter', keyCode: 13, metaKey: true },
      { key: 'Enter', keyCode: 13, metaKey: true, shiftKey: true },
      { key: 'l', keyCode: 76, metaKey: true },
      { key: 't', keyCode: 84, metaKey: true },
      { key: 'w', keyCode: 87, metaKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      view().contentDOM.dispatchEvent(event)
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false)
    }
    expect(view().state.doc.toString()).toBe('select 1')
  })

  it('focuses the editor from code', async () => {
    const { view, editor } = await mountEditor()
    expect(document.activeElement).not.toBe(view().contentDOM)
    expect(editor.focusEditor()).toBe(true)
    expect(view().hasFocus).toBe(true)
  })

  it('unregisters the editor API when unmounted', async () => {
    const { wrapper, editor } = await mountEditor()
    expect(editor.getDocumentText()).not.toBeNull()
    wrapper.unmount()
    mounted = undefined
    expect(editor.getDocumentText()).toBeNull()
    expect(editor.getExecutionText()).toBeNull()
    expect(editor.focusEditor()).toBe(false)
    expect(await editor.formatDocument()).toBe(false)
  })
})

describe('SqlEditor dialect', () => {
  it.each([
    ['postgres', PostgreSQL],
    ['sqlite', SQLite],
    [null, StandardSQL],
  ] as const)('highlights with the %s dialect', async (engine, dialect) => {
    const { view } = await mountEditor(engine)
    expect(view().state.facet(language)).toBe(dialect.language)
  })

  it('follows the session engine when it changes without losing the text', async () => {
    const { view, engine } = await mountEditor(null)
    type(view(), 'select 1')
    engine.value = 'postgres'
    await flushPromises()
    expect(view().state.facet(engineFacet)).toBe('postgres')
    expect(view().state.facet(language)).toBe(PostgreSQL.language)
    expect(view().state.doc.toString()).toBe('select 1')
  })

  it('renders the syntax highlighting with token colors, not literals', async () => {
    const { shadow, view } = await mountEditor('postgres')
    type(view(), "select 1 -- nota\nfrom t where a = 'x'")
    await flushPromises()
    expect(shadow().querySelectorAll('.cm-line span').length).toBeGreaterThan(0)
  })
})

describe('SqlEditor and the workspace store', () => {
  it('writes user edits to tab.content (single source of truth)', async () => {
    const { view, workspace } = await mountEditor()
    type(view(), 'select 1')
    expect(workspace.activeTab?.content).toBe('select 1')
  })

  it('shows external changes of tab.content in the editor', async () => {
    const { view, workspace } = await mountEditor()
    workspace.setContent('tab-1', 'select 42')
    await flushPromises()
    expect(view().state.doc.toString()).toBe('select 42')
    expect(workspace.activeTab?.content).toBe('select 42')
  })

  it('starts from the content the tab already had', async () => {
    const pinia = createPinia()
    const workspace = useWorkspaceStore(pinia)
    workspace.createTab()
    workspace.setContent('tab-1', 'select existing')
    const wrapper = mount(SqlEditor, {
      props: { tab: workspace.activeTab!, engine: null },
      global: { plugins: [pinia] },
      attachTo: document.body,
    })
    mounted = wrapper
    const shadow = document.querySelector<HTMLElement>('.sql-editor__host')!.shadowRoot!
    const view = EditorView.findFromDOM(shadow.querySelector<HTMLElement>('.cm-editor')!)!
    expect(view.state.doc.toString()).toBe('select existing')
  })

  it('keeps text, selection and undo history of each tab when switching', async () => {
    const { view, workspace } = await mountEditor()
    type(view(), 'select 1')
    type(view(), ' from a')
    view().dispatch({ selection: EditorSelection.range(0, 6) })

    workspace.createTab()
    await flushPromises()
    expect(workspace.activeTabId).toBe('tab-2')
    expect(view().state.doc.toString()).toBe('')
    type(view(), 'select 2')

    workspace.activateTab('tab-1')
    await flushPromises()
    expect(view().state.doc.toString()).toBe('select 1 from a')
    expect(view().state.selection.main).toMatchObject({ from: 0, to: 6 })
    undo(view())
    expect(view().state.doc.toString()).toBe('')
    expect(workspace.tabs[0]?.content).toBe('')

    workspace.activateTab('tab-2')
    await flushPromises()
    expect(view().state.doc.toString()).toBe('select 2')
    expect(workspace.tabs[1]?.content).toBe('select 2')
  })

  it('does not leak the previous tab content into the next one nor write it to the wrong tab', async () => {
    const { view, workspace } = await mountEditor()
    type(view(), 'uno')
    workspace.createTab()
    await flushPromises()
    type(view(), 'dos')
    expect(workspace.tabs.map((tab) => tab.content)).toEqual(['uno', 'dos'])
  })

  it('applies the current engine and content to a saved state that went stale while inactive', async () => {
    const { view, workspace, engine } = await mountEditor(null)
    type(view(), 'select 1')
    workspace.createTab()
    await flushPromises()
    workspace.setContent('tab-1', 'select 99')
    engine.value = 'sqlite'
    await flushPromises()
    workspace.activateTab('tab-1')
    await flushPromises()
    expect(view().state.doc.toString()).toBe('select 99')
    expect(view().state.facet(engineFacet)).toBe('sqlite')
  })

  it('drops the saved state of closed tabs', async () => {
    const { view, workspace } = await mountEditor()
    type(view(), 'primera')
    workspace.createTab()
    await flushPromises()
    workspace.closeTab('tab-1')
    await flushPromises()
    expect(workspace.tabs.map((tab) => tab.id)).toEqual(['tab-2'])
    expect(view().state.doc.toString()).toBe('')
  })

  it('keeps secrets and results out of the serialized Pinia state', async () => {
    const { view, pinia } = await mountEditor('postgres')
    type(view(), 'select 1')
    const serialized = JSON.stringify(pinia.state.value)
    expect(Object.keys(pinia.state.value)).toEqual(['workspace'])
    expect(serialized).not.toMatch(/password|secret|token|rows|columns/i)
    expect(JSON.parse(serialized).workspace.tabs[0]).toEqual({
      id: 'tab-1',
      title: 'Consulta 1',
      content: 'select 1',
      sessionId: null,
      saveToHistory: true,
    })
  })
})

describe('execution text API', () => {
  it('returns the whole document when nothing is selected', async () => {
    const { view, editor } = await mountEditor()
    type(view(), 'select 1;\nselect 2;')
    view().dispatch({ selection: EditorSelection.cursor(3) })
    expect(editor.getExecutionText()).toEqual({ text: 'select 1;\nselect 2;', scope: 'document' })
  })

  it('returns the selection when it is not empty, and getDocumentText ignores it', async () => {
    const { view, editor } = await mountEditor()
    type(view(), 'select 1;\nselect 2;')
    view().dispatch({ selection: EditorSelection.range(10, 19) })
    expect(editor.getExecutionText()).toEqual({ text: 'select 2;', scope: 'selection' })
    expect(editor.getDocumentText()).toEqual({ text: 'select 1;\nselect 2;', scope: 'document' })
  })

  it('refers to the active tab after switching', async () => {
    const { view, workspace, editor } = await mountEditor()
    type(view(), 'uno')
    workspace.createTab()
    await flushPromises()
    type(view(), 'dos')
    expect(editor.getDocumentText()?.text).toBe('dos')
    workspace.activateTab('tab-1')
    await flushPromises()
    expect(editor.getDocumentText()?.text).toBe('uno')
  })
})

describe('requestInsert', () => {
  it('inserts at the cursor and returns the focus to the editor', async () => {
    const { view, workspace } = await mountEditor()
    type(view(), 'select  from t')
    view().dispatch({ selection: EditorSelection.cursor(7) })
    workspace.requestInsert('public.users')
    await flushPromises()
    expect(view().state.doc.toString()).toBe('select public.users from t')
    expect(view().state.selection.main.head).toBe(19)
    expect(view().hasFocus).toBe(true)
    expect(workspace.activeTab?.content).toBe('select public.users from t')
  })

  it('replaces the selection', async () => {
    const { view, workspace } = await mountEditor()
    type(view(), 'select * from t')
    view().dispatch({ selection: EditorSelection.range(14, 15) })
    workspace.requestInsert('public.users')
    await flushPromises()
    expect(view().state.doc.toString()).toBe('select * from public.users')
  })

  it('applies queued requests in order and consumes them once', async () => {
    const { view, workspace } = await mountEditor()
    workspace.requestInsert('a')
    workspace.requestInsert('b')
    await flushPromises()
    expect(view().state.doc.toString()).toBe('ab')
    expect(workspace.insertQueues['tab-1']).toBeUndefined()
    await flushPromises()
    expect(view().state.doc.toString()).toBe('ab')
  })

  it('targets the active tab only', async () => {
    const { view, workspace } = await mountEditor()
    type(view(), 'uno')
    workspace.createTab()
    await flushPromises()
    workspace.requestInsert('X')
    await flushPromises()
    expect(view().state.doc.toString()).toBe('X')
    workspace.activateTab('tab-1')
    await flushPromises()
    expect(view().state.doc.toString()).toBe('uno')
  })

  it('is consumed when the editor mounts after the request', async () => {
    const pinia = createPinia()
    const workspace = useWorkspaceStore(pinia)
    workspace.createTab()
    workspace.requestInsert('late')
    const wrapper = mount(SqlEditor, {
      props: { tab: workspace.activeTab!, engine: null },
      global: { plugins: [pinia] },
      attachTo: document.body,
    })
    mounted = wrapper
    await flushPromises()
    const shadow = document.querySelector<HTMLElement>('.sql-editor__host')!.shadowRoot!
    const view = EditorView.findFromDOM(shadow.querySelector<HTMLElement>('.cm-editor')!)!
    expect(view.state.doc.toString()).toBe('late')
  })
})

describe('formatDocument', () => {
  const shiftAltF = () =>
    new KeyboardEvent('keydown', {
      key: 'Ï',
      code: 'KeyF',
      keyCode: 70,
      shiftKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    })

  it('formats the document with the PostgreSQL dialect as one undoable step', async () => {
    const { view, editor, workspace } = await mountEditor('postgres')
    type(view(), 'select a::int from t')
    expect(await editor.formatDocument()).toBe(true)
    expect(view().state.doc.toString()).toBe('select\n  a::int\nfrom\n  t')
    expect(workspace.activeTab?.content).toBe('select\n  a::int\nfrom\n  t')
    undo(view())
    expect(view().state.doc.toString()).toBe('select a::int from t')
  })

  it('reports invalid SQL for the dialect without touching the document', async () => {
    const { wrapper, view, editor } = await mountEditor('sqlite')
    type(view(), 'select a::int from t')
    expect(await editor.formatDocument()).toBe(false)
    expect(view().state.doc.toString()).toBe('select a::int from t')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('No se pudo formatear')
  })

  it('announces success and does nothing on an empty document', async () => {
    const { wrapper, view, editor } = await mountEditor()
    expect(await editor.formatDocument()).toBe(false)
    type(view(), 'select 1')
    expect(await editor.formatDocument()).toBe(true)
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe('Documento formateado')
  })

  it('is bound to Shift+Alt+F inside the editor', async () => {
    const { view } = await mountEditor('postgres')
    type(view(), 'select a from t')
    const event = shiftAltF()
    view().contentDOM.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await flushPromises()
    expect(view().state.doc.toString()).toBe('select\n  a\nfrom\n  t')
  })
})
