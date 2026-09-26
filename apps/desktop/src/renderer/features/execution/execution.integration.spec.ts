import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { ConnectionProfile, Session } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcFail, ipcOk } from '../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../connections/testing/fake-db'
import { useCommandCenter } from '../command-palette/stores/command-center'
import { usePaletteStore } from '../command-palette/stores/palette'
import { makeEntry } from '../history/testing/fake-history'
import { usePreferencesStore } from '../preferences'
import WorkspaceShell from '../workspace/components/WorkspaceShell.vue'
import { useWorkspaceStore } from '../workspace/stores/workspace'
import { useResultBuffers } from './model/result-buffers'
import { cancelled, chunk, done, failed, rowsOf, statementDone } from './testing/events'

const profile: ConnectionProfile = {
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

const session = (overrides: Partial<Session> = {}): Session => ({
  sessionId: 's1',
  profileId: 'pg1',
  engine: 'postgres',
  serverVersion: '17.0',
  readOnly: false,
  transaction: 'none',
  ...overrides,
})

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
  useResultBuffers().discard('tab-1')
  vi.restoreAllMocks()
})

interface MountOptions {
  connected?: boolean
  session?: Session
  sql?: string
}

async function mountWorkspace({
  connected = true,
  session: current = session(),
  sql,
}: MountOptions = {}) {
  const fake = createFakeDb({ profiles: [profile], connectResult: ipcOk(current) })
  installFakeDb(fake.db)
  pinia = createPinia()
  const wrapper = mount(WorkspaceShell, { global: { plugins: [pinia] }, attachTo: document.body })
  mounted = wrapper
  await flushPromises()
  if (connected) {
    await wrapper.get('[data-profile-id="pg1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
  }
  await wrapper.get('[data-action="new-tab"]').trigger('click')
  await flushPromises()
  if (sql !== undefined) write(sql)
  return { wrapper, fake, workspace: useWorkspaceStore(pinia) }
}

const editorView = () => {
  const shadow = document.querySelector<HTMLElement>('.sql-editor__host')!.shadowRoot!
  return EditorView.findFromDOM(shadow.querySelector<HTMLElement>('.cm-editor')!)!
}

function write(text: string): void {
  editorView().dispatch({ changes: { from: 0, to: editorView().state.doc.length, insert: text } })
}

// Los eventos del editor viven en un shadow root: son `composed` para llegar hasta `window`, como los reales.
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

const button = (wrapper: VueWrapper, action: string) =>
  wrapper.get<HTMLButtonElement>(`[data-region="execution-toolbar"] [data-action="${action}"]`)
const disabled = (wrapper: VueWrapper, action: string) =>
  button(wrapper, action).attributes('aria-disabled') === 'true'
const indicator = (wrapper: VueWrapper) => wrapper.get('[data-part="execution-indicator"]').text()
const transactionState = (wrapper: VueWrapper) =>
  wrapper.get('[data-region="execution-toolbar"] [data-part="transaction-state"]')
const transactionSegment = (wrapper: VueWrapper) =>
  wrapper.get('[data-segment="transaction"]').text()

async function runAndCapture(wrapper: VueWrapper, fake: ReturnType<typeof createFakeDb>) {
  await button(wrapper, 'run').trigger('click')
  await flushPromises()
  const request = fake.query.execute.mock.calls.at(-1)![0]
  return request.requestId
}

describe('execution toolbar', () => {
  it('exposes the six actions as accessible buttons inside a labelled group', async () => {
    const { wrapper } = await mountWorkspace()
    const group = wrapper.get('[role="group"][aria-label="Acciones de consulta"]')
    const labels = group.findAll('button').map((entry) => entry.text())
    expect(labels).toEqual([
      'Ejecutar',
      'Ejecutar todo',
      'Cancelar',
      'Iniciar transacción',
      'Confirmar',
      'Revertir',
      'IA',
      'Ajustes de ejecución',
      'Historial',
    ])
    expect(button(wrapper, 'run').attributes('aria-keyshortcuts')).toBe('Meta+Enter')
    expect(button(wrapper, 'run-all').attributes('aria-keyshortcuts')).toBe('Meta+Shift+Enter')
  })

  it('disables everything without a session, with a reason readable by assistive technology', async () => {
    const { wrapper } = await mountWorkspace({ connected: false })
    for (const action of ['run', 'run-all', 'cancel', 'begin', 'commit', 'rollback']) {
      expect(disabled(wrapper, action)).toBe(true)
      const reasonId = button(wrapper, action).attributes('aria-describedby')!
      expect(document.getElementById(reasonId)!.textContent).toBeTruthy()
    }
    expect(
      document.getElementById(button(wrapper, 'run').attributes('aria-describedby')!)!.textContent,
    ).toContain('conexión')
    expect(indicator(wrapper)).toContain('Sin conexión')
  })

  it('exposes the execution state on the indicator so it can carry a glyph besides the color', async () => {
    const { wrapper } = await mountWorkspace({ connected: false })
    expect(wrapper.get('[data-part="execution-indicator"]').attributes('data-state')).toBe(
      'offline',
    )
  })

  it('keeps the full accessible name when the label is shortened in narrow widths', async () => {
    const { wrapper } = await mountWorkspace()
    expect(button(wrapper, 'begin').text()).toBe('Iniciar transacción')
    expect(button(wrapper, 'begin').find('.exec-toolbar__more').text()).toBe('transacción')
    expect(wrapper.get('[data-part="execution-indicator"]').attributes('data-state')).toBe('idle')
  })

  it('keeps a tooltip with the full name on the buttons that narrow widths reduce to their symbol', async () => {
    const { wrapper } = await mountWorkspace()
    expect(button(wrapper, 'run-all').attributes('title')).toContain('Ejecutar todo')
    expect(button(wrapper, 'cancel').attributes('title')).toContain('Cancelar')
    expect(button(wrapper, 'run-all').get('[data-glyph="run-all"]').attributes('aria-hidden')).toBe(
      'true',
    )
  })

  it('exposes the transaction state on the toolbar so the segmented control can follow the chip', async () => {
    const { wrapper } = await mountWorkspace({ session: session({ transaction: 'active' }) })
    expect(wrapper.get('[data-region="execution-toolbar"]').attributes('data-transaction')).toBe(
      'active',
    )
  })

  it('leaves the transaction state out of the toolbar without a session', async () => {
    const { wrapper } = await mountWorkspace({ connected: false })
    expect(
      wrapper.get('[data-region="execution-toolbar"]').attributes('data-transaction'),
    ).toBeUndefined()
  })

  it('enables run and begin with an idle session and no transaction', async () => {
    const { wrapper } = await mountWorkspace()
    expect(disabled(wrapper, 'run')).toBe(false)
    expect(disabled(wrapper, 'run-all')).toBe(false)
    expect(disabled(wrapper, 'begin')).toBe(false)
    expect(disabled(wrapper, 'cancel')).toBe(true)
    expect(disabled(wrapper, 'commit')).toBe(true)
    expect(disabled(wrapper, 'rollback')).toBe(true)
    expect(button(wrapper, 'run').attributes('aria-describedby')).toBeUndefined()
  })
})

describe('run, chunks, acks and completion', () => {
  it('runs the document, acks every chunk, shows the result grid and the duration', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select * from t' })
    const requestId = await runAndCapture(wrapper, fake)

    expect(fake.query.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        sql: 'select * from t',
        timeoutMs: 30_000,
        maxRows: 10_000,
      }),
    )
    expect(disabled(wrapper, 'run')).toBe(true)
    expect(disabled(wrapper, 'cancel')).toBe(false)
    expect(indicator(wrapper)).toContain('Ejecutando el documento')

    fake.emitQueryEvent(chunk(requestId, rowsOf(0, 3), 0))
    fake.emitQueryEvent(chunk(requestId, rowsOf(3, 2), 1))
    fake.emitQueryEvent(statementDone(requestId, { rowsReturned: 5 }))
    fake.emitQueryEvent(done(requestId, 'none', 87))
    await flushPromises()

    expect(fake.query.ack).toHaveBeenCalledTimes(2)
    expect(fake.query.ack).toHaveBeenNthCalledWith(1, {
      requestId,
      statementIndex: 0,
      chunkIndex: 0,
    })
    expect(disabled(wrapper, 'run')).toBe(false)
    expect(indicator(wrapper)).toContain('Última ejecución completada')

    const grid = wrapper.get('[data-part="results-grid"] [role="grid"]')
    expect(grid.attributes('aria-rowcount')).toBe('6')
    expect(grid.get('[role="columnheader"][data-col="0"]').text()).toContain('id')
    expect(grid.get('[role="columnheader"][data-col="0"]').text()).toContain('integer')
    expect(grid.findAll('[role="row"]')).toHaveLength(6)
    expect(grid.text()).toContain('name-4')
    expect(wrapper.get('[data-part="filter-count"]').text()).toBe('5 filas')
    expect(wrapper.get('[data-segment="last-query"]').text()).toContain('87 ms')
  })

  it('runs the selection with Cmd+Enter and the whole document with Shift+Cmd+Enter, from inside the editor', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1; select 2' })
    // Abrir la pestaña deja el foco en el editor; happy-dom lo sincroniza de forma reentrante al mover la selección.
    editorView().contentDOM.blur()
    editorView().dispatch({ selection: EditorSelection.range(10, 18) })

    const event = pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(fake.query.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ sql: 'select 2' }),
    )
    expect(indicator(wrapper)).toContain('la selección')

    // Se libera la sesión para poder volver a ejecutar.
    const first = fake.query.execute.mock.calls[0]![0].requestId
    fake.emitQueryEvent(done(first))
    await flushPromises()

    pressInEditor({ key: 'Enter', metaKey: true, shiftKey: true })
    await flushPromises()
    expect(fake.query.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ sql: 'select 1; select 2' }),
    )
  })

  it('runs the whole document when nothing is selected', async () => {
    const { fake } = await mountWorkspace({ sql: 'select 1' })
    pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()
    expect(fake.query.execute).toHaveBeenCalledWith(expect.objectContaining({ sql: 'select 1' }))
  })

  it('does not repeat the run for auto-repeated keys nor with the wrong modifier', async () => {
    const { fake } = await mountWorkspace({ sql: 'select 1' })
    pressInEditor({ key: 'Enter', metaKey: true, repeat: true })
    pressInEditor({ key: 'Enter', ctrlKey: true })
    pressInEditor({ key: 'Enter' })
    await flushPromises()
    expect(fake.query.execute).not.toHaveBeenCalled()
  })

  it('explains why a shortcut did nothing when there is no session', async () => {
    const { wrapper, fake } = await mountWorkspace({ connected: false, sql: 'select 1' })
    pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()
    expect(fake.query.execute).not.toHaveBeenCalled()
    expect(indicator(wrapper)).toContain('No se puede ejecutar')
  })

  it('shows main rejections such as busy and lets the user retry', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    fake.query.execute.mockResolvedValueOnce(
      ipcFail({ code: 'busy', message: 'A query is already running', retryable: true }),
    )
    await button(wrapper, 'run').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-part="error"]').text()).toContain('sesión está ocupada')
    expect(disabled(wrapper, 'run')).toBe(false)

    await button(wrapper, 'run').trigger('click')
    await flushPromises()
    expect(fake.query.execute).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-part="error"]').exists()).toBe(false)
  })

  it('keeps the text and the focus in the editor after an error and re-executes at once', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'selec 1' })
    editorView().focus()
    pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()
    const requestId = fake.query.execute.mock.calls[0]![0].requestId
    fake.emitQueryEvent(failed(requestId, {}, 'none'))
    await flushPromises()

    expect(wrapper.get('[data-part="error"]').text()).toContain('syntax error near "selec"')
    expect(indicator(wrapper)).toContain('terminó con error')
    expect(editorView().state.doc.toString()).toBe('selec 1')
    expect(editorView().hasFocus).toBe(true)

    write('select 1')
    pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()
    expect(fake.query.execute).toHaveBeenCalledTimes(2)
  })
})

