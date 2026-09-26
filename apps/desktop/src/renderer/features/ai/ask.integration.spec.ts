import { EditorView } from '@codemirror/view'
import {
  DEFAULT_PREFERENCES,
  type ConnectionProfile,
  type QueryRequest,
  type Session,
} from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcOk } from '../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../connections/testing/fake-db'
import { useResultBuffers } from '../execution/model/result-buffers'
import { chunk, done, rowsOf, statementDone } from '../execution/testing/events'
import { usePreferencesStore } from '../preferences'
import WorkspaceShell from '../workspace/components/WorkspaceShell.vue'
import { useWorkspaceStore } from '../workspace/stores/workspace'
import { stubGenerateSql } from './testing/fake-ai'
import { useAskStore } from './stores/ask'

const profile: ConnectionProfile = {
  id: 'p1',
  engine: 'postgres',
  name: 'Tienda',
  readOnly: false,
  host: 'db.example.com',
  port: 5432,
  user: 'app',
  database: 'shop',
  ssl: 'require',
  secretRef: 'secret-p1',
}

const session = (overrides: Partial<Session> = {}): Session => ({
  sessionId: 's1',
  profileId: 'p1',
  engine: 'postgres',
  serverVersion: '17.0',
  readOnly: false,
  transaction: 'none',
  ...overrides,
})

const QUESTION = '¿cuántos pedidos hay por cliente?'
const READ_SQL =
  'SELECT c.name, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY 1'

let mounted: VueWrapper | undefined
let pinia: Pinia

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
  for (const id of ['tab-1', 'tab-2', 'tab-3']) useResultBuffers().discard(id)
  vi.restoreAllMocks()
})

interface MountOptions {
  session?: Session
  aiEnabled?: boolean
  connected?: boolean
}

async function mountWorkspace({
  session: current = session(),
  aiEnabled = true,
  connected = true,
}: MountOptions = {}) {
  const fake = createFakeDb({
    profiles: [profile],
    connectResult: ipcOk(current),
    preferences: { ...DEFAULT_PREFERENCES, ai: { ...DEFAULT_PREFERENCES.ai, enabled: aiEnabled } },
  })
  installFakeDb(fake.db)
  const backend = stubGenerateSql(fake)
  pinia = createPinia()
  const wrapper = mount(WorkspaceShell, { global: { plugins: [pinia] }, attachTo: document.body })
  mounted = wrapper
  await usePreferencesStore(pinia).load()
  await flushPromises()
  if (connected) {
    await wrapper.get('[data-profile-id="p1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
  }
  await wrapper.get('[data-action="new-tab"]').trigger('click')
  await flushPromises()
  return { wrapper, fake, backend, workspace: useWorkspaceStore(pinia), ask: useAskStore(pinia) }
}

const editorView = () => {
  const shadow = document.querySelector<HTMLElement>('.sql-editor__host')!.shadowRoot!
  return EditorView.findFromDOM(shadow.querySelector<HTMLElement>('.cm-editor')!)!
}

function pressInEditor(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    composed: true,
    cancelable: true,
    ...init,
  })
  editorView().contentDOM.dispatchEvent(event)
  return event
}

const dialog = (wrapper: VueWrapper) => wrapper.get<HTMLDialogElement>('[data-dialog="ask"]')
const textarea = (wrapper: VueWrapper) =>
  dialog(wrapper).get<HTMLTextAreaElement>('textarea[name="question"]')
const indicator = (wrapper: VueWrapper) => wrapper.get('[data-part="execution-indicator"]').text()
const runButton = (wrapper: VueWrapper) =>
  wrapper.get<HTMLButtonElement>('[data-region="execution-toolbar"] [data-action="run"]')

async function openWithShortcut() {
  const event = pressInEditor({ key: 'A', code: 'KeyA', metaKey: true, shiftKey: true })
  await flushPromises()
  return event
}

async function ask(ctx: Awaited<ReturnType<typeof mountWorkspace>>, question = QUESTION) {
  await openWithShortcut()
  await textarea(ctx.wrapper).setValue(question)
  await textarea(ctx.wrapper).trigger('keydown', { key: 'Enter', metaKey: true })
  await flushPromises()
}

async function answer(
  ctx: Awaited<ReturnType<typeof mountWorkspace>>,
  result: Parameters<typeof ctx.backend.answer>[0],
) {
  ctx.backend.answer(result)
  await flushPromises()
}

const lastExecute = (ctx: Awaited<ReturnType<typeof mountWorkspace>>): QueryRequest =>
  ctx.fake.query.execute.mock.calls.at(-1)![0]

