// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppServices } from './app-services'

describe('createAppServices', () => {
  it('registra los adapters de PostgreSQL y SQLite sin tocar safeStorage', () => {
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((plain: string) => Buffer.from(plain)),
      decryptString: vi.fn((encrypted: Buffer) => encrypted.toString()),
    }

    const { adapters } = createAppServices({
      userDataPath: '/user-data',
      safeStorage,
      sqliteWorkerPath: 'unused-in-this-test',
      showOpenDialog: vi.fn(),
    })

    expect(adapters.list().map((adapter) => adapter.engine)).toEqual(['postgres', 'sqlite'])
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
  })

  it('expone el ejecutor de consultas conectado al ConnectionManager', () => {
    const { queryExecutor, connectionManager } = createAppServices({
      userDataPath: '/user-data',
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain: string) => Buffer.from(plain),
        decryptString: (encrypted: Buffer) => encrypted.toString(),
      },
      sqliteWorkerPath: 'unused-in-this-test',
      showOpenDialog: vi.fn(),
    })

    expect(queryExecutor.cancelSession).toBeTypeOf('function')
    expect(connectionManager.getSessionRuntime('none')).toBeUndefined()
  })
})

describe('createAppServices: preferencias e historial', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function setup() {
    const userDataPath = await mkdtemp(join(tmpdir(), 'strata-app-services-'))
    dirs.push(userDataPath)
    const services = createAppServices({
      userDataPath,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain: string) => Buffer.from(plain),
        decryptString: (encrypted: Buffer) => encrypted.toString(),
      },
      sqliteWorkerPath: 'unused-in-this-test',
      showOpenDialog: vi.fn(),
    })
    return { ...services, userDataPath }
  }

  const entry = (daysAgo: number, sql: string) => ({
    sql,
    engine: 'sqlite' as const,
    profileId: 'p1',
    profileName: 'Local',
    executedAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    durationMs: 1,
    status: 'ok' as const,
  })

  it('no toca el disco al crear los servicios', async () => {
    const { userDataPath } = await setup()
    await mkdir(userDataPath, { recursive: true })

    await expect(stat(join(userDataPath, 'history.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(userDataPath, 'preferences.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('guarda preferencias e historial en archivos propios con permisos 0600', async () => {
    const { preferencesStore, historyStore, userDataPath } = await setup()

    await preferencesStore.update({ appearance: { theme: 'dark' } })
    await historyStore.add(entry(0, 'SELECT 1'))

    for (const name of ['preferences.json', 'history.json']) {
      expect((await stat(join(userDataPath, name))).mode & 0o777).toBe(0o600)
    }
    expect(
      JSON.parse(await readFile(join(userDataPath, 'preferences.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
      preferences: { appearance: { theme: 'dark' } },
    })
    const history = await readFile(join(userDataPath, 'history.json'), 'utf8')
    expect(history).toContain('SELECT 1')
    expect(await readFile(join(userDataPath, 'preferences.json'), 'utf8')).not.toContain('SELECT 1')
  })

  it('el historial usa la retención de las preferencias y cambiarla purga de inmediato', async () => {
    const { preferencesStore, historyStore } = await setup()
    await historyStore.add(entry(1, 'recent'))
    await historyStore.add(entry(20, 'twenty days'))
    await historyStore.add(entry(60, 'sixty days'))
    expect((await historyStore.list({})).entries.map(({ sql }) => sql)).toEqual([
      'recent',
      'twenty days',
    ])

    await preferencesStore.update({ history: { retentionDays: 7 } })

    expect((await historyStore.list({})).entries.map(({ sql }) => sql)).toEqual(['recent'])
  })

  it('el asistente de IA lee las preferencias del almacén real: desactivado de fábrica y activable sin reiniciar', async () => {
    const { aiService, preferencesStore } = await setup()
    const request = { requestId: 'r1', sessionId: 's1', question: 'How many rows?' }

    await expect(aiService.generateSql(request)).rejects.toMatchObject({
      normalized: { code: 'permission_denied' },
    })

    await preferencesStore.update({ ai: { enabled: true } })

    // Ya activado, el siguiente rechazo es el de la sesión que no existe: nunca llega a la red.
    await expect(aiService.generateSql(request)).rejects.toMatchObject({
      normalized: { code: 'no_session' },
    })
  })

  it('pasar a retención ilimitada no purga nada', async () => {
    const { preferencesStore, historyStore } = await setup()
    await preferencesStore.update({ history: { retentionDays: null } })
    await historyStore.add(entry(400, 'ancient'))

    await preferencesStore.update({ appearance: { theme: 'light' } })

    expect((await historyStore.list({})).entries).toHaveLength(1)
  })
})
