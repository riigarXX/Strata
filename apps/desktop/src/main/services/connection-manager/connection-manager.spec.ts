// @vitest-environment node
import type { ConnectionProfileInput, Session, TestConnectionResult } from '@strata/contracts'
import { AdapterError, AdapterRegistry, createNormalizedError } from '@strata/db-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialStoreError } from '../credential-store'
import { createApprovedSqlitePaths } from './approved-sqlite-paths'
import { createConnectionManager } from './connection-manager'
import { createProfileStore } from './profile-store'
import {
  createFakeAdapter,
  createFakeCredentialStore,
  createMemoryFileSystem,
  FAKE_TABLE,
  FAKE_TABLE_DETAILS,
} from './testing'

const PASSWORD = 'sup3r-s3cret-pw!'
const HOST = 'db.internal.example'
const PROFILES_PATH = '/user-data/connections.json'

const pgInput = {
  engine: 'postgres',
  name: 'Local PG',
  readOnly: false,
  host: HOST,
  port: 5432,
  user: 'analyst',
  database: 'app',
  ssl: 'require',
} as const satisfies ConnectionProfileInput

const sqliteInput = {
  engine: 'sqlite',
  name: 'Local file',
  readOnly: false,
  filePath: '/Users/me/data.db',
} as const satisfies ConnectionProfileInput

function setup(options: { registerAdapters?: boolean; connectTimeoutMs?: number } = {}) {
  const memory = createMemoryFileSystem()
  const credentials = createFakeCredentialStore()
  const adapters = new AdapterRegistry()
  const postgres = createFakeAdapter('postgres')
  const sqlite = createFakeAdapter('sqlite')
  if (options.registerAdapters ?? true) {
    adapters.register(postgres)
    adapters.register(sqlite)
  }
  const approvedSqlitePaths = createApprovedSqlitePaths()
  let counter = 0
  const manager = createConnectionManager({
    profileStore: createProfileStore({ fileSystem: memory.fileSystem, filePath: PROFILES_PATH }),
    credentialStore: credentials.store,
    adapters,
    approvedSqlitePaths,
    generateProfileId: () => `profile-${++counter}`,
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
  })
  return { manager, memory, credentials, adapters, postgres, sqlite, approvedSqlitePaths }
}

function expectNormalized(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ normalized: { code } })
}

