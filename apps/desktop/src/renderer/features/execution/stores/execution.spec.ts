import type { ConnectionProfile, Session } from '@strata/contracts'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { useConnectionsStore } from '../../connections'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { usePreferencesStore } from '../../preferences'
import { useResultBuffers } from '../model/result-buffers'
import { cancelled, chunk, done, failed, rowsOf, statementDone } from '../testing/events'
import { MAX_STATEMENT_SUMMARIES, STALE_CANCEL_MS, useExecutionStore } from './execution'

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

let pinia: Pinia
let fake: ReturnType<typeof createFakeDb>

beforeEach(async () => {
  pinia = createPinia()
  setActivePinia(pinia)
  fake = createFakeDb({ profiles: [profile], connectResult: ipcOk(session) })
  installFakeDb(fake.db)
  const connections = useConnectionsStore()
  await connections.load()
  await connections.connect('p1')
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'db')
  useResultBuffers().discard('tab-1')
  useResultBuffers().discard('tab-2')
})

const RUN = { sessionId: 's1', sql: 'select 1', scope: 'document' as const }

async function start(tabId = 'tab-1', input = RUN) {
  const store = useExecutionStore()
  await store.run(tabId, input)
  const requestId = store.stateOf(tabId).requestId!
  return { store, requestId }
}

const transactionOf = () => useConnectionsStore().runtimeOf('p1').session?.transaction

