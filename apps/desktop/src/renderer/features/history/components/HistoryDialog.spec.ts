import {
  DEFAULT_PREFERENCES,
  type ConnectionProfile,
  type HistoryPage,
  type NormalizedError,
  type Session,
} from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { usePaletteStore } from '../../command-palette/stores/palette'
import { useConnectionsStore } from '../../connections'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { usePreferencesStore } from '../../preferences'
import { useSettingsStore } from '../../settings/stores/settings'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { useHistoryFeed } from '../composables/use-history-feed'
import { HISTORY_PAGE_SIZE } from '../model/filters'
import { useHistoryPanelStore } from '../stores/history-panel'
import { CLOCK_TICK_MS, SEARCH_DEBOUNCE_MS, useHistoryStore } from '../stores/history'
import { HISTORY_NOW, makeEntries, makeEntry, stubHistory } from '../testing/fake-history'
import HistoryDialog from './HistoryDialog.vue'

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

const session: Session = {
  sessionId: 's-pg',
  profileId: 'pg1',
  engine: 'postgres',
  serverVersion: '17.0',
  readOnly: false,
  transaction: 'none',
}

const STORAGE_ERROR: NormalizedError = {
  code: 'internal_error',
  message: 'Could not read the history',
  retryable: true,
}

// El workspace monta la suscripción a los cambios del historial junto al diálogo: aquí se hace igual.
const Host = defineComponent({
  setup() {
    useHistoryFeed()
    return () => h(HistoryDialog)
  },
})

let wrapper: VueWrapper | undefined
let pinia: Pinia
let fake: ReturnType<typeof createFakeDb>
let backend: ReturnType<typeof stubHistory>
let opener: HTMLButtonElement

interface SetupOptions {
  entries?: ReturnType<typeof makeEntries>
  connected?: boolean
  profiles?: ConnectionProfile[]
  open?: boolean
  historyEnabled?: boolean
}

async function setup({
  entries = makeEntries(3),
  connected = false,
  profiles = [postgres],
  open = true,
  historyEnabled = true,
}: SetupOptions = {}) {
  fake = createFakeDb({
    profiles,
    connectResult: ipcOk(session),
    preferences: {
      history: { enabled: historyEnabled, retentionDays: 30 },
      appearance: { theme: 'system' },
      execution: { timeoutSeconds: 30, maxRows: 10_000, confirmDestructive: true },
      ai: DEFAULT_PREFERENCES.ai,
    },
  })
  installFakeDb(fake.db)
  backend = stubHistory(fake, entries)
  pinia = createPinia()
  opener = document.createElement('button')
  opener.textContent = 'Abrir'
  document.body.append(opener)
  wrapper = mount(Host, { global: { plugins: [pinia] }, attachTo: document.body })
  await useConnectionsStore(pinia).load()
  await usePreferencesStore(pinia).load()
  if (connected) await useConnectionsStore(pinia).connect('pg1')
  await flushPromises()
  if (open) await openPanel()
  return {
    panel: useHistoryPanelStore(pinia),
    history: useHistoryStore(pinia),
    workspace: useWorkspaceStore(pinia),
    preferences: usePreferencesStore(pinia),
    settings: useSettingsStore(pinia),
    palette: usePaletteStore(pinia),
    connections: useConnectionsStore(pinia),
  }
}

async function openPanel() {
  opener.focus()
  useHistoryPanelStore(pinia).open()
  await flushPromises()
}

const dialog = () => wrapper!.get<HTMLDialogElement>('[data-dialog="history"]')
const isOpen = () => dialog().element.open
const rows = () => dialog().findAll('[data-entry-id]')
const rowIds = () => rows().map((row) => row.attributes('data-entry-id'))
const entryButton = (id: string) =>
  dialog().get<HTMLButtonElement>(`[data-entry-id="${id}"] [data-part="entry"]`)
const search = () => dialog().get<HTMLInputElement>('[name="search"]')
const status = () => dialog().get('[data-part="history-status"]').text()
const clearDialog = () => dialog().get<HTMLDialogElement>('[data-dialog="clear-history"]')
const clearIsOpen = () => clearDialog().element.open