async function rejection(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise
  } catch (reason) {
    expect(reason).toBeInstanceOf(AdapterError)
    return reason as AdapterError
  }
  throw new Error('expected the promise to reject')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ConnectionManager: perfiles', () => {
  it('crea un perfil postgres: la password va al CredentialStore y el perfil solo guarda secretRef', async () => {
    const { manager, memory, credentials } = setup()

    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })

    expect(created).toEqual({ id: 'profile-1', ...pgInput, secretRef: 'secret-1' })
    expect(credentials.secrets.get('secret-1')).toBe(PASSWORD)
    expect(JSON.stringify(created)).not.toContain(PASSWORD)
    expect(memory.files.get(PROFILES_PATH)).not.toContain(PASSWORD)
    expect(await manager.listProfiles()).toEqual([created])
  })

  it('un perfil sin password no toca el CredentialStore', async () => {
    const { manager, credentials } = setup()

    const created = await manager.createProfile(pgInput)

    expect(created).not.toHaveProperty('secretRef')
    expect(credentials.calls).toEqual({ save: 0, get: 0, delete: 0 })
  })

  it('persiste entre instancias con el mismo almacén', async () => {
    const { manager, memory } = setup()
    await manager.createProfile(pgInput)

    const reloaded = createProfileStore({ fileSystem: memory.fileSystem, filePath: PROFILES_PATH })

    expect(await reloaded.list()).toHaveLength(1)
  })

  it('si falla el guardado del perfil, elimina el secreto recién guardado', async () => {
    const { manager, memory, credentials } = setup()
    memory.hooks.failRename = true

    await expectNormalized(
      manager.createProfile({ ...pgInput, password: PASSWORD }),
      'internal_error',
    )

    expect(credentials.secrets.size).toBe(0)
    expect(await manager.listProfiles()).toEqual([])
  })

  it('actualizar sin password conserva el secreto; con password lo reemplaza bajo la misma referencia', async () => {
    const { manager, credentials } = setup()
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })

    const renamed = await manager.updateProfile({ ...pgInput, id: created.id, name: 'Renamed' })
    expect(renamed).toMatchObject({ name: 'Renamed', secretRef: 'secret-1' })
    expect(credentials.secrets.get('secret-1')).toBe(PASSWORD)

    const rotated = await manager.updateProfile({ ...pgInput, id: created.id, password: 'n3w-pw' })
    expect(rotated).toMatchObject({ secretRef: 'secret-1' })
    expect(credentials.secrets.get('secret-1')).toBe('n3w-pw')
  })

  it('cambiar host, puerto o usuario sin volver a introducir la password se rechaza', async () => {
    const { manager } = setup()
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })

    for (const change of [{ host: 'evil.example' }, { port: 6543 }, { user: 'other' }]) {
      await expectNormalized(
        manager.updateProfile({ ...pgInput, ...change, id: created.id }),
        'validation_failed',
      )
    }

    const moved = await manager.updateProfile({
      ...pgInput,
      host: 'other.example',
      id: created.id,
      password: 'another-pw',
    })
    expect(moved).toMatchObject({ host: 'other.example' })
  })

  it('pasar de postgres a sqlite elimina el secreto huérfano', async () => {
    const { manager, credentials, approvedSqlitePaths } = setup()
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })
    approvedSqlitePaths.approve(sqliteInput.filePath)

    const updated = await manager.updateProfile({ ...sqliteInput, id: created.id })

    expect(updated).not.toHaveProperty('secretRef')
    expect(credentials.secrets.size).toBe(0)
  })

  it('eliminar borra el perfil, su secreto y cierra sus sesiones', async () => {
    const { manager, credentials, postgres } = setup()
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })
    const session = await manager.connect({ profileId: created.id })

    await manager.deleteProfile({ profileId: created.id })

    expect(await manager.listProfiles()).toEqual([])
    expect(credentials.secrets.size).toBe(0)
    expect(postgres.disconnected).toEqual([session.sessionId])
    expect(manager.hasActiveSessions()).toBe(false)
  })

  it('editar u operar sobre un perfil inexistente devuelve un error normalizado', async () => {
    const { manager } = setup()

    await expectNormalized(manager.updateProfile({ ...pgInput, id: 'nope' }), 'validation_failed')
    await expectNormalized(manager.deleteProfile({ profileId: 'nope' }), 'validation_failed')
    await expectNormalized(manager.connect({ profileId: 'nope' }), 'validation_failed')
  })

  it('un error del CredentialStore llega normalizado y sin la password', async () => {
    const { manager, credentials } = setup()
    credentials.store.save = () =>
      Promise.reject(new CredentialStoreError('ENCRYPTION_UNAVAILABLE'))

    const error = await rejection(manager.createProfile({ ...pgInput, password: PASSWORD }))

    expect(error.normalized.code).toBe('internal_error')
    expect(JSON.stringify(error.normalized)).not.toContain(PASSWORD)
  })

  it('un cambio de solo nombre no cierra la sesión abierta; otros cambios sí', async () => {
    const { manager, postgres } = setup()
    const created = await manager.createProfile(pgInput)
    await manager.connect({ profileId: created.id })

    await manager.updateProfile({ ...pgInput, id: created.id, name: 'Only a rename' })
    expect(manager.hasActiveSessions()).toBe(true)

    await manager.updateProfile({ ...pgInput, id: created.id, readOnly: true })
    expect(manager.hasActiveSessions()).toBe(false)
    expect(postgres.disconnected).toHaveLength(1)
  })
})