describe('execution store: lifecycle', () => {
  it('sends a unique request with the session, text and the configured limits', async () => {
    usePreferencesStore().setExecutionLimits({ timeoutSeconds: 45, maxRows: 250 })
    const first = await start('tab-1')
    await start('tab-2', { ...RUN, sessionId: 's2' })

    const [request, other] = fake.query.execute.mock.calls.map(([sent]) => sent)
    expect(request).toEqual({
      requestId: first.requestId,
      sessionId: 's1',
      sql: 'select 1',
      timeoutMs: 45_000,
      maxRows: 250,
    })
    expect(other!.requestId).not.toBe(request!.requestId)
    expect(first.store.stateOf('tab-1')).toMatchObject({
      status: 'running',
      scope: 'document',
      limits: { timeoutSeconds: 45, maxRows: 250 },
    })
  })

  it('accumulates chunks in the buffer, acks each one and finishes on done', async () => {
    const { store, requestId } = await start()
    store.applyEvent(chunk(requestId, rowsOf(0, 3), 0))
    store.applyEvent(chunk(requestId, rowsOf(3, 2), 1))

    expect(fake.query.ack.mock.calls.map(([ack]) => ack)).toEqual([
      { requestId, statementIndex: 0, chunkIndex: 0 },
      { requestId, statementIndex: 0, chunkIndex: 1 },
    ])
    expect(store.stateOf('tab-1').rowsReceived).toBe(5)
    expect(useResultBuffers().snapshot('tab-1').sets[0]!.rows).toHaveLength(5)

    store.applyEvent(statementDone(requestId, { rowsReturned: 5, durationMs: 3 }))
    store.applyEvent(done(requestId, 'none', 1500))

    const state = store.stateOf('tab-1')
    expect(state).toMatchObject({
      status: 'idle',
      requestId: null,
      outcome: 'done',
      durationMs: 1500,
      statementsDone: 1,
      statementCount: 1,
      error: null,
    })
    expect(state.messages.map((message) => message.kind)).toEqual(['statement', 'success'])
    expect(state.messages[1]!.text).toContain('1,50 s')
  })

  it('ignores events for unknown request ids and after the terminal event', async () => {
    const { store, requestId } = await start()
    store.applyEvent(chunk('someone-else', rowsOf(0, 2)))
    expect(fake.query.ack).not.toHaveBeenCalled()

    store.applyEvent(done(requestId))
    store.applyEvent(chunk(requestId, rowsOf(0, 2)))
    expect(fake.query.ack).not.toHaveBeenCalled()
    expect(store.stateOf('tab-1').rowsReceived).toBe(0)
  })

  it('bounds the row buffer to the requested maxRows without losing the count', async () => {
    usePreferencesStore().setExecutionLimits({ timeoutSeconds: 30, maxRows: 4 })
    const { store, requestId } = await start()
    store.applyEvent(chunk(requestId, rowsOf(0, 3), 0))
    store.applyEvent(chunk(requestId, rowsOf(3, 3), 1))

    const [set] = useResultBuffers().snapshot('tab-1').sets
    expect(set!.rows).toHaveLength(4)
    expect(set!.rowsReceived).toBe(6)
    expect(store.stateOf('tab-1').rowsReceived).toBe(6)
    // Ambos chunks se confirman igualmente: el backpressure no depende de lo que cabe en el búfer.
    expect(fake.query.ack).toHaveBeenCalledTimes(2)
  })

  it('drops the previous rows when a new execution starts and on closing the tab', async () => {
    const first = await start()
    first.store.applyEvent(chunk(first.requestId, rowsOf(0, 3)))
    first.store.applyEvent(done(first.requestId))
    expect(useResultBuffers().snapshot('tab-1').sets).toHaveLength(1)

    const second = await start()
    expect(second.requestId).not.toBe(first.requestId)
    expect(useResultBuffers().snapshot('tab-1').sets).toEqual([])
    expect(second.store.stateOf('tab-1').messages).toEqual([])

    second.store.forgetTab('tab-1')
    expect(second.store.stateOf('tab-1').status).toBe('idle')
    expect(useResultBuffers().snapshot('tab-1').version).toBe(0)
  })

  it('cancels a running request when its tab is forgotten and ignores its late events', async () => {
    const { store, requestId } = await start()
    store.forgetTab('tab-1')
    expect(fake.query.cancel).toHaveBeenCalledWith({ requestId })
    store.applyEvent(chunk(requestId, rowsOf(0, 1)))
    expect(fake.query.ack).not.toHaveBeenCalled()
  })

  it('does not start a second execution on a busy tab', async () => {
    const { store } = await start()
    await store.run('tab-1', RUN)
    expect(fake.query.execute).toHaveBeenCalledTimes(1)
  })

  it('routes the events of interleaved tabs to their own owner', async () => {
    const one = await start('tab-1')
    const two = await start('tab-2', { ...RUN, sessionId: 's2' })
    two.store.applyEvent(chunk(two.requestId, rowsOf(0, 2)))
    one.store.applyEvent(chunk(one.requestId, rowsOf(0, 5)))
    expect(one.store.stateOf('tab-1').rowsReceived).toBe(5)
    expect(one.store.stateOf('tab-2').rowsReceived).toBe(2)
    expect(one.store.isSessionBusy('s1', 'tab-2')).toBe(true)
    expect(one.store.isSessionBusy('s1', 'tab-1')).toBe(false)
  })

  it('routes events that arrive before execute resolves', async () => {
    let release!: () => void
    fake.query.execute.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(ipcOk(undefined)))),
    )
    const store = useExecutionStore()
    const pending = store.run('tab-1', RUN)
    const requestId = store.stateOf('tab-1').requestId!
    store.applyEvent(chunk(requestId, rowsOf(0, 2)))
    store.applyEvent(done(requestId))
    release()
    await pending
    expect(store.stateOf('tab-1')).toMatchObject({
      status: 'idle',
      outcome: 'done',
      rowsReceived: 2,
    })
  })
})

