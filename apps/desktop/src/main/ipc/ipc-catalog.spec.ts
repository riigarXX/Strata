// @vitest-environment node
import { IPC_CHANNEL_LIST, IPC_CHANNELS, type IpcChannel } from '@strata/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDbApi } from '../../preload/db-api'
import { createAppOrigin } from '../security/app-origin'
import type { IpcSenderLike } from '../security/sender-validation'
import { registerIpcHandlers, type IpcDependencies } from './register-handlers'

const ipcMainCalls = vi.hoisted(() => [] as { method: string; args: unknown[] }[])

// Registra cualquier uso de `ipcMain`, no solo `handle`: un `on`/`once`/`addListener` extra también sería un canal.
vi.mock('electron', () => ({
  ipcMain: new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          ipcMainCalls.push({ method, args })
        },
    },
  ),
}))

type HandlerFn = (event: unknown, payload?: unknown) => Promise<unknown>

/** Canales que solo van de main al renderer: no tienen handler. Los de consulta van al `webContents` solicitante; los del historial y el avance de descargas de la IA, solo a la ventana principal. */
const EVENT_ONLY_CHANNELS: readonly IpcChannel[] = [
  IPC_CHANNELS.query.event,
  IPC_CHANNELS.history.changed,
  IPC_CHANNELS.ai.pullProgress,
]
const REQUEST_CHANNELS = IPC_CHANNEL_LIST.filter(
  (channel) => !EVENT_ONLY_CHANNELS.includes(channel),
)

const SECRET = 'hunter2-s3cret-pw'
const HOST = 'db.internal.example.com'
const USER = 'svc_admin_user'
const PROFILE_PATH = '/Users/rigarxx/Library/Application Support/Strata/credentials.json'
const LEAKY_MESSAGE = `connect ECONNREFUSED ${HOST}:5432 user=${USER} password=${SECRET} ${PROFILE_PATH}`
const SENSITIVE_MARKERS = [SECRET, HOST, USER, PROFILE_PATH, 'rigarxx', 'ECONNREFUSED']

const sqliteProfile = { engine: 'sqlite', name: 'n', readOnly: false, filePath: '/a.db' }
const table = { schema: 'public', name: 'users' }

/** Un payload válido por canal de petición: si falta uno, el test de cobertura falla al añadir un canal. */
const VALID_PAYLOADS: Readonly<Record<string, unknown>> = {
  [IPC_CHANNELS.connections.list]: undefined,
  [IPC_CHANNELS.connections.create]: sqliteProfile,
  [IPC_CHANNELS.connections.update]: { id: 'p1', ...sqliteProfile },
  [IPC_CHANNELS.connections.delete]: { profileId: 'p1' },
  [IPC_CHANNELS.connections.test]: sqliteProfile,
  [IPC_CHANNELS.connections.connect]: { profileId: 'p1' },
  [IPC_CHANNELS.connections.disconnect]: { sessionId: 's1' },
  [IPC_CHANNELS.connections.pickSqliteFile]: undefined,
  [IPC_CHANNELS.query.execute]: { requestId: 'r1', sessionId: 's1', sql: 'SELECT 1' },
  [IPC_CHANNELS.query.cancel]: { requestId: 'r1' },
  [IPC_CHANNELS.query.ack]: { requestId: 'r1', statementIndex: 0, chunkIndex: 0 },
  [IPC_CHANNELS.metadata.schemas]: { sessionId: 's1' },
  [IPC_CHANNELS.metadata.tables]: { sessionId: 's1', schema: 'public' },
  [IPC_CHANNELS.metadata.describe]: { sessionId: 's1', table },
  [IPC_CHANNELS.transaction.begin]: { sessionId: 's1' },
  [IPC_CHANNELS.transaction.commit]: { sessionId: 's1' },
  [IPC_CHANNELS.transaction.rollback]: { sessionId: 's1' },
  [IPC_CHANNELS.preferences.get]: undefined,
  [IPC_CHANNELS.preferences.update]: { history: { enabled: false } },
  [IPC_CHANNELS.history.list]: {},
  [IPC_CHANNELS.history.delete]: { id: 'h1' },
  [IPC_CHANNELS.history.clear]: undefined,
  [IPC_CHANNELS.ai.status]: undefined,
  [IPC_CHANNELS.ai.listModels]: {},
  [IPC_CHANNELS.ai.generateSql]: { requestId: 'r1', sessionId: 's1', question: 'How many users?' },
  [IPC_CHANNELS.ai.pullModel]: { requestId: 'r1', model: 'qwen3:14b' },
  [IPC_CHANNELS.ai.cancel]: { requestId: 'r1' },
}