describe('cancellation and Esc precedence', () => {
  async function runningWorkspace() {
    const context = await mountWorkspace({ sql: 'select pg_sleep(30)' })
    const requestId = await runAndCapture(context.wrapper, context.fake)
    context.fake.query.cancel.mockResolvedValue(ipcOk({ requestId, outcome: 'requested' }))
    return { ...context, requestId }
  }

  it('the Cancel button asks main to cancel and the cancelled event returns the tab to idle', async () => {
    const { wrapper, fake, requestId } = await runningWorkspace()
    await button(wrapper, 'cancel').trigger('click')
    await flushPromises()
    expect(fake.query.cancel).toHaveBeenCalledWith({ requestId })
    expect(indicator(wrapper)).toContain('Cancelando')
    expect(disabled(wrapper, 'cancel')).toBe(true)

    fake.emitQueryEvent(cancelled(requestId, 'none'))
    await flushPromises()
    expect(indicator(wrapper)).toContain('se canceló')
    expect(disabled(wrapper, 'run')).toBe(false)
  })

  it('Esc cancels the running execution even with the focus inside the editor', async () => {
    const { fake, requestId } = await runningWorkspace()
    editorView().focus()
    pressInEditor({ key: 'Escape' })
    await flushPromises()
    expect(fake.query.cancel).toHaveBeenCalledWith({ requestId })
  })

  it('Esc does not stop propagation nor prevent the default action, so leaving the editor with Esc+Tab still works', async () => {
    const { fake } = await runningWorkspace()
    const event = pressInEditor({ key: 'Escape' })
    await flushPromises()
    expect(fake.query.cancel).toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('Esc does nothing when nothing is running', async () => {
    const { fake } = await mountWorkspace({ sql: 'select 1' })
    pressInEditor({ key: 'Escape' })
    await flushPromises()
    expect(fake.query.cancel).not.toHaveBeenCalled()
  })

  it('an open dialog gets Esc first: the execution is not cancelled', async () => {
    const { wrapper, fake } = await runningWorkspace()
    await button(wrapper, 'execution-settings').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-dialog="settings"]').attributes('open')).toBeDefined()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(fake.query.cancel).not.toHaveBeenCalled()
  })

  it('an Esc already consumed by the editor does not cancel', async () => {
    const { fake } = await runningWorkspace()
    const consumed = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    consumed.preventDefault()
    window.dispatchEvent(consumed)
    await flushPromises()
    expect(fake.query.cancel).not.toHaveBeenCalled()
  })

  it('does not interfere with the workspace shortcuts Cmd+K/T/W/P/L', async () => {
    const { workspace, fake } = await mountWorkspace({ sql: 'select 1' })
    for (const key of ['k', 'p', 'l']) pressInEditor({ key, metaKey: true })
    await flushPromises()
    // Cmd+K y Cmd+P abren la paleta: con ella abierta el resto de atajos esperan a que se cierre.
    pressInEditor({ key: 't', metaKey: true })
    pressInEditor({ key: 'Escape' })
    await flushPromises()
    expect(workspace.tabs).toHaveLength(1)
    pressInEditor({ key: 't', metaKey: true })
    await flushPromises()
    expect(fake.query.execute).not.toHaveBeenCalled()
    expect(workspace.tabs).toHaveLength(2)
  })
})

describe('destructive confirmation', () => {
  it('lists the destructive statements, focuses Cancel and does not send until confirmed', async () => {
    const { wrapper, fake } = await mountWorkspace({
      sql: 'SELECT 1; DROP TABLE users; DELETE FROM t',
    })
    pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()

    const dialog = wrapper.get('[data-dialog="destructive-confirmation"]')
    expect(dialog.attributes('open')).toBeDefined()
    expect(fake.query.execute).not.toHaveBeenCalled()
    const items = dialog
      .findAll('[data-part="destructive-statements"] li')
      .map((item) => item.text())
    expect(items).toHaveLength(2)
    expect(items[0]).toContain('DROP TABLE users')
    expect(items[1]).toContain('DELETE FROM t')
    expect(dialog.get('[data-action="cancel-destructive"]').attributes('autofocus')).toBeDefined()

    await dialog.get('[data-action="confirm-destructive"]').trigger('click')
    await flushPromises()
    expect(fake.query.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sql: 'SELECT 1; DROP TABLE users; DELETE FROM t' }),
    )
    expect(
      wrapper.get('[data-dialog="destructive-confirmation"]').attributes('open'),
    ).toBeUndefined()
  })

  it('cancelling sends nothing and returns the focus to the editor', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'DROP TABLE users' })
    editorView().focus()
    pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()
    await wrapper.get('[data-action="cancel-destructive"]').trigger('click')
    await flushPromises()

    expect(fake.query.execute).not.toHaveBeenCalled()
    expect(
      wrapper.get('[data-dialog="destructive-confirmation"]').attributes('open'),
    ).toBeUndefined()
    expect(editorView().hasFocus).toBe(true)
    expect(disabled(wrapper, 'run')).toBe(false)
  })

  it('runs straight away when the confirmation preference is off', async () => {
    const { fake } = await mountWorkspace({ sql: 'DROP TABLE users' })
    usePreferencesStore(pinia).setConfirmDestructive(false)
    pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()
    expect(fake.query.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sql: 'DROP TABLE users' }),
    )
  })

  it('does not ask on a read-only session: main blocks it and its error is shown', async () => {
    const { wrapper, fake } = await mountWorkspace({
      session: session({ readOnly: true }),
      sql: 'DROP TABLE users',
    })
    fake.query.execute.mockResolvedValueOnce(
      ipcFail({
        code: 'read_only_violation',
        message: 'Only read statements are allowed on a read-only connection',
        retryable: false,
      }),
    )
    pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()
    expect(
      wrapper.get('[data-dialog="destructive-confirmation"]').attributes('open'),
    ).toBeUndefined()
    expect(wrapper.get('[data-part="error"]').text()).toContain(
      'Only read statements are allowed on a read-only connection',
    )
  })

  it('does not ask for harmless statements', async () => {
    const { fake } = await mountWorkspace({ sql: 'DELETE FROM t WHERE id = 1' })
    pressInEditor({ key: 'Enter', metaKey: true })
    await flushPromises()
    expect(fake.query.execute).toHaveBeenCalledTimes(1)
  })
})

