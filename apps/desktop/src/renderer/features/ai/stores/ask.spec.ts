import {
  AI_QUESTION_MAX_LENGTH,
  DEFAULT_PREFERENCES,
  type ConnectionProfile,
  type Session,
} from '@strata/contracts'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { ipcOk } from '../../../../shared/ipc-result'
import { useConnectionsStore } from '../../connections'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { useExecutionStore } from '../../execution/stores/execution'
import { useResultBuffers } from '../../execution/model/result-buffers'
import { usePreferencesStore } from '../../preferences'
import { useWorkspaceStore } from '../../workspace/stores/workspace'
import { tabTitleFor } from '../model/ask'
import { CANNOT_ANSWER_ERROR, CANCELLED_ERROR, stubGenerateSql } from '../testing/fake-ai'
import { useAskStore } from './ask'

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
const SQL =
  'SELECT c.name, count(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY 1'

interface SetupOptions {
  aiEnabled?: boolean
  connected?: boolean
  session?: Session
  tab?: boolean
}

async function setup({
  aiEnabled = true,
  connected = true,
  session: current = session(),
  tab = true,
}: SetupOptions = {}) {
  const fake = createFakeDb({
    profiles: [profile],
    connectResult: ipcOk(current),
    preferences: {
      ...DEFAULT_PREFERENCES,
      ai: { ...DEFAULT_PREFERENCES.ai, enabled: aiEnabled },
    },
  })
  installFakeDb(fake.db)
  const backend = stubGenerateSql(fake)
  setActivePinia(createPinia())
  await usePreferencesStore().load()
  const connections = useConnectionsStore()
  await connections.load()
  if (connected) await connections.connect('p1')
  const workspace = useWorkspaceStore()
  if (tab) workspace.createTab(connected ? current.sessionId : null)
  return {
    fake,
    backend,
    ask: useAskStore(),
    workspace,
    connections,
    execution: useExecutionStore(),
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
  for (const id of ['tab-1', 'tab-2', 'tab-3']) useResultBuffers().discard(id)
})

async function ask(ctx: Awaited<ReturnType<typeof setup>>, question = QUESTION) {
  const pending = ctx.ask.submit(question)
  await flushPromises()
  return pending
}

describe('prerequisites', () => {
  it('lets you ask with the assistant on and a connected tab', async () => {
    const { ask: store } = await setup()
    expect(store.prerequisite).toBeNull()
  })

  it('reports the assistant as disabled before anything else', async () => {
    const { ask: store } = await setup({ aiEnabled: false, connected: false, tab: false })
    expect(store.prerequisite).toBe('disabled')
  })

  it('reports no tab and no session, and never calls the model in either case', async () => {
    const noTab = await setup({ connected: false, tab: false })
    expect(noTab.ask.prerequisite).toBe('no-tab')
    await noTab.ask.submit(QUESTION)
    expect(noTab.fake.ai.generateSql).not.toHaveBeenCalled()

    const noSession = await setup({ connected: false })
    expect(noSession.ask.prerequisite).toBe('no-session')
    await noSession.ask.submit(QUESTION)
    expect(noSession.fake.ai.generateSql).not.toHaveBeenCalled()
    expect(noSession.ask.phase).toBe('idle')
  })

  it('does not call the model with the assistant disabled', async () => {
    const ctx = await setup({ aiEnabled: false })
    await ctx.ask.submit(QUESTION)
    expect(ctx.fake.ai.generateSql).not.toHaveBeenCalled()
    expect(ctx.workspace.tabs).toHaveLength(1)
  })

  it('does not send a blank or an oversized question', async () => {
    const ctx = await setup()
    await ctx.ask.submit('   \n ')
    await ctx.ask.submit('x'.repeat(AI_QUESTION_MAX_LENGTH + 1))
    expect(ctx.fake.ai.generateSql).not.toHaveBeenCalled()
    expect(ctx.ask.phase).toBe('idle')
  })
})