async function press(id: string, key: string) {
  await entryButton(id).trigger('keydown', { key })
  await flushPromises()
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'db')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('structure, focus and accessibility', () => {
  it('is a closed modal dialog until opened, labelled by its title and described', async () => {
    await setup({ open: false })
    expect(isOpen()).toBe(false)

    await openPanel()

    expect(isOpen()).toBe(true)
    const title = dialog().get('h2')
    expect(title.text()).toBe('Historial de consultas')
    expect(dialog().attributes('aria-labelledby')).toBe(title.attributes('id'))
    expect(document.getElementById(dialog().attributes('aria-describedby')!)).not.toBeNull()
    expect(dialog().attributes('data-size')).toBe('wide')
  })

  it('puts the focus on the search field and gives it back to the opener on close', async () => {
    const { panel } = await setup()
    expect(document.activeElement).toBe(search().element)

    panel.close()
    await flushPromises()

    expect(isOpen()).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('closes with Escape and with the Close button', async () => {
    const { panel } = await setup()
    await dialog().trigger('cancel')
    await flushPromises()
    expect(panel.isOpen).toBe(false)

    await openPanel()
    await dialog().get('[data-action="close-history"]').trigger('click')
    await flushPromises()
    expect(panel.isOpen).toBe(false)
  })

  it('labels every filter and exposes the list as a named list of native buttons', async () => {
    await setup()
    for (const name of ['search', 'status', 'engine', 'profile', 'from', 'to']) {
      const control = dialog().get<HTMLInputElement>(`[name="${name}"]`)
      expect(control.element.labels?.length, name).toBeGreaterThan(0)
    }
    const list = dialog().get('ul')
    expect(list.attributes('aria-label')).toBe('Consultas del historial')
    expect(list.findAll('li')).toHaveLength(3)
    for (const row of rows()) expect(row.get('[data-part="entry"]').element.tagName).toBe('BUTTON')
  })

  it('has a live region that announces how many queries were found', async () => {
    await setup()
    const region = dialog().get('[data-part="history-status"]')
    expect(region.attributes('role')).toBe('status')
    expect(region.attributes('aria-live')).toBe('polite')
    expect(status()).toBe('3 consultas')
  })

  it('does not keep the SQL text in memory once the panel is closed', async () => {
    const { panel, history } = await setup()
    expect(history.entries).toHaveLength(3)

    panel.close()
    await flushPromises()

    expect(history.entries).toEqual([])
  })

  it('starts every opening from a clean search and fresh data', async () => {
    const { panel, history } = await setup()
    await search().setValue('select 2')
    await search().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(rowIds()).toEqual(['entry-2'])

    panel.close()
    await flushPromises()
    await openPanel()

    expect(search().element.value).toBe('')
    expect(history.filtered).toBe(false)
    expect(rowIds()).toEqual(['entry-1', 'entry-2', 'entry-3'])
  })
})

describe('entries', () => {
  it('shows the query, engine, connection, dates, duration, rows and a status with glyph and text', async () => {
    await setup({
      entries: [
        makeEntry(1, { sql: 'select   *\n  from users', status: 'ok', rowCount: 1 }),
        makeEntry(2, { status: 'error', errorCode: 'syntax_error', rowCount: undefined }),
        makeEntry(3, { status: 'cancelled', engine: 'sqlite', profileName: 'Local' }),
      ],
    })
    const first = dialog().get('[data-entry-id="entry-1"]')
    expect(first.get('.history-row__sql').text()).toBe('select * from users')
    expect(first.get('[data-part="engine"]').text()).toBe('PostgreSQL')
    expect(first.get('[data-part="profile"]').text()).toBe('Producción')
    expect(first.get('[data-part="duration"]').text()).toBe('13 ms')
    expect(first.get('[data-part="rows"]').text()).toBe('1 fila')
    const time = first.get('time')
    expect(time.attributes('datetime')).toBe(makeEntry(1).executedAt)
    expect(time.text()).toMatch(/2026/)

    const statuses = rows().map((row) => row.get('.history-row__status'))
    expect(statuses.map((entry) => entry.text())).toEqual(['Correcta', 'Con error', 'Cancelada'])
    for (const entry of statuses) {
      expect(entry.get('.history-row__glyph').attributes('aria-hidden')).toBe('true')
    }
    expect(dialog().get('[data-entry-id="entry-2"] [data-part="error-code"]').text()).toBe(
      'syntax_error',
    )
    expect(dialog().find('[data-entry-id="entry-2"] [data-part="rows"]').exists()).toBe(false)
  })

  it('truncates a long query in the row without losing it in the tooltip', async () => {
    await setup({ entries: [makeEntry(1, { sql: `select ${'x'.repeat(2_000)}` })] })
    const button = entryButton('entry-1')
    expect(button.get('.history-row__sql').text().length).toBeLessThan(200)
    expect(button.get('.history-row__sql').text().endsWith('…')).toBe(true)
    expect(button.attributes('title')!.startsWith('select xxx')).toBe(true)
  })

  it('has a single tab stop for the list (roving tabindex): the first row', async () => {
    await setup()
    const tabbable = rows().filter(
      (row) => row.get('[data-part="entry"]').attributes('tabindex') === '0',
    )
    expect(tabbable.map((row) => row.attributes('data-entry-id'))).toEqual(['entry-1'])
    expect(dialog().get('[data-action="delete-entry"]').attributes('tabindex')).toBe('-1')
  })
})

describe('states', () => {
  it('shows a loading message while the first page is pending', async () => {
    let release!: (page: HistoryPage) => void
    await setup({ open: false })
    fake.history.list.mockImplementationOnce(
      () => new Promise((resolve) => (release = (page) => resolve(ipcOk(page)))),
    )
    await openPanel()

    expect(dialog().get('[data-state="loading"]').text()).toContain('Cargando')
    expect(dialog().get('.history-dialog__body').attributes('aria-busy')).toBe('true')

    release({ entries: makeEntries(1), nextCursor: null })
    await flushPromises()
    expect(dialog().find('[data-state="loading"]').exists()).toBe(false)
    expect(rows()).toHaveLength(1)
  })

  it('explains an empty history and disables the clear button', async () => {
    await setup({ entries: [] })
    expect(dialog().get('[data-state="empty"]').text()).toContain('Todavía no hay consultas')
    expect(dialog().get('[data-action="clear-history"]').attributes('aria-disabled')).toBe('true')

    await dialog().get('[data-action="clear-history"]').trigger('click')
    expect(clearIsOpen()).toBe(false)
  })

  it('shows a readable error with a retry that recovers', async () => {
    await setup({ open: false })
    fake.history.list.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))
    await openPanel()

    const error = dialog().get('[data-state="error"]')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toContain('No se pudo leer el historial')
    expect(error.text()).toContain('Could not read the history')

    await error.get('[data-action="retry-history"]').trigger('click')
    await flushPromises()

    expect(dialog().find('[data-state="error"]').exists()).toBe(false)
    expect(rows()).toHaveLength(3)
  })

  it('says nothing matched when a search or filter leaves the list empty, and offers to remove them', async () => {
    const { history } = await setup()
    await search().setValue('no existe')
    await search().trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(dialog().get('[data-state="empty"]').text()).toContain('Ninguna consulta coincide')
    expect(status()).toBe('0 consultas')

    await dialog().get('[data-action="clear-filters"]').trigger('click')
    await flushPromises()

    expect(history.filtered).toBe(false)
    expect(search().element.value).toBe('')
    expect(rows()).toHaveLength(3)
    expect(document.activeElement).toBe(search().element)
  })
})