describe('ConnectionManager: rutas SQLite aprobadas', () => {
  it('rechaza crear un perfil con una ruta no aprobada', async () => {
    const { manager } = setup()

    await expectNormalized(manager.createProfile(sqliteInput), 'permission_denied')
    expect(await manager.listProfiles()).toEqual([])
  })

  it('acepta una ruta aprobada, también con otra forma equivalente de escribirla', async () => {
    const { manager, approvedSqlitePaths } = setup()
    approvedSqlitePaths.approve('/Users/me/data.db')

    const created = await manager.createProfile({
      ...sqliteInput,
      filePath: '/Users/me/../me/data.db',
    })

    expect(created).toMatchObject({ engine: 'sqlite' })
  })

  it('al editar rechaza una ruta nueva no aprobada pero acepta la que ya tenía el perfil', async () => {
    const { manager, approvedSqlitePaths } = setup()
    approvedSqlitePaths.approve(sqliteInput.filePath)
    const created = await manager.createProfile(sqliteInput)

    const renamed = await manager.updateProfile({ ...sqliteInput, id: created.id, name: 'Renamed' })
    expect(renamed).toMatchObject({ name: 'Renamed', filePath: sqliteInput.filePath })

    await expectNormalized(
      manager.updateProfile({ ...sqliteInput, id: created.id, filePath: '/etc/other.db' }),
      'permission_denied',
    )
  })

  it('al probar rechaza rutas no aprobadas, pero acepta la de un perfil guardado', async () => {
    const { manager, sqlite, approvedSqlitePaths } = setup()

    await expectNormalized(manager.testConnection(sqliteInput), 'permission_denied')
    expect(sqlite.tested).toEqual([])

    approvedSqlitePaths.approve(sqliteInput.filePath)
    const created = await manager.createProfile(sqliteInput)
    const result = await manager.testConnection({ ...sqliteInput, id: created.id })
    expect(result.ok).toBe(true)

    await expectNormalized(
      manager.testConnection({ ...sqliteInput, id: created.id, filePath: '/etc/other.db' }),
      'permission_denied',
    )
  })

  it('conectar usa la ruta del perfil guardado, sin volver a pedir aprobación tras reiniciar', async () => {
    const { manager, memory, adapters } = setup()
    memory.files.set(
      PROFILES_PATH,
      JSON.stringify({
        version: 1,
        profiles: [{ id: 'p1', ...sqliteInput }],
      }),
    )

    const session = await manager.connect({ profileId: 'p1' })

    expect(session.engine).toBe('sqlite')
    expect(adapters.has('sqlite')).toBe(true)
  })
})

describe('ConnectionManager: probar conexión', () => {
  it('prueba un perfil sin guardar con la password recibida y sin persistir nada', async () => {
    const { manager, postgres, credentials, memory } = setup()

    const result = await manager.testConnection({ ...pgInput, password: PASSWORD })

    expect(result).toEqual({ ok: true, serverVersion: '16.2', latencyMs: 4 })
    expect(postgres.tested[0]).toMatchObject({ host: HOST, password: PASSWORD })
    expect(credentials.calls.save).toBe(0)
    expect(memory.files.size).toBe(0)
  })

  it('en un perfil guardado, omitir la password reutiliza el secreto guardado', async () => {
    const { manager, postgres } = setup()
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })

    await manager.testConnection({ ...pgInput, id: created.id })

    expect(postgres.tested[0]).toMatchObject({ id: created.id, password: PASSWORD })
    expect(postgres.tested[0]).not.toHaveProperty('secretRef')
  })

  it('con otra password usa la recibida, no la guardada', async () => {
    const { manager, postgres } = setup()
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })

    await manager.testConnection({ ...pgInput, id: created.id, password: 'typed-pw' })

    expect(postgres.tested[0]).toMatchObject({ password: 'typed-pw' })
  })

  it('no reutiliza el secreto guardado contra otro host', async () => {
    const { manager, postgres } = setup()
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })

    await expectNormalized(
      manager.testConnection({ ...pgInput, host: 'evil.example', id: created.id }),
      'validation_failed',
    )
    expect(postgres.tested).toEqual([])
  })

  it('devuelve el fallo del adapter como resultado, con host y password redactados', async () => {
    const { manager, postgres } = setup()
    postgres.behavior.test = async () => ({
      ok: false,
      error: {
        code: 'connection_failed',
        message: `could not reach ${HOST} with password=${PASSWORD} as analyst`,
        retryable: true,
      },
    })

    const result = await manager.testConnection({ ...pgInput, password: PASSWORD })

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    for (const secret of [PASSWORD, HOST, 'analyst']) expect(serialized).not.toContain(secret)
  })

  it('un error desconocido del adapter se reduce a un mensaje genérico', async () => {
    const { manager, postgres } = setup()
    postgres.behavior.test = () => Promise.reject(new Error(`boom ${HOST} ${PASSWORD}`))

    const result = await manager.testConnection({ ...pgInput, password: PASSWORD })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'An unexpected internal error occurred',
        retryable: false,
      },
    })
  })

  it('sin adapter para el motor devuelve un fallo claro', async () => {
    const { manager } = setup({ registerAdapters: false })

    const result: TestConnectionResult = await manager.testConnection(pgInput)

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'connection_failed', retryable: false },
    })
    expect(result.ok === false && result.error.message).toContain('postgres')
  })

  it('rechaza con timeout una prueba que no termina', async () => {
    vi.useFakeTimers()
    const { manager, postgres } = setup({ connectTimeoutMs: 1_000 })
    postgres.behavior.test = () => new Promise(() => {})

    const pending = manager.testConnection(pgInput)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } })
  })
})

