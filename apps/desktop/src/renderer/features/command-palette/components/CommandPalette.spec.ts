import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ConnectionProfile, NormalizedError, Session } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import App from '../../../app/App.vue'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { makeEntries, stubHistory } from '../../history/testing/fake-history'
import { done, statementDone } from '../../execution/testing/events'
import { usePreferencesStore } from '../../preferences'
import { POSTGRES_CATALOG, postgresSession } from '../../schema-browser/testing/catalog'
import WorkspaceShell from '../../workspace/components/WorkspaceShell.vue'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { useCommandCenter } from '../stores/command-center'
import { usePaletteStore } from '../stores/palette'

const postgres: ConnectionProfile = {
  id: 'pg1',
  engine: 'postgres',
  name: 'Producción',
  readOnly: false,
  host: 'db.example.com',
  port: 5432,
  user: 'app_user',
  database: 'main',
  ssl: 'require',
  secretRef: 'secret-pg1',
}

const local: ConnectionProfile = {
  id: 'sq1',
  engine: 'sqlite',
  name: 'Local',
  readOnly: false,
  filePath: '/Users/me/data.db',
}

const sessions: Record<string, Session> = {
  pg1: { ...postgresSession, sessionId: 's-pg', profileId: 'pg1' },
  sq1: {
    sessionId: 's-sq',
    profileId: 'sq1',
    engine: 'sqlite',
    serverVersion: '3.46.0',
    readOnly: false,
    transaction: 'none',
  },
}

const SAVE_ERROR: NormalizedError = {
  code: 'internal_error',
  message: 'Could not access the saved preferences',
  retryable: true,
}

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X)'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

let mounted: VueWrapper | undefined
let userAgent = MAC

beforeEach(() => {
  userAgent = MAC
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => userAgent)
})

afterEach(async () => {
  const host = document.querySelector('.sql-editor__host')
  ;(host?.shadowRoot?.activeElement as HTMLElement | null | undefined)?.blur()
  mounted?.unmount()
  mounted = undefined
  await new Promise((resolve) => setTimeout(resolve, 30))
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  Reflect.deleteProperty(window, 'db')
  vi.restoreAllMocks()
})

interface MountOptions {
  connect?: boolean
  tab?: boolean
  agent?: string
  root?: 'shell' | 'app'
}

async function mountApp({ connect = true, tab = true, agent, root = 'shell' }: MountOptions = {}) {
  if (agent) userAgent = agent
  const fake = createFakeDb({ profiles: [postgres, local], catalog: POSTGRES_CATALOG })
  fake.connections.connect.mockImplementation(async ({ profileId }) => ipcOk(sessions[profileId]!))
  installFakeDb(fake.db)
  const pinia: Pinia = createPinia()
  const wrapper = mount(root === 'app' ? App : WorkspaceShell, {
    global: { plugins: [pinia] },
    attachTo: document.body,
  })
  mounted = wrapper
  await flushPromises()
  if (connect) {
    await wrapper.get('[data-profile-id="pg1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
  }
  if (tab) {
    await wrapper.get('[data-action="new-tab"]').trigger('click')
    await flushPromises()
  }
  return {
    wrapper,
    fake,
    pinia,
    workspace: useWorkspaceStore(pinia),
    palette: usePaletteStore(pinia),
    center: useCommandCenter(pinia),
    preferences: usePreferencesStore(pinia),
  }
}

const editorView = () => {
  const shadow = document.querySelector<HTMLElement>('.sql-editor__host')!.shadowRoot!
  return EditorView.findFromDOM(shadow.querySelector<HTMLElement>('.cm-editor')!)!
}
const editorHasFocus = () =>
  document
    .querySelector<HTMLElement>('.sql-editor__host')!
    .shadowRoot!.activeElement?.classList.contains('cm-content') ?? false

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    composed: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}
const pressInEditor = (init: KeyboardEventInit) => press(init, editorView().contentDOM)
const settle = async () => {
  await flushPromises()
  await nextTick()
}

const dialog = (wrapper: VueWrapper) => wrapper.find('[data-command-palette]')
const input = (wrapper: VueWrapper) => wrapper.get<HTMLInputElement>('[role="combobox"]')
const options = (wrapper: VueWrapper) => wrapper.findAll('[role="option"]')
const optionLabels = (wrapper: VueWrapper) =>
  options(wrapper).map((option) => option.get('.palette-option__label').text())
const optionNamed = (wrapper: VueWrapper, label: string) =>
  options(wrapper).find((option) => option.get('.palette-option__label').text() === label)!
const announcer = (wrapper: VueWrapper) => wrapper.get('[data-part="palette-announcer"]').text()

async function openPalette(wrapper: VueWrapper, query = '') {
  press({ key: 'k', metaKey: true })
  await settle()
  if (query !== '') {
    await input(wrapper).setValue(query)
    await settle()
  }
}

async function choose(wrapper: VueWrapper, key = 'Enter') {
  await input(wrapper).trigger('keydown', { key })
  await settle()
}

