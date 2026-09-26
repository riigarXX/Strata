import type { ConnectionProfile, Session } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import {
  createFakeDb,
  installFakeDb,
  NO_ADAPTER_ERROR,
  type FakeDbOptions,
} from '../testing/fake-db'
import ConnectionsView from './ConnectionsView.vue'

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

async function mountView(options: FakeDbOptions = {}) {
  const fake = createFakeDb(options)
  installFakeDb(fake.db)
  const pinia = createPinia()
  const wrapper = mount(ConnectionsView, { global: { plugins: [pinia] }, attachTo: document.body })
  mounted = wrapper
  await flushPromises()
  return { wrapper, pinia, ...fake }
}

type Wrapper = VueWrapper

const formDialog = (wrapper: Wrapper) => wrapper.findAll('dialog')[0]!
const confirmDialog = (wrapper: Wrapper) => wrapper.findAll('dialog')[1]!
const isOpen = (dialog: ReturnType<typeof formDialog>) => (dialog.element as HTMLDialogElement).open
const field = (wrapper: Wrapper, name: string) =>
  formDialog(wrapper).get<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)
const action = (wrapper: Wrapper, name: string) => wrapper.get(`[data-action="${name}"]`)
const item = (wrapper: Wrapper, id: string) => wrapper.get(`[data-profile-id="${id}"]`)

async function openNewForm(wrapper: Wrapper) {
  const button = action(wrapper, 'new')
  ;(button.element as HTMLElement).focus()
  await button.trigger('click')
  await flushPromises()
}

async function fillPostgres(wrapper: Wrapper, password = '') {
  await field(wrapper, 'name').setValue('  Mi servidor ')
  await field(wrapper, 'host').setValue('localhost')
  await field(wrapper, 'port').setValue('5433')
  await field(wrapper, 'user').setValue('me')
  await field(wrapper, 'database').setValue('app')
  await field(wrapper, 'ssl').setValue('verify-full')
  if (password) await field(wrapper, 'password').setValue(password)
}