describe('opening the dialog', () => {
  it('opens with Cmd+Shift+A from the editor, focused on the question, and does not steal the key from the editor', async () => {
    const { wrapper, ask: store } = await mountWorkspace()
    const event = await openWithShortcut()

    expect(event.defaultPrevented).toBe(true)
    expect(store.isOpen).toBe(true)
    expect(dialog(wrapper).element.open).toBe(true)
    expect(document.activeElement).toBe(textarea(wrapper).element)
    expect(editorView().state.doc.toString()).toBe('')
  })

  it('opens from its toolbar button, which announces the shortcut', async () => {
    const { wrapper, ask: store } = await mountWorkspace()
    const button = wrapper.get('[data-region="execution-toolbar"] [data-action="ask"]')
    expect(button.text()).toBe('IA')
    expect(button.attributes('aria-label')).toBe('Preguntar a la base con IA')
    expect(button.attributes('aria-keyshortcuts')).toBe('Meta+Shift+A')
    expect(button.attributes('title')).toBe('Preguntar a la base con IA (⇧⌘A)')

    await button.trigger('click')
    await flushPromises()
    expect(store.isOpen).toBe(true)
  })

  it('does not fire with the wrong modifier or without Shift', async () => {
    const { ask: store } = await mountWorkspace()
    pressInEditor({ key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true })
    pressInEditor({ key: 'a', code: 'KeyA', metaKey: true })
    await flushPromises()
    expect(store.isOpen).toBe(false)
  })

  it('with the assistant off it only explains and never reaches the model', async () => {
    const { wrapper, fake } = await mountWorkspace({ aiEnabled: false })
    await openWithShortcut()
    expect(dialog(wrapper).get('[data-part="ask-prerequisite"]').text()).toContain('desactivada')
    expect(fake.ai.generateSql).not.toHaveBeenCalled()
  })

  it('without a connected session it explains and never reaches the model', async () => {
    const { wrapper, fake } = await mountWorkspace({ connected: false })
    await openWithShortcut()
    expect(dialog(wrapper).get('[data-part="ask-prerequisite"]').text()).toContain('conexión')
    expect(wrapper.find('textarea[name="question"]').exists()).toBe(false)
    expect(fake.ai.generateSql).not.toHaveBeenCalled()
  })
})

describe('a read question', () => {
  it('opens a new tab with the SQL, runs it read-only and shows the grid; Escape then lands in the editor', async () => {
    const ctx = await mountWorkspace()
    const { wrapper, fake, workspace } = ctx
    await ask(ctx)
    await answer(ctx, { sql: READ_SQL })

    expect(workspace.tabs).toHaveLength(2)
    expect(workspace.activeTab).toMatchObject({ sessionId: 's1', content: READ_SQL })
    expect(workspace.activeTab?.title.startsWith('IA: ')).toBe(true)
    expect(editorView().state.doc.toString()).toBe(READ_SQL)

    expect(fake.query.execute).toHaveBeenCalledTimes(1)
    expect(lastExecute(ctx)).toMatchObject({
      sessionId: 's1',
      sql: READ_SQL,
      enforceReadOnly: true,
    })
    expect(indicator(wrapper)).toContain('Ejecutando')

    const { requestId } = lastExecute(ctx)
    fake.emitQueryEvent(chunk(requestId, rowsOf(0, 3), 0))
    fake.emitQueryEvent(statementDone(requestId, { rowsReturned: 3 }))
    fake.emitQueryEvent(done(requestId, 'none', 12))
    await flushPromises()
    expect(indicator(wrapper)).toContain('Última ejecución completada')
    expect(wrapper.get('[data-part="results-grid"] [role="grid"]').text()).toContain('name-2')

    // El diálogo sigue abierto con la explicación; Escape lo cierra y el foco va al editor de la pestaña nueva.
    expect(dialog(wrapper).get('[data-part="generated-sql"]').text()).toBe(READ_SQL)
    await dialog(wrapper).trigger('cancel')
    await flushPromises()
    expect(dialog(wrapper).element.open).toBe(false)
    expect(editorView().hasFocus).toBe(true)
  })

  it('sends the enforceReadOnly mark only from the assistant: a normal run never carries it', async () => {
    const ctx = await mountWorkspace()
    await ask(ctx)
    await answer(ctx, { sql: READ_SQL })
    const { requestId } = lastExecute(ctx)
    ctx.fake.emitQueryEvent(done(requestId))
    await flushPromises()
    await dialog(ctx.wrapper).trigger('cancel')
    await flushPromises()

    await runButton(ctx.wrapper).trigger('click')
    await flushPromises()
    expect(ctx.fake.query.execute).toHaveBeenCalledTimes(2)
    expect(lastExecute(ctx)).not.toHaveProperty('enforceReadOnly')
  })
})