describe('ConnectionManager: sesiones', () => {
  it('conecta con la password guardada resuelta solo dentro de main', async () => {
    const { manager, postgres } = setup()
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })

    const session = await manager.connect({ profileId: created.id })

    expect(postgres.connected[0]).toMatchObject({ id: created.id, host: HOST, password: PASSWORD })
    expect(postgres.connected[0]).not.toHaveProperty('secretRef')
    expect(JSON.stringify(session)).not.toContain(PASSWORD)
    expect(manager.getSession(session.sessionId)).toEqual(session)
    expect(manager.hasActiveSessions()).toBe(true)
  })

  it('Session.readOnly lo decide main desde el perfil, no el adapter', async () => {
    const { manager } = setup()
    const readOnlyProfile = await manager.createProfile({ ...pgInput, readOnly: true })
    const writableProfile = await manager.createProfile({ ...pgInput, name: 'RW' })

    expect((await manager.connect({ profileId: readOnlyProfile.id })).readOnly).toBe(true)
    expect((await manager.connect({ profileId: writableProfile.id })).readOnly).toBe(false)
  })

  it('conectar dos veces el mismo perfil, incluso a la vez, reutiliza una única sesión', async () => {
    const { manager, postgres } = setup()
    const created = await manager.createProfile(pgInput)

    const [first, second] = await Promise.all([
      manager.connect({ profileId: created.id }),
      manager.connect({ profileId: created.id }),
    ])
    const third = await manager.connect({ profileId: created.id })

    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(postgres.connected).toHaveLength(1)
  })

  it('sin adapter registrado para el motor devuelve un error normalizado claro', async () => {
    const { manager } = setup({ registerAdapters: false })
    const created = await manager.createProfile(pgInput)

    const error = await rejection(manager.connect({ profileId: created.id }))

    expect(error.normalized).toMatchObject({ code: 'connection_failed', retryable: false })
    expect(error.normalized.message).toContain('postgres')
  })

  it('un perfil con secretRef cuyo secreto ya no existe pide reintroducir la password', async () => {
    const { manager, credentials } = setup()
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })
    credentials.secrets.clear()

    await expectNormalized(manager.connect({ profileId: created.id }), 'authentication_failed')
  })

  it('el error del adapter llega normalizado, redactado y sin exponer la causa', async () => {
    const { manager, postgres } = setup()
    postgres.behavior.connect = () =>
      Promise.reject(
        new AdapterError(
          createNormalizedError(
            'authentication_failed',
            `password authentication failed for ${HOST}`,
          ),
        ),
      )
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })

    const error = await rejection(manager.connect({ profileId: created.id }))

    expect(error.normalized.code).toBe('authentication_failed')
    expect(error.normalized.message).not.toContain(HOST)
    expect(manager.hasActiveSessions()).toBe(false)
  })

  it('un fallo desconocido del adapter no filtra su mensaje', async () => {
    const { manager, postgres } = setup()
    postgres.behavior.connect = () => Promise.reject(new Error(`ECONNREFUSED ${HOST} ${PASSWORD}`))
    const created = await manager.createProfile({ ...pgInput, password: PASSWORD })

    const error = await rejection(manager.connect({ profileId: created.id }))

    expect(JSON.stringify(error.normalized)).not.toContain(HOST)
    expect(JSON.stringify(error.normalized)).not.toContain(PASSWORD)
    expect(error.normalized.code).toBe('internal_error')
  })

  it('aplica un timeout de conexión y cierra la sesión si el adapter termina tarde', async () => {
    vi.useFakeTimers()
    const { manager, postgres } = setup({ connectTimeoutMs: 1_000 })
    const created = await manager.createProfile(pgInput)
    let finish: (session: Session) => void = () => {}
    postgres.behavior.connect = () =>
      new Promise<Session>((resolve) => {
        finish = resolve
      })

    const pending = rejection(manager.connect({ profileId: created.id }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await pending).normalized.code).toBe('timeout')

    finish({
      sessionId: 'late-session',
      profileId: created.id,
      engine: 'postgres',
      serverVersion: '16',
      readOnly: false,
      transaction: 'none',
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(postgres.disconnected).toEqual(['late-session'])
    expect(manager.hasActiveSessions()).toBe(false)
  })

  it('rechaza y cierra una sesión inválida devuelta por el adapter', async () => {
    const { manager, postgres } = setup()
    postgres.behavior.connect = async () => ({ sessionId: 'broken' }) as unknown as Session
    const created = await manager.createProfile(pgInput)

    await expectNormalized(manager.connect({ profileId: created.id }), 'internal_error')

    expect(postgres.disconnected).toEqual(['broken'])
    expect(manager.hasActiveSessions()).toBe(false)
  })

  it('rechaza un adapter que devuelve un id de sesión ya en uso', async () => {
    const { manager, postgres } = setup()
    const first = await manager.createProfile(pgInput)
    const second = await manager.createProfile({ ...pgInput, name: 'Other' })
    postgres.behavior.connect = async (profile) => ({
      sessionId: 'same-id',
      profileId: profile.id,
      engine: 'postgres',
      serverVersion: '16',
      readOnly: false,
      transaction: 'none',
    })
    await manager.connect({ profileId: first.id })

    await expectNormalized(manager.connect({ profileId: second.id }), 'internal_error')

    expect(manager.getSession('same-id')?.profileId).toBe(first.id)
  })

  it('desconecta una sesión y rechaza una que no existe', async () => {
    const { manager, postgres } = setup()
    const created = await manager.createProfile(pgInput)
    const session = await manager.connect({ profileId: created.id })

    await manager.disconnect({ sessionId: session.sessionId })

    expect(postgres.disconnected).toEqual([session.sessionId])
    expect(manager.getSession(session.sessionId)).toBeUndefined()
    await expectNormalized(manager.disconnect({ sessionId: session.sessionId }), 'no_session')
  })

  it('reconectar desconecta la sesión anterior y abre una nueva', async () => {
    const { manager, postgres } = setup()
    const created = await manager.createProfile(pgInput)
    const first = await manager.connect({ profileId: created.id })

    const second = await manager.reconnect({ profileId: created.id })

    expect(second.sessionId).not.toBe(first.sessionId)
    expect(postgres.disconnected).toEqual([first.sessionId])
    expect(manager.getSession(first.sessionId)).toBeUndefined()
    expect(manager.getSession(second.sessionId)).toEqual(second)
  })

  it('closeAll cierra todas las sesiones aunque algún adapter falle', async () => {
    const { manager, postgres, sqlite, approvedSqlitePaths } = setup()
    approvedSqlitePaths.approve(sqliteInput.filePath)
    const pg = await manager.createProfile(pgInput)
    const lite = await manager.createProfile(sqliteInput)
    await manager.connect({ profileId: pg.id })
    await manager.connect({ profileId: lite.id })
    postgres.behavior.disconnect = () => Promise.reject(new Error('socket already closed'))

    await expect(manager.closeAll()).resolves.toBeUndefined()

    expect(postgres.disconnected).toHaveLength(1)
    expect(sqlite.disconnected).toHaveLength(1)
    expect(manager.hasActiveSessions()).toBe(false)
  })
})

