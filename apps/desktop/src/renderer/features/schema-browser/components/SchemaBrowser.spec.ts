import type { ConnectionProfile, NormalizedError, Session } from '@strata/contracts'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { useConnectionsStore } from '../../connections'
import { createFakeDb, installFakeDb, type FakeCatalog } from '../../connections/testing/fake-db'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import {
  POSTGRES_CATALOG,
  postgresSession,
  SQLITE_CATALOG,
  sqliteSession,
} from '../testing/catalog'
import { useSchemaCacheStore } from '../stores/schema-cache'
import SchemaBrowser from './SchemaBrowser.vue'

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
  readOnly: false,
  filePath: '/Users/me/data.db',
}

const TIMEOUT: NormalizedError = {
  code: 'timeout',
  message: 'The query timed out',
  retryable: true,
}

let mounted: VueWrapper | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'db')
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useRealTimers()
})

interface Setup {
  catalog?: FakeCatalog
  /** Sesiones abiertas; la primera se asocia a la pestaña. Vacío: pestaña sin sesión. */
  sessions?: { profile: ConnectionProfile; session: Session }[]
  tab?: boolean
}

async function mountBrowser({ catalog = POSTGRES_CATALOG, sessions, tab = true }: Setup = {}) {
  const open = sessions ?? [{ profile: postgres, session: postgresSession }]
  const fake = createFakeDb({ catalog })
  installFakeDb(fake.db)
  const pinia = createPinia()
  const connections = useConnectionsStore(pinia)
  const workspace = useWorkspaceStore(pinia)
  connections.profiles = open.map((entry) => entry.profile)
  for (const { profile, session } of open) {
    connections.runtimes[profile.id] = {
      status: 'connected',
      session,
      error: null,
      reconnecting: false,
    }
  }
  if (tab) workspace.createTab(open[0]?.session.sessionId ?? null)

  const wrapper = mount(SchemaBrowser, { global: { plugins: [pinia] }, attachTo: document.body })
  mounted = wrapper
  await flushPromises()
  return { wrapper, pinia, connectionsStore: connections, workspace, ...fake }
}

const item = (wrapper: VueWrapper, label: string): DOMWrapper<HTMLElement> => {
  const found = wrapper
    .findAll<HTMLElement>('[role="treeitem"]')
    .find((entry) => entry.get('.tree-row__name').text() === label)
  if (!found) throw new Error(`No tree item «${label}»`)
  return found
}
const labels = (wrapper: VueWrapper) =>
  wrapper.findAll('[role="treeitem"]').map((entry) =>
    Array.from(entry.get('.tree-row').element.children)
      .filter((part) => !part.classList.contains('tree-row__chevron'))
      .map((part) => part.textContent?.trim())
      .filter(Boolean)
      .join(' '),
  )
const focusedLabel = () =>
  (document.activeElement as HTMLElement | null)?.querySelector('.tree-row__name')?.textContent
async function pressOn(
  target: Pick<DOMWrapper<Element>, 'element' | 'trigger'>,
  init: KeyboardEventInit,
) {
  ;(target.element as HTMLElement).focus()
  await target.trigger('keydown', init)
  await flushPromises()
}

describe('without a session', () => {
  it('explains how to get started when there are no tabs', async () => {
    const { wrapper, cache } = await mountWithoutTabs()
    expect(wrapper.find('[role="tree"]').exists()).toBe(false)
    const state = wrapper.get('[data-state="no-session"]')
    expect(state.attributes('role')).toBe('status')
    expect(state.text()).toContain('Cmd/Ctrl+T')
    expect(cache).not.toHaveBeenCalled()
  })

  it('explains how to connect when the active tab has no session', async () => {
    const { wrapper, metadata } = await mountBrowser({ sessions: [], tab: true })
    expect(wrapper.get('[data-state="no-session"]').text()).toContain('«Conexiones»')
    expect(wrapper.find('input[type="search"]').exists()).toBe(false)
    expect(wrapper.get<HTMLButtonElement>('[data-action="refresh"]').element.disabled).toBe(true)
    expect(wrapper.get<HTMLButtonElement>('[data-action="insert"]').element.disabled).toBe(true)
    expect(metadata.listSchemas).not.toHaveBeenCalled()
  })

  async function mountWithoutTabs() {
    const result = await mountBrowser({ tab: false })
    return { ...result, cache: result.metadata.listSchemas }
  }
})

