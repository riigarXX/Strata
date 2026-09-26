// @vitest-environment node
import { IPC_CHANNELS } from '@strata/contracts'
import { AdapterError, AdapterRegistry, createNormalizedError } from '@strata/db-core'
import { describe, expect, it, vi } from 'vitest'
import type { IpcResult } from '../../shared/ipc-result'
import { createAppOrigin } from '../security/app-origin'
import type { IpcSenderLike } from '../security/sender-validation'
import {
  createApprovedSqlitePaths,
  createConnectionManager,
  createProfileStore,
  type ConnectionManager,
} from '../services/connection-manager'
import {
  createFakeAdapter,
  createFakeCredentialStore,
  createMemoryFileSystem,
  FAKE_TABLE,
  FAKE_TABLE_DETAILS,
} from '../services/connection-manager/testing'
import { createMetadataHandlers } from './metadata-handlers'

const ENTRY_URL = 'app://strata/index.html'
const HOST = 'db.internal.example'
const USER = 'analyst'
const PASSWORD = 'sup3r-s3cret-pw!'
const appOrigin = createAppOrigin()

const channels = IPC_CHANNELS.metadata
const mainFrame = { url: ENTRY_URL }
const webContents = { mainFrame }
const trustedEvent: IpcSenderLike = { sender: webContents, senderFrame: mainFrame }

async function setup() {
  const memory = createMemoryFileSystem()
  const credentials = createFakeCredentialStore()
  const adapters = new AdapterRegistry()
  const postgres = createFakeAdapter('postgres')
  adapters.register(postgres)
  const connectionManager = createConnectionManager({
    profileStore: createProfileStore({
      fileSystem: memory.fileSystem,
      filePath: '/ud/connections.json',
    }),
    credentialStore: credentials.store,
    adapters,
    approvedSqlitePaths: createApprovedSqlitePaths(),
  })
  const profile = await connectionManager.createProfile({
    engine: 'postgres',
    name: 'PG',
    readOnly: false,
    host: HOST,
    port: 5432,
    user: USER,
    database: 'app',
    ssl: 'disable',
    password: PASSWORD,
  })
  const { sessionId } = await connectionManager.connect({ profileId: profile.id })
  const handlers = createMetadataHandlers({
    connectionManager,
    getMainWindow: () => ({ webContents }),
    appOrigin,
  })
  const invoke = (channel: string, payload?: unknown, event: IpcSenderLike = trustedEvent) => {
    const handler = handlers[channel]
    if (!handler) throw new Error(`no handler for ${channel}`)
    return handler(event, payload)
  }
  return { invoke, handlers, connectionManager, postgres, sessionId }
}

function expectFailure(result: IpcResult<unknown>, code: string) {
  expect(result).toMatchObject({ ok: false, error: { code } })
}

