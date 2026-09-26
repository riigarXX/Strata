// @vitest-environment node
import { IPC_CHANNELS, type HistoryEntry } from '@strata/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createAppOrigin } from '../security/app-origin'
import type { IpcSenderLike } from '../security/sender-validation'
import { entryAt, NOW, setupHistory } from '../services/history-store/testing'
import { createHistoryHandlers } from './history-handlers'

const ENTRY_URL = 'app://strata/index.html'
const appOrigin = createAppOrigin()
const channels = IPC_CHANNELS.history
const mainFrame = { url: ENTRY_URL }
const webContents = { mainFrame }
const trustedEvent: IpcSenderLike = { sender: webContents, senderFrame: mainFrame }

const MINUTE = 60_000

async function setup() {
  const ctx = setupHistory()
  await ctx.store.add(entryAt(NOW - 3 * MINUTE, { sql: 'SELECT * FROM Users' }))
  await ctx.store.add(entryAt(NOW - 2 * MINUTE, { sql: 'DELETE FROM orders', status: 'cancelled' }))
  await ctx.store.add(
    entryAt(NOW - MINUTE, { sql: 'select 1', engine: 'postgres', profileId: 'pg' }),
  )
  const historyStore = {
    list: vi.fn((request) => ctx.store.list(request)),
    delete: vi.fn((id: string) => ctx.store.delete(id)),
    clear: vi.fn(() => ctx.store.clear()),
  }
  const handlers = createHistoryHandlers({
    historyStore,
    getMainWindow: () => ({ webContents }),
    appOrigin,
  })
  return { ...ctx, handlers, historyStore }
}