describe('ConnectionManager: metadata', () => {
  async function connected() {
    const context = setup()
    const created = await context.manager.createProfile({ ...pgInput, password: PASSWORD })
    const session = await context.manager.connect({ profileId: created.id })
    return { ...context, sessionId: session.sessionId }
  }

  it('resuelve la sesión activa y delega en su adapter', async () => {
    const { manager, postgres, sessionId } = await connected()
    const listTables = vi.spyOn(postgres.behavior, 'listTables')

    expect(await manager.listSchemas({ sessionId })).toEqual([{ name: 'public' }])
    expect(await manager.listTables({ sessionId, schema: 'public' })).toEqual([FAKE_TABLE])
    expect(await manager.describeTable({ sessionId, table: FAKE_TABLE })).toEqual(
      FAKE_TABLE_DETAILS,
    )
    expect(listTables).toHaveBeenCalledWith(sessionId, 'public')
  })

  it('una sesión inexistente o ya cerrada responde no_session sin llamar al adapter', async () => {
    const { manager, postgres, sessionId } = await connected()
    const listSchemas = vi.spyOn(postgres.behavior, 'listSchemas')

    await expectNormalized(manager.listSchemas({ sessionId: 'unknown' }), 'no_session')
    await manager.disconnect({ sessionId })

    await expectNormalized(manager.listSchemas({ sessionId }), 'no_session')
    await expectNormalized(manager.listTables({ sessionId }), 'no_session')
    await expectNormalized(manager.describeTable({ sessionId, table: FAKE_TABLE }), 'no_session')
    expect(listSchemas).not.toHaveBeenCalled()
  })

  it('conserva el error normalizado del adapter y redacta host, usuario y password', async () => {
    const { manager, postgres, sessionId } = await connected()
    postgres.behavior.listTables = () =>
      Promise.reject(
        new AdapterError(
          createNormalizedError('not_found', `schema missing on ${HOST} for analyst`),
        ),
      )

    const error = await rejection(manager.listTables({ sessionId, schema: 'nope' }))

    expect(error.normalized.code).toBe('not_found')
    expect(JSON.stringify(error.normalized)).not.toContain(HOST)
    expect(JSON.stringify(error.normalized)).not.toContain('analyst')
  })

  it('un fallo desconocido del adapter no filtra su mensaje', async () => {
    const { manager, postgres, sessionId } = await connected()
    postgres.behavior.describeTable = () =>
      Promise.reject(new Error(`connect ECONNREFUSED ${HOST} password=${PASSWORD}`))

    const error = await rejection(manager.describeTable({ sessionId, table: FAKE_TABLE }))

    expect(error.normalized).toEqual({
      code: 'internal_error',
      message: 'An unexpected internal error occurred',
      retryable: false,
    })
  })

  it('redacta con el contexto del perfil aunque el adapter no lo haya hecho', async () => {
    const { manager, sqlite, approvedSqlitePaths } = setup()
    approvedSqlitePaths.approve(sqliteInput.filePath)
    const created = await manager.createProfile(sqliteInput)
    const { sessionId } = await manager.connect({ profileId: created.id })
    sqlite.behavior.listSchemas = () =>
      Promise.reject(
        new AdapterError({
          code: 'internal_error',
          message: `cannot read ${sqliteInput.filePath}`,
          retryable: false,
        }),
      )

    const error = await rejection(manager.listSchemas({ sessionId }))

    expect(error.normalized.message).not.toContain(sqliteInput.filePath)
  })
})

describe('ConnectionManager: perfiles almacenados corruptos', () => {
  it('list no falla y las operaciones siguen funcionando tras un archivo corrupto', async () => {
    const { manager, memory } = setup()
    memory.files.set(PROFILES_PATH, '{ not json')

    expect(await manager.listProfiles()).toEqual([])
    const created = await manager.createProfile(pgInput)

    expect(await manager.listProfiles()).toEqual([created])
    expect(memory.files.get(`${PROFILES_PATH}.corrupt`)).toBe('{ not json')
  })
})
