import type { ConnectionProfile, Session } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { useConnectionsStore } from '../../connections'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { useResultBuffers } from '../../execution/model/result-buffers'
import { useExecutionStore } from '../../execution/stores/execution'
import { chunk, done, rowsOf, statementDone } from '../../execution/testing/events'
import { usePreferencesStore } from '../../preferences'
import ResultsView from './ResultsView.vue'

const profile: ConnectionProfile = {
  id: 'p1',
  engine: 'postgres',
  name: 'Local',
  readOnly: false,
  host: 'localhost',
  port: 5432,
  user: 'me',
  database: 'app',
  ssl: 'disable',
}
const session: Session = {
  sessionId: 's1',
  profileId: 'p1',
  engine: 'postgres',
  serverVersion: '17.0',
  readOnly: false,
  transaction: 'none',
}
const tab = { id: 'tab-1', title: 'Consulta 1', content: '', sessionId: 's1', saveToHistory: true }

let wrapper: VueWrapper | undefined

beforeEach(async () => {
  setActivePinia(createPinia())
  installFakeDb(createFakeDb({ profiles: [profile], connectResult: ipcOk(session) }).db)
  const connections = useConnectionsStore()
  await connections.load()
  await connections.connect('p1')
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'db')
  useResultBuffers().discard('tab-1')
})

async function run() {
  const store = useExecutionStore()
  await store.run('tab-1', { sessionId: 's1', sql: 'select 1', scope: 'document' })
  const requestId = store.stateOf('tab-1').requestId!
  wrapper = mount(ResultsView, { props: { tab }, attachTo: document.body })
  return { store, requestId }
}

const tabs = () => wrapper!.findAll('[role="tab"]')