describe('transactions in the status bar', () => {
  it('begin, run and commit reflect the state of the session at every step', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    expect(transactionSegment(wrapper)).toContain('Sin transacción')

    fake.transactions.begin.mockResolvedValue(ipcOk({ sessionId: 's1', transaction: 'active' }))
    await button(wrapper, 'begin').trigger('click')
    await flushPromises()
    expect(fake.transactions.begin).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(transactionSegment(wrapper)).toContain('Transacción activa')
    expect(disabled(wrapper, 'begin')).toBe(true)
    expect(disabled(wrapper, 'commit')).toBe(false)
    expect(disabled(wrapper, 'rollback')).toBe(false)

    fake.transactions.commit.mockResolvedValue(ipcOk({ sessionId: 's1', transaction: 'none' }))
    await button(wrapper, 'commit').trigger('click')
    await flushPromises()
    expect(transactionSegment(wrapper)).toContain('Sin transacción')
  })

  it('an error inside a transaction shows aborted, suggests reverting and rollback clears it', async () => {
    const { wrapper, fake } = await mountWorkspace({
      session: session({ transaction: 'active' }),
      sql: 'select boom',
    })
    const requestId = await runAndCapture(wrapper, fake)
    fake.emitQueryEvent(failed(requestId, { message: 'division by zero' }, 'aborted'))
    await flushPromises()

    expect(transactionSegment(wrapper)).toContain('Transacción abortada')
    expect(transactionSegment(wrapper)).toContain('revertir')
    expect(wrapper.get('[data-hint="revert-first"]').text()).toBe(
      'Transacción abortada: solo puedes ejecutar ROLLBACK o pulsar «Revertir».',
    )
    expect(disabled(wrapper, 'commit')).toBe(true)
    expect(disabled(wrapper, 'begin')).toBe(true)
    expect(disabled(wrapper, 'rollback')).toBe(false)
    expect(disabled(wrapper, 'run')).toBe(false)

    fake.transactions.rollback.mockResolvedValue(ipcOk({ sessionId: 's1', transaction: 'none' }))
    await button(wrapper, 'rollback').trigger('click')
    await flushPromises()
    expect(transactionSegment(wrapper)).toContain('Sin transacción')
    expect(wrapper.find('[data-hint="revert-first"]').exists()).toBe(false)
  })

  it('with an aborted transaction only a closing statement reaches the server; anything else is refused with the reason', async () => {
    const { wrapper, fake } = await mountWorkspace({
      session: session({ transaction: 'aborted' }),
      sql: 'select 2',
    })
    const hint = wrapper.get('[data-hint="revert-first"]')
    expect(hint.attributes('id')).toBeTruthy()
    for (const action of ['run', 'run-all']) {
      expect(button(wrapper, action).attributes('aria-describedby')).toBe(hint.attributes('id'))
    }

    await button(wrapper, 'run').trigger('click')
    await flushPromises()
    expect(fake.query.execute).not.toHaveBeenCalled()
    expect(indicator(wrapper)).toContain('solo admite ROLLBACK')
    expect(wrapper.get('[data-part="execution-indicator"]').attributes('data-state')).toBe(
      'blocked',
    )
    expect(wrapper.find('[data-part="error"]').exists()).toBe(false)

    pressInEditor({ key: 'Enter', metaKey: true, shiftKey: true })
    await flushPromises()
    expect(fake.query.execute).not.toHaveBeenCalled()

    write('rollback to savepoint sp1')
    await button(wrapper, 'run').trigger('click')
    await flushPromises()
    expect(fake.query.execute).toHaveBeenCalledTimes(1)
    expect(fake.query.execute.mock.calls[0]![0].sql).toBe('rollback to savepoint sp1')
    expect(indicator(wrapper)).not.toContain('solo admite ROLLBACK')
  })

  it('lets a run through as soon as the transaction is not aborted any more', async () => {
    const { wrapper, fake } = await mountWorkspace({
      session: session({ transaction: 'aborted' }),
      sql: 'select 2',
    })
    fake.transactions.rollback.mockResolvedValue(ipcOk({ sessionId: 's1', transaction: 'none' }))
    await button(wrapper, 'rollback').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-hint="revert-first"]').exists()).toBe(false)
    expect(button(wrapper, 'run').attributes('aria-describedby')).toBeUndefined()

    await button(wrapper, 'run').trigger('click')
    await flushPromises()
    expect(fake.query.execute).toHaveBeenCalledTimes(1)
  })

  it('a failed transaction operation reports the normalized error', async () => {
    const { wrapper, fake } = await mountWorkspace()
    fake.transactions.begin.mockResolvedValue(
      ipcFail({ code: 'busy', message: 'A query is running', retryable: true }),
    )
    await button(wrapper, 'begin').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-part="error"]').text()).toContain('sesión está ocupada')
    expect(transactionSegment(wrapper)).toContain('Sin transacción')
  })
})

