// @vitest-environment node
import { IPC_CHANNELS } from '@strata/contracts'
import { AdapterError, createNormalizedError } from '@strata/db-core'
import { describe, expect, it, vi } from 'vitest'
import { createAppOrigin } from '../security/app-origin'
import type { IpcSenderLike } from '../security/sender-validation'
import { createTransactionHandlers } from './transaction-handlers'

const ENTRY_URL = 'app://strata/index.html'
const appOrigin = createAppOrigin()
const channels = IPC_CHANNELS.transaction
const mainFrame = { url: ENTRY_URL }
const webContents = { mainFrame }
const trustedEvent: IpcSenderLike = { sender: webContents, senderFrame: mainFrame }

function setup() {
  const connectionManager = {
    begin: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      transaction: 'active' as const,
    })),
    commit: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      transaction: 'none' as const,
    })),
    rollback: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      sessionId,
      transaction: 'none' as const,
    })),
  }
  const handlers = createTransactionHandlers({
    connectionManager,
    getMainWindow: () => ({ webContents }),
    appOrigin,
  })
  return { connectionManager, handlers }
}

describe('createTransactionHandlers', () => {
  it('registra begin, commit y rollback', () => {
    expect(Object.keys(setup().handlers).sort()).toEqual(
      [channels.begin, channels.commit, channels.rollback].sort(),
    )
  })

  it('cada canal devuelve el estado de transacción real que reporta el manager', async () => {
    const { handlers, connectionManager } = setup()

    await expect(handlers[channels.begin]!(trustedEvent, { sessionId: 's1' })).resolves.toEqual({
      ok: true,
      data: { sessionId: 's1', transaction: 'active' },
    })
    await expect(handlers[channels.commit]!(trustedEvent, { sessionId: 's1' })).resolves.toEqual({
      ok: true,
      data: { sessionId: 's1', transaction: 'none' },
    })
    await expect(handlers[channels.rollback]!(trustedEvent, { sessionId: 's1' })).resolves.toEqual({
      ok: true,
      data: { sessionId: 's1', transaction: 'none' },
    })
    expect(connectionManager.begin).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('un adapter que responde con un estado inválido no llega al renderer', async () => {
    const { handlers, connectionManager } = setup()
    connectionManager.begin.mockResolvedValueOnce({
      sessionId: 's1',
      transaction: 'pending' as never,
    })
    const result = await handlers[channels.begin]!(trustedEvent, { sessionId: 's1' })
    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  })

  it('propaga busy y no_session normalizados', async () => {
    const { handlers, connectionManager } = setup()
    connectionManager.commit.mockRejectedValueOnce(
      new AdapterError(createNormalizedError('busy', 'A query is running on this session')),
    )
    await expect(
      handlers[channels.commit]!(trustedEvent, { sessionId: 's1' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'busy' },
    })
    connectionManager.rollback.mockRejectedValueOnce(new Error('boom host=db.internal'))
    const result = await handlers[channels.rollback]!(trustedEvent, { sessionId: 's1' })
    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
    expect(JSON.stringify(result)).not.toContain('db.internal')
  })

  it.each([undefined, {}, { sessionId: '' }, { sessionId: 's1', extra: true }, 'x'])(
    'rechaza un payload inválido (%j) sin llegar al manager',
    async (payload) => {
      const { handlers, connectionManager } = setup()
      for (const handler of Object.values(handlers)) {
        await expect(handler(trustedEvent, payload)).resolves.toMatchObject({
          ok: false,
          error: { code: 'validation_failed' },
        })
      }
      expect(connectionManager.begin).not.toHaveBeenCalled()
    },
  )

  it('rechaza un remitente no confiable en todos los canales', async () => {
    const { handlers, connectionManager } = setup()
    const other = { url: ENTRY_URL }
    const event: IpcSenderLike = { sender: { mainFrame: other }, senderFrame: other }
    for (const handler of Object.values(handlers)) {
      await expect(handler(event, { sessionId: 's1' })).rejects.toThrow('IPC sender not allowed')
    }
    expect(connectionManager.begin).not.toHaveBeenCalled()
    expect(connectionManager.commit).not.toHaveBeenCalled()
    expect(connectionManager.rollback).not.toHaveBeenCalled()
  })
})