describe('tree structure and accessibility', () => {
  it('renders the schemas of the active tab session as a labelled ARIA tree', async () => {
    const { wrapper, metadata } = await mountBrowser()
    const tree = wrapper.get('[role="tree"]')
    expect(tree.attributes('aria-label')).toBe('Esquema de Producción')
    expect(tree.attributes('aria-describedby')).toBeDefined()
    expect(wrapper.get('[data-part="source"]').text()).toBe('Producción · PostgreSQL')

    const schemas = wrapper.findAll('[role="treeitem"]')
    expect(schemas.map((entry) => entry.attributes('aria-level'))).toEqual(['1', '1'])
    expect(schemas.map((entry) => entry.attributes('aria-posinset'))).toEqual(['1', '2'])
    expect(schemas.map((entry) => entry.attributes('aria-setsize'))).toEqual(['2', '2'])
    expect(schemas.map((entry) => entry.attributes('aria-expanded'))).toEqual(['false', 'false'])
    expect(metadata.listSchemas).toHaveBeenCalledWith({ sessionId: 's-pg' })
    expect(metadata.listTables).not.toHaveBeenCalled()
  })

  it('uses a roving tabindex: exactly one item is in the tab order', async () => {
    const { wrapper } = await mountBrowser()
    const stops = wrapper.findAll('[role="treeitem"][tabindex="0"]')
    expect(stops).toHaveLength(1)
    expect(stops[0]!.get('.tree-row__name').text()).toBe('public')
    expect(wrapper.findAll('[role="treeitem"][tabindex="-1"]')).toHaveLength(1)
  })

  it('nests children in role="group" with level, position and size', async () => {
    const { wrapper } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()

    const group = wrapper.get('[role="treeitem"][aria-expanded="true"] > [role="group"]')
    expect(
      group.findAll(':scope > [role="treeitem"]').map((entry) => entry.attributes('aria-level')),
    ).toEqual(['2', '2'])
    await item(wrapper, 'Tablas').trigger('click')
    expect(item(wrapper, 'Tablas').attributes('aria-expanded')).toBe('false')
    await item(wrapper, 'Tablas').trigger('click')

    const orders = item(wrapper, 'orders')
    expect(orders.attributes()).toMatchObject({
      'aria-level': '3',
      'aria-posinset': '2',
      'aria-setsize': '5',
      'aria-expanded': 'false',
    })
    expect(orders.get('[data-part="kind"]').text()).toBe('tabla')
    expect(item(wrapper, 'active_users').get('[data-part="kind"]').text()).toBe('vista')
    expect(item(wrapper, 'totals').get('[data-part="kind"]').text()).toBe('vista materializada')
    expect(item(wrapper, 'events').get('[data-part="kind"]').text()).toBe('particionada')
    expect(item(wrapper, 'remote_stats').get('[data-part="kind"]').text()).toBe('foránea')
  })
})