describe('ConnectionsView', () => {
  it('shows a loading state, then the empty state without profiles', async () => {
    const fake = createFakeDb()
    installFakeDb(fake.db)
    const wrapper = mount(ConnectionsView, {
      global: { plugins: [createPinia()] },
      attachTo: document.body,
    })
    mounted = wrapper

    expect(wrapper.text()).toContain('Cargando conexiones')
    await flushPromises()

    expect(wrapper.text()).toContain('Todavía no hay conexiones')
    expect(wrapper.find('ul').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Cargando conexiones')
  })

  it('shows the load error with a retry action', async () => {
    const fake = createFakeDb()
    fake.connections.list.mockResolvedValueOnce(ipcFail(NO_ADAPTER_ERROR))
    installFakeDb(fake.db)
    const wrapper = mount(ConnectionsView, {
      global: { plugins: [createPinia()] },
      attachTo: document.body,
    })
    mounted = wrapper
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain(NO_ADAPTER_ERROR.message)

    await action(wrapper, 'retry').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Todavía no hay conexiones')
  })

  it('lists profiles with the status communicated as text', async () => {
    const { wrapper } = await mountView({ profiles: [postgres, sqlite] })

    expect(wrapper.findAll('li')).toHaveLength(2)
    expect(item(wrapper, 'pg1').text()).toContain('Desconectado')
    expect(item(wrapper, 'pg1').text()).toContain('PostgreSQL')
    expect(item(wrapper, 'sq1').text()).toContain('Solo lectura')
  })

  describe('create', () => {
    it('creates a PostgreSQL profile, sends the password once and clears the form', async () => {
      const { wrapper, connections } = await mountView()
      await openNewForm(wrapper)
      expect(isOpen(formDialog(wrapper))).toBe(true)
      expect(field(wrapper, 'password').attributes('type')).toBe('password')
      expect(field(wrapper, 'password').attributes('autocomplete')).toBe('off')

      await fillPostgres(wrapper, 'hunter2-secret')
      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(connections.create).toHaveBeenCalledWith({
        engine: 'postgres',
        name: 'Mi servidor',
        readOnly: false,
        host: 'localhost',
        port: 5433,
        user: 'me',
        database: 'app',
        ssl: 'verify-full',
        password: 'hunter2-secret',
      })
      expect(isOpen(formDialog(wrapper))).toBe(false)
      expect(wrapper.findAll('li')).toHaveLength(1)
      expect(wrapper.get('[role="status"][aria-live]').text()).toContain('Mi servidor')

      await openNewForm(wrapper)
      expect((field(wrapper, 'password').element as HTMLInputElement).value).toBe('')
    })

    it('creates a SQLite profile only through the file picker', async () => {
      const { wrapper, connections } = await mountView({ pickedPath: '/Users/me/notes.sqlite' })
      await openNewForm(wrapper)
      await field(wrapper, 'name').setValue('Notas')
      await field(wrapper, 'engine').setValue('sqlite')

      const path = field(wrapper, 'filePath')
      expect(path.attributes('readonly')).toBeDefined()
      expect(wrapper.find('[name="password"]').exists()).toBe(false)

      await action(wrapper, 'pick-file').trigger('click')
      await flushPromises()
      expect((path.element as HTMLInputElement).value).toBe('/Users/me/notes.sqlite')

      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(connections.pickSqliteFile).toHaveBeenCalledTimes(1)
      expect(connections.create).toHaveBeenCalledWith({
        engine: 'sqlite',
        name: 'Notas',
        readOnly: false,
        filePath: '/Users/me/notes.sqlite',
      })
      expect(wrapper.findAll('li')).toHaveLength(1)
    })

    it('keeps the path empty when the picker is cancelled and blocks saving', async () => {
      const { wrapper, connections } = await mountView({ pickedPath: null })
      await openNewForm(wrapper)
      await field(wrapper, 'name').setValue('Notas')
      await field(wrapper, 'engine').setValue('sqlite')

      await action(wrapper, 'pick-file').trigger('click')
      await flushPromises()
      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(connections.create).not.toHaveBeenCalled()
      expect(field(wrapper, 'filePath').attributes('aria-invalid')).toBe('true')
    })

    it('validates fields with accessible per-field errors and focuses the first one', async () => {
      const { wrapper, connections } = await mountView()
      await openNewForm(wrapper)
      await field(wrapper, 'host').setValue('bad host/')
      await field(wrapper, 'port').setValue('70000')

      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(connections.create).not.toHaveBeenCalled()
      for (const name of ['name', 'host', 'port', 'user', 'database']) {
        const input = field(wrapper, name)
        expect(input.attributes('aria-invalid')).toBe('true')
        const errorId = input.attributes('aria-describedby')!
        expect(wrapper.get(`[id="${errorId}"]`).text().length).toBeGreaterThan(0)
      }
      expect(document.activeElement).toBe(field(wrapper, 'name').element)
      expect(field(wrapper, 'ssl').attributes('aria-invalid')).toBeUndefined()
    })

    it('shows main errors on save, keeps the dialog open and drops the typed password', async () => {
      const { wrapper, connections } = await mountView()
      connections.create.mockResolvedValueOnce(ipcFail(NO_ADAPTER_ERROR))
      await openNewForm(wrapper)
      await fillPostgres(wrapper, 'hunter2-secret')

      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(isOpen(formDialog(wrapper))).toBe(true)
      expect(formDialog(wrapper).get('[role="alert"]').text()).toContain(NO_ADAPTER_ERROR.message)
      expect((field(wrapper, 'password').element as HTMLInputElement).value).toBe('')
    })
  })

  describe('test connection', () => {
    it('shows success with the server version and does not save', async () => {
      const { wrapper, connections } = await mountView()
      await openNewForm(wrapper)
      await fillPostgres(wrapper, 'pw')

      await action(wrapper, 'test').trigger('click')
      await flushPromises()

      const result = formDialog(wrapper).get('[data-result="ok"]')
      expect(result.text()).toContain('PostgreSQL 16.2')
      expect(connections.create).not.toHaveBeenCalled()
      expect(connections.test).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw' }))
      expect((field(wrapper, 'password').element as HTMLInputElement).value).toBe('pw')
    })

    it('shows the safe error when the test fails and clears it after editing', async () => {
      const { wrapper, connections } = await mountView()
      connections.test.mockResolvedValueOnce(
        ipcOk({
          ok: false,
          error: {
            code: 'authentication_failed',
            message: 'Authentication failed',
            retryable: false,
          },
        }),
      )
      await openNewForm(wrapper)
      await fillPostgres(wrapper)

      await action(wrapper, 'test').trigger('click')
      await flushPromises()

      const failure = formDialog(wrapper).get('[data-result="failed"]')
      expect(failure.attributes('role')).toBe('alert')
      expect(failure.text()).toContain('Authentication failed')

      await field(wrapper, 'host').setValue('other')
      expect(formDialog(wrapper).find('[data-result]').exists()).toBe(false)
    })

    it('does not call main when the draft is invalid', async () => {
      const { wrapper, connections } = await mountView()
      await openNewForm(wrapper)

      await action(wrapper, 'test').trigger('click')
      await flushPromises()

      expect(connections.test).not.toHaveBeenCalled()
      expect(field(wrapper, 'name').attributes('aria-invalid')).toBe('true')
    })

    it('tests a saved profile from the list without sending a password', async () => {
      const { wrapper, connections } = await mountView({ profiles: [postgres] })

      await item(wrapper, 'pg1').get('[data-action="test"]').trigger('click')
      await flushPromises()

      expect(connections.test.mock.calls[0]?.[0]).not.toHaveProperty('password')
      expect(item(wrapper, 'pg1').get('[data-result="ok"]').text()).toContain('PostgreSQL 16.2')
    })
  })

  describe('connect and disconnect', () => {
    it('shows the normalized "no adapter" error gracefully and allows retrying', async () => {
      const { wrapper, connections } = await mountView({ profiles: [sqlite] })

      await item(wrapper, 'sq1').get('[data-action="toggle-connection"]').trigger('click')
      await flushPromises()

      const row = item(wrapper, 'sq1')
      expect(row.attributes('data-status')).toBe('error')
      expect(row.get('.connection-status').text()).toContain('Error')
      expect(row.get('[role="alert"]').text()).toContain(NO_ADAPTER_ERROR.message)
      expect(row.get('[data-action="toggle-connection"]').text()).toBe('Conectar')

      await row.get('[data-action="toggle-connection"]').trigger('click')
      await flushPromises()
      expect(connections.connect).toHaveBeenCalledTimes(2)
    })

    it('connects, announces it and disconnects', async () => {
      const { wrapper, connections } = await mountView({
        profiles: [sqlite],
        connectResult: ipcOk(session),
      })

      await item(wrapper, 'sq1').get('[data-action="toggle-connection"]').trigger('click')
      await flushPromises()

      const row = item(wrapper, 'sq1')
      expect(row.get('.connection-status').text()).toContain('Conectado')
      expect(wrapper.get('[role="status"][aria-live]').text()).toContain('Conectado a «Local»')
      expect(row.find('[data-action="reconnect"]').exists()).toBe(true)

      await row.get('[data-action="toggle-connection"]').trigger('click')
      await flushPromises()

      expect(connections.disconnect).toHaveBeenCalledWith({ sessionId: 's1' })
      expect(row.get('.connection-status').text()).toContain('Desconectado')
    })

    it('reconnects an open session', async () => {
      const { wrapper, connections } = await mountView({
        profiles: [sqlite],
        connectResult: ipcOk(session),
      })
      await item(wrapper, 'sq1').get('[data-action="toggle-connection"]').trigger('click')
      await flushPromises()

      await item(wrapper, 'sq1').get('[data-action="reconnect"]').trigger('click')
      await flushPromises()

      expect(connections.disconnect).toHaveBeenCalledTimes(1)
      expect(connections.connect).toHaveBeenCalledTimes(2)
      expect(item(wrapper, 'sq1').attributes('data-status')).toBe('connected')
    })
  })

  describe('edit', () => {
    it('prefills the form and keeps the stored password when only the name changes', async () => {
      const { wrapper, connections } = await mountView({ profiles: [postgres] })
      await item(wrapper, 'pg1').get('[data-action="edit"]').trigger('click')
      await flushPromises()

      expect((field(wrapper, 'host').element as HTMLInputElement).value).toBe('db.example.com')
      expect((field(wrapper, 'password').element as HTMLInputElement).value).toBe('')
      expect(formDialog(wrapper).text()).toContain('conservar la contraseña guardada')

      await field(wrapper, 'name').setValue('Prod renombrada')
      await wrapper.get('form').trigger('submit')
      await flushPromises()

      const request = connections.update.mock.calls[0]?.[0]
      expect(request).toMatchObject({ id: 'pg1', name: 'Prod renombrada' })
      expect(request).not.toHaveProperty('password')
      expect(item(wrapper, 'pg1').text()).toContain('Prod renombrada')
    })

    it('asks for the password again when host, port or user change', async () => {
      const { wrapper, connections } = await mountView({ profiles: [postgres] })
      await item(wrapper, 'pg1').get('[data-action="edit"]').trigger('click')
      await flushPromises()

      await field(wrapper, 'host').setValue('other.example.com')
      expect(formDialog(wrapper).text()).toContain('vuelve a escribir la contraseña')

      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(connections.update).not.toHaveBeenCalled()
      expect(field(wrapper, 'password').attributes('aria-invalid')).toBe('true')
      expect(document.activeElement).toBe(field(wrapper, 'password').element)

      await field(wrapper, 'password').setValue('new-secret')
      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(connections.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pg1', host: 'other.example.com', password: 'new-secret' }),
      )
      expect(isOpen(formDialog(wrapper))).toBe(false)
    })

    it('resets the connection state when the edit affects an open session', async () => {
      const { wrapper } = await mountView({ profiles: [sqlite], connectResult: ipcOk(session) })
      await item(wrapper, 'sq1').get('[data-action="toggle-connection"]').trigger('click')
      await flushPromises()

      await item(wrapper, 'sq1').get('[data-action="edit"]').trigger('click')
      await flushPromises()
      await field(wrapper, 'readOnly').setValue(false)
      await wrapper.get('form').trigger('submit')
      await flushPromises()

      expect(item(wrapper, 'sq1').attributes('data-status')).toBe('disconnected')
    })
  })

  describe('delete', () => {
    it('asks for confirmation, warns about the saved secret and deletes', async () => {
      const { wrapper, connections } = await mountView({ profiles: [postgres] })
      const trigger = item(wrapper, 'pg1').get('[data-action="delete"]')
      ;(trigger.element as HTMLElement).focus()
      await trigger.trigger('click')
      await flushPromises()

      const dialog = confirmDialog(wrapper)
      expect(isOpen(dialog)).toBe(true)
      expect(dialog.text()).toContain('Producción')
      expect(dialog.get('[data-notice="secret"]').text()).toContain('contraseña guardada')
      expect(connections.delete).not.toHaveBeenCalled()

      await dialog.get('[data-action="confirm-delete"]').trigger('click')
      await flushPromises()

      expect(connections.delete).toHaveBeenCalledWith({ profileId: 'pg1' })
      expect(isOpen(dialog)).toBe(false)
      expect(wrapper.text()).toContain('Todavía no hay conexiones')
      expect(document.activeElement).toBe(action(wrapper, 'new').element)
    })

    it('does not delete when cancelled and returns focus to the trigger', async () => {
      const { wrapper, connections } = await mountView({ profiles: [postgres] })
      const trigger = item(wrapper, 'pg1').get('[data-action="delete"]')
      ;(trigger.element as HTMLElement).focus()
      await trigger.trigger('click')
      await flushPromises()

      await confirmDialog(wrapper).get('[data-action="cancel"]').trigger('click')
      await flushPromises()

      expect(connections.delete).not.toHaveBeenCalled()
      expect(isOpen(confirmDialog(wrapper))).toBe(false)
      expect(wrapper.findAll('li')).toHaveLength(1)
      expect(document.activeElement).toBe(trigger.element)
    })

    it('omits the secret warning for profiles without a saved password and shows main errors', async () => {
      const { wrapper, connections } = await mountView({ profiles: [sqlite] })
      connections.delete.mockResolvedValueOnce(ipcFail(NO_ADAPTER_ERROR))
      await item(wrapper, 'sq1').get('[data-action="delete"]').trigger('click')
      await flushPromises()

      const dialog = confirmDialog(wrapper)
      expect(dialog.find('[data-notice="secret"]').exists()).toBe(false)

      await dialog.get('[data-action="confirm-delete"]').trigger('click')
      await flushPromises()

      expect(isOpen(dialog)).toBe(true)
      expect(dialog.get('[role="alert"]').text()).toContain(NO_ADAPTER_ERROR.message)
      expect(wrapper.findAll('li')).toHaveLength(1)
    })
  })

  describe('secrets', () => {
    it('never puts the password in the serialized Pinia state', async () => {
      const { wrapper, pinia } = await mountView()
      await openNewForm(wrapper)
      await fillPostgres(wrapper, 'hunter2-secret')

      expect(JSON.stringify(pinia.state.value)).not.toContain('hunter2-secret')

      await action(wrapper, 'test').trigger('click')
      await flushPromises()
      await wrapper.get('form').trigger('submit')
      await flushPromises()

      const serialized = JSON.stringify(pinia.state.value)
      expect(serialized).not.toContain('hunter2-secret')
      expect(serialized).not.toMatch(/password/i)
    })

    it('clears the password when the dialog is cancelled', async () => {
      const { wrapper } = await mountView()
      await openNewForm(wrapper)
      await field(wrapper, 'password').setValue('hunter2-secret')

      await action(wrapper, 'cancel').trigger('click')
      await flushPromises()
      await openNewForm(wrapper)

      expect((field(wrapper, 'password').element as HTMLInputElement).value).toBe('')
    })
  })

  describe('dialog behaviour', () => {
    it('closes on Escape (cancel event) and returns focus to the opener', async () => {
      const { wrapper } = await mountView({ profiles: [sqlite] })
      const opener = action(wrapper, 'new')
      await openNewForm(wrapper)
      expect(isOpen(formDialog(wrapper))).toBe(true)

      await formDialog(wrapper).trigger('cancel')
      await flushPromises()

      expect(isOpen(formDialog(wrapper))).toBe(false)
      expect(document.activeElement).toBe(opener.element)
    })

    it('returns focus to the row action that opened the edit dialog', async () => {
      const { wrapper } = await mountView({ profiles: [sqlite] })
      const edit = item(wrapper, 'sq1').get('[data-action="edit"]')
      ;(edit.element as HTMLElement).focus()
      await edit.trigger('click')
      await flushPromises()

      await formDialog(wrapper).trigger('cancel')
      await flushPromises()

      expect(document.activeElement).toBe(edit.element)
    })

    it('labels each dialog with its title', async () => {
      const { wrapper } = await mountView()
      await openNewForm(wrapper)

      const dialog = formDialog(wrapper)
      const title = dialog.get(`[id="${dialog.attributes('aria-labelledby')}"]`)
      expect(title.text()).toBe('Nueva conexión')
    })
  })

  describe('keyboard', () => {
    async function press(wrapper: Wrapper, id: string, key: string) {
      await item(wrapper, id).get('.connection-item__summary').trigger('keydown', { key })
      await flushPromises()
    }

    it('moves through the list with the arrow keys using a roving tabindex', async () => {
      const { wrapper } = await mountView({ profiles: [postgres, sqlite] })
      const summary = (id: string) => item(wrapper, id).get('.connection-item__summary')
      expect(summary('pg1').attributes('tabindex')).toBe('0')
      expect(summary('sq1').attributes('tabindex')).toBe('-1')

      await press(wrapper, 'pg1', 'ArrowDown')
      expect(document.activeElement).toBe(summary('sq1').element)
      expect(summary('sq1').attributes('tabindex')).toBe('0')
      expect(summary('pg1').attributes('tabindex')).toBe('-1')

      await press(wrapper, 'sq1', 'Home')
      expect(document.activeElement).toBe(summary('pg1').element)

      await press(wrapper, 'pg1', 'End')
      expect(document.activeElement).toBe(summary('sq1').element)
    })

    it('connects the selected item with Enter', async () => {
      const { wrapper, connections } = await mountView({
        profiles: [sqlite],
        connectResult: ipcOk(session),
      })

      await press(wrapper, 'sq1', 'Enter')

      expect(connections.connect).toHaveBeenCalledWith({ profileId: 'sq1' })
      expect(item(wrapper, 'sq1').attributes('data-status')).toBe('connected')
    })

    it('opens edit with E and delete confirmation with Delete', async () => {
      const { wrapper } = await mountView({ profiles: [sqlite] })

      await press(wrapper, 'sq1', 'e')
      expect(isOpen(formDialog(wrapper))).toBe(true)
      await formDialog(wrapper).trigger('cancel')
      await flushPromises()

      await press(wrapper, 'sq1', 'Delete')
      expect(isOpen(confirmDialog(wrapper))).toBe(true)
    })

    it('ignores shortcuts that carry global modifiers', async () => {
      const { wrapper, connections } = await mountView({ profiles: [sqlite] })

      await item(wrapper, 'sq1')
        .get('.connection-item__summary')
        .trigger('keydown', { key: 'Enter', metaKey: true })

      expect(connections.connect).not.toHaveBeenCalled()
    })
  })
})