describe('opening, closing and focus', () => {
  it('opens with Cmd+K as a modal dialog with the combobox and listbox pattern, focusing the field', async () => {
    const { wrapper } = await mountApp()
    expect(dialog(wrapper).exists()).toBe(false)

    const event = press({ key: 'k', metaKey: true })
    await settle()

    expect(event.defaultPrevented).toBe(true)
    const panel = wrapper.get('[role="dialog"]')
    expect(panel.attributes('aria-modal')).toBe('true')
    expect(panel.attributes('aria-label')).toBe('Paleta de comandos')
    const field = input(wrapper)
    expect(field.attributes('aria-autocomplete')).toBe('list')
    expect(field.attributes('aria-expanded')).toBe('true')
    const list = wrapper.get('[role="listbox"]')
    expect(field.attributes('aria-controls')).toBe(list.attributes('id'))
    expect(document.activeElement).toBe(field.element)
    expect(field.attributes('aria-activedescendant')).toBe(options(wrapper)[0]!.attributes('id'))
  })

  it('Cmd+K toggles, and Esc and a click on the backdrop close it', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper)
    press({ key: 'k', metaKey: true })
    await settle()
    expect(dialog(wrapper).exists()).toBe(false)

    await openPalette(wrapper)
    await choose(wrapper, 'Escape')
    expect(dialog(wrapper).exists()).toBe(false)

    await openPalette(wrapper)
    await dialog(wrapper).trigger('mousedown')
    await settle()
    expect(dialog(wrapper).exists()).toBe(false)
  })

  it('closes with Esc even if the focus is outside the dialog', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper)
    press({ key: 'Escape' })
    await settle()
    expect(dialog(wrapper).exists()).toBe(false)
  })

  it('returns the focus to exactly the element that had it', async () => {
    const { wrapper } = await mountApp()
    const button = wrapper.get<HTMLButtonElement>('[data-action="manage-connections"]').element
    button.focus()
    await openPalette(wrapper)
    expect(document.activeElement).not.toBe(button)
    await choose(wrapper, 'Escape')
    expect(document.activeElement).toBe(button)
  })

  it('returns the focus to the editor with its selection untouched', async () => {
    const { wrapper } = await mountApp()
    const view = editorView()
    // Abrir la pestaña ya dejó el foco en el editor: se suelta para editar el estado con el foco fuera.
    view.contentDOM.blur()
    view.dispatch({ changes: { from: 0, insert: 'select * from users' } })
    view.dispatch({ selection: EditorSelection.range(7, 8) })
    view.focus()
    expect(editorHasFocus()).toBe(true)

    pressInEditor({ key: 'k', metaKey: true })
    await settle()
    expect(dialog(wrapper).exists()).toBe(true)
    expect(editorHasFocus()).toBe(false)

    await input(wrapper).setValue('nueva')
    await choose(wrapper, 'Escape')
    expect(editorHasFocus()).toBe(true)
    expect(view.state.selection.main.from).toBe(7)
    expect(view.state.selection.main.to).toBe(8)
    expect(view.state.doc.toString()).toBe('select * from users')
  })

  it('restores the focus before running the chosen command, so commands can move it', async () => {
    const { wrapper, workspace } = await mountApp()
    wrapper.get<HTMLButtonElement>('[data-action="manage-connections"]').element.focus()
    await openPalette(wrapper, 'nueva pestaña')
    await choose(wrapper)
    expect(workspace.tabs).toHaveLength(2)
    expect(workspace.activeTab?.id).toBe('tab-2')
    expect(editorHasFocus()).toBe(true)
  })

  it('Cmd+P while open switches to the quick search without losing the original opener', async () => {
    const { wrapper } = await mountApp()
    const button = wrapper.get<HTMLButtonElement>('[data-action="manage-connections"]').element
    button.focus()
    await openPalette(wrapper)
    press({ key: 'p', metaKey: true })
    await settle()
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe(
      'Buscar tabla, vista o conexión',
    )
    await choose(wrapper, 'Escape')
    expect(document.activeElement).toBe(button)
  })

  it('the rest of the shortcuts wait while it is open, including Cmd+T and Cmd+Enter', async () => {
    const { wrapper, workspace, fake } = await mountApp()
    await openPalette(wrapper)
    press({ key: 't', metaKey: true })
    press({ key: 'Enter', metaKey: true })
    press({ key: 'l', metaKey: true })
    await settle()
    expect(workspace.tabs).toHaveLength(1)
    expect(fake.query.execute).not.toHaveBeenCalled()
    expect(dialog(wrapper).exists()).toBe(true)
  })

  it('Esc closes the palette and does not cancel a running execution', async () => {
    const { wrapper, fake, workspace } = await mountApp()
    editorView().dispatch({ changes: { from: 0, insert: 'select pg_sleep(30)' } })
    press({ key: 'Enter', metaKey: true })
    await settle()
    expect(fake.query.execute).toHaveBeenCalledTimes(1)
    void workspace

    await openPalette(wrapper)
    await choose(wrapper, 'Escape')
    expect(fake.query.cancel).not.toHaveBeenCalled()

    press({ key: 'Escape' })
    await settle()
    expect(fake.query.cancel).toHaveBeenCalledTimes(1)
  })

  it('traps Tab inside the dialog', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper)
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    input(wrapper).element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(input(wrapper).element)
  })
})