describe('lazy loading and cache', () => {
  it('requests tables when a schema is expanded and columns when a table is expanded', async () => {
    const { wrapper, metadata } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    expect(metadata.listTables).toHaveBeenCalledTimes(1)
    expect(metadata.listTables).toHaveBeenCalledWith({ sessionId: 's-pg', schema: 'public' })
    expect(metadata.describeTable).not.toHaveBeenCalled()

    await item(wrapper, 'orders').trigger('click')
    await flushPromises()
    expect(metadata.describeTable).toHaveBeenCalledWith({
      sessionId: 's-pg',
      table: { schema: 'public', name: 'orders' },
    })
    expect(labels(wrapper)).toEqual(
      expect.arrayContaining([
        'Columnas (2)',
        'id integer PK clave primaria NOT NULL',
        'user_id integer NOT NULL',
        'Claves foráneas (1)',
        'user_id → public.users (id)',
        'Índices (1)',
        'orders_user_idx (user_id, id)',
      ]),
    )
    expect(item(wrapper, 'id').get('[data-part="primary-key"]').text()).toBe('PK')
  })

  it('marks unique indexes and nullable columns', async () => {
    const { wrapper } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    await item(wrapper, 'users').trigger('click')
    await flushPromises()
    expect(item(wrapper, 'users_email_key').get('[data-part="unique"]').text()).toBe('única')
    expect(item(wrapper, 'Full Name').get('[data-part="nullable"]').text()).toBe('NULL')
    expect(item(wrapper, 'email').get('[data-part="nullable"]').text()).toBe('NOT NULL')
  })

  it('shows a loading status while a schema is loading', async () => {
    const { wrapper, metadata } = await mountBrowser()
    let release!: (value: ReturnType<typeof ipcOk<never[]>>) => void
    metadata.listTables.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    await item(wrapper, 'Sales').trigger('click')
    await flushPromises()

    const status = wrapper.get('[data-status="loading"]')
    expect(status.attributes('role')).toBe('status')
    expect(status.text()).toBe('Cargando tablas de Sales…')

    release(ipcOk([]))
    await flushPromises()
    expect(wrapper.get('[data-status="empty"]').text()).toBe('Sin tablas ni vistas')
  })

  it('serves collapse and re-expand from the cache without new requests', async () => {
    const { wrapper, metadata } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    await item(wrapper, 'public').trigger('click')
    expect(wrapper.findAll('[role="treeitem"]')).toHaveLength(2)
    await item(wrapper, 'public').trigger('click')
    await flushPromises()

    expect(item(wrapper, 'users').exists()).toBe(true)
    expect(metadata.listTables).toHaveBeenCalledTimes(1)
  })

  it('opens the only schema of a database by default', async () => {
    const { wrapper, metadata } = await mountBrowser({
      catalog: SQLITE_CATALOG,
      sessions: [{ profile: sqlite, session: sqliteSession }],
    })
    expect(item(wrapper, 'main').attributes('aria-expanded')).toBe('true')
    expect(metadata.listTables).toHaveBeenCalledWith({ sessionId: 's-sq', schema: 'main' })
    expect(item(wrapper, 'Customers').exists()).toBe(true)
    expect(item(wrapper, 'recent').get('[data-part="kind"]').text()).toBe('vista')
  })
})

describe('refresh', () => {
  it('reloads the known nodes from the button and announces it', async () => {
    const { wrapper, metadata } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    await item(wrapper, 'orders').trigger('click')
    await flushPromises()
    metadata.describeTable.mockClear()

    metadata.listTables.mockResolvedValueOnce(
      ipcOk([
        ...POSTGRES_CATALOG.tables['public']!,
        { schema: 'public', name: 'audit', kind: 'table' },
      ]),
    )
    await wrapper.get('[data-action="refresh"]').trigger('click')
    await flushPromises()

    expect(metadata.listSchemas).toHaveBeenCalledTimes(2)
    expect(metadata.describeTable).toHaveBeenCalledTimes(1)
    expect(item(wrapper, 'audit').exists()).toBe(true)
    expect(item(wrapper, 'orders').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-part="notice"]').text()).toBe('Esquema actualizado.')
  })

  it('F5 in the tree refreshes and is not swallowed by other shortcuts', async () => {
    const { wrapper, metadata } = await mountBrowser()
    const first = item(wrapper, 'public')
    ;(first.element as HTMLElement).focus()
    await first.trigger('keydown', { key: 'F5' })
    await flushPromises()
    expect(metadata.listSchemas).toHaveBeenCalledTimes(2)
    expect(focusedLabel()).toBe('public')
  })
})

