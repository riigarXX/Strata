// @vitest-environment node
import { IPC_CHANNELS } from '@strata/contracts'
import { AdapterRegistry } from '@strata/db-core'
import { describe, expect, it, vi } from 'vitest'
import type { IpcResult } from '../../shared/ipc-result'
import { createAppOrigin } from '../security/app-origin'
import type { IpcSenderLike } from '../security/sender-validation'
import {
  createApprovedSqlitePaths,
  createConnectionManager,
  createProfileStore,
  createSqliteFilePicker,
  type ConnectionManager,
} from '../services/connection-manager'
import {
  createFakeAdapter,
  createFakeCredentialStore,
  createMemoryFileSystem,
} from '../services/connection-manager/testing'
import { createConnectionsHandlers } from './connections-handlers'

const PASSWORD = 'sup3r-s3cret-pw!'
const ENTRY_URL = 'app://strata/index.html'
const appOrigin = createAppOrigin()

const pgInput = {
  engine: 'postgres',
  name: 'Local PG',
  readOnly: false,
  host: 'localhost',
  port: 5432,
  user: 'me',
  database: 'app',
  ssl: 'disable',
} as const

const sqliteInput = {
  engine: 'sqlite',
  name: 'File',
  readOnly: true,
  filePath: '/Users/me/data.db',
} as const

const channels = IPC_CHANNELS.connections
const mainFrame = { url: ENTRY_URL }
const webContents = { mainFrame }
const trustedEvent: IpcSenderLike = { sender: webContents, senderFrame: mainFrame }

function setup(dialogResult = { canceled: false, filePaths: ['/Users/me/data.db'] }) {
  const memory = createMemoryFileSystem()
  const credentials = createFakeCredentialStore()
  const adapters = new AdapterRegistry()
  adapters.register(createFakeAdapter('postgres'))
  adapters.register(createFakeAdapter('sqlite'))
  const approvedSqlitePaths = createApprovedSqlitePaths()
  const connectionManager = createConnectionManager({
    profileStore: createProfileStore({
      fileSystem: memory.fileSystem,
      filePath: '/ud/connections.json',
    }),
    credentialStore: credentials.store,
    adapters,
    approvedSqlitePaths,
  })
  const sqliteFilePicker = createSqliteFilePicker({
    showOpenDialog: async () => dialogResult,
    approvedPaths: approvedSqlitePaths,
  })
  const handlers = createConnectionsHandlers({
    connectionManager,
    sqliteFilePicker,
    getMainWindow: () => ({ webContents }),
    appOrigin,
  })
  const invoke = (channel: string, payload?: unknown, event: IpcSenderLike = trustedEvent) => {
    const handler = handlers[channel]
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler(event, payload)
  }
  return { invoke, handlers, connectionManager, memory }
}

function expectFailure(result: IpcResult<unknown>, code: string) {
  expect(result).toMatchObject({ ok: false, error: { code } })
}