// Ningún payload válido de ningún canal: ni objetos (todos los schemas son estrictos) ni `nothing`.
const INVALID_PAYLOADS: readonly unknown[] = [
  `${HOST} ${USER} ${SECRET}`,
  { unexpected: SECRET, host: HOST, user: USER },
  null,
  [],
  42,
]

const ENTRY_URL = 'app://strata/index.html'
const appOrigin = createAppOrigin()
const mainFrame = { url: ENTRY_URL }
const mainWebContents = { mainFrame }
const trustedEvent: IpcSenderLike = { sender: mainWebContents, senderFrame: mainFrame }

function untrustedEvents(): Record<string, IpcSenderLike> {
  const other = { url: ENTRY_URL }
  const at = (url: string): IpcSenderLike => {
    const frame = { url }
    return { sender: { mainFrame: frame }, senderFrame: frame }
  }
  return {
    'otro webContents con el mismo origen': { sender: { mainFrame: other }, senderFrame: other },
    'subframe de la ventana principal': {
      sender: mainWebContents,
      senderFrame: { url: ENTRY_URL },
    },
    'frame destruido (nulo)': { sender: mainWebContents, senderFrame: null },
    'origen externo': at('https://evil.example.com/'),
    'file:// de otra ruta': at('file:///etc/passwd'),
    'file:// del antiguo index': at('file:///app/out/renderer/index.html'),
    'app:// con otro host': at('app://evil/index.html'),
    'app:// con otra ruta': at('app://strata/assets/index.js'),
    'about:blank': at('about:blank'),
    'data:': at('data:text/html,<script>1</script>'),
    'blob:': at('blob:file:///0b6c0b4e-0000-4000-8000-000000000000'),
    'dev server en producción': at('http://localhost:5173/'),
  }
}

/** Servicio doble: cualquier método que se llame se anota y lanza un error cargado de datos sensibles. */
function createLeakyService(touched: string[]): unknown {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => () => {
        touched.push(method)
        throw new Error(LEAKY_MESSAGE)
      },
    },
  )
}

function setup(options: { mainWindow?: boolean } = {}) {
  ipcMainCalls.length = 0
  const touched: string[] = []
  const service = createLeakyService(touched)
  const hasWindow = options.mainWindow ?? true
  registerIpcHandlers({
    getMainWindow: () => (hasWindow ? { webContents: mainWebContents } : null),
    appOrigin,
    connectionManager: service,
    sqliteFilePicker: service,
    queryExecutor: service,
    preferencesStore: service,
    historyStore: service,
    aiService: service,
  } as unknown as IpcDependencies)

  const handlers = new Map<string, HandlerFn>()
  for (const call of ipcMainCalls) {
    if (call.method === 'handle') handlers.set(call.args[0] as string, call.args[1] as HandlerFn)
  }
  const invoke = (channel: string, payload: unknown, event: unknown = trustedEvent) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`sin handler para ${channel}`)
    return handler(event, payload)
  }
  return { handlers, invoke, touched }
}

function expectNoSensitiveData(value: unknown): void {
  const text = value instanceof Error ? value.message : JSON.stringify(value)
  for (const marker of SENSITIVE_MARKERS) expect(text).not.toContain(marker)
}

beforeEach(() => {
  ipcMainCalls.length = 0
})