describe('search and filters', () => {
  it('searches after the typing pause and immediately with Enter', async () => {
    await setup()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fake.history.list.mockClear()

    await search().setValue('select 3')
    expect(fake.history.list).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS)
    await flushPromises()
    expect(fake.history.list).toHaveBeenCalledWith({ limit: HISTORY_PAGE_SIZE, search: 'select 3' })
    expect(rowIds()).toEqual(['entry-3'])

    await search().setValue('select 1')
    await search().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(rowIds()).toEqual(['entry-1'])
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2)
    expect(fake.history.list).toHaveBeenCalledTimes(2)
  })

  it('filters by status, engine and connection through native selects', async () => {
    await setup({
      entries: [
        makeEntry(1, { status: 'error' }),
        makeEntry(2, { engine: 'sqlite', profileId: 'sq1', profileName: 'Local' }),
        makeEntry(3),
      ],
    })
    const choose = async (name: string, value: string) => {
      const select = dialog().get<HTMLSelectElement>(`[name="${name}"]`)
      select.element.value = value
      await select.trigger('change')
      await flushPromises()
    }

    await choose('status', 'error')
    expect(rowIds()).toEqual(['entry-1'])
    await choose('status', '')
    await choose('engine', 'sqlite')
    expect(rowIds()).toEqual(['entry-2'])
    await choose('engine', '')
    await choose('profile', 'pg1')
    expect(rowIds()).toEqual(['entry-1', 'entry-3'])
    expect(fake.history.list).toHaveBeenLastCalledWith({
      limit: HISTORY_PAGE_SIZE,
      profileId: 'pg1',
    })
    expect(
      dialog()
        .findAll('[name="profile"] option')
        .map((option) => option.text()),
    ).toEqual(['Todas', 'Producción'])
  })
})