describe('execution store: errors, rejections and re-execution', () => {
  it('goes back to idle with the normalized error and can run again right away', async () => {
    const { store, requestId } = await start()
    store.applyEvent(failed(requestId))

    const state = store.stateOf('tab-1')
    expect(state).toMatchObject({
      status: 'idle',
      outcome: 'error',
      errorSummary: 'syntax error near "selec"',
    })
    expect(state.error?.code).toBe('syntax_error')
    expect(state.messages[0]!).toMatchObject({
      kind: 'error',
      text: 'Error en la sentencia n.º 1: syntax error near "selec"',
    })

    const again = await start()
    expect(again.store.stateOf('tab-1')).toMatchObject({ status: 'running', error: null })
    expect(fake.query.execute).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['busy', 'sesión está ocupada'],
    ['no_session', 'sesión ya no está abierta'],
    ['read_only_violation', 'solo lectura'],
  ] as const)(
    'shows a clear message for a %s rejection and leaves the tab idle',
    async (code, text) => {
      fake.query.execute.mockResolvedValue(
        ipcFail({ code, message: 'raw main message', retryable: false }),
      )
      const store = useExecutionStore()
      await store.run('tab-1', RUN)

      const state = store.stateOf('tab-1')
      expect(state.status).toBe('idle')
      expect(state.requestId).toBeNull()
      expect(state.error?.code).toBe(code)
      expect(state.errorSummary).toContain(text)
      expect(state.messages).toHaveLength(1)
      expect(useResultBuffers().snapshot('tab-1').sets).toEqual([])

      // Sin bloqueo: la pestaña puede reejecutar inmediatamente.
      fake.query.execute.mockResolvedValue(ipcOk(undefined))
      await store.run('tab-1', RUN)
      expect(store.stateOf('tab-1').status).toBe('running')
    },
  )

  it('shows main read-only message untouched inside the explanation', async () => {
    fake.query.execute.mockResolvedValue(
      ipcFail({
        code: 'read_only_violation',
        message: 'Only read statements are allowed on a read-only connection',
        retryable: false,
      }),
    )
    const store = useExecutionStore()
    await store.run('tab-1', RUN)
    expect(store.stateOf('tab-1').errorSummary).toContain(
      'Only read statements are allowed on a read-only connection',
    )
  })

  it('rejects blank SQL locally without calling main', async () => {
    const store = useExecutionStore()
    await store.run('tab-1', { ...RUN, sql: '   ' })
    expect(fake.query.execute).not.toHaveBeenCalled()
    expect(store.stateOf('tab-1')).toMatchObject({
      status: 'idle',
      errorSummary: 'No hay SQL que ejecutar.',
    })
  })

  it('turns a rejected IPC call into a normalized error instead of throwing', async () => {
    fake.query.execute.mockRejectedValue(new Error('Error invoking remote method: secret detail'))
    const store = useExecutionStore()
    await store.run('tab-1', RUN)
    const state = store.stateOf('tab-1')
    expect(state.status).toBe('idle')
    expect(state.errorSummary).not.toContain('secret detail')
  })
})

describe('execution store: cancellation', () => {
  it('moves to cancelling, asks main and finishes on the cancelled event', async () => {
    const { store, requestId } = await start()
    fake.query.cancel.mockResolvedValue(ipcOk({ requestId, outcome: 'requested' }))
    await store.cancel('tab-1')
    expect(fake.query.cancel).toHaveBeenCalledWith({ requestId })
    expect(store.stateOf('tab-1').status).toBe('cancelling')

    store.applyEvent(cancelled(requestId, 'none'))
    expect(store.stateOf('tab-1')).toMatchObject({
      status: 'idle',
      outcome: 'cancelled',
      error: null,
    })
    expect(store.stateOf('tab-1').messages.at(-1)).toMatchObject({ kind: 'cancelled' })
  })

  it('does nothing when there is no running execution', async () => {
    const store = useExecutionStore()
    await store.cancel('tab-1')
    expect(fake.query.cancel).not.toHaveBeenCalled()
  })

  it('waits for execute to answer before asking main to cancel', async () => {
    let release!: () => void
    fake.query.execute.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(ipcOk(undefined)))),
    )
    const store = useExecutionStore()
    const running = store.run('tab-1', RUN)
    const cancelling = store.cancel('tab-1')
    await Promise.resolve()
    expect(fake.query.cancel).not.toHaveBeenCalled()
    fake.query.cancel.mockResolvedValue(ipcOk({ requestId: 'x', outcome: 'requested' }))
    release()
    await Promise.all([running, cancelling])
    expect(fake.query.cancel).toHaveBeenCalledTimes(1)
  })

  it('does not stay in cancelling forever when main does not know the request and no event arrives', async () => {
    vi.useFakeTimers()
    const { store, requestId } = await start()
    fake.query.cancel.mockResolvedValue(ipcOk({ requestId, outcome: 'not_running' }))
    await store.cancel('tab-1')
    expect(store.stateOf('tab-1').status).toBe('cancelling')

    await vi.advanceTimersByTimeAsync(STALE_CANCEL_MS + 1)
    expect(store.stateOf('tab-1')).toMatchObject({ status: 'idle', outcome: 'cancelled' })
  })

  it('does not stale-close when the terminal event arrives first', async () => {
    vi.useFakeTimers()
    const { store, requestId } = await start()
    fake.query.cancel.mockResolvedValue(ipcOk({ requestId, outcome: 'not_running' }))
    await store.cancel('tab-1')
    store.applyEvent(done(requestId))
    await vi.advanceTimersByTimeAsync(STALE_CANCEL_MS + 1)
    expect(store.stateOf('tab-1').outcome).toBe('done')
    expect(store.stateOf('tab-1').messages).toHaveLength(1)
  })
})