describe('transaction state in the toolbar', () => {
  it('shows nothing without a session', async () => {
    const { wrapper } = await mountWorkspace({ connected: false })
    expect(wrapper.find('[data-part="transaction-state"]').exists()).toBe(false)
  })

  it('says there is no transaction with a glyph and text, without a live region of its own', async () => {
    const { wrapper } = await mountWorkspace()
    const chip = transactionState(wrapper)
    expect(chip.text()).toBe('Sin transacción')
    expect(chip.attributes('data-state')).toBe('none')
    expect(chip.get('.exec-toolbar__tx-glyph').attributes('aria-hidden')).toBe('true')
    // La barra de estado ya anuncia cada cambio: un segundo anuncio sería ruido.
    expect(chip.attributes('role')).toBeUndefined()
    expect(chip.attributes('aria-live')).toBeUndefined()
  })

  it('follows begin, an aborting error and rollback, keeping the buttons and the revert hint intact', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select boom' })
    const labels = () =>
      wrapper
        .findAll('[data-region="execution-toolbar"] [role="group"] button')
        .map((b) => b.text())
    const before = labels()

    fake.transactions.begin.mockResolvedValue(ipcOk({ sessionId: 's1', transaction: 'active' }))
    await button(wrapper, 'begin').trigger('click')
    await flushPromises()
    expect(transactionState(wrapper).text()).toBe('Transacción activa')
    expect(transactionState(wrapper).attributes('data-state')).toBe('active')
    expect(wrapper.find('[data-hint="revert-first"]').exists()).toBe(false)
    expect(labels()).toEqual(before)

    const requestId = await runAndCapture(wrapper, fake)
    fake.emitQueryEvent(failed(requestId, { message: 'division by zero' }, 'aborted'))
    await flushPromises()
    expect(transactionState(wrapper).text()).toBe('Transacción abortada')
    expect(transactionState(wrapper).attributes('data-state')).toBe('aborted')
    expect(wrapper.get('[data-hint="revert-first"]').text()).toContain('ROLLBACK')
    expect(labels()).toEqual(before)

    fake.transactions.rollback.mockResolvedValue(ipcOk({ sessionId: 's1', transaction: 'none' }))
    await button(wrapper, 'rollback').trigger('click')
    await flushPromises()
    expect(transactionState(wrapper).text()).toBe('Sin transacción')
    expect(transactionState(wrapper).attributes('data-state')).toBe('none')
  })

  it('splits the label so a narrow toolbar can keep only the word that changes', async () => {
    const { wrapper } = await mountWorkspace({ session: session({ transaction: 'active' }) })
    const chip = transactionState(wrapper)
    expect(chip.get('.exec-toolbar__tx-lead').text()).toBe('Transacción')
    expect(chip.text()).toBe('Transacción activa')
    expect(chip.attributes('title')).toBe('Transacción activa')
  })
})

