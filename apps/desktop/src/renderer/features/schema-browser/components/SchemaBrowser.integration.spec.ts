import { EditorView } from '@codemirror/view'
import type { ConnectionProfile } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import WorkspaceShell from '../../workspace/components/WorkspaceShell.vue'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { SQLITE_CATALOG, sqliteSession } from '../testing/catalog'

const sqlite: ConnectionProfile = {
  id: 'sq1',
  engine: 'sqlite',
  name: 'Local',
  readOnly: false,
  filePath: '/Users/me/data.db',
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

const editorView = () => {
  const shadow = document.querySelector<HTMLElement>('.sql-editor__host')!.shadowRoot!
  return EditorView.findFromDOM(shadow.querySelector<HTMLElement>('.cm-editor')!)!
}

describe('schema browser in the workspace shell', () => {
  it('connects from the sidebar, browses lazily and inserts into the editor, which gets the focus', async () => {
    const fake = createFakeDb({
      profiles: [sqlite],
      connectResult: ipcOk({ ...sqliteSession, sessionId: 's1', profileId: 'sq1' }),
      catalog: SQLITE_CATALOG,
    })
    installFakeDb(fake.db)
    const pinia = createPinia()
    const wrapper = mount(WorkspaceShell, { global: { plugins: [pinia] }, attachTo: document.body })
    mounted = wrapper
    await flushPromises()

    const region = wrapper.get('[data-region="schema-explorer"]')
    expect(region.get('[data-state="no-session"]').text()).toContain('Cmd/Ctrl+T')

    await wrapper.get('[data-action="new-tab"]').trigger('click')
    expect(region.get('[data-state="no-session"]').text()).toContain('«Conexiones»')

    await wrapper.get('[data-profile-id="sq1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
    expect(region.get('[role="tree"]').attributes('aria-label')).toBe('Esquema de Local')
    const names = region.findAll('.tree-row__name').map((entry) => entry.text())
    expect(names).toEqual(expect.arrayContaining(['main', 'Customers', 'order items', 'recent']))

    const table = region
      .findAll<HTMLElement>('[role="treeitem"]')
      .find((entry) => entry.get('.tree-row__name').text() === 'order items')!
    table.element.focus()
    await table.trigger('keydown', { key: 'Enter', shiftKey: true })
    await flushPromises()

    expect(editorView().state.doc.toString()).toBe('"order items"')
    expect(useWorkspaceStore(pinia).activeTab?.content).toBe('"order items"')
    const shadow = document.querySelector<HTMLElement>('.sql-editor__host')!.shadowRoot!
    expect(shadow.activeElement?.classList.contains('cm-content')).toBe(true)

    await wrapper.get('[data-profile-id="sq1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
    expect(region.find('[role="tree"]').exists()).toBe(false)
    expect(region.find('[data-state="no-session"]').exists()).toBe(true)
  })
})