describe('execution store: session loss and reload', () => {
  it('closes the running execution of a session that disappeared', async () => {
    const { store, requestId } = await start()
    store.sessionClosed('s1')

    expect(store.stateOf('tab-1')).toMatchObject({
      status: 'idle',
      outcome: 'error',
      requestId: null,
    })
    expect(store.stateOf('tab-1').errorSummary).toContain('sesión se cerró')
    store.applyEvent(done(requestId))
    expect(store.stateOf('tab-1').outcome).toBe('error')
  })

  it('leaves executions of other sessions alone', async () => {
    const { store } = await start()
    store.sessionClosed('other')
    expect(store.stateOf('tab-1').status).toBe('running')
  })

  it('abandonAll cancels and closes every running execution', async () => {
    const one = await start('tab-1')
    await start('tab-2', { ...RUN, sessionId: 's2' })
    one.store.abandonAll()
    expect(fake.query.cancel).toHaveBeenCalledTimes(2)
    expect(one.store.stateOf('tab-1').status).toBe('idle')
    expect(one.store.stateOf('tab-2').status).toBe('idle')
  })

  it('a reloaded renderer starts from an empty store, so no tab is stuck running', async () => {
    const { requestId } = await start()
    setActivePinia(createPinia())
    const fresh = useExecutionStore()
    expect(fresh.stateOf('tab-1').status).toBe('idle')
    fresh.applyEvent(chunk(requestId, rowsOf(0, 1)))
    expect(fresh.stateOf('tab-1').rowsReceived).toBe(0)
  })
})

describe('execution store: transactions', () => {
  it('updates the session transaction from done, error and cancelled events', async () => {
    const one = await start()
    one.store.applyEvent(done(one.requestId, 'active'))
    expect(transactionOf()).toBe('active')

    const two = await start()
    two.store.applyEvent(failed(two.requestId, {}, 'aborted'))
    expect(transactionOf()).toBe('aborted')

    const three = await start()
    three.store.applyEvent(cancelled(three.requestId, 'none'))
    expect(transactionOf()).toBe('none')
  })

  it('keeps the transaction state when an error event does not report one', async () => {
    const one = await start()
    one.store.applyEvent(done(one.requestId, 'active'))
    const two = await start()
    two.store.applyEvent(failed(two.requestId))
    expect(transactionOf()).toBe('active')
  })

  it.each([
    ['begin', 'active', 'Transacción iniciada.'],
    ['commit', 'none', 'Transacción confirmada.'],
    ['rollback', 'none', 'Transacción revertida.'],
  ] as const)('%s calls main and reflects the returned state', async (action, next, message) => {
    fake.transactions[action].mockResolvedValue(ipcOk({ sessionId: 's1', transaction: next }))
    const store = useExecutionStore()
    await store.runTransaction('tab-1', 's1', action)

    expect(fake.transactions[action]).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(transactionOf()).toBe(next)
    expect(store.stateOf('tab-1').transactionBusy).toBeNull()
    expect(store.stateOf('tab-1').messages.at(-1)).toMatchObject({
      kind: 'transaction',
      text: message,
    })
  })

  it('shows the normalized error when a transaction operation fails, e.g. busy', async () => {
    fake.transactions.begin.mockResolvedValue(
      ipcFail({ code: 'busy', message: 'A query is running', retryable: true }),
    )
    const store = useExecutionStore()
    await store.runTransaction('tab-1', 's1', 'begin')
    expect(store.stateOf('tab-1').errorSummary).toContain('sesión está ocupada')
    expect(transactionOf()).toBe('none')
  })
})