describe('createHistoryHandlers', () => {
  it('registra exactamente los canales list, delete y clear', async () => {
    const { handlers } = await setup()
    expect(Object.keys(handlers).sort()).toEqual(
      [channels.list, channels.delete, channels.clear].sort(),
    )
  })

  it('list responde con la página, la búsqueda, los filtros y el cursor', async () => {
    const { handlers } = await setup()

    const all = await handlers[channels.list]!(trustedEvent, {})
    expect(all).toMatchObject({ ok: true, data: { nextCursor: null } })
    const first = await handlers[channels.list]!(trustedEvent, { limit: 2 })
    const cursor = (first as { data: { nextCursor: string } }).data.nextCursor
    const second = await handlers[channels.list]!(trustedEvent, { limit: 2, cursor })

    expect(
      (second as { data: { entries: HistoryEntry[] } }).data.entries.map((e) => e.sql),
    ).toEqual(['SELECT * FROM Users'])
    const searched = await handlers[channels.list]!(trustedEvent, {
      search: 'USERS',
      engine: 'sqlite',
    })
    expect((searched as { data: { entries: HistoryEntry[] } }).data.entries).toHaveLength(1)
    const cancelled = await handlers[channels.list]!(trustedEvent, { status: 'cancelled' })
    expect(
      (cancelled as { data: { entries: HistoryEntry[] } }).data.entries.map((e) => e.sql),
    ).toEqual(['DELETE FROM orders'])
  })

  it('delete borra por id y responde cuántas entradas se fueron; clear vacía todo', async () => {
    const { handlers, store } = await setup()
    const [target] = (await store.list({})).entries

    await expect(handlers[channels.delete]!(trustedEvent, { id: target!.id })).resolves.toEqual({
      ok: true,
      data: { deleted: 1 },
    })
    await expect(handlers[channels.delete]!(trustedEvent, { id: target!.id })).resolves.toEqual({
      ok: true,
      data: { deleted: 0 },
    })
    await expect(handlers[channels.clear]!(trustedEvent, undefined)).resolves.toEqual({
      ok: true,
      data: { deleted: 2 },
    })
    expect((await store.list({})).entries).toEqual([])
  })

  it.each([
    { limit: 201 },
    { limit: 0 },
    { cursor: 'garbage' },
    { engine: 'oracle' },
    { status: 'pending' },
    { from: 'yesterday' },
    { orderBy: 'asc' },
    { search: 'x'.repeat(501) },
    'x',
    null,
    undefined,
  ])('list rechaza un payload inválido (%j) sin llegar al almacén', async (payload) => {
    const { handlers, historyStore } = await setup()

    await expect(handlers[channels.list]!(trustedEvent, payload)).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    })
    expect(historyStore.list).not.toHaveBeenCalled()
  })

  it.each([{}, { id: '' }, { id: 5 }, { id: 'a', all: true }, 'x', undefined])(
    'delete rechaza un payload inválido (%j)',
    async (payload) => {
      const { handlers, historyStore } = await setup()

      await expect(handlers[channels.delete]!(trustedEvent, payload)).resolves.toMatchObject({
        ok: false,
        error: { code: 'validation_failed' },
      })
      expect(historyStore.delete).not.toHaveBeenCalled()
    },
  )

  it.each([{}, { all: true }, 'x'])('clear rechaza un payload inesperado (%j)', async (payload) => {
    const { handlers, historyStore } = await setup()

    await expect(handlers[channels.clear]!(trustedEvent, payload)).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation_failed' },
    })
    expect(historyStore.clear).not.toHaveBeenCalled()
  })

  it('rechaza un remitente no confiable en todos los canales sin tocar el almacén', async () => {
    const { handlers, historyStore } = await setup()
    const other = { url: ENTRY_URL }
    const event: IpcSenderLike = { sender: { mainFrame: other }, senderFrame: other }

    for (const channel of [channels.list, channels.delete, channels.clear]) {
      await expect(handlers[channel]!(event, {})).rejects.toThrow('IPC sender not allowed')
    }
    expect(historyStore.list).not.toHaveBeenCalled()
    expect(historyStore.delete).not.toHaveBeenCalled()
    expect(historyStore.clear).not.toHaveBeenCalled()
  })

  it('un remitente no confiable no puede vaciar el historial', async () => {
    const { handlers, store } = await setup()
    const event: IpcSenderLike = { sender: { mainFrame }, senderFrame: null }

    await expect(handlers[channels.clear]!(event, undefined)).rejects.toThrow(
      'IPC sender not allowed',
    )
    expect((await store.list({})).entries).toHaveLength(3)
  })

  it('un fallo del almacén llega normalizado y sin la ruta del archivo', async () => {
    const { handlers, memory } = await setup()
    memory.hooks.failWrite = true

    const result = await handlers[channels.clear]!(trustedEvent, undefined)

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Could not access the query history',
        retryable: false,
      },
    })
    expect(JSON.stringify(result)).not.toContain('/user-data')
  })

  it('las respuestas solo llevan el SQL y los metadatos de la entrada, nunca resultados ni secretos', async () => {
    const { handlers } = await setup()

    const result = await handlers[channels.list]!(trustedEvent, {})
    const [entry] = (result as { data: { entries: Record<string, unknown>[] } }).data.entries

    expect(Object.keys(entry!).sort()).toEqual(
      [
        'durationMs',
        'engine',
        'executedAt',
        'id',
        'profileId',
        'profileName',
        'sql',
        'status',
      ].sort(),
    )
    expect(JSON.stringify(result)).not.toMatch(/password|secret|"rows"/i)
  })

  it('una entrada dañada que el almacén devolviera no llega al renderer', async () => {
    const handlers = createHistoryHandlers({
      historyStore: {
        list: async () => ({
          entries: [{ ...entryAt(NOW), id: 'x', rows: [[1]] } as never],
          nextCursor: null,
        }),
        delete: async () => 0,
        clear: async () => 0,
      },
      getMainWindow: () => ({ webContents }),
      appOrigin,
    })

    const result = await handlers[channels.list]!(trustedEvent, {})

    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  })
})