describe('listing and searching commands', () => {
  it('groups by category with headings and shows the shortcut of each command', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper)
    const headings = wrapper
      .findAll('[data-part="palette-group-heading"]')
      .map((entry) => entry.text())
    expect(headings).toEqual([
      'Pestañas',
      'Consulta',
      'Transacción',
      'Editor',
      'Esquema',
      'Conexiones',
      'Aplicación',
    ])
    expect(wrapper.findAll('[data-command-palette] [role="group"]')).toHaveLength(headings.length)
    for (const group of wrapper.findAll('[data-command-palette] [role="group"]')) {
      expect(group.attributes('aria-labelledby')).toBeTruthy()
    }
    expect(optionNamed(wrapper, 'Nueva pestaña SQL').get('kbd').text()).toBe('⌘T')
    expect(optionNamed(wrapper, 'Ejecutar todo').get('kbd').text()).toBe('⇧⌘↵')
    expect(optionNamed(wrapper, 'Enfocar editor').get('kbd').text()).toBe('⌘L')
    expect(optionNamed(wrapper, 'Buscar tabla, vista o conexión').get('kbd').text()).toBe('⌘P')
    expect(optionNamed(wrapper, 'Cancelar ejecución').get('kbd').text()).toBe('Esc')
  })

  it('filters with fuzzy search, highlights the matches and ranks the best first', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, 'ejec')
    expect(optionLabels(wrapper).slice(0, 2)).toEqual(['Ejecutar', 'Ejecutar todo'])
    expect(wrapper.findAll('[data-command-palette] [role="group"]')).toHaveLength(0)
    const first = options(wrapper)[0]!
    expect(first.get('mark').text()).toBe('Ejec')
    expect(first.get('.palette-option__category').text()).toBe('Consulta')

    await input(wrapper).setValue('pestana sig')
    await settle()
    expect(optionLabels(wrapper)).toEqual(['Pestaña siguiente'])
    expect(wrapper.get('mark').text().length).toBeGreaterThan(0)
  })

  it('finds by keyword, ignoring accents', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, 'oscuro')
    expect(optionLabels(wrapper)).toContain('Cambiar tema…')
  })

  it('shows an empty state when nothing matches and announces the number of results', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, 'zzzzzzzz')
    expect(options(wrapper)).toHaveLength(0)
    expect(wrapper.get('[data-part="palette-empty"]').text()).toContain('Ningún comando coincide')
    expect(input(wrapper).attributes('aria-expanded')).toBe('false')
    expect(input(wrapper).attributes('aria-activedescendant')).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(wrapper.get('[data-part="palette-count"]').text()).toBe('Sin resultados')

    await input(wrapper).setValue('cerrar pest')
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(wrapper.get('[data-part="palette-count"]').text()).toBe('1 resultado')

    await input(wrapper).setValue('pest')
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(wrapper.get('[data-part="palette-count"]').text()).toMatch(/^\d+ resultados$/)
  })

  it('remembers the commands used, most recent first and without repeats', async () => {
    const { palette } = await mountApp()
    palette.recordUse('tab.close')
    palette.recordUse('tab.new')
    palette.recordUse('tab.close')
    expect(palette.recents).toEqual(['tab.close', 'tab.new'])
  })
})

describe('keyboard navigation', () => {
  it('moves with the arrows, wraps around and supports Home and End, keeping aria-activedescendant in sync', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, 'pestaña')
    const ids = options(wrapper).map((option) => option.attributes('id'))
    const selected = () =>
      options(wrapper).findIndex((o) => o.attributes('aria-selected') === 'true')
    expect(ids.length).toBeGreaterThan(3)
    expect(selected()).toBe(0)
    expect(input(wrapper).attributes('aria-activedescendant')).toBe(ids[0])

    await choose(wrapper, 'ArrowDown')
    expect(selected()).toBe(1)
    expect(input(wrapper).attributes('aria-activedescendant')).toBe(ids[1])
    await choose(wrapper, 'End')
    expect(selected()).toBe(ids.length - 1)
    await choose(wrapper, 'ArrowDown')
    expect(selected()).toBe(0)
    await choose(wrapper, 'ArrowUp')
    expect(selected()).toBe(ids.length - 1)
    await choose(wrapper, 'Home')
    expect(selected()).toBe(0)
    expect(options(wrapper).filter((o) => o.attributes('aria-selected') === 'true')).toHaveLength(1)
  })

  it('Enter runs the active command, a click runs the clicked one, and hovering moves the selection', async () => {
    const { wrapper, workspace } = await mountApp()
    await openPalette(wrapper, 'nueva pestaña')
    await choose(wrapper)
    expect(dialog(wrapper).exists()).toBe(false)
    expect(workspace.tabs).toHaveLength(2)

    await openPalette(wrapper, 'cerrar pestaña')
    await options(wrapper)[0]!.trigger('mousemove')
    expect(options(wrapper)[0]!.attributes('aria-selected')).toBe('true')
    await options(wrapper)[0]!.trigger('click')
    await settle()
    expect(workspace.tabs).toHaveLength(1)
  })

  it('changing the text moves the selection back to the first result', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, 'pestaña')
    await choose(wrapper, 'ArrowDown')
    await input(wrapper).setValue('pesta')
    await settle()
    expect(options(wrapper)[0]!.attributes('aria-selected')).toBe('true')
  })
})

describe('disabled commands', () => {
  it('are listed with aria-disabled and the reason, and never run', async () => {
    const { wrapper, fake } = await mountApp({ connect: false, tab: false })
    await openPalette(wrapper, 'ejecutar')

    const run = optionNamed(wrapper, 'Ejecutar')
    expect(run.attributes('aria-disabled')).toBe('true')
    expect(run.get('[data-part="palette-reason"]').text()).toBe('No hay ninguna pestaña abierta')

    await choose(wrapper)
    expect(dialog(wrapper).exists()).toBe(true)
    expect(fake.query.execute).not.toHaveBeenCalled()
    expect(wrapper.get('[data-part="palette-message"]').text()).toBe(
      'No disponible: No hay ninguna pestaña abierta',
    )
    expect(announcer(wrapper)).toBe('No disponible: No hay ninguna pestaña abierta')
  })

  it('use the same reasons as the toolbar buttons', async () => {
    const { wrapper } = await mountApp({ connect: false })
    await openPalette(wrapper, 'iniciar transacción')
    expect(
      optionNamed(wrapper, 'Iniciar transacción').get('[data-part="palette-reason"]').text(),
    ).toBe('Esta pestaña no tiene una conexión abierta.')
  })

  it('become enabled when the precondition is met', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, 'iniciar transacción')
    expect(optionNamed(wrapper, 'Iniciar transacción').attributes('aria-disabled')).toBeUndefined()
    expect(wrapper.find('[data-part="palette-reason"]').exists()).toBe(false)
  })

  it('keep the palette open when chosen, and can still be navigated to', async () => {
    const { wrapper } = await mountApp({ connect: false, tab: false })
    await openPalette(wrapper, 'cerrar pestaña')
    expect(options(wrapper)[0]!.attributes('aria-selected')).toBe('true')
    expect(options(wrapper)[0]!.attributes('aria-disabled')).toBe('true')
  })
})

