import { language } from '@codemirror/language'
import { PostgreSQL, StandardSQL } from '@codemirror/lang-sql'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ConnectionProfile, Session } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb, type FakeDbOptions } from '../../connections/testing/fake-db'
import { useWorkspaceStore } from '../stores/workspace'
import WorkspaceShell from './WorkspaceShell.vue'

const postgres: ConnectionProfile = {
  id: 'pg1',
  engine: 'postgres',
  name: 'Producción',
  readOnly: false,
  host: 'db.example.com',
  port: 5432,
  user: 'app',
  database: 'main',
  ssl: 'require',
  secretRef: 'secret-pg1',
}

const postgresSession: Session = {
  sessionId: 's1',
  profileId: 'pg1',
  engine: 'postgres',
  serverVersion: '16.4',
  readOnly: false,
  transaction: 'none',
}

let mounted: VueWrapper | undefined

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
})

afterEach(async () => {
  const host = document.querySelector('.sql-editor__host')
  ;(host?.shadowRoot?.activeElement as HTMLElement | null | undefined)?.blur()
  mounted?.unmount()
  mounted = undefined
  await new Promise((resolve) => setTimeout(resolve, 30))
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'db')
  vi.restoreAllMocks()
})

async function mountShell(options: FakeDbOptions = {}) {
  installFakeDb(createFakeDb(options).db)
  const pinia = createPinia()
  const wrapper = mount(WorkspaceShell, { global: { plugins: [pinia] }, attachTo: document.body })
  mounted = wrapper
  await flushPromises()
  return { wrapper, workspace: useWorkspaceStore(pinia) }
}

const editorView = () => {
  const shadow = document.querySelector<HTMLElement>('.sql-editor__host')!.shadowRoot!
  return EditorView.findFromDOM(shadow.querySelector<HTMLElement>('.cm-editor')!)!
}

function press(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

describe('editor in the workspace', () => {
  it('mounts in the editor region of the active tab', async () => {
    const { wrapper } = await mountShell()
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    const region = wrapper.get('[data-region="editor"]')
    expect(region.attributes('aria-label')).toBe('Editor SQL')
    expect(region.find('.sql-editor__host').exists()).toBe(true)
    expect(region.text()).not.toContain('pendiente')
  })

  it('uses standard SQL without a connection', async () => {
    const { wrapper } = await mountShell()
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    expect(editorView().state.facet(language)).toBe(StandardSQL.language)
  })

  it('uses the dialect of the engine of the tab session', async () => {
    const { wrapper, workspace } = await mountShell({
      profiles: [postgres],
      connectResult: ipcOk(postgresSession),
    })
    await wrapper.get('[data-profile-id="pg1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    expect(workspace.activeTab?.sessionId).toBe('s1')
    expect(editorView().state.facet(language)).toBe(PostgreSQL.language)

    // Una pestaña sin sesión vuelve a SQL estándar y la primera conserva PostgreSQL.
    workspace.setSession('tab-1', null)
    await flushPromises()
    expect(editorView().state.facet(language)).toBe(StandardSQL.language)
  })

  it('keeps each tab text when switching with the tab shortcuts, even while typing in the editor', async () => {
    const { wrapper, workspace } = await mountShell()
    press({ key: 't', metaKey: true })
    await flushPromises()
    editorView().dispatch({ changes: { from: 0, insert: 'select 1' } })

    // Cmd+T con el foco dentro del editor sigue creando pestañas: CodeMirror no lo consume.
    const target = editorView().contentDOM
    const event = new KeyboardEvent('keydown', {
      key: 't',
      metaKey: true,
      bubbles: true,
      composed: true,
      cancelable: true,
    })
    target.dispatchEvent(event)
    await flushPromises()
    expect(workspace.tabs).toHaveLength(2)
    editorView().dispatch({
      changes: { from: 0, insert: 'select 2' },
      selection: EditorSelection.cursor(8),
    })

    press({ key: '1', code: 'Digit1', metaKey: true })
    await flushPromises()
    expect(editorView().state.doc.toString()).toBe('select 1')
    press({ key: '2', code: 'Digit2', metaKey: true })
    await flushPromises()
    expect(editorView().state.doc.toString()).toBe('select 2')
    expect(workspace.tabs.map((tab) => tab.content)).toEqual(['select 1', 'select 2'])
    expect(wrapper.findAll('.sql-editor')).toHaveLength(1)
  })
})