describe('errors', () => {
  it('shows the safe error of a schema listing with a retry that recovers', async () => {
    const fake = createFakeDb({ catalog: POSTGRES_CATALOG })
    fake.metadata.listSchemas.mockResolvedValueOnce(ipcFail(TIMEOUT))
    installFakeDb(fake.db)
    const pinia = createPinia()
    const connections = useConnectionsStore(pinia)
    connections.profiles = [postgres]
    connections.runtimes['pg1'] = {
      status: 'connected',
      session: postgresSession,
      error: null,
      reconnecting: false,
    }
    useWorkspaceStore(pinia).createTab('s-pg')
    const wrapper = mount(SchemaBrowser, { global: { plugins: [pinia] }, attachTo: document.body })
    mounted = wrapper
    await flushPromises()

    const state = wrapper.get('[data-state="error"]')
    expect(state.attributes('role')).toBe('alert')
    expect(state.text()).toContain('The query timed out')
    expect(wrapper.find('[role="tree"]').exists()).toBe(false)

    await wrapper.get('[data-action="retry-schemas"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-state="error"]').exists()).toBe(false)
    expect(wrapper.find('[role="tree"]').exists()).toBe(true)
    expect(fake.metadata.listSchemas).toHaveBeenCalledTimes(2)
  })

  it('shows a failed table listing inside its schema and retries it from the button and from the keyboard', async () => {
    const { wrapper, metadata } = await mountBrowser()
    metadata.listTables
      .mockResolvedValueOnce(ipcFail(TIMEOUT))
      .mockResolvedValueOnce(ipcFail(TIMEOUT))
    await item(wrapper, 'public').trigger('click')
    await flushPromises()

    const row = wrapper.get('[data-kind="error"]')
    expect(row.get('[role="alert"]').text()).toBe('The query timed out')
    expect(row.get('[data-action="retry"]').attributes('tabindex')).toBe('-1')

    await row.get('[data-action="retry"]').trigger('click')
    await flushPromises()
    expect(metadata.listTables).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-kind="error"]').exists()).toBe(true)

    await pressOn(wrapper.get('[data-kind="error"]'), { key: 'Enter' })
    expect(metadata.listTables).toHaveBeenCalledTimes(3)
    expect(item(wrapper, 'users').exists()).toBe(true)
    expect(wrapper.find('[data-kind="error"]').exists()).toBe(false)
  })

  it('shows a failed description in its table', async () => {
    const { wrapper, metadata } = await mountBrowser()
    metadata.describeTable.mockResolvedValueOnce(ipcFail({ ...TIMEOUT, message: 'No permission' }))
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    await item(wrapper, 'users').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-kind="error"]').text()).toContain('No permission')
    expect(wrapper.get('[data-part="notice"]').text()).toContain('No se pudo cargar users')
  })
})

describe('sessions', () => {
  it('drops the cache and shows the empty state when the session closes', async () => {
    const { wrapper, connectionsStore, workspace, pinia } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    expect(Object.keys(useSchemaCacheStore(pinia).sessions)).toEqual(['s-pg'])

    connectionsStore.runtimes['pg1'] = {
      status: 'disconnected',
      session: null,
      error: null,
      reconnecting: false,
    }
    workspace.detachClosedSessions(new Set())
    await flushPromises()

    expect(wrapper.find('[role="tree"]').exists()).toBe(false)
    expect(wrapper.find('[data-state="no-session"]').exists()).toBe(true)
    expect(JSON.stringify(useSchemaCacheStore(pinia).sessions)).toBe('{}')
  })

  it('shows the tree of the session of the active tab and recomputes when switching tabs', async () => {
    const { wrapper, workspace, metadata } = await mountBrowser({
      sessions: [
        { profile: postgres, session: postgresSession },
        { profile: sqlite, session: sqliteSession },
      ],
    })
    metadata.listSchemas.mockImplementation(async ({ sessionId }) =>
      ipcOk(
        (sessionId === 's-sq' ? SQLITE_CATALOG : POSTGRES_CATALOG).schemas.map((name) => ({
          name,
        })),
      ),
    )
    metadata.listTables.mockImplementation(async ({ sessionId, schema }) =>
      ipcOk((sessionId === 's-sq' ? SQLITE_CATALOG : POSTGRES_CATALOG).tables[schema ?? ''] ?? []),
    )
    workspace.createTab('s-sq')
    await flushPromises()

    expect(wrapper.get('[data-part="source"]').text()).toBe('Local · SQLite')
    expect(item(wrapper, 'Customers').exists()).toBe(true)

    workspace.activateAt(0)
    await flushPromises()
    expect(wrapper.get('[data-part="source"]').text()).toBe('Producción · PostgreSQL')
    expect(item(wrapper, 'public').exists()).toBe(true)
    expect(metadata.listSchemas).toHaveBeenCalledTimes(2)

    workspace.activateAt(1)
    await flushPromises()
    expect(metadata.listSchemas).toHaveBeenCalledTimes(2)
    expect(item(wrapper, 'Customers').exists()).toBe(true)
  })
})