describe('generating', () => {
  it('sends the trimmed question with the session of the active connection and a fresh request id', async () => {
    const ctx = await setup()
    void ctx.ask.submit(`  ${QUESTION}  `)
    await flushPromises()

    expect(ctx.ask.phase).toBe('generating')
    expect(ctx.fake.ai.generateSql).toHaveBeenCalledTimes(1)
    expect(ctx.backend.request()).toEqual({
      requestId: expect.any(String),
      sessionId: 's1',
      question: QUESTION,
    })
  })

  it('ignores a second question while one is in flight', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    await ctx.ask.submit('otra pregunta')
    expect(ctx.fake.ai.generateSql).toHaveBeenCalledTimes(1)
  })

  it('uses the connection selected in the sidebar when the tab has no session', async () => {
    const ctx = await setup({ tab: false })
    ctx.workspace.createTab(null)
    ctx.connections.select('p1')
    expect(ctx.ask.prerequisite).toBeNull()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    expect(ctx.backend.request().sessionId).toBe('s1')
  })
})

describe('a read query', () => {
  it('opens a new tab with the SQL, links it to the session, titles it and runs it read-only', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.backend.answer({ sql: SQL })
    await flushPromises()

    expect(ctx.ask.phase).toBe('ready')
    expect(ctx.workspace.tabs).toHaveLength(2)
    const tab = ctx.workspace.activeTab!
    expect(tab.id).toBe('tab-2')
    expect(tab).toMatchObject({
      title: tabTitleFor(QUESTION),
      content: SQL,
      sessionId: 's1',
    })
    expect(ctx.fake.query.execute).toHaveBeenCalledTimes(1)
    expect(ctx.fake.query.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', sql: SQL, enforceReadOnly: true }),
    )
    expect(ctx.execution.stateOf('tab-2').status).toBe('running')
    expect(ctx.ask.outcome).toMatchObject({
      sql: SQL,
      risk: 'read',
      blocked: false,
      decision: { run: true },
      tabId: 'tab-2',
      tabTitle: tab.title,
    })
  })

  it('does not wait for the execution to finish to report it is ready', async () => {
    const ctx = await setup()
    ctx.fake.query.execute.mockImplementation(() => new Promise(() => undefined))
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.backend.answer({ sql: SQL })
    await flushPromises()
    expect(ctx.ask.phase).toBe('ready')
  })

  it('carries the warnings through', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.backend.answer({ sql: SQL, warnings: ['schema_truncated', 'formatting_removed'] })
    await flushPromises()
    expect(ctx.ask.outcome?.warnings).toEqual(['schema_truncated', 'formatting_removed'])
  })
})

describe('anything that is not a plain read', () => {
  it.each([
    ['write', 'dml', "UPDATE orders SET status = 'x' WHERE id = 1"],
    ['destructive', 'dml', 'DELETE FROM orders'],
    ['destructive', 'ddl', 'DROP TABLE orders'],
    ['unknown', 'transaction', 'BEGIN'],
    ['unknown', 'session', 'SET search_path = evil'],
    ['read', 'other', 'SHOW server_version'],
  ] as const)(
    'opens a %s %s statement in a tab and does NOT run it',
    async (risk, statementType, sql) => {
      const ctx = await setup()
      void ctx.ask.submit('borra todos los pedidos')
      await flushPromises()
      ctx.backend.answer({ sql, risk, statementType })
      await flushPromises()

      expect(ctx.fake.query.execute).not.toHaveBeenCalled()
      expect(ctx.workspace.activeTab).toMatchObject({ content: sql, sessionId: 's1' })
      expect(ctx.execution.stateOf('tab-2').status).toBe('idle')
      expect(ctx.ask.phase).toBe('ready')
      expect(ctx.ask.outcome?.decision).toEqual({ run: false, reason: 'risk' })
      expect(ctx.ask.outcome?.risk).toBe(risk)
    },
  )

  it('opens a blocked statement in a tab without running it', async () => {
    const ctx = await setup({ session: session({ readOnly: true }) })
    void ctx.ask.submit('borra todos los pedidos')
    await flushPromises()
    ctx.backend.answer({
      sql: 'DELETE FROM orders',
      risk: 'destructive',
      statementType: 'dml',
      warnings: ['read_only_blocked'],
      blocked: true,
    })
    await flushPromises()

    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
    expect(ctx.workspace.activeTab?.content).toBe('DELETE FROM orders')
    expect(ctx.ask.outcome).toMatchObject({
      blocked: true,
      decision: { run: false, reason: 'blocked' },
    })
  })

  it('does not run even a read the model marked blocked', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.backend.answer({ sql: SQL, blocked: true })
    await flushPromises()
    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
  })

  it.each(['active', 'aborted'] as const)(
    'does not run a read by itself inside a %s transaction',
    async (transaction) => {
      const ctx = await setup({ session: session({ transaction }) })
      void ctx.ask.submit(QUESTION)
      await flushPromises()
      ctx.backend.answer({ sql: SQL })
      await flushPromises()

      expect(ctx.fake.query.execute).not.toHaveBeenCalled()
      expect(ctx.workspace.activeTab?.content).toBe(SQL)
      expect(ctx.ask.outcome?.decision).toEqual({ run: false, reason: 'transaction' })
    },
  )

  it('reads the transaction state when the answer arrives, not when the question was sent', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.connections.applyTransaction('s1', 'active')
    ctx.backend.answer({ sql: SQL })
    await flushPromises()

    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
    expect(ctx.ask.outcome?.decision).toEqual({ run: false, reason: 'transaction' })
  })

  it('does not run while another tab is executing in the same session', async () => {
    const ctx = await setup()
    await ctx.execution.run('tab-1', {
      sessionId: 's1',
      sql: 'select pg_sleep(9)',
      scope: 'document',
    })
    expect(ctx.execution.stateOf('tab-1').status).toBe('running')
    ctx.fake.query.execute.mockClear()

    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.backend.answer({ sql: SQL })
    await flushPromises()

    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
    expect(ctx.workspace.activeTab?.content).toBe(SQL)
    expect(ctx.ask.outcome?.decision).toEqual({ run: false, reason: 'busy' })
  })
})

