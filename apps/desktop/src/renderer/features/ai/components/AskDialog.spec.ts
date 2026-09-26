import {
  DEFAULT_PREFERENCES,
  type ConnectionProfile,
  type NormalizedError,
  type Session,
} from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { useConnectionsStore } from '../../connections'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { useResultBuffers } from '../../execution/model/result-buffers'
import { usePreferencesStore } from '../../preferences'
import { registerEditor } from '../../query-editor/composables/use-query-editor'
import { useSettingsStore } from '../../settings/stores/settings'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { CANNOT_ANSWER_ERROR, CONNECTION_ERROR, stubGenerateSql } from '../testing/fake-ai'
import { useAskStore } from '../stores/ask'
import AskDialog from './AskDialog.vue'

const profile: ConnectionProfile = {
  id: 'p1',
  engine: 'sqlite',
  name: 'Tienda',
  readOnly: false,
  filePath: '/tmp/tienda.db',
}

const session = (overrides: Partial<Session> = {}): Session => ({
  sessionId: 's1',
  profileId: 'p1',
  engine: 'sqlite',
  serverVersion: '3.46',
  readOnly: false,
  transaction: 'none',
  ...overrides,
})

const QUESTION = '¿cuántos pedidos hay por cliente?'

let wrapper: VueWrapper | undefined
let pinia: Pinia
let unregister: (() => void) | undefined
const focusEditor = vi.fn()

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X)')
  focusEditor.mockClear()
  unregister = registerEditor({
    executionText: () => null as never,
    documentText: () => null as never,
    focus: focusEditor,
    format: async () => true,
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  unregister?.()
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'db')
  for (const id of ['tab-1', 'tab-2']) useResultBuffers().discard(id)
  vi.restoreAllMocks()
})

interface SetupOptions {
  aiEnabled?: boolean
  connected?: boolean
  session?: Session
  open?: boolean
}

async function setup({
  aiEnabled = true,
  connected = true,
  session: current = session(),
  open = true,
}: SetupOptions = {}) {
  const fake = createFakeDb({
    profiles: [profile],
    connectResult: ipcOk(current),
    preferences: { ...DEFAULT_PREFERENCES, ai: { ...DEFAULT_PREFERENCES.ai, enabled: aiEnabled } },
  })
  installFakeDb(fake.db)
  const backend = stubGenerateSql(fake)
  pinia = createPinia()
  wrapper = mount(AskDialog, { global: { plugins: [pinia] }, attachTo: document.body })
  await usePreferencesStore(pinia).load()
  const connections = useConnectionsStore(pinia)
  await connections.load()
  if (connected) await connections.connect('p1')
  const workspace = useWorkspaceStore(pinia)
  workspace.createTab(connected ? current.sessionId : null)
  await flushPromises()
  const store = useAskStore(pinia)
  if (open) {
    store.open()
    await flushPromises()
  }
  return { fake, backend, store, workspace, settings: useSettingsStore(pinia) }
}

const dialog = () => wrapper!.get<HTMLDialogElement>('[data-dialog="ask"]')
const isOpen = () => dialog().element.open
const textarea = () => dialog().get<HTMLTextAreaElement>('textarea[name="question"]')
const status = () => dialog().get('[data-part="ask-status"]').text()
const submitButton = () => dialog().get('[data-action="submit-ask"]')

async function type(text: string) {
  await textarea().setValue(text)
}

async function pressInTextarea(init: KeyboardEventInit) {
  await textarea().trigger('keydown', { key: 'Enter', ...init })
  await flushPromises()
}

async function ask(text = QUESTION) {
  await type(text)
  await pressInTextarea({ metaKey: true })
}

async function answer(
  ctx: Awaited<ReturnType<typeof setup>>,
  result: Parameters<Awaited<ReturnType<typeof setup>>['backend']['answer']>[0] = {},
) {
  ctx.backend.answer(result)
  await flushPromises()
}

async function pressEscape() {
  await dialog().trigger('cancel')
  await flushPromises()
}

