// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppServices } from '../app-services'

const SECRET = 'hunter2-s3cret-pw!'

// Cifrado de juguete reversible: lo único que importa es que el archivo no contenga la password en claro.
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(Buffer.from(plain).map((byte) => byte ^ 0x5a)),
  decryptString: (encrypted: Buffer) =>
    Buffer.from(encrypted.map((byte) => byte ^ 0x5a)).toString(),
}

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function populatedUserData() {
  const userDataPath = await mkdtemp(join(tmpdir(), 'strata-user-data-'))
  directories.push(userDataPath)
  const services = createAppServices({ userDataPath, safeStorage, showOpenDialog: vi.fn() })

  const profile = await services.connectionManager.createProfile({
    engine: 'postgres',
    name: 'Prod',
    readOnly: false,
    host: 'db.internal.example.com',
    port: 5432,
    user: 'svc_admin',
    database: 'app',
    ssl: 'require',
    password: SECRET,
  })
  await services.preferencesStore.update({ history: { retentionDays: 7 } })
  await services.historyStore.add({
    sql: 'SELECT 1',
    engine: 'postgres',
    profileId: profile.id,
    profileName: profile.name,
    executedAt: new Date().toISOString(),
    durationMs: 3,
    status: 'ok',
  })
  return { userDataPath, profile }
}

describe('archivos de userData tras una sesión que guarda una password', () => {
  it('connections, credentials, preferences e history existen, con modo 0600 y sin residuos temporales', async () => {
    const { userDataPath } = await populatedUserData()

    const files = (await readdir(userDataPath)).sort()
    expect(files).toEqual([
      'connections.json',
      'credentials.json',
      'history.json',
      'preferences.json',
    ])
    for (const file of files) {
      expect((await stat(join(userDataPath, file))).mode & 0o777, file).toBe(0o600)
    }
  })

  it('ningún archivo contiene la password en claro ni en base64', async () => {
    const { userDataPath } = await populatedUserData()
    const encodings = [
      SECRET,
      Buffer.from(SECRET).toString('base64'),
      Buffer.from(SECRET).toString('hex'),
      encodeURIComponent(SECRET),
    ]

    for (const file of await readdir(userDataPath)) {
      const content = await readFile(join(userDataPath, file), 'utf8')
      for (const encoded of encodings) expect(content, file).not.toContain(encoded)
    }
    expect(await readFile(join(userDataPath, 'credentials.json'), 'utf8')).toContain('"secrets"')
  })

  it('el perfil que vuelve al renderer no incluye la password, solo una referencia', async () => {
    const { profile } = await populatedUserData()

    expect(JSON.stringify(profile)).not.toContain(SECRET)
    expect(profile).not.toHaveProperty('password')
  })

  it('un perfil sin password no crea credentials.json', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'strata-user-data-'))
    directories.push(userDataPath)
    const { connectionManager } = createAppServices({
      userDataPath,
      safeStorage,
      showOpenDialog: vi.fn(),
    })

    await connectionManager.createProfile({
      engine: 'postgres',
      name: 'Local',
      readOnly: false,
      host: 'localhost',
      port: 5432,
      user: 'me',
      database: 'app',
      ssl: 'disable',
    })

    expect(await readdir(userDataPath)).toEqual(['connections.json'])
  })
})