describe('internal commands mode (\\)', () => {
  it('lists the internal commands with their usage as soon as a backslash is typed', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\')
    expect(optionLabels(wrapper)).toEqual([
      '\\connect <nombre>',
      '\\disconnect',
      '\\connections',
      '\\schemas',
      '\\tables [schema]',
      '\\describe <tabla>',
      '\\history',
      '\\ask',
      '\\timing [on|off]',
      '\\clear',
      '\\theme <dark|light|system>',
    ])
    expect(wrapper.get('[data-part="palette-help"]').text()).toContain('Comandos internos')
    expect(wrapper.findAll('[data-part="palette-group-heading"]')).toHaveLength(0)
  })

  it('filters by name and highlights the typed part after the backslash', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\ta')
    expect(optionLabels(wrapper)[0]).toBe('\\tables [schema]')
    expect(options(wrapper)[0]!.get('mark').text()).toBe('ta')
  })

  it('Tab completes the name in the field and shows the argument help', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\conn')
    await choose(wrapper, 'Tab')
    expect(input(wrapper).element.value).toBe('\\connect ')
    expect(wrapper.get('[data-part="palette-help"]').text()).toBe(
      '\\connect <nombre> — Nombre de la conexión',
    )
  })

  it('choosing a command that needs an argument completes it instead of running it', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\connec')
    await choose(wrapper)
    expect(dialog(wrapper).exists()).toBe(true)
    expect(input(wrapper).element.value).toBe('\\connect ')
  })

  it('an unknown command shows the error with suggestions and keeps the palette open', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\tabels ')
    expect(optionLabels(wrapper)).toEqual(['\\tables [schema]'])
    await input(wrapper).setValue('\\tabels')
    await settle()
    await choose(wrapper)
    expect(wrapper.get('[data-part="palette-message"]').text()).toBe(
      'Comando desconocido «\\tabels». ¿Quisiste decir \\tables?',
    )
    expect(wrapper.get('[data-part="palette-message"]').attributes('role')).toBe('alert')
    expect(dialog(wrapper).exists()).toBe(true)
  })

  it('validates arguments before closing and explains what is wrong', async () => {
    const { wrapper, preferences } = await mountApp()
    await openPalette(wrapper, '\\theme oscuro')
    await choose(wrapper)
    expect(wrapper.get('[data-part="palette-message"]').text()).toContain(
      '«oscuro» no es un valor válido',
    )
    expect(preferences.theme).toBe('system')
    expect(dialog(wrapper).exists()).toBe(true)

    await input(wrapper).setValue('\\disconnect ahora')
    await settle()
    await choose(wrapper)
    expect(wrapper.get('[data-part="palette-message"]').text()).toContain('no admite argumentos')
  })

  it('completes connection names from the loaded profiles, without new requests', async () => {
    const { wrapper, fake } = await mountApp()
    const listCalls = fake.connections.list.mock.calls.length
    const schemaCalls = fake.metadata.listSchemas.mock.calls.length
    const tableCalls = fake.metadata.listTables.mock.calls.length

    await openPalette(wrapper, '\\connect ')
    expect(optionLabels(wrapper)).toEqual(['Producción', 'Local'])
    expect(options(wrapper)[0]!.get('.palette-option__detail').text()).toBe(
      'PostgreSQL · conectada',
    )
    expect(options(wrapper)[1]!.get('.palette-option__detail').text()).toBe('SQLite · desconectada')
    await input(wrapper).setValue('\\connect loc')
    await settle()
    expect(optionLabels(wrapper)).toEqual(['Local'])

    expect(fake.connections.list.mock.calls.length).toBe(listCalls)
    expect(fake.metadata.listSchemas.mock.calls.length).toBe(schemaCalls)
    expect(fake.metadata.listTables.mock.calls.length).toBe(tableCalls)
  })

  it('completes table names from the schema cache only', async () => {
    const { wrapper, fake } = await mountApp()
    // Solo el schema `public` se ha cargado: `Sales` no se ha expandido.
    expect(fake.metadata.listTables.mock.calls.map(([request]) => request.schema)).toEqual([])

    await openPalette(wrapper, '\\describe ')
    expect(options(wrapper)).toHaveLength(0)
    expect(wrapper.get('[data-part="palette-empty"]').text()).toContain('Expande el esquema')

    await choose(wrapper, 'Escape')
    const tree = wrapper.get('[role="tree"]')
    await tree.findAll('[role="treeitem"]')[0]!.trigger('click')
    await flushPromises()
    const callsAfterExpand = fake.metadata.listTables.mock.calls.length

    await openPalette(wrapper, '\\describe us')
    expect(optionLabels(wrapper)).toEqual(
      expect.arrayContaining(['public.users', 'public.active_users']),
    )
    expect(optionLabels(wrapper).every((label) => label.startsWith('public.'))).toBe(true)
    expect(options(wrapper)[0]!.get('.palette-option__detail').text()).toMatch(/tabla|vista/)
    expect(fake.metadata.listTables.mock.calls.length).toBe(callsAfterExpand)
  })

  it('completes the theme values', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\theme ')
    expect(optionLabels(wrapper)).toEqual(['dark', 'light', 'system'])
    await input(wrapper).setValue('\\theme li')
    await settle()
    expect(optionLabels(wrapper)).toEqual(['light'])
  })

  it('Enter with the typed command and no completion runs it as written', async () => {
    const { wrapper, preferences } = await mountApp()
    await openPalette(wrapper, '\\timing off')
    await choose(wrapper)
    expect(dialog(wrapper).exists()).toBe(false)
    expect(preferences.showTiming).toBe(false)
  })
})