describe('cancelling and late answers', () => {
  it('cancels the generation in main and opens nothing', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    const { requestId } = ctx.backend.request()

    ctx.ask.cancel()
    await flushPromises()

    expect(ctx.fake.ai.cancel).toHaveBeenCalledWith({ requestId })
    expect(ctx.ask.phase).toBe('cancelled')
    expect(ctx.workspace.tabs).toHaveLength(1)
    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
  })

  it('discards an answer that arrives after the cancellation', async () => {
    const ctx = await setup()
    ctx.fake.ai.cancel.mockImplementation(async ({ requestId }) =>
      ipcOk({ requestId, outcome: 'not_running' }),
    )
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.ask.cancel()
    ctx.backend.answer({ sql: 'DELETE FROM orders', risk: 'destructive', statementType: 'dml' })
    await flushPromises()

    expect(ctx.ask.phase).toBe('cancelled')
    expect(ctx.ask.outcome).toBeNull()
    expect(ctx.workspace.tabs).toHaveLength(1)
    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
  })

  it('never lets the late answer of a cancelled question overwrite the new one', async () => {
    const ctx = await setup()
    ctx.fake.ai.cancel.mockImplementation(async ({ requestId }) =>
      ipcOk({ requestId, outcome: 'not_running' }),
    )
    void ctx.ask.submit('primera')
    await flushPromises()
    ctx.ask.cancel()
    void ctx.ask.submit('segunda pregunta')
    await flushPromises()
    expect(ctx.backend.count()).toBe(2)

    ctx.backend.answer({ sql: 'SELECT 1 AS primera' }, 0)
    await flushPromises()
    expect(ctx.ask.phase).toBe('generating')
    expect(ctx.workspace.tabs).toHaveLength(1)

    ctx.backend.answer({ sql: 'SELECT 2 AS segunda' })
    await flushPromises()
    expect(ctx.ask.phase).toBe('ready')
    expect(ctx.workspace.activeTab?.content).toBe('SELECT 2 AS segunda')
    expect(ctx.workspace.tabs).toHaveLength(2)
  })

  it('ignores a cancel when nothing is generating', async () => {
    const ctx = await setup()
    ctx.ask.cancel()
    expect(ctx.ask.phase).toBe('idle')
    expect(ctx.fake.ai.cancel).not.toHaveBeenCalled()
  })

  it('closing the dialog while generating cancels the request', async () => {
    const ctx = await setup()
    ctx.ask.open()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.ask.close()
    await flushPromises()

    expect(ctx.ask.isOpen).toBe(false)
    expect(ctx.fake.ai.cancel).toHaveBeenCalledTimes(1)
    expect(ctx.ask.phase).toBe('cancelled')
  })
})