describe('execution store: messages and serialised state', () => {
  it('keeps notices, statements and truncation in chronological order', async () => {
    usePreferencesStore().setExecutionLimits({ timeoutSeconds: 30, maxRows: 5000 })
    const { store, requestId } = await start()
    store.applyEvent({
      type: 'notice',
      requestId,
      statementIndex: 0,
      level: 'warning',
      message: 'careful',
    })
    store.applyEvent(statementDone(requestId, { rowsReturned: 100, truncated: true }))
    store.applyEvent(done(requestId))

    const messages = store.stateOf('tab-1').messages
    expect(messages.map((message) => message.kind)).toEqual([
      'warning',
      'statement',
      'warning',
      'success',
    ])
    expect(messages[0]!.text).toContain('careful')
    expect(messages[2]!.text).toContain('tope inferior')
    expect(store.stateOf('tab-1').truncated).toBe(true)
  })

  it('keeps a bounded per-statement summary for the results view', async () => {
    const { store, requestId } = await start()
    store.applyEvent(
      statementDone(requestId, {
        statementIndex: 0,
        command: 'INSERT',
        rowsAffected: 3,
        durationMs: 7,
      }),
    )
    expect(store.stateOf('tab-1').statements).toEqual([
      {
        statementIndex: 0,
        command: 'INSERT',
        rowsReturned: 0,
        rowsAffected: 3,
        durationMs: 7,
        truncated: false,
      },
    ])
    for (let index = 1; index <= MAX_STATEMENT_SUMMARIES + 5; index += 1) {
      store.applyEvent(statementDone(requestId, { statementIndex: index }))
    }
    const { statements } = store.stateOf('tab-1')
    expect(statements).toHaveLength(MAX_STATEMENT_SUMMARIES)
    expect(statements.at(-1)!.statementIndex).toBe(MAX_STATEMENT_SUMMARIES + 5)
  })

  it('keeps the truncated marks of a chunk in the row buffer', async () => {
    const { store, requestId } = await start()
    store.applyEvent({
      ...chunk(requestId, rowsOf(0, 3)),
      truncated: [{ row: 2, column: 1, originalBytes: 400_000 }],
    } as ReturnType<typeof chunk>)
    expect(useResultBuffers().snapshot('tab-1').sets[0]!.truncated).toEqual([
      { row: 2, column: 1, originalBytes: 400_000 },
    ])
  })

  it('caps the message log and counts what it dropped', async () => {
    const { store, requestId } = await start()
    for (let index = 0; index < 520; index += 1) {
      store.applyEvent({
        type: 'notice',
        requestId,
        statementIndex: 0,
        level: 'info',
        message: `n${index}`,
      })
    }
    const state = store.stateOf('tab-1')
    expect(state.messages).toHaveLength(500)
    expect(state.droppedMessages).toBe(20)
    expect(state.messages[0]!.text).toContain('n20')
  })

  it('keeps neither rows nor the SQL text in the serialised Pinia state', async () => {
    const { store, requestId } = await start('tab-1', {
      ...RUN,
      sql: "select 'top-secret-sql-text'",
    })
    store.applyEvent(chunk(requestId, [[1, 'row-value-must-not-leak']]))
    store.applyEvent(done(requestId))

    const serialised = JSON.stringify(pinia.state.value)
    expect(serialised).toContain('"execution"')
    expect(serialised).not.toContain('row-value-must-not-leak')
    expect(serialised).not.toContain('top-secret-sql-text')
    expect(serialised).not.toMatch(/"(rows|results|password|secret)"/i)
  })
})