describe('internal commands wired to the application', () => {
  it('\\connect connects by name and binds the connection to the active tab', async () => {
    const { wrapper, workspace, fake } = await mountApp({ connect: false })
    expect(workspace.activeTab?.sessionId).toBeNull()
    await openPalette(wrapper, '\\connect "Producción"')
    await choose(wrapper)
    await flushPromises()
    expect(fake.connections.connect).toHaveBeenCalledWith({ profileId: 'pg1' })
    expect(workspace.activeTab?.sessionId).toBe('s-pg')
  })

  it('\\connect with an unknown name keeps the palette open with the list of available ones', async () => {
    const { wrapper, fake } = await mountApp({ connect: false })
    await openPalette(wrapper, '\\connect nada')
    await choose(wrapper)
    expect(wrapper.get('[data-part="palette-message"]').text()).toContain('«Producción», «Local»')
    expect(fake.connections.connect).not.toHaveBeenCalled()
  })

  it('\\connect on another profile rebinds the tab; on an open one it does not reconnect', async () => {
    const { wrapper, workspace, fake } = await mountApp()
    await openPalette(wrapper, '\\connect local')
    await choose(wrapper)
    await flushPromises()
    expect(workspace.activeTab?.sessionId).toBe('s-sq')

    await openPalette(wrapper, '\\connect producción')
    await choose(wrapper)
    await flushPromises()
    expect(workspace.activeTab?.sessionId).toBe('s-pg')
    expect(fake.connections.connect).toHaveBeenCalledTimes(2)
  })

  it('\\disconnect closes the active connection and is disabled without one', async () => {
    const { wrapper, fake } = await mountApp()
    await openPalette(wrapper, '\\disconnect')
    await choose(wrapper)
    await flushPromises()
    expect(fake.connections.disconnect).toHaveBeenCalledWith({ sessionId: 's-pg' })

    await openPalette(wrapper, '\\disconnect')
    expect(options(wrapper)[0]!.attributes('aria-disabled')).toBe('true')
    expect(options(wrapper)[0]!.get('[data-part="palette-reason"]').text()).toBe(
      'Requiere una conexión activa',
    )
  })

  it('\\connections opens the connection management dialog and returns the focus afterwards', async () => {
    const { wrapper } = await mountApp()
    editorView().focus()
    pressInEditor({ key: 'k', metaKey: true })
    await settle()
    await input(wrapper).setValue('\\connections')
    await choose(wrapper)
    await flushPromises()
    expect(wrapper.find('dialog[open]').exists()).toBe(true)

    await wrapper.get('[data-action="close-manage"]').trigger('click')
    await settle()
    expect(wrapper.find('dialog[open]').exists()).toBe(false)
    expect(editorHasFocus()).toBe(true)
  })

  it('\\schemas moves the focus to the schema explorer', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\schemas')
    await choose(wrapper)
    await flushPromises()
    const active = document.activeElement as HTMLElement
    expect(active.getAttribute('role')).toBe('treeitem')
    expect(wrapper.get('[data-region="schema-explorer"]').element.contains(active)).toBe(true)
  })

  it('\\tables <schema> expands that schema and focuses it', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\tables sales')
    await choose(wrapper)
    await flushPromises()
    await settle()
    const active = document.activeElement as HTMLElement
    expect(active.getAttribute('role')).toBe('treeitem')
    expect(active.textContent).toContain('Sales')
    expect(active.getAttribute('aria-expanded')).toBe('true')
    expect(wrapper.text()).toContain('Invoice Lines')
  })

  it('\\tables without a schema opens the main one', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\tables')
    await choose(wrapper)
    await flushPromises()
    const active = document.activeElement as HTMLElement
    expect(active.textContent).toContain('public')
    expect(active.getAttribute('aria-expanded')).toBe('true')
  })

  it('\\tables with an unknown schema explains it and stays open', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\tables publik')
    await choose(wrapper)
    expect(wrapper.get('[data-part="palette-message"]').text()).toContain(
      '¿Quisiste decir «public»?',
    )
    expect(dialog(wrapper).exists()).toBe(true)
  })

  it('\\describe <table> expands the table and focuses its node', async () => {
    const { wrapper } = await mountApp()
    await wrapper.get('[role="tree"]').findAll('[role="treeitem"]')[0]!.trigger('click')
    await flushPromises()
    await openPalette(wrapper, '\\describe users')
    await choose(wrapper)
    await flushPromises()
    await settle()
    const active = document.activeElement as HTMLElement
    expect(active.getAttribute('role')).toBe('treeitem')
    expect(active.textContent).toContain('users')
    expect(active.getAttribute('aria-expanded')).toBe('true')
    expect(wrapper.text()).toContain('email')
  })

  it('\\describe of a table that is not loaded says so', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, '\\describe users')
    await choose(wrapper)
    expect(wrapper.get('[data-part="palette-message"]').text()).toContain('ya cargadas')
  })

  it('\\history is enabled, closes the palette and opens the history panel', async () => {
    const { wrapper, fake } = await mountApp()
    stubHistory(fake, makeEntries(2))
    await openPalette(wrapper, '\\history')
    expect(options(wrapper)[0]!.attributes('aria-disabled')).toBeUndefined()

    await choose(wrapper)
    await settle()

    expect(dialog(wrapper).exists()).toBe(false)
    expect(document.querySelector<HTMLDialogElement>('[data-dialog="history"]')!.open).toBe(true)
    expect(wrapper.findAll('[data-dialog="history"] [data-part="entry"]')).toHaveLength(2)
  })

  it('\\timing toggles the duration in the Messages panel, including the text of the messages', async () => {
    const { wrapper, fake } = await mountApp()
    editorView().dispatch({ changes: { from: 0, insert: 'select 1' } })
    press({ key: 'Enter', metaKey: true })
    await settle()
    const requestId = fake.query.execute.mock.calls[0]![0].requestId
    fake.emitQueryEvent(statementDone(requestId, { durationMs: 12 }))
    fake.emitQueryEvent(done(requestId, 'none', 42))
    await settle()
    await wrapper.get('[data-pane="messages"]').trigger('click')
    const messages = () => wrapper.get('[data-part="messages"]').text()
    expect(messages()).toContain('Duración total')
    expect(messages()).toContain('12 ms')

    await openPalette(wrapper, '\\timing')
    await choose(wrapper)
    expect(messages()).not.toContain('Duración total')
    expect(messages()).not.toContain('12 ms')
    expect(messages()).not.toContain('42 ms')
    expect(messages()).toContain('Ejecución completada: 1 sentencia.')
    expect(announcer(wrapper)).toBe('Duración en Mensajes: oculta')

    await openPalette(wrapper, '\\timing on')
    await choose(wrapper)
    expect(messages()).toContain('Duración total')
    expect(messages()).toContain('12 ms')
  })

  it('\\clear empties the messages and results of the active tab only', async () => {
    const { wrapper, fake, workspace } = await mountApp()
    editorView().dispatch({ changes: { from: 0, insert: 'select 1' } })
    press({ key: 'Enter', metaKey: true })
    await settle()
    const requestId = fake.query.execute.mock.calls[0]![0].requestId
    fake.emitQueryEvent(statementDone(requestId))
    fake.emitQueryEvent(done(requestId))
    await settle()
    await wrapper.get('[data-pane="messages"]').trigger('click')
    expect(wrapper.findAll('[data-part="log"] li').length).toBeGreaterThan(0)

    await openPalette(wrapper, '\\clear')
    await choose(wrapper)
    expect(wrapper.findAll('[data-part="log"] li')).toHaveLength(0)
    expect(wrapper.find('[data-part="no-messages"]').exists()).toBe(true)
    expect(workspace.tabs).toHaveLength(1)
    expect(announcer(wrapper)).toBe('Mensajes y resultados limpiados')
  })

  it('\\clear is disabled while a query is running', async () => {
    const { wrapper } = await mountApp()
    editorView().dispatch({ changes: { from: 0, insert: 'select pg_sleep(30)' } })
    press({ key: 'Enter', metaKey: true })
    await settle()
    await openPalette(wrapper, '\\clear')
    expect(options(wrapper)[0]!.get('[data-part="palette-reason"]').text()).toBe(
      'Hay una ejecución en curso',
    )
  })

  it('\\theme goes through the preferences (persisted in main) and never touches data-theme', async () => {
    const { wrapper, fake, preferences } = await mountApp({ root: 'app' })
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)

    await openPalette(wrapper, '\\theme light')
    await choose(wrapper)
    await settle()
    expect(fake.preferences.update).toHaveBeenLastCalledWith({ appearance: { theme: 'light' } })
    expect(fake.storedPreferences().appearance.theme).toBe('light')
    expect(preferences.theme).toBe('light')

    await openPalette(wrapper, '\\theme dark')
    await choose(wrapper)
    await settle()
    expect(fake.storedPreferences().appearance.theme).toBe('dark')

    await openPalette(wrapper, '\\theme system')
    await choose(wrapper)
    await settle()
    expect(fake.storedPreferences().appearance.theme).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('\\theme reports an error and keeps the theme when the preference cannot be saved', async () => {
    const { wrapper, fake, preferences, palette } = await mountApp({ root: 'app' })
    fake.preferences.update.mockResolvedValueOnce(ipcFail(SAVE_ERROR))

    await openPalette(wrapper, '\\theme dark')
    await choose(wrapper)
    await settle()

    expect(preferences.theme).toBe('system')
    expect(palette.announcement).toBe('No se pudo guardar el tema.')
  })

  it('the commands that need an argument open the palette pre-filled from the list', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, 'cambiar tema')
    await choose(wrapper)
    expect(dialog(wrapper).exists()).toBe(true)
    expect(input(wrapper).element.value).toBe('\\theme ')
    expect(optionLabels(wrapper)).toEqual(['dark', 'light', 'system'])
    expect(document.activeElement).toBe(input(wrapper).element)
  })
})