describe('createMetadataHandlers', () => {
  it('registra exactamente un handler por canal del catálogo de metadata', async () => {
    const { handlers } = await setup()
    expect(Object.keys(handlers).sort()).toEqual(Object.values(channels).sort())
  })

  it('cada canal devuelve los datos de la sesión activa', async () => {
    const { invoke, sessionId } = await setup()

    expect(await invoke(channels.schemas, { sessionId })).toEqual({
      ok: true,
      data: [{ name: 'public' }],
    })
    expect(await invoke(channels.tables, { sessionId })).toEqual({ ok: true, data: [FAKE_TABLE] })
    expect(await invoke(channels.tables, { sessionId, schema: 'public' })).toEqual({
      ok: true,
      data: [FAKE_TABLE],
    })
    expect(
      await invoke(channels.describe, {
        sessionId,
        table: { schema: 'public', name: 'users' },
      }),
    ).toEqual({ ok: true, data: FAKE_TABLE_DETAILS })
  })

  it('pasa al adapter los nombres tal cual, sin interpolarlos ni transformarlos', async () => {
    const { invoke, postgres, sessionId } = await setup()
    const listTables = vi.spyOn(postgres.behavior, 'listTables')
    const describeTable = vi.spyOn(postgres.behavior, 'describeTable')
    const table = { schema: `x"; DROP TABLE users; --`, name: "o'brien" }

    await invoke(channels.tables, { sessionId, schema: table.schema })
    await invoke(channels.describe, { sessionId, table })

    expect(listTables).toHaveBeenCalledWith(sessionId, table.schema)
    expect(describeTable).toHaveBeenCalledWith(sessionId, table)
  })

  it('una sesión inexistente devuelve no_session normalizado', async () => {
    const { invoke } = await setup()
    const table = { schema: 'public', name: 'users' }

    for (const [channel, payload] of [
      [channels.schemas, { sessionId: 'gone' }],
      [channels.tables, { sessionId: 'gone' }],
      [channels.describe, { sessionId: 'gone', table }],
    ] as const) {
      const result = await invoke(channel, payload)
      expectFailure(result, 'no_session')
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'no_session',
          message: 'The session does not exist or was closed',
          retryable: false,
        },
      })
    }
  })

  it('una sesión ya desconectada devuelve no_session', async () => {
    const { invoke, connectionManager, sessionId } = await setup()
    await connectionManager.disconnect({ sessionId })

    expectFailure(await invoke(channels.schemas, { sessionId }), 'no_session')
  })

  describe('payload inválido', () => {
    const invalidPayloads: [string, unknown][] = [
      [channels.schemas, undefined],
      [channels.schemas, { sessionId: '' }],
      [channels.schemas, { sessionId: 42 }],
      [channels.schemas, { sessionId: 's1', extra: true }],
      [channels.tables, { sessionId: 's1', schema: '' }],
      [channels.tables, { sessionId: 's1', schema: 'a'.repeat(257) }],
      [channels.tables, { sessionId: 's1', schema: 7 }],
      [channels.tables, 's1'],
      [channels.describe, { sessionId: 's1' }],
      [channels.describe, { sessionId: 's1', table: { schema: 'public' } }],
      [
        channels.describe,
        { sessionId: 's1', table: { schema: 'public', name: 'u', kind: 'view' } },
      ],
      [channels.describe, { sessionId: 's1', table: 'public.users' }],
    ]

    it.each(invalidPayloads)('%s rechaza %j con validation_failed', async (channel, payload) => {
      const { invoke, connectionManager } = await setup()
      const spies = [
        vi.spyOn(connectionManager, 'listSchemas'),
        vi.spyOn(connectionManager, 'listTables'),
        vi.spyOn(connectionManager, 'describeTable'),
      ]

      expectFailure(await invoke(channel, payload), 'validation_failed')
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    })
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
          listSchemas: vi.fn(),
          listTables: vi.fn(),
          describeTable: vi.fn(),
        } satisfies Pick<ConnectionManager, 'listSchemas' | 'listTables' | 'describeTable'>
        const handlers = createMetadataHandlers({
          connectionManager,
          getMainWindow: () => ({ webContents }),
          appOrigin,
        })
        const validPayloads: Record<string, unknown> = {
          [channels.schemas]: { sessionId: 's1' },
          [channels.tables]: { sessionId: 's1' },
          [channels.describe]: { sessionId: 's1', table: { schema: 'public', name: 'users' } },
        }

        for (const [channel, handler] of Object.entries(handlers)) {
          await expect(handler(event, validPayloads[channel])).rejects.toThrow(
            'IPC sender not allowed',
          )
        }
        for (const method of Object.values(connectionManager)) expect(method).not.toHaveBeenCalled()
      },
    )

    it('sin ventana principal se rechaza todo', async () => {
      const { connectionManager } = await setup()
      const handlers = createMetadataHandlers({
        connectionManager,
        getMainWindow: () => null,
        appOrigin,
      })

      await expect(
        handlers[channels.schemas]?.(trustedEvent, { sessionId: 's1' }),
      ).rejects.toThrow()
    })
  })

  describe('sin filtrar datos sensibles', () => {
    const table = { schema: 'public', name: 'users' }

    it('un error desconocido del adapter llega como error genérico', async () => {
      const { invoke, postgres, sessionId } = await setup()
      const leak = new Error(`connect ECONNREFUSED ${HOST} user=${USER} password=${PASSWORD}`)
      postgres.behavior.listSchemas = () => Promise.reject(leak)
      postgres.behavior.listTables = () => Promise.reject(leak)
      postgres.behavior.describeTable = () => Promise.reject(leak)

      for (const [channel, payload] of [
        [channels.schemas, { sessionId }],
        [channels.tables, { sessionId }],
        [channels.describe, { sessionId, table }],
      ] as const) {
        const result = await invoke(channel, payload)
        expect(result).toEqual({
          ok: false,
          error: {
            code: 'internal_error',
            message: 'An unexpected internal error occurred',
            retryable: false,
          },
        })
      }
    })

    it('un error normalizado del adapter conserva el código y se redacta el host y el usuario', async () => {
      const { invoke, postgres, sessionId } = await setup()
      postgres.behavior.describeTable = () =>
        Promise.reject(
          new AdapterError(
            createNormalizedError('not_found', `no such table on ${HOST} as ${USER}`),
          ),
        )

      const result = await invoke(channels.describe, { sessionId, table })

      expectFailure(result, 'not_found')
      const serialized = JSON.stringify(result)
      for (const secret of [HOST, USER, PASSWORD]) expect(serialized).not.toContain(secret)
    })

    it('valida la salida: una respuesta con campos extra no sale de main', async () => {
      const { invoke, postgres, sessionId } = await setup()
      postgres.behavior.listSchemas = async () => [
        { name: 'public', owner: USER, connection: `postgres://${USER}:${PASSWORD}@${HOST}` },
      ]

      const result = await invoke(channels.schemas, { sessionId })

      expectFailure(result, 'internal_error')
      const serialized = JSON.stringify(result)
      for (const secret of [HOST, USER, PASSWORD]) expect(serialized).not.toContain(secret)
    })

    it('el error de validación no repite lo que envió el renderer', async () => {
      const { invoke } = await setup()

      const result = await invoke(channels.schemas, { sessionId: 's1', token: PASSWORD })

      expect(JSON.stringify(result)).not.toContain(PASSWORD)
    })
  })
})