describe('insert into the editor', () => {
  it('Shift+Enter inserts the qualified table name with minimal quoting', async () => {
    const { wrapper, workspace } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    await pressOn(item(wrapper, 'orders'), { key: 'Enter', shiftKey: true })
    await pressOn(item(wrapper, 'user'), { key: 'Enter', shiftKey: true })
    await pressOn(item(wrapper, 'Sales'), { key: 'Enter', shiftKey: true })
    expect(workspace.takeInserts('tab-1')).toEqual(['public.orders', 'public."user"', '"Sales"'])
  })

  it('inserts a column name, a foreign key target, and nothing for structural nodes', async () => {
    const { wrapper, workspace } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    await item(wrapper, 'orders').trigger('click')
    await flushPromises()

    await pressOn(item(wrapper, 'user_id'), { key: 'Enter', shiftKey: true })
    await pressOn(wrapper.get('[data-kind="foreign-key"]'), {
      key: 'Enter',
      shiftKey: true,
    })
    await pressOn(item(wrapper, 'Columnas'), { key: 'Enter', shiftKey: true })
    await pressOn(item(wrapper, 'orders_user_idx'), { key: 'Enter', shiftKey: true })
    expect(workspace.takeInserts('tab-1')).toEqual(['user_id', 'public.users'])
  })

  it('double click inserts without toggling the node', async () => {
    const { wrapper, workspace } = await mountBrowser()
    await item(wrapper, 'Sales').trigger('click', { detail: 1 })
    await flushPromises()
    await item(wrapper, 'Invoice Lines').trigger('click', { detail: 1 })
    await item(wrapper, 'Invoice Lines').trigger('click', { detail: 2 })
    await item(wrapper, 'Invoice Lines').trigger('dblclick')
    await flushPromises()

    expect(workspace.takeInserts('tab-1')).toEqual(['"Sales"."Invoice Lines"'])
    expect(item(wrapper, 'Invoice Lines').attributes('aria-expanded')).toBe('true')
  })

  it('the toolbar button inserts the selected node and is disabled when there is nothing to insert', async () => {
    const { wrapper, workspace } = await mountBrowser()
    const button = wrapper.get<HTMLButtonElement>('[data-action="insert"]')
    expect(button.element.disabled).toBe(false)
    await item(wrapper, 'public').trigger('click')
    await flushPromises()

    await item(wrapper, 'Tablas').trigger('click')
    expect(button.element.disabled).toBe(true)

    await item(wrapper, 'Tablas').trigger('click')
    await item(wrapper, 'events').trigger('click')
    await flushPromises()
    expect(button.element.disabled).toBe(false)
    await button.trigger('click')
    expect(workspace.takeInserts('tab-1')).toEqual(['public.events'])
  })

  it('uses sqlite rules: no schema for main, quotes only when needed', async () => {
    const { wrapper, workspace } = await mountBrowser({
      catalog: SQLITE_CATALOG,
      sessions: [{ profile: sqlite, session: sqliteSession }],
    })
    await pressOn(item(wrapper, 'Customers'), { key: 'Enter', shiftKey: true })
    await pressOn(item(wrapper, 'order items'), { key: 'Enter', shiftKey: true })
    expect(workspace.takeInserts('tab-1')).toEqual(['Customers', '"order items"'])
  })

  it('Enter inserts a column but toggles a table', async () => {
    const { wrapper, workspace } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    await pressOn(item(wrapper, 'users'), { key: 'Enter' })
    expect(item(wrapper, 'users').attributes('aria-expanded')).toBe('true')
    expect(workspace.takeInserts('tab-1')).toEqual([])

    await pressOn(item(wrapper, 'email'), { key: 'Enter' })
    expect(workspace.takeInserts('tab-1')).toEqual(['email'])
  })
})