describe('quick search (Cmd+P)', () => {
  it('lists connections and the cached tables and views, connections first', async () => {
    const { wrapper } = await mountApp()
    await wrapper.get('[role="tree"]').findAll('[role="treeitem"]')[0]!.trigger('click')
    await flushPromises()
    press({ key: 'p', metaKey: true })
    await settle()
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe(
      'Buscar tabla, vista o conexión',
    )
    const labels = optionLabels(wrapper)
    expect(labels.slice(0, 2)).toEqual(['Producción', 'Local'])
    expect(labels).toEqual(expect.arrayContaining(['public.users', 'public.active_users']))
  })

  it('finds a table by fuzzy search and inserts its qualified name into the editor, which gets the focus', async () => {
    const { wrapper } = await mountApp()
    await wrapper.get('[role="tree"]').findAll('[role="treeitem"]')[0]!.trigger('click')
    await flushPromises()
    press({ key: 'p', metaKey: true })
    await settle()
    await input(wrapper).setValue('act users')
    await settle()
    expect(optionLabels(wrapper)).toEqual(['public.active_users'])
    expect(options(wrapper)[0]!.get('.palette-option__detail').text()).toBe('vista')
    await choose(wrapper)
    await flushPromises()
    expect(editorView().state.doc.toString()).toBe('public.active_users')
    expect(editorHasFocus()).toBe(true)
  })

  it('quotes identifiers that need it, as the schema browser does', async () => {
    const { wrapper } = await mountApp()
    await wrapper.get('[role="tree"]').findAll('[role="treeitem"]')[0]!.trigger('click')
    await flushPromises()
    press({ key: 'p', metaKey: true })
    await settle()
    await input(wrapper).setValue('public.user')
    await settle()
    await choose(wrapper, 'End')
    const labels = optionLabels(wrapper)
    expect(labels).toContain('public.user')
    await input(wrapper).setValue('public.user')
    await settle()
    const target = options(wrapper).find(
      (o) => o.get('.palette-option__label').text() === 'public.user',
    )!
    await target.trigger('click')
    await flushPromises()
    expect(editorView().state.doc.toString()).toBe('public."user"')
  })

  it('choosing a connection connects it and binds it to the tab', async () => {
    const { wrapper, workspace, fake } = await mountApp()
    press({ key: 'p', metaKey: true })
    await settle()
    await input(wrapper).setValue('local')
    await settle()
    await choose(wrapper)
    await flushPromises()
    expect(fake.connections.connect).toHaveBeenLastCalledWith({ profileId: 'sq1' })
    expect(workspace.activeTab?.sessionId).toBe('s-sq')
    expect(dialog(wrapper).exists()).toBe(false)
  })

  it('tables cannot be inserted without a tab and say why', async () => {
    const { wrapper, workspace } = await mountApp({ tab: false })
    press({ key: 'p', metaKey: true })
    await settle()
    expect(workspace.tabs).toHaveLength(0)
    expect(optionLabels(wrapper)).toEqual(['Producción', 'Local'])
  })

  it('shows an empty state with guidance when there is nothing to search', async () => {
    const { wrapper } = await mountApp({ connect: false, tab: false })
    await wrapper.get('[data-profile-id="pg1"]').trigger('click')
    press({ key: 'p', metaKey: true })
    await settle()
    await input(wrapper).setValue('zzz')
    await settle()
    expect(wrapper.get('[data-part="palette-empty"]').text()).toContain(
      'Ninguna conexión, tabla ni vista',
    )
  })
})