describe('errors', () => {
  it.each([
    'permission_denied',
    'connection_failed',
    'not_found',
    'timeout',
    'validation_failed',
    'busy',
    'transaction_aborted',
  ] as const)('moves to the error state on an IpcResult failure with code %s', async (code) => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.backend.fail({ code, message: 'boom', retryable: false })
    await flushPromises()

    expect(ctx.ask.phase).toBe('error')
    expect(ctx.ask.error?.code).toBe(code)
    expect(ctx.ask.outcome).toBeNull()
    expect(ctx.workspace.tabs).toHaveLength(1)
    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
  })

  it('keeps cannot_answer as an error the dialog can explain', async () => {
    const ctx = await setup()
    void ctx.ask.submit('¿cuál es el sentido de la vida?')
    await flushPromises()
    ctx.backend.fail(CANNOT_ANSWER_ERROR)
    await flushPromises()
    expect(ctx.ask.phase).toBe('error')
    expect(ctx.ask.error?.code).toBe('cannot_answer')
  })

  it('treats a cancelled error from main as a cancellation, not a failure', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.backend.fail(CANCELLED_ERROR)
    await flushPromises()
    expect(ctx.ask.phase).toBe('cancelled')
    expect(ctx.ask.error).toEqual(CANCELLED_ERROR)
  })

  it('turns a malformed response into an error instead of opening a tab', async () => {
    const ctx = await setup()
    ctx.fake.ai.generateSql.mockResolvedValue(ipcOk({ requestId: 'x', sql: '' } as never))
    await ask(ctx)
    expect(ctx.ask.phase).toBe('error')
    expect(ctx.workspace.tabs).toHaveLength(1)
    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
  })

  it('turns a thrown IPC exception into an error', async () => {
    const ctx = await setup()
    ctx.fake.ai.generateSql.mockRejectedValue(new Error('Error invoking remote method'))
    await ask(ctx)
    expect(ctx.ask.phase).toBe('error')
    expect(ctx.ask.error).not.toBeNull()
  })

  it('reports the session as gone when it closed while the model was working', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    await ctx.connections.disconnect('p1')
    ctx.backend.answer({ sql: SQL })
    await flushPromises()

    expect(ctx.ask.phase).toBe('error')
    expect(ctx.ask.error?.code).toBe('no_session')
    expect(ctx.fake.query.execute).not.toHaveBeenCalled()
    expect(ctx.workspace.tabs).toHaveLength(1)
  })

  it('can ask again after an error', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.backend.fail(CANNOT_ANSWER_ERROR)
    await flushPromises()

    void ctx.ask.submit(QUESTION)
    await flushPromises()
    expect(ctx.ask.phase).toBe('generating')
    expect(ctx.ask.error).toBeNull()
  })
})

describe('open and privacy', () => {
  it('starts every opening from a clean state', async () => {
    const ctx = await setup()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.backend.answer({ sql: SQL })
    await flushPromises()
    ctx.ask.close()

    ctx.ask.open()
    expect(ctx.ask.isOpen).toBe(true)
    expect(ctx.ask.phase).toBe('idle')
    expect(ctx.ask.outcome).toBeNull()
  })

  it('keeps a running generation when it is opened again', async () => {
    const ctx = await setup()
    ctx.ask.open()
    void ctx.ask.submit(QUESTION)
    await flushPromises()
    ctx.ask.open()
    expect(ctx.ask.phase).toBe('generating')
  })

  it('does not keep the question anywhere in the store or in the tab beyond its abbreviated title', async () => {
    const ctx = await setup()
    const question = 'muéstrame el saldo de la cuenta 4111-1111 de Marta Fernández Ruiz por favor'
    void ctx.ask.submit(question)
    await flushPromises()
    ctx.backend.answer({ sql: SQL })
    await flushPromises()

    expect(JSON.stringify(ctx.ask.$state)).not.toContain('Marta')
    const tab = ctx.workspace.activeTab!
    expect(tab.content).toBe(SQL)
    expect(tab.title.length).toBeLessThan(question.length)
    expect(JSON.stringify(ctx.workspace.tabs)).not.toContain('Fernández')
  })
})