describe('date filters', () => {
  // Una entrada por día local, al mediodía: la 1 es del día 20, la 2 del 19, la 3 del 18…
  const perDay = () =>
    Array.from({ length: 5 }, (_, index) =>
      makeEntry(index + 1, { executedAt: new Date(2026, 8, 20 - index, 12).toISOString() }),
    )
  const from = () => dialog().get<HTMLInputElement>('[name="from"]')
  const to = () => dialog().get<HTMLInputElement>('[name="to"]')
  const pick = async (input: HTMLInputElement, value: string) => {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
  }

  it('are native date inputs labelled with their time zone, next to the other filters', async () => {
    await setup()

    expect(from().attributes('type')).toBe('date')
    expect(to().attributes('type')).toBe('date')
    expect(from().element.labels?.[0]?.textContent).toBe('Desde (hora local)')
    expect(to().element.labels?.[0]?.textContent).toBe('Hasta (hora local)')
    expect(dialog().get('[role="search"]').findAll('input[type="date"]')).toHaveLength(2)
  })

  it('narrow the list to the local-day range and offer «Quitar filtros» when nothing matches', async () => {
    await setup({ entries: perDay() })

    await pick(from().element, '2026-09-18')
    await pick(to().element, '2026-09-19')
    expect(rowIds()).toEqual(['entry-2', 'entry-3'])
    expect(fake.history.list).toHaveBeenLastCalledWith({
      limit: HISTORY_PAGE_SIZE,
      from: new Date(2026, 8, 18, 0, 0, 0, 0).toISOString(),
      to: new Date(2026, 8, 19, 23, 59, 59, 999).toISOString(),
    })

    await pick(from().element, '2026-10-01')
    await pick(to().element, '2026-10-02')
    expect(dialog().get('[data-state="empty"]').text()).toContain('Ninguna consulta coincide')

    await dialog().get('[data-action="clear-filters"]').trigger('click')
    await flushPromises()
    expect(from().element.value).toBe('')
    expect(to().element.value).toBe('')
    expect(rowIds()).toHaveLength(5)
    expect(document.activeElement).toBe(search().element)
  })

  it('link their limits so the native picker cannot cross them', async () => {
    await setup({ entries: perDay() })

    await pick(from().element, '2026-09-18')
    await pick(to().element, '2026-09-19')

    expect(to().attributes('min')).toBe('2026-09-18')
    expect(from().attributes('max')).toBe('2026-09-19')
  })

  it('refuse an inverted range: no request, a described and announced error, and the list is kept', async () => {
    await setup({ entries: perDay() })
    fake.history.list.mockClear()

    await pick(from().element, '2026-09-20')
    await pick(to().element, '2026-09-18')

    expect(fake.history.list).toHaveBeenCalledTimes(1)
    expect(rowIds()).toEqual(['entry-1'])
    expect(to().attributes('aria-invalid')).toBe('true')
    expect(from().attributes('aria-invalid')).toBeUndefined()
    const message = document.getElementById(to().attributes('aria-describedby')!)!
    expect(message.textContent).toBe('La fecha «Desde» no puede ser posterior a «Hasta».')
    expect(status()).toBe('La fecha «Desde» no puede ser posterior a «Hasta».')

    await pick(to().element, '2026-09-21')
    expect(to().attributes('aria-invalid')).toBeUndefined()
    expect(rowIds()).toEqual(['entry-1'])
  })

  it('an emptied date drops that bound', async () => {
    await setup({ entries: perDay() })
    await pick(from().element, '2026-09-20')
    expect(rowIds()).toEqual(['entry-1'])

    await pick(from().element, '')

    expect(rows()).toHaveLength(5)
  })

  it('start empty on every opening', async () => {
    const { panel } = await setup({ entries: perDay() })
    await pick(from().element, '2026-09-20')

    panel.close()
    await flushPromises()
    await openPanel()

    expect(from().element.value).toBe('')
    expect(rows()).toHaveLength(5)
  })
})