describe('opening and the form', () => {
  it('is closed until asked to open', async () => {
    await setup({ open: false })
    expect(isOpen()).toBe(false)
    expect(wrapper!.find('textarea').exists()).toBe(false)
  })

  it('opens labelled, with the question focused and the counter and shortcut in its hint', async () => {
    await setup()
    expect(isOpen()).toBe(true)
    expect(dialog().attributes('aria-labelledby')).toBeTruthy()
    expect(document.getElementById(dialog().attributes('aria-labelledby')!)!.textContent).toBe(
      'Preguntar a la base',
    )
    expect(wrapper!.get('label').text()).toBe('Tu pregunta')
    expect(document.activeElement).toBe(textarea().element)
    expect(textarea().attributes('maxlength')).toBe('2000')
    const hintId = textarea().attributes('aria-describedby')!
    expect(document.getElementById(hintId)!.textContent).toBe('0 / 2000 · ⌘↵ para preguntar')

    await type('hola')
    expect(document.getElementById(hintId)!.textContent).toContain('4 / 2000')
  })

  it('starts empty every time it opens: the question is not remembered', async () => {
    const { store } = await setup()
    await type('algo privado')
    store.close()
    await flushPromises()
    store.open()
    await flushPromises()
    expect(textarea().element.value).toBe('')
  })

  it('keeps the send button unavailable until there is a question', async () => {
    await setup()
    expect(submitButton().attributes('aria-disabled')).toBe('true')
    await type('   ')
    expect(submitButton().attributes('aria-disabled')).toBe('true')
    await type('algo')
    expect(submitButton().attributes('aria-disabled')).toBeUndefined()
  })
})

describe('keyboard', () => {
  it('Cmd+Enter sends the question on macOS', async () => {
    const { fake, backend } = await setup()
    await ask()
    expect(fake.ai.generateSql).toHaveBeenCalledTimes(1)
    expect(backend.request().question).toBe(QUESTION)
  })

  it('Ctrl+Enter is the shortcut elsewhere and Cmd+Enter is not', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64)')
    const { fake } = await setup()
    await type(QUESTION)
    await pressInTextarea({ metaKey: true })
    expect(fake.ai.generateSql).not.toHaveBeenCalled()
    await pressInTextarea({ ctrlKey: true })
    expect(fake.ai.generateSql).toHaveBeenCalledTimes(1)
    expect(
      document.getElementById(textarea().attributes('aria-describedby')!)!.textContent,
    ).toContain('Ctrl+Enter')
  })

  it('a plain Enter, Shift+Enter or Ctrl+Enter on macOS do not send (Enter writes a new line)', async () => {
    const { fake } = await setup()
    await type(QUESTION)
    await pressInTextarea({})
    await pressInTextarea({ shiftKey: true })
    await pressInTextarea({ ctrlKey: true })
    await pressInTextarea({ metaKey: true, altKey: true })
    expect(fake.ai.generateSql).not.toHaveBeenCalled()
  })

  it('does not send an empty question with the shortcut', async () => {
    const { fake } = await setup()
    await pressInTextarea({ metaKey: true })
    expect(fake.ai.generateSql).not.toHaveBeenCalled()
  })

  it('the send button asks too', async () => {
    const { fake } = await setup()
    await type(QUESTION)
    await submitButton().trigger('click')
    await flushPromises()
    expect(fake.ai.generateSql).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the dialog and hands the focus to the editor', async () => {
    const { store } = await setup()
    await pressEscape()
    expect(store.isOpen).toBe(false)
    expect(isOpen()).toBe(false)
    expect(focusEditor).toHaveBeenCalled()
  })

  it('Escape while generating cancels first and keeps the dialog and the text; the next Escape closes', async () => {
    const ctx = await setup()
    await ask()
    expect(ctx.store.phase).toBe('generating')
    const { requestId } = ctx.backend.request()

    await pressEscape()
    expect(ctx.fake.ai.cancel).toHaveBeenCalledWith({ requestId })
    expect(ctx.store.phase).toBe('cancelled')
    expect(isOpen()).toBe(true)
    expect(textarea().element.value).toBe(QUESTION)
    expect(textarea().attributes('readonly')).toBeUndefined()
    expect(document.activeElement).toBe(textarea().element)

    await pressEscape()
    expect(isOpen()).toBe(false)
    expect(focusEditor).toHaveBeenCalled()
    expect(ctx.workspace.tabs).toHaveLength(1)
  })

  it('the close button hands the focus to the editor too and cancels a generation in flight', async () => {
    const ctx = await setup()
    await ask()
    await dialog().get('[data-action="close-ask"]').trigger('click')
    await flushPromises()
    expect(isOpen()).toBe(false)
    expect(ctx.fake.ai.cancel).toHaveBeenCalled()
    expect(focusEditor).toHaveBeenCalled()
  })
})