describe('messages panel', () => {
  it('lists notices, statements, errors with the normalized text, duration and rows', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1; select boom' })
    const requestId = await runAndCapture(wrapper, fake)
    fake.emitQueryEvent({
      type: 'notice',
      requestId,
      statementIndex: 0,
      level: 'info',
      message: 'table created',
    })
    fake.emitQueryEvent(chunk(requestId, rowsOf(0, 2)))
    fake.emitQueryEvent(statementDone(requestId, { rowsReturned: 2, durationMs: 7 }))
    fake.emitQueryEvent(
      failed(requestId, { code: 'internal_error', message: 'relation "boom" does not exist' }),
    )
    await flushPromises()

    await wrapper.get('[data-pane="messages"]').trigger('click')
    const log = wrapper.get('[role="log"]')
    const entries = log.findAll('li').map((entry) => entry.text())
    expect(entries).toEqual([
      'Aviso de la sentencia n.º 1: table created',
      'Sentencia n.º 1 · SELECT · 2 filas · 7 ms',
      'Error en la sentencia n.º 1: relation "boom" does not exist',
    ])
    expect(wrapper.get('[data-part="run-summary"]').text()).toMatch(
      /Duración total: .* ms · Filas recibidas: 2 filas/,
    )
    expect(wrapper.get('[data-pane="messages"]').text()).toContain('(3)')
  })

  it('has a Plan section that says it is not available in the MVP', async () => {
    const { wrapper } = await mountWorkspace()
    await wrapper.get('[data-pane="plan"]').trigger('click')
    expect(wrapper.get('[data-pane-content="plan"]').text()).toContain(
      'no está disponible en el MVP',
    )
  })

  it('is a real tablist: selected state, roving tabindex and arrow keys', async () => {
    const { wrapper } = await mountWorkspace()
    const tabs = wrapper.findAll('[data-pane]')
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1'])

    await tabs[0]!.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('[data-pane="messages"]').attributes('aria-selected')).toBe('true')
    await wrapper.get('[data-pane="messages"]').trigger('keydown', { key: 'End' })
    expect(wrapper.get('[data-pane="plan"]').attributes('aria-selected')).toBe('true')
    await wrapper.get('[data-pane="plan"]').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('[data-pane="results"]').attributes('aria-selected')).toBe('true')

    for (const tab of wrapper.findAll('[data-pane]')) {
      const panel = document.getElementById(tab.attributes('aria-controls')!)!
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.attributes('id'))
    }
  })
})