describe('live updates', () => {
  const fresh = (id: number, overrides = {}) =>
    makeEntry(id, {
      id: `new-${id}`,
      sql: `select ${id} from live`,
      executedAt: new Date(Date.now()).toISOString(),
      ...overrides,
    })

  it('shows a query executed with the panel open at the top, and announces it', async () => {
    await setup()

    backend.record(fresh(1), 'r1')
    await flushPromises()

    expect(rowIds()).toEqual(['new-1', 'entry-1', 'entry-2', 'entry-3'])
    expect(status()).toBe('Consulta nueva añadida al historial')
    expect(fake.history.list).toHaveBeenCalledTimes(1)
  })

  it('does not steal the focus nor move the selected row', async () => {
    await setup()
    entryButton('entry-2').element.focus()
    await entryButton('entry-2').trigger('focusin')

    backend.record(fresh(1))
    await flushPromises()

    expect(document.activeElement).toBe(entryButton('entry-2').element)
    expect(entryButton('entry-2').attributes('tabindex')).toBe('0')
    expect(entryButton('new-1').attributes('tabindex')).toBe('-1')
    // Los demás nodos siguen siendo los mismos: la lista no se vuelve a pintar entera.
    expect(rowIds()).toEqual(['new-1', 'entry-1', 'entry-2', 'entry-3'])
  })

  it('respects the active search: a new entry that does not match is not shown', async () => {
    await setup()
    await search().setValue('nada-que-coincida')
    await search().trigger('keydown', { key: 'Enter' })
    await flushPromises()

    backend.record(fresh(1))
    await flushPromises()
    expect(rows()).toHaveLength(0)

    await search().setValue('live')
    await search().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    backend.record(fresh(2))
    await flushPromises()
    expect(rowIds()).toEqual(['new-2', 'new-1'])
  })

  it('leaves the empty state when the first query arrives', async () => {
    await setup({ entries: [] })
    expect(dialog().find('[data-state="empty"]').exists()).toBe(true)

    backend.record(fresh(1))
    await flushPromises()

    expect(dialog().find('[data-state="empty"]').exists()).toBe(false)
    expect(rowIds()).toEqual(['new-1'])
  })

  it('removes an entry deleted elsewhere and empties the list when the history is cleared', async () => {
    await setup()

    fake.emitHistoryChange({ type: 'removed', id: 'entry-2' })
    await flushPromises()
    expect(rowIds()).toEqual(['entry-1', 'entry-3'])

    fake.emitHistoryChange({ type: 'cleared' })
    await flushPromises()
    expect(rows()).toHaveLength(0)
    expect(dialog().find('[data-state="empty"]').exists()).toBe(true)
  })

  it('reloads the first page when retention purges entries', async () => {
    await setup({ entries: [makeEntry(1), makeEntry(2), makeEntry(400)] })
    await backend.delete({ id: 'entry-400' })
    fake.history.list.mockClear()

    fake.emitHistoryChange({ type: 'purged' })
    await flushPromises()

    expect(fake.history.list).toHaveBeenCalledTimes(1)
    expect(rowIds()).toEqual(['entry-1', 'entry-2'])
  })

  it('ignores a malformed change pushed by main', async () => {
    await setup()

    fake.emitHistoryChange({ type: 'added', entry: { id: 'x' } } as never)
    fake.emitHistoryChange({ type: 'exploded' } as never)
    await flushPromises()

    expect(rows()).toHaveLength(3)
  })

  it('keeps nothing once closed: a query that finishes with the panel shut does not fill the list', async () => {
    const { panel, history } = await setup()
    panel.close()
    await flushPromises()

    backend.record(fresh(1))
    await flushPromises()

    expect(history.entries).toEqual([])
    expect(history.status).toBe('idle')
  })

  it('a query recorded while the first page is still loading is not lost', async () => {
    await setup({ open: false })
    let release!: (page: HistoryPage) => void
    fake.history.list.mockImplementationOnce(
      () => new Promise((resolve) => (release = (page) => resolve(ipcOk(page)))),
    )
    await openPanel()

    backend.record(fresh(1))
    release({ entries: makeEntries(3), nextCursor: null })
    await flushPromises()

    expect(rowIds()[0]).toBe('new-1')
  })

  it('refreshes the relative dates while open and stops when closed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(HISTORY_NOW)
    const { panel } = await setup()
    const date = () => rows()[0]!.get('[data-part="date"]').text()
    expect(date()).toMatch(/^hace 1 min/)

    await vi.advanceTimersByTimeAsync(CLOCK_TICK_MS)
    await vi.advanceTimersByTimeAsync(CLOCK_TICK_MS)
    await flushPromises()
    expect(date()).toMatch(/^hace 2 min/)

    panel.close()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('keyboard navigation', () => {
  it('moves through the rows with the arrows, Home and End, without wrapping', async () => {
    await setup()
    entryButton('entry-1').element.focus()

    await press('entry-1', 'ArrowDown')
    expect(document.activeElement).toBe(entryButton('entry-2').element)
    await press('entry-2', 'ArrowDown')
    await press('entry-3', 'ArrowDown')
    expect(document.activeElement).toBe(entryButton('entry-3').element)
    await press('entry-3', 'ArrowUp')
    expect(document.activeElement).toBe(entryButton('entry-2').element)
    await press('entry-2', 'Home')
    expect(document.activeElement).toBe(entryButton('entry-1').element)
    await press('entry-1', 'ArrowUp')
    expect(document.activeElement).toBe(entryButton('entry-1').element)
    await press('entry-1', 'End')
    expect(document.activeElement).toBe(entryButton('entry-3').element)
  })

  it('makes the row that has the focus the only tab stop', async () => {
    await setup()
    entryButton('entry-2').element.focus()
    await flushPromises()
    expect(entryButton('entry-2').attributes('tabindex')).toBe('0')
    expect(entryButton('entry-1').attributes('tabindex')).toBe('-1')
  })

  it('goes from the search field to the list with ArrowDown and back with "/"', async () => {
    await setup()
    search().element.focus()
    await search().trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(entryButton('entry-1').element)

    await press('entry-1', '/')
    expect(document.activeElement).toBe(search().element)
  })

  it('leaves ArrowDown alone in the search field when the list is empty', async () => {
    await setup({ entries: [] })
    search().element.focus()
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    })
    search().element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not steal modified arrow keys from the row', async () => {
    await setup({ entries: makeEntries(2) })
    const shifted = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    entryButton('entry-1').element.dispatchEvent(shifted)
    expect(shifted.defaultPrevented).toBe(false)
  })
})

describe('reopening in a new tab', () => {
  it('opens the SQL in a new tab without running it, closes the panel and focuses the editor tab', async () => {
    const { workspace, panel } = await setup({
      entries: [makeEntry(1, { sql: 'select 42 from answers' })],
    })
    workspace.createTab()

    await entryButton('entry-1').trigger('click')
    await flushPromises()

    expect(workspace.tabs).toHaveLength(2)
    expect(workspace.activeTab).toMatchObject({
      title: 'Consulta 2',
      content: 'select 42 from answers',
      saveToHistory: true,
    })
    expect(workspace.tabs[0]!.content).toBe('')
    expect(fake.query.execute).not.toHaveBeenCalled()
    expect(panel.isOpen).toBe(false)
    expect(isOpen()).toBe(false)
  })

  it('binds the tab to the live session of the connection when it still exists and is connected', async () => {
    const { workspace, connections } = await setup({ connected: true })

    await entryButton('entry-1').trigger('click')
    await flushPromises()

    expect(workspace.activeTab?.sessionId).toBe('s-pg')
    expect(connections.selectedId).toBe('pg1')
    expect(usePaletteStore(pinia).announcement).toBe(
      'Consulta reabierta en una pestaña nueva; no se ha ejecutado.',
    )
  })

  it('selects an existing but disconnected connection and says it must be connected', async () => {
    const { workspace, connections, palette } = await setup({ connected: false })

    await entryButton('entry-1').trigger('click')
    await flushPromises()

    expect(workspace.activeTab?.sessionId).toBeNull()
    expect(connections.selectedId).toBe('pg1')
    expect(palette.announcement).toContain('conéctala')
  })

  it('leaves the tab without connection when the profile no longer exists', async () => {
    const { workspace, palette } = await setup({
      connected: true,
      entries: [makeEntry(1, { profileId: 'deleted', profileName: 'Antigua' })],
    })

    await entryButton('entry-1').trigger('click')
    await flushPromises()

    expect(workspace.activeTab?.sessionId).toBeNull()
    expect(workspace.activeTab?.content).toBe('select 1 from users')
    expect(palette.announcement).toContain('ya no existe')
  })
})

describe('deleting an entry', () => {
  it('Delete removes the entry in main and moves the focus to the next one', async () => {
    await setup()
    entryButton('entry-1').element.focus()

    await press('entry-1', 'Delete')

    expect(fake.history.delete).toHaveBeenCalledWith({ id: 'entry-1' })
    expect(rowIds()).toEqual(['entry-2', 'entry-3'])
    expect(backend.entries()).toHaveLength(2)
    expect(document.activeElement).toBe(entryButton('entry-2').element)
    expect(status()).toBe('Consulta eliminada del historial')
  })

  it('Backspace also deletes, and the last row hands the focus to the previous one', async () => {
    await setup()
    entryButton('entry-3').element.focus()

    await press('entry-3', 'Backspace')

    expect(rowIds()).toEqual(['entry-1', 'entry-2'])
    expect(document.activeElement).toBe(entryButton('entry-2').element)
  })

  it('returns the focus to the search field when the last entry goes', async () => {
    await setup({ entries: makeEntries(1) })
    entryButton('entry-1').element.focus()

    await press('entry-1', 'Delete')

    expect(rows()).toHaveLength(0)
    expect(dialog().find('[data-state="empty"]').exists()).toBe(true)
    expect(document.activeElement).toBe(search().element)
  })

  it('also deletes with the row button, for pointer users, naming the query', async () => {
    await setup()
    const button = dialog().get('[data-entry-id="entry-2"] [data-action="delete-entry"]')
    expect(button.attributes('aria-label')).toBe('Borrar del historial: select 2 from users')

    await button.trigger('click')
    await flushPromises()

    expect(rowIds()).toEqual(['entry-1', 'entry-3'])
  })

  it('keeps the entry, the focus and announces the failure when main cannot delete it', async () => {
    await setup()
    entryButton('entry-2').element.focus()
    fake.history.delete.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    await press('entry-2', 'Delete')

    expect(rowIds()).toEqual(['entry-1', 'entry-2', 'entry-3'])
    expect(document.activeElement).toBe(entryButton('entry-2').element)
    expect(dialog().get('[data-part="action-error"]').text()).toContain(
      'Could not read the history',
    )
    expect(status()).toContain('No se pudo borrar')
  })

  it('does not send the same delete twice while it is in flight', async () => {
    await setup()
    let release!: () => void
    fake.history.delete.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(ipcOk({ deleted: 1 })))),
    )
    entryButton('entry-1').element.focus()

    await entryButton('entry-1').trigger('keydown', { key: 'Delete' })
    await entryButton('entry-1').trigger('keydown', { key: 'Delete' })
    release()
    await flushPromises()

    expect(fake.history.delete).toHaveBeenCalledTimes(1)
  })
})