describe('catálogo IPC frente a los handlers de main', () => {
  it('cada canal de petición del catálogo tiene exactamente un handler y no hay handlers fuera del catálogo', () => {
    const { handlers } = setup()
    const registered = ipcMainCalls.filter((call) => call.method === 'handle')

    expect([...handlers.keys()].sort()).toEqual([...REQUEST_CHANNELS].sort())
    expect(registered).toHaveLength(REQUEST_CHANNELS.length)
    expect(new Set(registered.map((call) => call.args[0])).size).toBe(registered.length)
    for (const channel of handlers.keys()) expect(IPC_CHANNEL_LIST).toContain(channel)
  })

  it('main no registra nada más en `ipcMain` (on, once, addListener…): solo `handle`', () => {
    setup()
    expect(new Set(ipcMainCalls.map((call) => call.method))).toEqual(new Set(['handle']))
  })

  it('los canales solo de eventos (main -> renderer) no aceptan peticiones', () => {
    const { handlers } = setup()
    for (const channel of EVENT_ONLY_CHANNELS) expect(handlers.has(channel)).toBe(false)
  })

  it('hay un payload válido de prueba para cada canal de petición y para ninguno más', () => {
    expect(Object.keys(VALID_PAYLOADS).sort()).toEqual([...REQUEST_CHANNELS].sort())
  })

  it('el preload alcanza exactamente los canales de petición, cada uno una vez, y ninguno fuera del catálogo', async () => {
    const reached: string[] = []
    const invoke = vi.fn(async (channel: string) => {
      reached.push(channel)
      return { ok: true, data: undefined }
    })
    const api = createDbApi(invoke, () => () => undefined)
    for (const group of [
      api.connections,
      api.metadata,
      api.transactions,
      api.preferences,
      api.history,
      api.query,
      api.ai,
    ]) {
      for (const [name, method] of Object.entries(group)) {
        if (name === 'onEvent' || name === 'onChange' || name === 'onPullProgress') continue
        await (method as (payload?: unknown) => Promise<unknown>)(undefined)
      }
    }

    expect([...reached].sort()).toEqual([...REQUEST_CHANNELS].sort())
  })
})

describe('remitentes no confiables', () => {
  const cases = Object.entries(untrustedEvents())

  it.each(
    REQUEST_CHANNELS.flatMap((channel) =>
      cases.map(([name, event]) => [channel, name, event] as const),
    ),
  )('%s rechaza a: %s', async (channel, _name, event) => {
    const { invoke, touched } = setup()

    const rejection = await invoke(channel, VALID_PAYLOADS[channel], event).catch(
      (reason: unknown) => reason,
    )

    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toBe('IPC sender not allowed')
    expect(touched).toEqual([])
    expectNoSensitiveData(rejection)
  })

  it.each(REQUEST_CHANNELS)(
    '%s rechaza cualquier remitente si no hay ventana principal',
    async (channel) => {
      const { invoke, touched } = setup({ mainWindow: false })

      await expect(invoke(channel, VALID_PAYLOADS[channel])).rejects.toThrow(
        'IPC sender not allowed',
      )
      expect(touched).toEqual([])
    },
  )
})

describe('payloads inválidos', () => {
  it.each(REQUEST_CHANNELS)(
    '%s responde validation_failed, sin llegar al servicio ni citar lo enviado',
    async (channel) => {
      const { invoke, touched } = setup()

      for (const payload of INVALID_PAYLOADS) {
        const result = await invoke(channel, payload)

        expect(result).toEqual({
          ok: false,
          error: {
            code: 'validation_failed',
            message: 'The request is not valid',
            retryable: false,
          },
        })
        expectNoSensitiveData(result)
      }
      expect(touched).toEqual([])
    },
  )
})

describe('errores de los servicios', () => {
  it.each(REQUEST_CHANNELS)(
    '%s convierte un fallo con host, usuario, ruta y password en un error genérico',
    async (channel) => {
      const { invoke, touched } = setup()

      const result = await invoke(channel, VALID_PAYLOADS[channel])

      expect(touched.length).toBeGreaterThan(0)
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'internal_error',
          message: 'An unexpected internal error occurred',
          retryable: false,
        },
      })
      expectNoSensitiveData(result)
    },
  )

  it('una respuesta con campos de más (una password) no llega al renderer', async () => {
    ipcMainCalls.length = 0
    const profiles = {
      listProfiles: async () => [{ id: 'p1', ...sqliteProfile, password: SECRET }],
    }
    registerIpcHandlers({
      getMainWindow: () => ({ webContents: mainWebContents }),
      appOrigin,
      connectionManager: profiles,
    } as unknown as IpcDependencies)
    const list = ipcMainCalls.find((call) => call.args[0] === IPC_CHANNELS.connections.list)
      ?.args[1] as HandlerFn

    const result = await list(trustedEvent, undefined)

    expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
    expectNoSensitiveData(result)
  })
})