describe('keyboard', () => {
  async function expandedTree() {
    const context = await mountBrowser()
    await item(context.wrapper, 'public').trigger('click')
    await flushPromises()
    return context
  }

  it('Arrow Up/Down, Home and End move through the visible items', async () => {
    const { wrapper } = await expandedTree()
    await pressOn(item(wrapper, 'public'), { key: 'ArrowDown' })
    expect(focusedLabel()).toBe('Tablas')
    await pressOn(item(wrapper, 'Tablas'), { key: 'ArrowDown' })
    expect(focusedLabel()).toBe('users')
    await pressOn(item(wrapper, 'users'), { key: 'ArrowUp' })
    expect(focusedLabel()).toBe('Tablas')
    await pressOn(item(wrapper, 'Tablas'), { key: 'End' })
    expect(focusedLabel()).toBe('Sales')
    await pressOn(item(wrapper, 'Sales'), { key: 'ArrowDown' })
    expect(focusedLabel()).toBe('Sales')
    await pressOn(item(wrapper, 'Sales'), { key: 'Home' })
    expect(focusedLabel()).toBe('public')
  })

  it('Arrow Right expands, then enters the first child; Arrow Left collapses, then goes to the parent', async () => {
    const { wrapper, metadata } = await mountBrowser()
    await pressOn(item(wrapper, 'public'), { key: 'ArrowRight' })
    expect(item(wrapper, 'public').attributes('aria-expanded')).toBe('true')
    expect(metadata.listTables).toHaveBeenCalledTimes(1)
    expect(focusedLabel()).toBe('public')

    await pressOn(item(wrapper, 'public'), { key: 'ArrowRight' })
    expect(focusedLabel()).toBe('Tablas')
    await pressOn(item(wrapper, 'Tablas'), { key: 'ArrowRight' })
    await pressOn(item(wrapper, 'Tablas'), { key: 'ArrowRight' })
    expect(focusedLabel()).toBe('users')
    await pressOn(item(wrapper, 'users'), { key: 'ArrowRight' })
    await pressOn(item(wrapper, 'users'), { key: 'ArrowRight' })
    expect(focusedLabel()).toBe('Columnas')

    await pressOn(item(wrapper, 'Columnas'), { key: 'ArrowLeft' })
    expect(item(wrapper, 'Columnas').attributes('aria-expanded')).toBe('false')
    await pressOn(item(wrapper, 'Columnas'), { key: 'ArrowLeft' })
    expect(focusedLabel()).toBe('users')
    await pressOn(item(wrapper, 'users'), { key: 'ArrowLeft' })
    await pressOn(item(wrapper, 'users'), { key: 'ArrowLeft' })
    expect(focusedLabel()).toBe('Tablas')
    await pressOn(item(wrapper, 'Tablas'), { key: 'ArrowLeft' })
    await pressOn(item(wrapper, 'Tablas'), { key: 'ArrowLeft' })
    expect(focusedLabel()).toBe('public')
  })

  it('Arrow Right does nothing on a leaf and Arrow Left on a root', async () => {
    const { wrapper } = await expandedTree()
    await item(wrapper, 'users').trigger('click')
    await flushPromises()
    await pressOn(item(wrapper, 'email'), { key: 'ArrowRight' })
    expect(focusedLabel()).toBe('email')
    await pressOn(item(wrapper, 'public'), { key: 'ArrowLeft' })
    await pressOn(item(wrapper, 'public'), { key: 'ArrowLeft' })
    expect(focusedLabel()).toBe('public')
  })

  it('Enter toggles a node and Space acts like Enter', async () => {
    const { wrapper } = await mountBrowser()
    await pressOn(item(wrapper, 'Sales'), { key: 'Enter' })
    expect(item(wrapper, 'Sales').attributes('aria-expanded')).toBe('true')
    await pressOn(item(wrapper, 'Sales'), { key: ' ' })
    expect(item(wrapper, 'Sales').attributes('aria-expanded')).toBe('false')
  })

  it('typing jumps to the next item that starts with the text', async () => {
    const { wrapper } = await expandedTree()
    vi.useFakeTimers()
    await pressOn(item(wrapper, 'public'), { key: 'o' })
    expect(focusedLabel()).toBe('orders')
    vi.advanceTimersByTime(1_000)
    await pressOn(item(wrapper, 'orders'), { key: 'S', shiftKey: true })
    expect(focusedLabel()).toBe('Sales')
  })

  it('moves the tab stop with the focus and tracks the selected item', async () => {
    const { wrapper } = await expandedTree()
    await pressOn(item(wrapper, 'public'), { key: 'ArrowDown' })
    expect(wrapper.findAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1)
    expect(item(wrapper, 'Tablas').attributes('tabindex')).toBe('0')
    expect(item(wrapper, 'Tablas').attributes('aria-selected')).toBe('true')
    expect(item(wrapper, 'public').attributes('aria-selected')).toBe('false')
  })

  it('does not swallow global shortcuts with Cmd, Ctrl or Alt', async () => {
    const { wrapper } = await expandedTree()
    const target = item(wrapper, 'public')
    ;(target.element as HTMLElement).focus()
    for (const init of [
      { key: 't', metaKey: true },
      { key: 'w', ctrlKey: true },
      { key: 'p', metaKey: true },
      { key: 'l', metaKey: true },
      { key: 'k', metaKey: true },
      { key: 'r', metaKey: true },
      { key: 'ArrowDown', altKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      target.element.dispatchEvent(event)
      expect(event.defaultPrevented, init.key).toBe(false)
    }
    expect(focusedLabel()).toBe('public')
  })

  it('ignores keys pressed on the retry button so that Enter does not act twice', async () => {
    const { wrapper, metadata } = await mountBrowser()
    metadata.listTables.mockResolvedValueOnce(ipcFail(TIMEOUT))
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    await wrapper.get('[data-action="retry"]').trigger('keydown', { key: 'Enter' })
    expect(metadata.listTables).toHaveBeenCalledTimes(1)
  })
})

describe('filter', () => {
  it('narrows the tree, loads every table list and announces the result count', async () => {
    vi.useFakeTimers()
    const { wrapper, metadata } = await mountBrowser()
    const input = wrapper.get<HTMLInputElement>('input[type="search"]')
    expect(wrapper.get('label').text()).toBe('Filtrar tablas y vistas')

    await input.setValue('USER')
    await flushPromises()
    expect(metadata.listTables).toHaveBeenCalledTimes(2)
    expect(labels(wrapper).filter((entry) => !/^(Tablas|Vistas)/.test(entry))).toEqual([
      'public',
      'users tabla',
      'user tabla',
      'active_users vista',
    ])

    expect(wrapper.get('[data-part="matches"]').text()).toBe('')
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.get('[data-part="matches"]').text()).toBe('3 resultados.')
    expect(wrapper.get('[data-part="matches"]').attributes('aria-live')).toBe('polite')

    await input.setValue('sales')
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.get('[data-part="matches"]').text()).toBe('1 resultado.')
    expect(labels(wrapper)).toEqual(['Sales', 'Tablas (1)', 'Invoice Lines tabla'])
  })

  it('announces when nothing matches and restores the tree when cleared', async () => {
    vi.useFakeTimers()
    const { wrapper } = await mountBrowser()
    const input = wrapper.get<HTMLInputElement>('input[type="search"]')
    await input.setValue('zzz')
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.get('[data-state="no-results"]').text()).toContain('«zzz»')
    expect(wrapper.get('[data-part="matches"]').text()).toBe('Sin resultados para «zzz».')
    expect(wrapper.find('[role="tree"]').exists()).toBe(false)

    await input.setValue('')
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.get('[data-part="matches"]').text()).toBe('')
    expect(labels(wrapper)).toEqual(['public', 'Sales'])
  })

  it('is reachable by keyboard: Cmd+F from the tree, Arrow Down or Enter back, Escape clears', async () => {
    const { wrapper } = await mountBrowser()
    const first = item(wrapper, 'public')
    ;(first.element as HTMLElement).focus()
    const find = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    first.element.dispatchEvent(find)
    expect(find.defaultPrevented).toBe(true)
    const input = wrapper.get<HTMLInputElement>('input[type="search"]')
    expect(document.activeElement).toBe(input.element)

    await input.setValue('sales')
    await flushPromises()
    await input.trigger('keydown', { key: 'Escape' })
    expect(input.element.value).toBe('')
    expect(document.activeElement).toBe(input.element)

    await input.trigger('keydown', { key: 'Escape' })
    expect(focusedLabel()).toBe('public')

    input.element.focus()
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(focusedLabel()).toBe('public')
  })

  it('resets when the session changes', async () => {
    const { wrapper, workspace } = await mountBrowser({
      sessions: [
        { profile: postgres, session: postgresSession },
        { profile: sqlite, session: sqliteSession },
      ],
    })
    await wrapper.get('input[type="search"]').setValue('abc')
    workspace.createTab('s-sq')
    await flushPromises()
    expect(wrapper.get<HTMLInputElement>('input[type="search"]').element.value).toBe('')
  })
})

describe('state hygiene', () => {
  it('keeps no secrets or query results in the serialised Pinia state', async () => {
    const { wrapper, pinia } = await mountBrowser()
    await item(wrapper, 'public').trigger('click')
    await flushPromises()
    await item(wrapper, 'users').trigger('click')
    await flushPromises()

    const state = (pinia as Pinia).state.value
    expect(Object.keys(state).sort()).toEqual(['connections', 'schemaCache', 'workspace'])
    const serialised = JSON.stringify(state['schemaCache'])
    expect(serialised).toContain('users_email_key')
    expect(serialised).not.toMatch(/password|secret|host|"rows"|"results"/i)
  })
})