describe('loading more', () => {
  it('offers "Cargar más" only while there is a next page and appends it', async () => {
    await setup({ entries: makeEntries(HISTORY_PAGE_SIZE + 5) })
    expect(rows()).toHaveLength(HISTORY_PAGE_SIZE)
    expect(status()).toContain('hay más por cargar')

    await dialog().get('[data-action="load-more"]').trigger('click')
    await flushPromises()

    expect(rows()).toHaveLength(HISTORY_PAGE_SIZE + 5)
    expect(dialog().find('[data-action="load-more"]').exists()).toBe(false)
    expect(status()).toContain('5 consultas más cargadas')
    expect(document.activeElement).toBe(entryButton(`entry-${HISTORY_PAGE_SIZE + 1}`).element)
  })

  it('keeps the list and shows an alert when a page fails, and the button retries', async () => {
    await setup({ entries: makeEntries(HISTORY_PAGE_SIZE + 5) })
    fake.history.list.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    await dialog().get('[data-action="load-more"]').trigger('click')
    await flushPromises()

    expect(rows()).toHaveLength(HISTORY_PAGE_SIZE)
    expect(dialog().get('[data-part="more-error"]').attributes('role')).toBe('alert')

    await dialog().get('[data-action="load-more"]').trigger('click')
    await flushPromises()
    expect(rows()).toHaveLength(HISTORY_PAGE_SIZE + 5)
    expect(dialog().find('[data-part="more-error"]').exists()).toBe(false)
  })
})