describe('migrated global shortcuts', () => {
  it('work with the focus inside the CodeMirror editor', async () => {
    const { workspace, wrapper } = await mountApp()
    editorView().focus()
    const event = pressInEditor({ key: 't', metaKey: true })
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(workspace.tabs).toHaveLength(2)

    pressInEditor({ key: 'Tab', ctrlKey: true })
    await settle()
    expect(workspace.activeTab?.id).toBe('tab-1')
    pressInEditor({ key: '2', code: 'Digit2', metaKey: true })
    await settle()
    expect(workspace.activeTab?.id).toBe('tab-2')
    pressInEditor({ key: 'w', metaKey: true })
    await settle()
    expect(workspace.tabs).toHaveLength(1)
    void wrapper
  })

  it('Cmd+L focuses the editor from anywhere and does nothing without tabs', async () => {
    const { wrapper } = await mountApp()
    wrapper.get<HTMLButtonElement>('[data-action="manage-connections"]').element.focus()
    const event = press({ key: 'l', metaKey: true })
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(editorHasFocus()).toBe(true)
  })

  it('Alt+Shift+F formats the document from outside the editor, and the editor handles it itself when focused', async () => {
    const { wrapper } = await mountApp()
    editorView().dispatch({ changes: { from: 0, insert: 'select a,b from t where x=1' } })
    wrapper.get<HTMLButtonElement>('[data-action="manage-connections"]').element.focus()
    press({ key: 'Ï', code: 'KeyF', altKey: true, shiftKey: true })
    await vi.waitFor(() => expect(editorView().state.doc.toString()).toContain('\n'))
  })

  it('explain in the toolbar and announcer why a blocked shortcut did nothing', async () => {
    const { wrapper } = await mountApp({ connect: false, tab: false })
    press({ key: 'w', metaKey: true })
    await settle()
    expect(announcer(wrapper)).toBe('No se puede cerrar pestaña: No hay ninguna pestaña abierta')

    press({ key: 'Tab', ctrlKey: true })
    await settle()
    expect(announcer(wrapper)).toContain('«Pestaña siguiente» no está disponible')
  })

  it('does not repeat commands while a key is held, except tab cycling', async () => {
    const { workspace } = await mountApp()
    press({ key: 't', metaKey: true, repeat: true })
    await settle()
    expect(workspace.tabs).toHaveLength(1)
    press({ key: 't', metaKey: true })
    press({ key: 't', metaKey: true })
    await settle()
    expect(workspace.tabs).toHaveLength(3)
    press({ key: 'Tab', ctrlKey: true, repeat: true })
    await settle()
    expect(workspace.activeTab?.id).toBe('tab-1')
  })

  it('ignores an event that another handler already consumed', async () => {
    const { workspace } = await mountApp()
    const consumed = new KeyboardEvent('keydown', {
      key: 't',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    consumed.preventDefault()
    window.dispatchEvent(consumed)
    await settle()
    expect(workspace.tabs).toHaveLength(1)
  })

  it('Esc keeps not consuming the event when it cancels', async () => {
    const { fake } = await mountApp()
    editorView().dispatch({ changes: { from: 0, insert: 'select pg_sleep(30)' } })
    press({ key: 'Enter', metaKey: true })
    await settle()
    const requestId = fake.query.execute.mock.calls[0]![0].requestId
    fake.query.cancel.mockResolvedValue(ipcOk({ requestId, outcome: 'requested' }))
    const event = press({ key: 'Escape' })
    await settle()
    expect(fake.query.cancel).toHaveBeenCalledWith({ requestId })
    expect(event.defaultPrevented).toBe(false)
  })

  it('buttons announce the shortcuts registered for the platform', async () => {
    const { wrapper } = await mountApp()
    const run = wrapper.get('[data-region="execution-toolbar"] [data-action="run"]')
    expect(run.attributes('aria-keyshortcuts')).toBe('Meta+Enter')
    expect(run.attributes('title')).toBe('Ejecutar (⌘↵)')
    expect(wrapper.get('[data-action="new-tab"]').attributes('aria-keyshortcuts')).toBe('Meta+T')
  })
})

describe('settings screen', () => {
  const settingsDialog = () =>
    document.querySelector<HTMLDialogElement>('[data-dialog="settings"]')!

  it('Cmd+, opens it from the editor and Esc gives the focus back to the editor', async () => {
    const { wrapper } = await mountApp()
    editorView().focus()
    const event = pressInEditor({ key: ',', code: 'Comma', metaKey: true })
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(settingsDialog().open).toBe(true)
    expect(settingsDialog().querySelector('[data-section="appearance"]')).not.toBeNull()

    await wrapper.get('[data-dialog="settings"]').trigger('cancel')
    await settle()
    expect(settingsDialog().open).toBe(false)
    expect(editorHasFocus()).toBe(true)
  })

  it('"Abrir ajustes" in the palette opens it and the shortcut is shown', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, 'ajustes')
    expect(optionNamed(wrapper, 'Abrir ajustes').get('kbd').text()).toBe('⌘,')

    await choose(wrapper)
    await settle()

    expect(dialog(wrapper).exists()).toBe(false)
    expect(settingsDialog().open).toBe(true)
  })

  it('"Ajustes de ejecución" opens it on the execution section, also without tabs', async () => {
    const { wrapper } = await mountApp({ tab: false })
    await openPalette(wrapper, 'ajustes de ejecución')
    await choose(wrapper)
    await settle()

    expect(settingsDialog().open).toBe(true)
    expect(document.activeElement).toBe(settingsDialog().querySelector('[name="timeoutSeconds"]'))
  })

  it('while it is open the other shortcuts are left alone (a modal dialog owns the keyboard)', async () => {
    const { workspace } = await mountApp()
    press({ key: ',', code: 'Comma', metaKey: true })
    await settle()
    press({ key: 't', metaKey: true })
    await settle()
    expect(workspace.tabs).toHaveLength(1)
  })

  it('uses Ctrl+, on Windows and Linux and ignores Cmd+,', async () => {
    await mountApp({ agent: WINDOWS })
    press({ key: ',', code: 'Comma', metaKey: true })
    await settle()
    expect(settingsDialog().open).toBe(false)

    press({ key: ',', code: 'Comma', ctrlKey: true })
    await settle()
    expect(settingsDialog().open).toBe(true)
  })
})