function dataOf<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`)
  return result.data
}

describe('createConnectionsHandlers', () => {
  it('registra exactamente un handler por canal del catálogo de connections', () => {
    const { handlers } = setup()
    expect(Object.keys(handlers).sort()).toEqual(Object.values(channels).sort())
  })

  it('flujo completo: crear, listar, probar, conectar, desconectar y borrar', async () => {
    const { invoke } = setup()

    const created = dataOf(await invoke(channels.create, { ...pgInput, password: PASSWORD })) as {
      id: string
    }
    const listed = dataOf(await invoke(channels.list))
    const tested = dataOf(await invoke(channels.test, { ...pgInput, id: created.id }))
    const session = dataOf(await invoke(channels.connect, { profileId: created.id })) as {
      sessionId: string
    }
    const disconnected = await invoke(channels.disconnect, { sessionId: session.sessionId })
    const deleted = await invoke(channels.delete, { profileId: created.id })

    expect(listed).toEqual([created])
    expect(tested).toMatchObject({ ok: true })
    expect(session).toMatchObject({ profileId: created.id, engine: 'postgres', readOnly: false })
    expect(disconnected).toEqual({ ok: true, data: undefined })
    expect(deleted).toEqual({ ok: true, data: undefined })
    expect(dataOf(await invoke(channels.list))).toEqual([])
    for (const value of [created, listed, tested, session]) {
      expect(JSON.stringify(value)).not.toContain(PASSWORD)
    }
  })

  it('actualiza un perfil y devuelve el perfil público', async () => {
    const { invoke } = setup()
    const created = dataOf(await invoke(channels.create, pgInput)) as { id: string }

    const updated = await invoke(channels.update, { ...pgInput, id: created.id, name: 'Renamed' })

    expect(dataOf(updated)).toMatchObject({ id: created.id, name: 'Renamed' })
  })

  describe('remitente no confiable', () => {
    const untrustedEvents: Record<string, IpcSenderLike> = {
      'otra ventana': { sender: { mainFrame }, senderFrame: mainFrame },
      subframe: { sender: webContents, senderFrame: { url: ENTRY_URL } },
      'frame destruido': { sender: webContents, senderFrame: null },
      'origen no permitido': (() => {
        const evilFrame = { url: 'https://evil.test/' }
        return { sender: { mainFrame: evilFrame }, senderFrame: evilFrame }
      })(),
    }

    it.each(Object.entries(untrustedEvents))(
      '%s: todos los canales rechazan sin llegar al ConnectionManager',
      async (_name, event) => {
        const connectionManager = {
          listProfiles: vi.fn(),
          createProfile: vi.fn(),
          updateProfile: vi.fn(),
          deleteProfile: vi.fn(),
          testConnection: vi.fn(),
          connect: vi.fn(),
          disconnect: vi.fn(),
          reconnect: vi.fn(),
          getSession: vi.fn(),
          getSessionRuntime: vi.fn(),
          hasActiveSessions: vi.fn(),
          transactionState: vi.fn(),
          closeAll: vi.fn(),
          listSchemas: vi.fn(),
          listTables: vi.fn(),
          describeTable: vi.fn(),
          begin: vi.fn(),
          commit: vi.fn(),
          rollback: vi.fn(),
        } satisfies ConnectionManager
        const pick = vi.fn(async () => '/Users/me/data.db')
        const handlers = createConnectionsHandlers({
          connectionManager,
          sqliteFilePicker: { pick },
          getMainWindow: () => ({ webContents }),
          appOrigin,
        })
        const validPayloads: Record<string, unknown> = {
          [channels.create]: pgInput,
          [channels.update]: { ...pgInput, id: 'p1' },
          [channels.delete]: { profileId: 'p1' },
          [channels.test]: pgInput,
          [channels.connect]: { profileId: 'p1' },
          [channels.disconnect]: { sessionId: 's1' },
        }

        for (const [channel, handler] of Object.entries(handlers)) {
          await expect(handler(event, validPayloads[channel])).rejects.toThrow(
            'IPC sender not allowed',
          )
        }
        for (const method of Object.values(connectionManager)) expect(method).not.toHaveBeenCalled()
        expect(pick).not.toHaveBeenCalled()
      },
    )

    it('sin ventana principal se rechaza todo', async () => {
      const { connectionManager } = setup()
      const handlers = createConnectionsHandlers({
        connectionManager,
        sqliteFilePicker: { pick: async () => null },
        getMainWindow: () => null,
        appOrigin,
      })

      await expect(handlers[channels.list]?.(trustedEvent, undefined)).rejects.toThrow()
    })
  })

  describe('payload inválido', () => {
    const invalidPayloads: [string, string, unknown][] = [
      ['create', channels.create, undefined],
      ['create', channels.create, { ...pgInput, port: 70000 }],
      ['create', channels.create, { ...pgInput, secretRef: 'stolen-ref' }],
      ['create', channels.create, { ...pgInput, id: 'chosen-by-renderer' }],
      ['create', channels.create, { ...sqliteInput, password: PASSWORD }],
      ['create', channels.create, { ...pgInput, host: 'user@evil:5432/db' }],
      ['create', channels.create, { ...sqliteInput, filePath: 'relative.db' }],
      ['update', channels.update, pgInput],
      ['delete', channels.delete, 'p1'],
      ['delete', channels.delete, { profileId: 'p1', extra: true }],
      ['test', channels.test, { engine: 'mysql' }],
      ['connect', channels.connect, { profileId: '' }],
      ['disconnect', channels.disconnect, { sessionId: 42 }],
      ['list', channels.list, { unexpected: 'payload' }],
      ['pick', channels.pickSqliteFile, 'anything'],
    ]

    it.each(invalidPayloads)(
      '%s rechaza %j con validation_failed',
      async (_name, channel, payload) => {
        const { invoke, connectionManager } = setup()
        const createSpy = vi.spyOn(connectionManager, 'createProfile')

        const result = await invoke(channel, payload)

        expectFailure(result, 'validation_failed')
        expect(createSpy).not.toHaveBeenCalled()
        expect(await connectionManager.listProfiles()).toEqual([])
      },
    )

    it('el mensaje de error no repite lo que envió el renderer', async () => {
      const { invoke } = setup()

      const result = await invoke(channels.create, { ...pgInput, password: PASSWORD, port: 'x' })

      expect(JSON.stringify(result)).not.toContain(PASSWORD)
    })
  })

  describe('errores', () => {
    it('los errores del ConnectionManager llegan como NormalizedError', async () => {
      const { invoke } = setup()

      expectFailure(await invoke(channels.connect, { profileId: 'missing' }), 'validation_failed')
      expectFailure(await invoke(channels.disconnect, { sessionId: 'gone' }), 'no_session')
    })

    it('un fallo inesperado no filtra el mensaje original', async () => {
      const { connectionManager, handlers } = setup()
      vi.spyOn(connectionManager, 'listProfiles').mockRejectedValue(
        new Error(`ECONNREFUSED 10.0.0.5 password=${PASSWORD}`),
      )

      const result = await handlers[channels.list]?.(trustedEvent, undefined)

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'internal_error',
          message: 'An unexpected internal error occurred',
          retryable: false,
        },
      })
    })

    it('valida la salida: un perfil con campos extra, como una password, no sale de main', async () => {
      const { connectionManager, handlers } = setup()
      vi.spyOn(connectionManager, 'listProfiles').mockResolvedValue([
        { id: 'p1', ...sqliteInput, password: PASSWORD } as never,
      ])

      const result = await handlers[channels.list]?.(trustedEvent, undefined)

      expectFailure(result as IpcResult<unknown>, 'internal_error')
      expect(JSON.stringify(result)).not.toContain(PASSWORD)
    })
  })

  describe('selección de archivo SQLite', () => {
    it('devuelve la ruta elegida y a partir de ahí se puede registrar un perfil con ella', async () => {
      const { invoke } = setup()

      expect(await invoke(channels.pickSqliteFile)).toEqual({
        ok: true,
        data: { filePath: '/Users/me/data.db' },
      })
      expect(dataOf(await invoke(channels.create, sqliteInput))).toMatchObject({ engine: 'sqlite' })
    })

    it('devuelve null si se cancela y entonces la ruta sigue sin poder registrarse', async () => {
      const { invoke } = setup({ canceled: true, filePaths: [] })

      expect(await invoke(channels.pickSqliteFile)).toEqual({ ok: true, data: { filePath: null } })
      expectFailure(await invoke(channels.create, sqliteInput), 'permission_denied')
    })

    it('un renderer que salta el diálogo no puede crear, editar ni probar perfiles con rutas propias', async () => {
      const { invoke } = setup()

      expectFailure(await invoke(channels.create, sqliteInput), 'permission_denied')
      expectFailure(await invoke(channels.test, sqliteInput), 'permission_denied')

      await invoke(channels.pickSqliteFile)
      const created = dataOf(await invoke(channels.create, sqliteInput)) as { id: string }
      expectFailure(
        await invoke(channels.update, { ...sqliteInput, id: created.id, filePath: '/etc/passwd' }),
        'permission_denied',
      )
    })
  })
})