describe('clearing the whole history', () => {
  it('asks for confirmation and Cancel deletes nothing', async () => {
    await setup()
    await dialog().get('[data-action="clear-history"]').trigger('click')
    await flushPromises()
    expect(clearIsOpen()).toBe(true)

    await clearDialog().get('[data-action="cancel-clear-history"]').trigger('click')
    await flushPromises()

    expect(clearIsOpen()).toBe(false)
    expect(fake.history.clear).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(3)
  })

  it('confirming empties main and the list, and announces how many entries went', async () => {
    await setup()
    await dialog().get('[data-action="clear-history"]').trigger('click')
    await flushPromises()

    await clearDialog().get('[data-action="confirm-clear-history"]').trigger('click')
    await flushPromises()

    expect(fake.history.clear).toHaveBeenCalledTimes(1)
    expect(backend.entries()).toEqual([])
    expect(clearIsOpen()).toBe(false)
    expect(rows()).toHaveLength(0)
    expect(dialog().find('[data-state="empty"]').exists()).toBe(true)
    expect(status()).toBe('Historial vaciado: 3 consultas eliminadas')
    expect(isOpen()).toBe(true)
  })

  it('keeps the confirmation open with the error when main fails', async () => {
    await setup()
    await dialog().get('[data-action="clear-history"]').trigger('click')
    await flushPromises()
    fake.history.clear.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    await clearDialog().get('[data-action="confirm-clear-history"]').trigger('click')
    await flushPromises()

    expect(clearIsOpen()).toBe(true)
    expect(clearDialog().get('[data-part="clear-error"]').text()).toContain(
      'Could not read the history',
    )
    expect(rows()).toHaveLength(3)
  })
})