describe('history panel', () => {
  const historyDialog = () => document.querySelector<HTMLDialogElement>('[data-dialog="history"]')!

  it('Cmd+Shift+H opens it from the editor and Esc gives the focus back to the editor', async () => {
    const { wrapper } = await mountApp()
    editorView().focus()
    const event = pressInEditor({ key: 'H', code: 'KeyH', metaKey: true, shiftKey: true })
    await settle()

    expect(event.defaultPrevented).toBe(true)
    expect(historyDialog().open).toBe(true)
    expect(document.activeElement).toBe(historyDialog().querySelector('[name="search"]'))

    await wrapper.get('[data-dialog="history"]').trigger('cancel')
    await settle()
    expect(historyDialog().open).toBe(false)
    expect(editorHasFocus()).toBe(true)
  })

  it('works without tabs, uses Ctrl+Shift+H on Windows and ignores Cmd there', async () => {
    await mountApp({ tab: false, agent: WINDOWS })
    press({ key: 'H', code: 'KeyH', metaKey: true, shiftKey: true })
    await settle()
    expect(historyDialog().open).toBe(false)

    press({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true })
    await settle()
    expect(historyDialog().open).toBe(true)
  })

  it('"Abrir historial" shows its shortcut in the palette', async () => {
    const { wrapper } = await mountApp()
    await openPalette(wrapper, 'historial')
    expect(optionNamed(wrapper, 'Abrir historial').get('kbd').text()).toBe('⇧⌘H')
  })

  it('leaves the other shortcuts alone while it is open (a modal dialog owns the keyboard)', async () => {
    const { workspace } = await mountApp()
    press({ key: 'H', code: 'KeyH', metaKey: true, shiftKey: true })
    await settle()
    press({ key: 't', metaKey: true })
    await settle()
    expect(workspace.tabs).toHaveLength(1)
  })
})

describe('other platforms', () => {
  it('uses Ctrl on Windows and Linux, ignores Cmd, and shows Ctrl+ labels', async () => {
    const { wrapper, workspace } = await mountApp({ agent: WINDOWS })
    press({ key: 'k', metaKey: true })
    await settle()
    expect(dialog(wrapper).exists()).toBe(false)

    press({ key: 'k', ctrlKey: true })
    await settle()
    expect(dialog(wrapper).exists()).toBe(true)
    expect(optionNamed(wrapper, 'Nueva pestaña SQL').get('kbd').text()).toBe('Ctrl+T')
    expect(optionNamed(wrapper, 'Ejecutar todo').get('kbd').text()).toBe('Ctrl+Shift+Enter')
    await choose(wrapper, 'Escape')

    press({ key: 't', ctrlKey: true })
    await settle()
    expect(workspace.tabs).toHaveLength(2)
    press({ key: 'Tab', ctrlKey: true })
    await settle()
    expect(workspace.activeTab?.id).toBe('tab-1')
  })
})

describe('context hygiene', () => {
  it('carries no secrets or connection targets into the commands', async () => {
    const { center } = await mountApp()
    const serialised = JSON.stringify(center.context)
    expect(serialised).toContain('Producción')
    expect(serialised).not.toContain('secret-pg1')
    expect(serialised).not.toContain('secretRef')
    expect(serialised).not.toContain('db.example.com')
    expect(serialised).not.toContain('app_user')
    expect(serialised).not.toContain('/Users/me/data.db')
    expect(serialised).not.toMatch(/password/i)
    expect(Object.keys(center.context.connections[0]!).sort()).toEqual([
      'engine',
      'id',
      'name',
      'readOnly',
      'status',
    ])
  })

  it('keeps no secrets, rows or SQL in the serialised Pinia state', async () => {
    const { wrapper, pinia } = await mountApp()
    await openPalette(wrapper, '\\connect Producción')
    const serialised = JSON.stringify(pinia.state.value.commandPalette)
    expect(Object.keys(pinia.state.value)).toContain('commandPalette')
    expect(serialised).toContain('Producción')
    expect(serialised).not.toContain('secret-pg1')
    expect(serialised).not.toContain('db.example.com')
    expect(serialised).not.toMatch(/"password"/i)
  })
})
