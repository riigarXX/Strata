import type { ConnectionProfile, Session } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb, type FakeDbOptions } from '../../connections/testing/fake-db'
import { deepActiveElement } from '../../../components/focus'
import { PANEL_SIZE } from '../stores/layout'
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

const sqlite: ConnectionProfile = {
  id: 'sq1',
  engine: 'sqlite',
  name: 'Local',
  readOnly: true,
  filePath: '/Users/me/data.db',
}

const sqliteSession: Session = {
  sessionId: 's1',
  profileId: 'sq1',
  engine: 'sqlite',
  serverVersion: '3.46.0',
  readOnly: true,
  transaction: 'none',
}

let mounted: VueWrapper | undefined

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
})

afterEach(async () => {
  // CodeMirror comprueba el foco en un timeout tras enfocarse; happy-dom falla si para entonces el foco
  // sigue en un shadow root ya desmontado. Se suelta el foco y se drenan esos timeouts.
  deepActiveElement()?.blur()
  mounted?.unmount()
  mounted = undefined
  await new Promise((resolve) => setTimeout(resolve, 30))
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'db')
  vi.restoreAllMocks()
})

async function mountShell(options: FakeDbOptions = {}) {
  const fake = createFakeDb(options)
  installFakeDb(fake.db)
  const pinia = createPinia()
  const wrapper = mount(WorkspaceShell, { global: { plugins: [pinia] }, attachTo: document.body })
  mounted = wrapper
  await flushPromises()
  return { wrapper, pinia, workspace: useWorkspaceStore(pinia), ...fake }
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

// La primera tablist es la de consultas; la del panel inferior (Resultados/Mensajes/Plan) queda fuera.
const strip = (wrapper: VueWrapper) => wrapper.get('[role="tablist"]')
const tabTitles = (wrapper: VueWrapper) =>
  strip(wrapper)
    .findAll('[role="tab"]')
    .map((tab) => tab.text().replace('×', '').trim())
// El editor vive en un shadow root: el foco «de verdad» se resuelve con `deepActiveElement`.
const inEditor = (element: HTMLElement | null) => element?.classList.contains('cm-content') ?? false
const selectedTitle = (wrapper: VueWrapper) =>
  strip(wrapper).get('[role="tab"][aria-selected="true"]').text().replace('×', '').trim()

describe('WorkspaceShell layout', () => {
  it('renders every labelled region', async () => {
    const { wrapper } = await mountShell()
    expect(wrapper.get('h1').text()).toBe('Strata')
    expect(wrapper.find('header').exists()).toBe(true)
    expect(wrapper.get('aside').attributes('aria-label')).toBe('Barra lateral')
    expect(wrapper.get('[data-region="connections"]').attributes('aria-labelledby')).toBeDefined()
    expect(wrapper.get('[data-region="schema-explorer"]').attributes('aria-label')).toBe(
      'Explorador de esquema',
    )
    expect(wrapper.find('main').exists()).toBe(true)
    expect(wrapper.get('footer').attributes('aria-label')).toBe('Barra de estado')
    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
  })

  it('shows an empty state without tabs, pointing to the shortcut', async () => {
    const { wrapper } = await mountShell()
    expect(wrapper.find('[role="tabpanel"]').exists()).toBe(false)
    expect(wrapper.get('[data-region="no-tabs"]').text()).toContain('Cmd/Ctrl+T')
  })

  it('renders labelled editor and results placeholders in the tab panel', async () => {
    const { wrapper } = await mountShell()
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    const panel = wrapper.get('[role="tabpanel"]')
    expect(panel.attributes('aria-labelledby')).toBe('strata-tab-tab-1')
    expect(panel.get('[data-region="editor"]').attributes('aria-label')).toBe('Editor SQL')
    expect(panel.get('[data-region="results"]').attributes('aria-label')).toContain('Resultados')
    expect(panel.get('[data-region="results"]').text()).toContain('Ejecuta una consulta')
  })

  it('has two accessible separators with independent keyboard resizing and limits', async () => {
    const { wrapper } = await mountShell()
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    const [sidebar, panel] = wrapper.findAll('[role="separator"]')

    expect(sidebar!.attributes('aria-orientation')).toBe('vertical')
    expect(sidebar!.attributes('aria-valuenow')).toBe('240')
    await sidebar!.trigger('keydown', { key: 'ArrowRight' })
    expect(sidebar!.attributes('aria-valuenow')).toBe('256')
    await sidebar!.trigger('keydown', { key: 'End' })
    expect(sidebar!.attributes('aria-valuenow')).toBe(sidebar!.attributes('aria-valuemax'))

    expect(panel!.attributes('aria-orientation')).toBe('horizontal')
    expect(panel!.attributes('aria-controls')).toBe('strata-results-panel')
    expect(panel!.attributes('aria-valuenow')).toBe(String(PANEL_SIZE.initial))
    await panel!.trigger('keydown', { key: 'ArrowUp' })
    expect(panel!.attributes('aria-valuenow')).toBe(String(PANEL_SIZE.initial + 16))
    await panel!.trigger('keydown', { key: 'Home' })
    expect(panel!.attributes('aria-valuenow')).toBe(panel!.attributes('aria-valuemin'))
    await panel!.trigger('keydown', { key: 'ArrowDown' })
    expect(panel!.attributes('aria-valuenow')).toBe(panel!.attributes('aria-valuemin'))
  })

  it('keeps the results panel size when switching tabs', async () => {
    const { wrapper } = await mountShell()
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    await wrapper.findAll('[role="separator"]')[1]!.trigger('keydown', { key: 'ArrowUp' })
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    expect(wrapper.findAll('[role="separator"]')[1]!.attributes('aria-valuenow')).toBe(
      String(PANEL_SIZE.initial + 16),
    )
  })
})

describe('WorkspaceShell tab shortcuts', () => {
  it('Cmd+T creates tabs and moves the focus to the editor of the new one', async () => {
    const { wrapper } = await mountShell()
    const event = press({ key: 't', metaKey: true })
    await flushPromises()
    expect(inEditor(deepActiveElement())).toBe(true)
    press({ key: 't', metaKey: true })
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(tabTitles(wrapper)).toEqual(['Consulta 1', 'Consulta 2'])
    expect(selectedTitle(wrapper)).toBe('Consulta 2')
    expect(inEditor(deepActiveElement())).toBe(true)
    expect(document.activeElement?.id).not.toBe('strata-tab-tab-2')
  })

  it('the new-tab button also moves the focus to the editor', async () => {
    const { wrapper } = await mountShell()
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    await flushPromises()

    expect(tabTitles(wrapper)).toEqual(['Consulta 1'])
    expect(inEditor(deepActiveElement())).toBe(true)
  })

  it('switching tabs with the arrow keys keeps the focus on the tab', async () => {
    const { wrapper } = await mountShell()
    press({ key: 't', metaKey: true })
    press({ key: 't', metaKey: true })
    await flushPromises()
    const first = wrapper.get('#strata-tab-tab-1')
    ;(first.element as HTMLElement).focus()

    await first.trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()

    expect(selectedTitle(wrapper)).toBe('Consulta 2')
    expect(document.activeElement?.id).toBe('strata-tab-tab-2')
  })

  it('does not create a tab for each auto-repeat of a held key', async () => {
    const { wrapper } = await mountShell()
    press({ key: 't', metaKey: true })
    press({ key: 't', metaKey: true, repeat: true })
    await flushPromises()
    expect(tabTitles(wrapper)).toHaveLength(1)
  })

  it('Cmd+W closes the active tab and activates its neighbour, keeping focus in the strip', async () => {
    const { wrapper } = await mountShell()
    for (let index = 0; index < 3; index += 1) press({ key: 't', metaKey: true })
    press({ key: '2', code: 'Digit2', metaKey: true })
    await flushPromises()
    ;(wrapper.get('[aria-selected="true"]').element as HTMLElement).focus()

    press({ key: 'w', metaKey: true })
    await flushPromises()

    expect(tabTitles(wrapper)).toEqual(['Consulta 1', 'Consulta 3'])
    expect(selectedTitle(wrapper)).toBe('Consulta 3')
    expect(document.activeElement?.id).toBe('strata-tab-tab-3')
  })

  it('Cmd+W with the last tab leaves the empty state and moves focus to the new-tab button', async () => {
    const { wrapper } = await mountShell()
    press({ key: 't', metaKey: true })
    await flushPromises()
    press({ key: 'w', metaKey: true })
    await flushPromises()

    expect(tabTitles(wrapper)).toEqual([])
    expect(wrapper.find('[role="tabpanel"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-action="new-tab"]').element)
    expect(() => press({ key: 'w', metaKey: true })).not.toThrow()
  })

  it('Ctrl+Tab, Ctrl+Shift+Tab and Cmd+1..9 switch tabs', async () => {
    const { wrapper } = await mountShell()
    for (let index = 0; index < 3; index += 1) press({ key: 't', metaKey: true })
    await flushPromises()

    press({ key: 'Tab', ctrlKey: true })
    await flushPromises()
    expect(selectedTitle(wrapper)).toBe('Consulta 1')

    press({ key: 'Tab', ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(selectedTitle(wrapper)).toBe('Consulta 3')

    press({ key: '1', code: 'Digit1', metaKey: true })
    await flushPromises()
    expect(selectedTitle(wrapper)).toBe('Consulta 1')

    press({ key: '9', code: 'Digit9', metaKey: true })
    await flushPromises()
    expect(selectedTitle(wrapper)).toBe('Consulta 3')

    press({ key: '8', code: 'Digit8', metaKey: true })
    await flushPromises()
    expect(selectedTitle(wrapper)).toBe('Consulta 3')
  })

  it('ignores the shortcuts while a modal dialog is open', async () => {
    const { wrapper } = await mountShell()
    await wrapper.get('[data-action="manage-connections"]').trigger('click')
    await flushPromises()

    const event = press({ key: 't', metaKey: true })
    await flushPromises()

    expect(event.defaultPrevented).toBe(false)
    expect(tabTitles(wrapper)).toEqual([])
  })

  it('removes its listener when unmounted', async () => {
    const { wrapper, workspace } = await mountShell()
    wrapper.unmount()
    mounted = undefined
    press({ key: 't', metaKey: true })
    expect(workspace.tabs).toEqual([])
  })
})

describe('WorkspaceShell connections and status', () => {
  const connectable = { profiles: [postgres, sqlite], connectResult: ipcOk(sqliteSession) }

  async function connectLocal(wrapper: VueWrapper) {
    await wrapper.get('[data-profile-id="sq1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
  }

  it('shows the transaction state of the active connection in the status bar', async () => {
    const { wrapper } = await mountShell({
      ...connectable,
      connectResult: ipcOk({ ...sqliteSession, transaction: 'active' }),
    })
    const bar = wrapper.get('footer')
    expect(bar.text()).toContain('Sin conexión')

    await connectLocal(wrapper)

    expect(bar.text()).toContain('Local')
    expect(bar.text()).toContain('SQLite')
    expect(bar.text()).toContain('data.db')
    expect(bar.text()).toContain('Solo lectura')
    expect(bar.get('[data-segment="transaction"]').text()).toContain('Transacción activa')

    await wrapper.get('[data-profile-id="sq1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
    expect(bar.text()).toContain('Sin conexión')
  })

  it('associates new tabs with the connected session of the selected profile', async () => {
    const { wrapper, workspace } = await mountShell(connectable)
    await connectLocal(wrapper)
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    expect(workspace.activeTab?.sessionId).toBe('s1')
  })

  it('binds a session opened later to the active tab that had none, and unbinds it on disconnect', async () => {
    const { wrapper, workspace } = await mountShell(connectable)
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    expect(workspace.activeTab?.sessionId).toBeNull()

    await connectLocal(wrapper)
    expect(workspace.activeTab?.sessionId).toBe('s1')

    await wrapper.get('[data-profile-id="sq1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
    expect(workspace.activeTab?.sessionId).toBeNull()
  })
})

describe('WorkspaceShell state hygiene', () => {
  it('keeps no secrets or query results in the serialised Pinia state', async () => {
    const { wrapper, pinia, connections } = await mountShell({
      profiles: [sqlite],
      connectResult: ipcOk(sqliteSession),
    })
    await wrapper.get('[data-profile-id="sq1"] [data-action="toggle-connection"]').trigger('click')
    press({ key: 't', metaKey: true })
    await flushPromises()

    await wrapper.get('[data-action="manage-connections"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-action="new"]').trigger('click')
    await flushPromises()
    const field = (name: string) => wrapper.get<HTMLInputElement>(`dialog [name="${name}"]`)
    await field('name').setValue('Nuevo')
    await field('host').setValue('localhost')
    await field('user').setValue('me')
    await field('database').setValue('app')
    await field('password').setValue('hunter2-secret')
    await wrapper.get('dialog form').trigger('submit')
    await flushPromises()

    expect(connections.create).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'hunter2-secret' }),
    )
    const serialised = JSON.stringify((pinia as Pinia).state.value)
    expect(Object.keys((pinia as Pinia).state.value)).toEqual(
      expect.arrayContaining(['connections', 'execution', 'layout', 'preferences', 'workspace']),
    )
    expect(serialised).toContain('Nuevo')
    expect(serialised).not.toContain('hunter2-secret')
    expect(serialised).not.toMatch(/"password"/i)
    expect(serialised).not.toMatch(/"(rows|results)"/i)
  })
})