describe('execution settings', () => {
  const dialogSelector = '[data-dialog="settings"]'
  const field = (wrapper: VueWrapper, name: string) =>
    wrapper.get<HTMLInputElement>(`${dialogSelector} [name="${name}"]`)

  async function openSettings(wrapper: VueWrapper) {
    await button(wrapper, 'execution-settings').trigger('click')
    await flushPromises()
  }

  async function commit(wrapper: VueWrapper, name: string, value: string) {
    await field(wrapper, name).setValue(value)
    await field(wrapper, name).trigger('change')
    await flushPromises()
  }

  it('opens the settings screen on the execution section, with the focus on its first field', async () => {
    const { wrapper } = await mountWorkspace()
    await openSettings(wrapper)
    expect(wrapper.get(dialogSelector).attributes('open')).toBeDefined()
    expect(wrapper.find(`${dialogSelector} [data-section="execution"]`).exists()).toBe(true)
    expect(document.activeElement).toBe(field(wrapper, 'timeoutSeconds').element)
  })

  it('validates the limits, keeps the dialog open with an error and saves nothing', async () => {
    const { wrapper, fake } = await mountWorkspace()
    await openSettings(wrapper)
    await commit(wrapper, 'timeoutSeconds', '0')
    await commit(wrapper, 'maxRows', 'abc')

    const dialog = wrapper.get(dialogSelector)
    expect(dialog.attributes('open')).toBeDefined()
    expect(dialog.findAll('.form-field__error')).toHaveLength(2)
    expect(field(wrapper, 'timeoutSeconds').attributes('aria-invalid')).toBe('true')
    expect(usePreferencesStore(pinia).timeoutSeconds).toBe(30)
    expect(fake.preferences.update).not.toHaveBeenCalled()
  })

  it('sends the saved limits in the next request', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    await openSettings(wrapper)
    await commit(wrapper, 'timeoutSeconds', '60')
    await commit(wrapper, 'maxRows', '500')
    expect(fake.storedPreferences().execution).toMatchObject({ timeoutSeconds: 60, maxRows: 500 })

    await wrapper.get('[data-action="close-settings"]').trigger('click')
    await flushPromises()
    expect(wrapper.get(dialogSelector).attributes('open')).toBeUndefined()
    await button(wrapper, 'run').trigger('click')
    await flushPromises()
    expect(fake.query.execute).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 60_000, maxRows: 500 }),
    )
  })

  it('turns the destructive confirmation off from the same dialog', async () => {
    const { wrapper, fake } = await mountWorkspace()
    await openSettings(wrapper)
    await field(wrapper, 'confirmDestructive').setValue(false)
    await flushPromises()
    expect(usePreferencesStore(pinia).confirmDestructive).toBe(false)
    expect(fake.storedPreferences().execution.confirmDestructive).toBe(false)
  })

  it('discards an unsaved invalid edit when it is closed and reopened', async () => {
    const { wrapper } = await mountWorkspace()
    await openSettings(wrapper)
    await commit(wrapper, 'maxRows', '0')
    await wrapper.get('[data-action="close-settings"]').trigger('click')
    await flushPromises()
    await openSettings(wrapper)
    expect(field(wrapper, 'maxRows').element.value).toBe('10000')
    expect(wrapper.get(dialogSelector).findAll('.form-field__error')).toHaveLength(0)
  })
})