describe('anything that is not a plain read stays in a tab, unexecuted', () => {
  it.each([
    ['destructive', 'dml', 'DELETE FROM orders', 'Destructiva'],
    ['destructive', 'ddl', 'DROP TABLE orders', 'Destructiva'],
    ['write', 'dml', "UPDATE orders SET status = 'paid' WHERE id = 1", 'Escritura'],
    ['unknown', 'transaction', 'BEGIN', 'Desconocida'],
  ] as const)('%s %s: %s', async (risk, statementType, sql, label) => {
    const ctx = await mountWorkspace()
    await ask(ctx, 'borra todos los pedidos')
    await answer(ctx, { sql, risk, statementType })

    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
    expect(ctx.workspace.tabs).toHaveLength(2)
    expect(ctx.workspace.activeTab).toMatchObject({ content: sql, sessionId: 's1' })
    expect(editorView().state.doc.toString()).toBe(sql)
    expect(indicator(ctx.wrapper)).toContain('Listo para ejecutar')
    expect(dialog(ctx.wrapper).get('[data-part="risk-chip"]').text()).toContain(label)
    expect(dialog(ctx.wrapper).get('[data-part="run-outcome"]').text()).toContain(
      'No se ha ejecutado',
    )
  })

  it('a blocked statement in a read-only profile is opened and explained, not run', async () => {
    const ctx = await mountWorkspace({ session: session({ readOnly: true }) })
    await ask(ctx, 'borra todos los pedidos')
    await answer(ctx, {
      sql: 'DELETE FROM orders',
      risk: 'destructive',
      statementType: 'dml',
      warnings: ['read_only_blocked'],
      blocked: true,
    })

    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
    expect(ctx.workspace.activeTab?.content).toBe('DELETE FROM orders')
    expect(dialog(ctx.wrapper).get('[data-part="blocked-reason"]').text()).toContain('solo lectura')
  })

  it.each(['active', 'aborted'] as const)(
    'a read in a %s transaction is opened and not run by itself',
    async (transaction) => {
      const ctx = await mountWorkspace({ session: session({ transaction }) })
      await ask(ctx)
      await answer(ctx, { sql: READ_SQL })

      expect(ctx.fake.query.execute).not.toHaveBeenCalled()
      expect(ctx.workspace.activeTab?.content).toBe(READ_SQL)
      expect(dialog(ctx.wrapper).get('[data-part="run-outcome"]').text()).toContain('transacción')
    },
  )

  it('still asks for the usual confirmation when the user runs a destructive proposal by hand', async () => {
    const ctx = await mountWorkspace()
    await ask(ctx, 'borra todos los pedidos')
    await answer(ctx, { sql: 'DELETE FROM orders', risk: 'destructive', statementType: 'dml' })
    await dialog(ctx.wrapper).trigger('cancel')
    await flushPromises()

    await runButton(ctx.wrapper).trigger('click')
    await flushPromises()
    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
    const confirm = ctx.wrapper.get<HTMLDialogElement>('[data-dialog="destructive-confirmation"]')
    expect(confirm.element.open).toBe(true)

    await confirm.get('[data-action="confirm-destructive"]').trigger('click')
    await flushPromises()
    expect(lastExecute(ctx)).toMatchObject({ sql: 'DELETE FROM orders' })
    expect(lastExecute(ctx)).not.toHaveProperty('enforceReadOnly')
  })

  it('does not run over another tab that is executing in the session', async () => {
    const ctx = await mountWorkspace()
    editorView().dispatch({ changes: { from: 0, insert: 'select pg_sleep(30)' } })
    await runButton(ctx.wrapper).trigger('click')
    await flushPromises()
    expect(ctx.fake.query.execute).toHaveBeenCalledTimes(1)

    await ask(ctx)
    await answer(ctx, { sql: READ_SQL })
    expect(ctx.fake.query.execute).toHaveBeenCalledTimes(1)
    expect(ctx.workspace.activeTab?.content).toBe(READ_SQL)
    expect(dialog(ctx.wrapper).get('[data-part="run-outcome"]').text()).toContain('en curso')
  })
})

describe('cancelling', () => {
  it('cancels the request from the dialog with Escape and leaves the workspace as it was', async () => {
    const ctx = await mountWorkspace()
    await ask(ctx)
    expect(ctx.ask.phase).toBe('generating')
    await dialog(ctx.wrapper).trigger('cancel')
    await flushPromises()

    expect(ctx.fake.ai.cancel).toHaveBeenCalled()
    expect(ctx.workspace.tabs).toHaveLength(1)
    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
  })
})