describe('states', () => {
  it('shows generating with a busy notice, a read-only textarea and a cancel button, and announces it', async () => {
    await setup()
    await ask()
    expect(dialog().get('[data-state="generating"]').attributes('aria-busy')).toBe('true')
    expect(textarea().attributes('readonly')).toBeDefined()
    expect(submitButton().attributes('aria-disabled')).toBe('true')
    expect(dialog().find('[data-action="cancel-ask"]').exists()).toBe(true)
    expect(status()).toBe('Generando la consulta…')
  })

  it('the cancel button abandons the request and brings the focus back to the question', async () => {
    const ctx = await setup()
    await ask()
    await dialog().get('[data-action="cancel-ask"]').trigger('click')
    await flushPromises()
    expect(ctx.store.phase).toBe('cancelled')
    expect(dialog().get('[data-state="cancelled"]').text()).toContain('cancelada')
    expect(status()).toBe('Generación cancelada.')
    expect(document.activeElement).toBe(textarea().element)
  })

  it('announces a read query as ready and shows chip, SQL and the outcome in a polite live region', async () => {
    const ctx = await setup()
    await ask()
    await answer(ctx, { sql: 'SELECT c.name FROM customers c' })

    const region = dialog().get('[data-part="ask-status"]')
    expect(region.attributes('role')).toBe('status')
    expect(region.attributes('aria-live')).toBe('polite')
    expect(status()).toContain('Consulta lista, riesgo: lectura.')
    expect(status()).toContain('se ha ejecutado en la pestaña')

    const result = dialog().get('[data-state="ready"]')
    expect(result.get('[data-part="risk-chip"]').text()).toContain('Riesgo: Lectura')
    expect(result.get('[data-part="risk-chip"]').attributes('data-risk')).toBe('read')
    expect(result.get('[data-part="generated-sql"]').text()).toBe('SELECT c.name FROM customers c')
    expect(result.get('[data-part="run-outcome"]').classes()).toContain('callout--success')
    expect(result.text()).toContain(ctx.workspace.activeTab!.title)
    expect(dialog().find('[data-part="blocked-reason"]').exists()).toBe(false)
  })

  it('shows a destructive query as not run, with its chip, and no success', async () => {
    const ctx = await setup()
    await ask('borra todos los pedidos')
    await answer(ctx, { sql: 'DELETE FROM orders', risk: 'destructive', statementType: 'dml' })

    const chip = dialog().get('[data-part="risk-chip"]')
    expect(chip.attributes('data-risk')).toBe('destructive')
    expect(chip.text()).toContain('Destructiva')
    const outcome = dialog().get('[data-part="run-outcome"]')
    expect(outcome.text()).toContain('No se ha ejecutado')
    expect(outcome.classes()).toContain('callout--warning')
    expect(status()).toContain('riesgo: destructiva')
    expect(ctxExecuted(ctx)).toBe(false)
  })

  it('explains a blocked statement and leaves it unexecuted', async () => {
    const ctx = await setup({ session: session({ readOnly: true }) })
    await ask('borra todos los pedidos')
    await answer(ctx, {
      sql: 'DELETE FROM orders',
      risk: 'destructive',
      statementType: 'dml',
      warnings: ['read_only_blocked'],
      blocked: true,
    })

    expect(dialog().get('[data-part="blocked-reason"]').text()).toContain('solo lectura')
    expect(dialog().get('[data-part="run-outcome"]').classes()).toContain('callout--error')
    expect(dialog().find('[data-part="ask-warnings"]').exists()).toBe(false)
    expect(ctxExecuted(ctx)).toBe(false)
  })

  it('lists the warnings of the model output with the interface wording', async () => {
    const ctx = await setup()
    await ask()
    await answer(ctx, { warnings: ['schema_truncated', 'formatting_removed'] })
    const items = dialog().findAll('[data-part="ask-warnings"] li')
    expect(items).toHaveLength(2)
    expect(items[0]!.text()).toContain('esquema')
  })

  it('does not run a read inside a transaction and says why', async () => {
    const ctx = await setup({ session: session({ transaction: 'active' }) })
    await ask()
    await answer(ctx)
    expect(dialog().get('[data-part="run-outcome"]').text()).toContain('transacción')
    expect(ctxExecuted(ctx)).toBe(false)
  })

  it.each([
    [CANNOT_ANSWER_ERROR, 'reformula la pregunta', false],
    [CONNECTION_ERROR, 'servidor de modelos', true],
    [{ code: 'timeout', message: 'x', retryable: true }, 'tardó demasiado', false],
  ] as [NormalizedError, string, boolean][])(
    'shows an error (%#) in our own words, never the server text',
    async (error, fragment, hasSettings) => {
      const ctx = await setup()
      await ask()
      ctx.backend.fail(error)
      await flushPromises()

      const box = dialog().get('[data-state="error"]')
      expect(box.text()).toContain(fragment)
      expect(box.text()).not.toContain(error.message === 'x' ? '\u0000' : error.message)
      expect(box.find('[data-action="open-ai-settings"]').exists()).toBe(hasSettings)
      expect(status()).toContain(fragment)
      expect(document.activeElement).toBe(textarea().element)
    },
  )

  it('lets you fix the question and ask again after an error', async () => {
    const ctx = await setup()
    await ask()
    ctx.backend.fail(CANNOT_ANSWER_ERROR)
    await flushPromises()
    await pressInTextarea({ metaKey: true })
    expect(ctx.fake.ai.generateSql).toHaveBeenCalledTimes(2)
    expect(dialog().find('[data-state="error"]').exists()).toBe(false)
  })
})