describe('preferences', () => {
  it('explains that the history is disabled, still lists the saved queries and opens the settings', async () => {
    const { settings } = await setup({ historyEnabled: false })
    const notice = dialog().get('[data-part="history-disabled"]')
    expect(notice.text()).toContain('El historial está desactivado')
    expect(rows()).toHaveLength(3)

    await notice.get('[data-action="open-history-settings"]').trigger('click')

    expect(settings.isOpen).toBe(true)
    expect(settings.section).toBe('history')
    expect(isOpen()).toBe(true)
  })

  it('does not show the notice while the history is enabled and reacts to turning it off', async () => {
    const { preferences } = await setup()
    expect(dialog().find('[data-part="history-disabled"]').exists()).toBe(false)

    await preferences.setHistoryEnabled(false)
    await flushPromises()

    expect(dialog().find('[data-part="history-disabled"]').exists()).toBe(true)
  })

  // Main purga al guardar la retención y solo emite `purged` si de verdad quitó algo (history-store).
  const savingRetention = (days: 7 | 30 | 90, purge: () => Promise<void>) =>
    fake.preferences.update.mockImplementationOnce(async () => {
      await purge()
      return ipcOk({
        history: { enabled: true, retentionDays: days },
        appearance: { theme: 'system' },
        execution: { timeoutSeconds: 30, maxRows: 10_000, confirmDestructive: true },
        ai: DEFAULT_PREFERENCES.ai,
      })
    })

  it('refreshes the open list through the purged event when a new retention purges entries', async () => {
    const { preferences } = await setup({
      entries: [makeEntry(1), makeEntry(2), makeEntry(400)],
    })
    fake.history.list.mockClear()
    savingRetention(7, async () => {
      await backend.delete({ id: 'entry-400' })
      fake.emitHistoryChange({ type: 'purged' })
    })
    expect(rows()).toHaveLength(3)

    await preferences.setHistoryRetentionDays(7)
    await flushPromises()

    expect(fake.history.list).toHaveBeenCalledTimes(1)
    expect(rowIds()).toEqual(['entry-1', 'entry-2'])
  })

  it('does not reload when a new retention purges nothing, because main emits no event then', async () => {
    const { preferences } = await setup()
    fake.history.list.mockClear()
    savingRetention(90, async () => undefined)

    await preferences.setHistoryRetentionDays(90)
    await flushPromises()

    expect(fake.history.list).not.toHaveBeenCalled()
    expect(rowIds()).toEqual(['entry-1', 'entry-2', 'entry-3'])
  })

  it('does not reload for other settings or for a retention that failed to save', async () => {
    const { preferences } = await setup()
    fake.history.list.mockClear()

    await preferences.setTheme('dark')
    await flushPromises()
    expect(fake.history.list).not.toHaveBeenCalled()

    fake.preferences.update.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))
    await preferences.setHistoryRetentionDays(90)
    await flushPromises()
    expect(fake.history.list).not.toHaveBeenCalled()
  })

  it('ignores a purge that main reports while the panel is closed', async () => {
    const { panel } = await setup()
    panel.close()
    await flushPromises()
    fake.history.list.mockClear()

    fake.emitHistoryChange({ type: 'purged' })
    await flushPromises()

    expect(fake.history.list).not.toHaveBeenCalled()
  })
})