describe('history opt-out', () => {
  const checkbox = (wrapper: VueWrapper) =>
    wrapper.get<HTMLInputElement>('[data-region="execution-toolbar"] [name="saveToHistory"]')

  it('is on by default and a normal run does not ask for an opt-out', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    expect(checkbox(wrapper).element.checked).toBe(true)
    expect(checkbox(wrapper).attributes('aria-disabled')).toBeUndefined()

    await button(wrapper, 'run').trigger('click')
    await flushPromises()

    expect(fake.query.execute.mock.calls[0]![0]).not.toHaveProperty('saveToHistory')
  })

  it('sends saveToHistory: false for the tab that opted out, and only for that tab', async () => {
    const { wrapper, fake, workspace } = await mountWorkspace({ sql: 'select 1' })
    await checkbox(wrapper).setValue(false)
    expect(workspace.tabs[0]!.saveToHistory).toBe(false)

    await button(wrapper, 'run').trigger('click')
    await flushPromises()
    expect(fake.query.execute.mock.calls[0]![0]).toMatchObject({ saveToHistory: false })

    await wrapper.get('[data-action="new-tab"]').trigger('click')
    await flushPromises()
    expect(checkbox(wrapper).element.checked).toBe(true)
    workspace.activateTab('tab-1')
    await flushPromises()
    expect(checkbox(wrapper).element.checked).toBe(false)
  })

  it('keeps the opt-out through the destructive confirmation', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'DROP TABLE users' })
    await checkbox(wrapper).setValue(false)
    await button(wrapper, 'run').trigger('click')
    await flushPromises()
    expect(fake.query.execute).not.toHaveBeenCalled()

    await wrapper.get('[data-action="confirm-destructive"]').trigger('click')
    await flushPromises()

    expect(fake.query.execute.mock.calls[0]![0]).toMatchObject({ saveToHistory: false })
  })

  it('is shown off and inert, with its reason, while the history is disabled in the settings', async () => {
    const { wrapper, fake, workspace } = await mountWorkspace({ sql: 'select 1' })
    await usePreferencesStore(pinia).setHistoryEnabled(false)
    await flushPromises()

    expect(checkbox(wrapper).element.checked).toBe(false)
    expect(checkbox(wrapper).attributes('aria-disabled')).toBe('true')
    expect(
      document.getElementById(checkbox(wrapper).attributes('aria-describedby')!)!.textContent,
    ).toContain('desactivado')

    await checkbox(wrapper).trigger('click')
    await checkbox(wrapper).trigger('change')
    expect(workspace.tabs[0]!.saveToHistory).toBe(true)
    expect(checkbox(wrapper).element.checked).toBe(false)

    await button(wrapper, 'run').trigger('click')
    await flushPromises()
    expect(fake.query.execute.mock.calls[0]![0]).not.toHaveProperty('saveToHistory')
  })

  it('shows the reason of the inert checkbox as visible text, not only to assistive technology', async () => {
    const { wrapper } = await mountWorkspace({ sql: 'select 1' })
    await usePreferencesStore(pinia).setHistoryEnabled(false)
    await flushPromises()

    const reason = document.getElementById(checkbox(wrapper).attributes('aria-describedby')!)!
    expect(reason.classList.contains('visually-hidden')).toBe(false)
    expect(wrapper.get('[data-part="save-to-history"]').attributes('data-disabled')).toBe('true')
  })

  it('keeps the whole sentence of the reason and its place next to the checkbox when the compact layout hides part of it', async () => {
    const { wrapper } = await mountWorkspace({ sql: 'select 1' })
    await usePreferencesStore(pinia).setHistoryEnabled(false)
    await flushPromises()

    const reason = document.getElementById(checkbox(wrapper).attributes('aria-describedby')!)!
    expect(reason.textContent).toBe('El historial está desactivado en los ajustes.')
    expect(reason.getAttribute('title')).toBe('El historial está desactivado en los ajustes.')
    expect(reason.parentElement).toBe(wrapper.get('.exec-toolbar__history').element)
  })

  it('keeps the checkbox name whole although the compact layout shows only «Historial»', async () => {
    const { wrapper } = await mountWorkspace({ sql: 'select 1' })

    expect(wrapper.get('[data-part="save-to-history"]').text()).toBe('Guardar en el historial')
    expect(wrapper.get('.exec-toolbar__optout-word').text()).toBe('historial')
  })

  it('shows the last result without its «Última ejecución» prefix only to the eye: the text stays whole', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    await button(wrapper, 'run').trigger('click')
    await flushPromises()
    const requestId = fake.query.execute.mock.calls[0]![0].requestId
    fake.emitQueryEvent(done(requestId, 'none', 87))
    await flushPromises()

    const status = wrapper.get('[data-part="execution-indicator"]')
    expect(status.get('.exec-toolbar__status-lead').text()).toBe('Última ejecución')
    expect(status.text()).toMatch(/^Última ejecución completada \(\d+ ms\)\.$/)
    expect(status.attributes('title')).toBe(status.text())
  })

  it('opens the history from its toolbar button, announcing the shortcut', async () => {
    const { wrapper } = await mountWorkspace()
    expect(button(wrapper, 'open-history').attributes('aria-keyshortcuts')).toBe('Meta+Shift+H')

    await button(wrapper, 'open-history').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-dialog="history"]').attributes('open')).toBeDefined()
  })
})

describe('lifecycle', () => {
  it('subscribes once to the query events and unsubscribes on unmount', async () => {
    const { wrapper, fake } = await mountWorkspace()
    expect(fake.queryListenerCount()).toBe(1)
    wrapper.unmount()
    mounted = undefined
    expect(fake.queryListenerCount()).toBe(0)
  })

  it('does not leave the tab running when its session goes away', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select pg_sleep(30)' })
    await runAndCapture(wrapper, fake)
    expect(indicator(wrapper)).toContain('Ejecutando')

    await wrapper.get('[data-profile-id="pg1"] [data-action="toggle-connection"]').trigger('click')
    await flushPromises()
    expect(indicator(wrapper)).not.toContain('Ejecutando')
    expect(wrapper.get('[data-part="error"]').text()).toContain('sesión se cerró')
  })

  it('forgets rows and cancels the request when its tab is closed', async () => {
    const { wrapper, fake, workspace } = await mountWorkspace({ sql: 'select 1' })
    const requestId = await runAndCapture(wrapper, fake)
    fake.emitQueryEvent(chunk(requestId, rowsOf(0, 2)))
    expect(useResultBuffers().snapshot('tab-1').sets).toHaveLength(1)

    workspace.closeTab('tab-1')
    await flushPromises()
    expect(fake.query.cancel).toHaveBeenCalledWith({ requestId })
    expect(useResultBuffers().snapshot('tab-1').sets).toEqual([])
  })

  it('serialises no rows, SQL text or secrets in Pinia', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: "select 'sql-text-not-in-pinia'" })
    const requestId = await runAndCapture(wrapper, fake)
    fake.emitQueryEvent(chunk(requestId, [[1, 'row-value-not-in-pinia']]))
    fake.emitQueryEvent(done(requestId))
    await flushPromises()

    const serialised = JSON.stringify(pinia.state.value)
    expect(serialised).not.toContain('row-value-not-in-pinia')
    expect(serialised).not.toMatch(/"(rows|results|password)"/i)
    expect(serialised).toContain('sql-text-not-in-pinia') // el texto de la pestaña vive en `workspace`, como antes
    expect(JSON.stringify(pinia.state.value.execution)).not.toContain('sql-text-not-in-pinia')
  })
})