describe('the generated SQL is text, never markup', () => {
  const PAYLOAD = '<img src=x onerror="window.__pwned = true">'

  it('renders hostile SQL as plain text', async () => {
    const ctx = await setup()
    await ask()
    await answer(ctx, { sql: `SELECT '${PAYLOAD}' AS x` })

    const pre = dialog().get('[data-part="generated-sql"]')
    expect(pre.element.tagName).toBe('PRE')
    expect(pre.text()).toBe(`SELECT '${PAYLOAD}' AS x`)
    expect(pre.find('img').exists()).toBe(false)
    expect(dialog().find('img').exists()).toBe(false)
    expect(document.querySelector('img')).toBeNull()
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('renders markup in the tab title and the announcement as text too', async () => {
    const ctx = await setup()
    await ask(`<img src=x onerror=alert(1)> ${QUESTION}`)
    await answer(ctx)
    expect(dialog().find('img').exists()).toBe(false)
    expect(dialog().get('[data-state="ready"]').text()).toContain('<img src=x')
    expect(status()).toContain('<img src=x')
  })
})

describe('prerequisites', () => {
  it('with the assistant off, explains it and offers the AI settings without touching the model', async () => {
    const { fake, settings, store } = await setup({ aiEnabled: false })
    const notice = dialog().get('[data-part="ask-prerequisite"]')
    expect(notice.attributes('data-reason')).toBe('disabled')
    expect(notice.text()).toContain('La IA local está desactivada')
    expect(wrapper!.find('textarea').exists()).toBe(false)
    const button = notice.get('[data-action="open-ai-settings"]')
    expect(document.activeElement).toBe(button.element)

    await button.trigger('click')
    await flushPromises()
    expect(store.isOpen).toBe(false)
    expect(isOpen()).toBe(false)
    expect(settings.isOpen).toBe(true)
    expect(settings.section).toBe('ai')
    expect(fake.ai.generateSql).not.toHaveBeenCalled()
  })

  it('closes the dialog before opening the settings so the two never overlap', async () => {
    const { settings, store } = await setup({ aiEnabled: false })
    const order: string[] = []
    const open = settings.open
    settings.open = (section) => {
      order.push(`settings:${store.isOpen ? 'ask-still-open' : 'ask-closed'}`)
      open(section)
    }
    await dialog().get('[data-action="open-ai-settings"]').trigger('click')
    await flushPromises()
    expect(order).toEqual(['settings:ask-closed'])
  })

  it('without a connected tab says so, has no form and never calls the model', async () => {
    const { fake } = await setup({ connected: false })
    const notice = dialog().get('[data-part="ask-prerequisite"]')
    expect(notice.attributes('data-reason')).toBe('no-session')
    expect(notice.text()).toContain('no tiene una conexión abierta')
    expect(notice.find('[data-action="open-ai-settings"]').exists()).toBe(false)
    expect(wrapper!.find('textarea').exists()).toBe(false)
    expect(document.activeElement).toBe(dialog().get('[data-action="close-ask"]').element)
    expect(fake.ai.generateSql).not.toHaveBeenCalled()
  })

  it('without any tab asks to open one', async () => {
    const { workspace } = await setup({ connected: false })
    workspace.closeActiveTab()
    await flushPromises()
    expect(dialog().get('[data-part="ask-prerequisite"]').attributes('data-reason')).toBe('no-tab')
  })
})

function ctxExecuted(ctx: Awaited<ReturnType<typeof setup>>): boolean {
  return ctx.fake.query.execute.mock.calls.length > 0
}