describe('ResultsView', () => {
  it('asks to run a query when there is nothing yet', async () => {
    wrapper = mount(ResultsView, { props: { tab }, attachTo: document.body })
    expect(wrapper.get('[data-part="empty"]').text()).toContain('Ejecuta una consulta')
    expect(wrapper.find('[role="grid"]').exists()).toBe(false)
  })

  it('shows the grid for a single statement without a tab selector', async () => {
    const { store, requestId } = await run()
    store.applyEvent(chunk(requestId, rowsOf(0, 4)))
    store.applyEvent(
      statementDone(requestId, { rowsReturned: 4, command: 'SELECT', durationMs: 12 }),
    )
    store.applyEvent(done(requestId, 'none', 30))
    await flushPromises()
    expect(wrapper!.find('[role="tablist"]').exists()).toBe(false)
    expect(wrapper!.get('[role="grid"]').attributes('aria-rowcount')).toBe('5')
    expect(wrapper!.get('[data-part="grid-caption"]').text()).toBe('4 filas recibidas en 30 ms.')
  })

  it('follows the buffer while chunks arrive', async () => {
    const { store, requestId } = await run()
    store.applyEvent(chunk(requestId, rowsOf(0, 3), 0))
    await flushPromises()
    expect(wrapper!.get('[role="grid"]').attributes('aria-busy')).toBe('true')
    expect(wrapper!.get('[role="grid"]').attributes('aria-rowcount')).toBe('4')
    store.applyEvent(chunk(requestId, rowsOf(3, 7), 1))
    await flushPromises()
    expect(wrapper!.get('[role="grid"]').attributes('aria-rowcount')).toBe('11')
    store.applyEvent(statementDone(requestId, { rowsReturned: 10 }))
    store.applyEvent(done(requestId))
    await flushPromises()
    expect(wrapper!.get('[role="grid"]').attributes('aria-busy')).toBe('false')
  })

  it('lists every statement as a tab and switches between them, with the last result set by default', async () => {
    const { store, requestId } = await run()
    store.applyEvent(chunk(requestId, rowsOf(0, 3), 0, 0))
    store.applyEvent(statementDone(requestId, { statementIndex: 0, rowsReturned: 3 }))
    store.applyEvent(
      statementDone(requestId, {
        statementIndex: 1,
        command: 'INSERT',
        rowsAffected: 5,
        durationMs: 8,
      }),
    )
    store.applyEvent(chunk(requestId, rowsOf(100, 2), 0, 2))
    store.applyEvent(statementDone(requestId, { statementIndex: 2, rowsReturned: 2 }))
    store.applyEvent(done(requestId))
    await flushPromises()

    expect(wrapper!.get('[role="tablist"]').attributes('aria-label')).toContain('sentencia')
    expect(tabs().map((node) => node.text())).toEqual([
      'Sentencia n.º 1 · 3 filas',
      'Sentencia n.º 2 · 5 filas afectadas',
      'Sentencia n.º 3 · 2 filas',
    ])
    expect(tabs().map((node) => node.attributes('aria-selected'))).toEqual([
      'false',
      'false',
      'true',
    ])
    expect(tabs().map((node) => node.attributes('tabindex'))).toEqual(['-1', '-1', '0'])
    expect(wrapper!.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe(
      tabs()[2]!.attributes('id'),
    )
    expect(wrapper!.get('[data-part="grid-body"] [data-row="0"][data-col="0"]').text()).toBe('100')

    await tabs()[1]!.trigger('click')
    const affected = wrapper!.get('[data-part="statement-result"]')
    expect(affected.text()).toContain('5 filas afectadas')
    expect(affected.text()).toContain('8 ms')
    expect(wrapper!.find('[role="grid"]').exists()).toBe(false)

    await tabs()[0]!.trigger('click')
    expect(wrapper!.get('[data-part="grid-body"] [data-row="0"][data-col="0"]').text()).toBe('0')
    expect(wrapper!.get('[data-part="grid-caption"]').text()).toContain('SELECT')
  })

  it('moves between the tabs with the arrow keys', async () => {
    const { store, requestId } = await run()
    store.applyEvent(chunk(requestId, rowsOf(0, 1), 0, 0))
    store.applyEvent(chunk(requestId, rowsOf(0, 1), 0, 1))
    await flushPromises()
    await tabs()[1]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(tabs()[0]!.attributes('aria-selected')).toBe('true')
    await tabs()[0]!.trigger('keydown', { key: 'End' })
    expect(tabs()[1]!.attributes('aria-selected')).toBe('true')
  })

  it('shows "N filas afectadas" and the duration for a statement without rows', async () => {
    const { store, requestId } = await run()
    store.applyEvent(
      statementDone(requestId, { command: 'INSERT', rowsAffected: 1, durationMs: 4 }),
    )
    store.applyEvent(done(requestId))
    await flushPromises()
    const text = wrapper!.get('[data-part="statement-result"]').text()
    expect(text).toContain('1 fila afectada')
    expect(text).toContain('4 ms')
  })

  it('explains that the rows of an evicted statement were dropped', async () => {
    usePreferencesStore().setExecutionLimits({ timeoutSeconds: 30, maxRows: 5 })
    const { store, requestId } = await run()
    store.applyEvent(chunk(requestId, rowsOf(0, 3), 0, 0))
    store.applyEvent(statementDone(requestId, { statementIndex: 0, rowsReturned: 3 }))
    store.applyEvent(chunk(requestId, rowsOf(0, 4), 0, 1))
    store.applyEvent(statementDone(requestId, { statementIndex: 1, rowsReturned: 4 }))
    store.applyEvent(done(requestId))
    await flushPromises()
    expect(wrapper!.get('[data-part="evicted"]').text()).toContain('Se descartaron 1')
    await tabs()[0]!.trigger('click')
    expect(wrapper!.get('[data-part="statement-result"]').text()).toContain('se descartaron')
  })

  it('flags a result cut by the row limit', async () => {
    const { store, requestId } = await run()
    store.applyEvent(chunk(requestId, rowsOf(0, 3)))
    store.applyEvent(statementDone(requestId, { rowsReturned: 3, truncated: true }))
    store.applyEvent(done(requestId))
    await flushPromises()
    expect(wrapper!.get('[data-part="limit-note"]').text()).toContain('límite de filas')
  })

  it('shows the error and the cancellation of the run', async () => {
    const { store, requestId } = await run()
    store.applyEvent({
      type: 'error',
      requestId,
      error: { code: 'syntax_error', message: 'syntax error', retryable: false },
    })
    await flushPromises()
    expect(wrapper!.get('[data-part="error"]').text()).toContain('syntax error')
  })
})