describe('excluding the last query from the history', () => {
  const exclude = (wrapper: VueWrapper) =>
    wrapper.find<HTMLButtonElement>(
      '[data-region="execution-toolbar"] [data-action="exclude-from-history"]',
    )
  const note = (wrapper: VueWrapper) => wrapper.find('[data-part="history-excluded"]')

  /** Ejecuta y termina la consulta; main guarda la entrada y avisa con `added` (con el requestId de la ejecución). */
  async function runAndRecord(
    wrapper: VueWrapper,
    fake: ReturnType<typeof createFakeDb>,
    entryId = 'entry-1',
  ) {
    const requestId = await runAndCapture(wrapper, fake)
    fake.emitQueryEvent(done(requestId))
    await flushPromises()
    fake.emitHistoryChange({ type: 'added', entry: makeEntry(1, { id: entryId }), requestId })
    await flushPromises()
    return requestId
  }

  it('subscribes once to the history changes and releases the subscription on unmount', async () => {
    const { wrapper, fake } = await mountWorkspace()
    expect(fake.historyListenerCount()).toBe(1)

    wrapper.unmount()
    mounted = undefined

    expect(fake.historyListenerCount()).toBe(0)
  })

  it('offers nothing before the first run, while running, or when the entry is not there', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    expect(exclude(wrapper).exists()).toBe(false)

    const requestId = await runAndCapture(wrapper, fake)
    fake.emitHistoryChange({ type: 'added', entry: makeEntry(1), requestId: 'de-otra-consulta' })
    fake.emitQueryEvent(done(requestId))
    await flushPromises()

    expect(exclude(wrapper).exists()).toBe(false)
  })

  it('shows the button once the entry of that run is recorded and deletes exactly that entry', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    await runAndRecord(wrapper, fake, 'entry-42')

    expect(exclude(wrapper).exists()).toBe(true)
    expect(exclude(wrapper).text()).toBe('Quitar del historial')

    await exclude(wrapper).trigger('click')
    await flushPromises()

    expect(fake.history.delete).toHaveBeenCalledExactlyOnceWith({ id: 'entry-42' })
  })

  it('replaces the button with a visible note, announces it and returns the focus to the editor', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    await runAndRecord(wrapper, fake)
    fake.history.delete.mockImplementationOnce(async ({ id }) => {
      fake.emitHistoryChange({ type: 'removed', id })
      return ipcOk({ deleted: 1 })
    })

    await exclude(wrapper).trigger('click')
    await flushPromises()

    expect(exclude(wrapper).exists()).toBe(false)
    expect(note(wrapper).text()).toBe('Quitada del historial')
    expect(usePaletteStore(pinia).announcement).toBe('Consulta quitada del historial')
    expect(editorView().hasFocus).toBe(true)
  })

  it('treats an entry that was already gone as done and says so', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    await runAndRecord(wrapper, fake)
    fake.history.delete.mockResolvedValueOnce(ipcOk({ deleted: 0 }))

    await exclude(wrapper).trigger('click')
    await flushPromises()

    expect(usePaletteStore(pinia).announcement).toBe('La consulta ya no estaba en el historial')
    expect(exclude(wrapper).exists()).toBe(false)
  })

  it('keeps the button and reports the failure when main cannot delete', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    await runAndRecord(wrapper, fake)
    fake.history.delete.mockResolvedValueOnce(
      ipcFail({ code: 'internal_error', message: 'Could not access the history', retryable: true }),
    )

    await exclude(wrapper).trigger('click')
    await flushPromises()

    expect(exclude(wrapper).exists()).toBe(true)
    expect(usePaletteStore(pinia).announcement).toContain('No se pudo quitar la consulta')
    expect(indicator(wrapper)).toContain('No se pudo quitar la consulta')
  })

  it('shows the note, and no button, when the entry is deleted from the history panel or cleared', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    await runAndRecord(wrapper, fake)

    fake.emitHistoryChange({ type: 'cleared' })
    await flushPromises()

    expect(exclude(wrapper).exists()).toBe(false)
    expect(note(wrapper).exists()).toBe(true)
  })

  it('a new run replaces the offer: the previous entry stays, and the new one gets its own button', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    await runAndRecord(wrapper, fake, 'first')

    await runAndRecord(wrapper, fake, 'second')
    await exclude(wrapper).trigger('click')
    await flushPromises()

    expect(fake.history.delete).toHaveBeenCalledExactlyOnceWith({ id: 'second' })
  })

  it('follows each tab: another tab has nothing to exclude and the first one keeps its button', async () => {
    const { wrapper, fake, workspace } = await mountWorkspace({ sql: 'select 1' })
    await runAndRecord(wrapper, fake)

    await wrapper.get('[data-action="new-tab"]').trigger('click')
    await flushPromises()
    expect(exclude(wrapper).exists()).toBe(false)

    workspace.activateTab('tab-1')
    await flushPromises()
    expect(exclude(wrapper).exists()).toBe(true)
  })

  it('is also a palette command, available only while there is an entry to remove', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    const { registry } = useCommandCenter(pinia)
    expect(registry.availability('history.exclude').enabled).toBe(false)

    await runAndRecord(wrapper, fake, 'entry-7')
    fake.history.delete.mockResolvedValueOnce(ipcOk({ deleted: 1 }))
    expect(registry.availability('history.exclude')).toEqual({ enabled: true })

    expect(await registry.execute('history.exclude')).toMatchObject({ ok: true })
    await flushPromises()

    expect(fake.history.delete).toHaveBeenCalledExactlyOnceWith({ id: 'entry-7' })
    expect(usePaletteStore(pinia).announcement).toBe('Consulta quitada del historial')
  })

  it('does not offer it when the run opted out of the history, because main never records it', async () => {
    const { wrapper, fake } = await mountWorkspace({ sql: 'select 1' })
    await wrapper.get<HTMLInputElement>('[name="saveToHistory"]').setValue(false)
    const requestId = await runAndCapture(wrapper, fake)
    fake.emitQueryEvent(done(requestId))
    await flushPromises()

    expect(exclude(wrapper).exists()).toBe(false)
    expect(note(wrapper).exists()).toBe(false)
  })
})
