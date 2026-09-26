import type { ConnectionProfile, Session } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb, type FakeDbOptions } from '../testing/fake-db'
import ConnectionsSidebar from './ConnectionsSidebar.vue'

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

const session: Session = {
  sessionId: 's1',
  profileId: 'sq1',
  engine: 'sqlite',
  serverVersion: '3.46.0',
  readOnly: true,
  transaction: 'none',
}

let mounted: VueWrapper | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'db')
})

async function mountSidebar(options: FakeDbOptions = {}) {
  const fake = createFakeDb(options)
  installFakeDb(fake.db)
  const wrapper = mount(ConnectionsSidebar, {
    global: { plugins: [createPinia()] },
    attachTo: document.body,
  })
  mounted = wrapper
  await flushPromises()
  return { wrapper, ...fake }
}

const row = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-profile-id="${id}"]`)
const toggle = (wrapper: VueWrapper, id: string) =>
  row(wrapper, id).get('[data-action="toggle-connection"]')

describe('ConnectionsSidebar', () => {
  it('is a labelled region that shows a loading state and then the empty state', async () => {
    const fake = createFakeDb()
    installFakeDb(fake.db)
    const wrapper = mount(ConnectionsSidebar, {
      global: { plugins: [createPinia()] },
      attachTo: document.body,
    })
    mounted = wrapper
    expect(wrapper.text()).toContain('Cargando conexiones')
    await flushPromises()
    expect(wrapper.get('section').attributes('aria-labelledby')).toBeDefined()
    expect(wrapper.text()).toContain('Todavía no hay conexiones')
  })

  it('lists compact rows with the status as text and the read-only flag', async () => {
    const { wrapper } = await mountSidebar({ profiles: [postgres, sqlite] })
    expect(wrapper.findAll('li')).toHaveLength(2)
    expect(row(wrapper, 'pg1').text()).toContain('Desconectado')
    expect(row(wrapper, 'pg1').text()).toContain('PostgreSQL')
    expect(row(wrapper, 'sq1').text()).toContain('Solo lectura')
    expect(toggle(wrapper, 'pg1').text()).toBe('Conectar')
    expect(toggle(wrapper, 'pg1').attributes('aria-label')).toBe('Conectar Producción')
  })

  it('connects, shows «Conectado» and offers to disconnect', async () => {
    const { wrapper, connections } = await mountSidebar({
      profiles: [sqlite],
      connectResult: ipcOk(session),
    })
    await toggle(wrapper, 'sq1').trigger('click')
    await flushPromises()

    expect(connections.connect).toHaveBeenCalledWith({ profileId: 'sq1' })
    expect(row(wrapper, 'sq1').text()).toContain('Conectado')
    expect(toggle(wrapper, 'sq1').text()).toBe('Desconectar')

    await toggle(wrapper, 'sq1').trigger('click')
    await flushPromises()
    expect(connections.disconnect).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(row(wrapper, 'sq1').text()).toContain('Desconectado')
  })

  it('shows the connection error as an alert with text', async () => {
    const { wrapper } = await mountSidebar({ profiles: [sqlite] })
    await toggle(wrapper, 'sq1').trigger('click')
    await flushPromises()
    expect(row(wrapper, 'sq1').text()).toContain('Error')
    expect(row(wrapper, 'sq1').get('[role="alert"]').text()).toContain('No database driver')
  })

  it('selects a row on focus and keeps only that row in the tab order', async () => {
    const { wrapper } = await mountSidebar({ profiles: [postgres, sqlite] })
    expect(toggle(wrapper, 'pg1').attributes('tabindex')).toBe('0')
    expect(toggle(wrapper, 'sq1').attributes('tabindex')).toBe('-1')

    await row(wrapper, 'sq1').trigger('focusin')
    expect(row(wrapper, 'sq1').attributes('data-selected')).toBe('true')
    expect(toggle(wrapper, 'sq1').attributes('tabindex')).toBe('0')
    expect(toggle(wrapper, 'pg1').attributes('tabindex')).toBe('-1')
  })

  it('moves between rows with the arrow keys, Home and End', async () => {
    const { wrapper } = await mountSidebar({ profiles: [postgres, sqlite] })
    const first = toggle(wrapper, 'pg1')
    const second = toggle(wrapper, 'sq1')
    await first.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second.element)
    await second.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(first.element)
    await first.trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(second.element)
    await second.trigger('keydown', { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first.element)
  })

  it('opens the full connections view in a modal dialog to manage profiles', async () => {
    const { wrapper } = await mountSidebar({ profiles: [postgres] })
    const dialog = wrapper.findAll('dialog')[0]!
    expect((dialog.element as HTMLDialogElement).open).toBe(false)
    expect(wrapper.find('[data-action="new"]').exists()).toBe(false)

    await wrapper.get('[data-action="manage-connections"]').trigger('click')
    await flushPromises()

    expect((dialog.element as HTMLDialogElement).open).toBe(true)
    expect(dialog.attributes('aria-labelledby')).toBeDefined()
    expect(dialog.find('[data-action="new"]').exists()).toBe(true)
    expect(dialog.find('[data-action="edit"]').exists()).toBe(true)

    await dialog.get('[data-action="close-manage"]').trigger('click')
    await flushPromises()
    expect((dialog.element as HTMLDialogElement).open).toBe(false)
    expect(wrapper.find('[data-action="new"]').exists()).toBe(false)
  })

  it('does not reload the profiles when the manage view opens', async () => {
    const { wrapper, connections } = await mountSidebar({ profiles: [postgres] })
    await wrapper.get('[data-action="manage-connections"]').trigger('click')
    await flushPromises()
    expect(connections.list).toHaveBeenCalledTimes(1)
  })
})
