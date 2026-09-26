// @vitest-environment node
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCredentialStore,
  CredentialStoreError,
  type CredentialFileSystem,
  type SafeStorageLike,
} from './credential-store'
import { createNodeCredentialFileSystem, credentialsFilePath } from './node-file-system'

const FILE_PATH = '/user-data/credentials.json'
const SECRET = 'p4ssw0rd-super-secreta!'

function createFakeSafeStorage(available = true): SafeStorageLike & { available: boolean } {
  const key = randomBytes(32)
  const state = {
    available,
    isEncryptionAvailable: () => state.available,
    encryptString(plainText: string): Buffer {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(encrypted: Buffer): string {
      const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
      decipher.setAuthTag(encrypted.subarray(12, 28))
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(
        'utf8',
      )
    },
  }
  return state
}

function createMemoryFileSystem() {
  const files = new Map<string, string>()
  const hooks: { failRename: boolean; failWrite: boolean; failRead: boolean } = {
    failRename: false,
    failWrite: false,
    failRead: false,
  }
  const fileSystem: CredentialFileSystem = {
    async readFile(path) {
      if (hooks.failRead) throw Object.assign(new Error(`EIO ${path}`), { code: 'EIO' })
      const content = files.get(path)
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return content
    },
    async writeFile(path, data) {
      if (hooks.failWrite) throw new Error('disk full')
      files.set(path, data)
    },
    async rename(from, to) {
      if (hooks.failRename) throw new Error('rename failed')
      const content = files.get(from)
      if (content === undefined) throw new Error('missing source')
      files.delete(from)
      files.set(to, content)
    },
    async rm(path) {
      files.delete(path)
    },
    async mkdir() {},
  }
  return { files, hooks, fileSystem }
}

function setup(options: { encryption?: boolean } = {}) {
  const safeStorage = createFakeSafeStorage(options.encryption ?? true)
  const memory = createMemoryFileSystem()
  const store = createCredentialStore({
    safeStorage,
    fileSystem: memory.fileSystem,
    filePath: FILE_PATH,
  })
  return { safeStorage, store, ...memory }
}

describe('CredentialStore', () => {
  it('guarda y recupera un secreto (round-trip) bajo una secretRef generada', async () => {
    const { store } = setup()

    const secretRef = await store.save(SECRET)

    expect(secretRef).toMatch(/^[0-9a-f-]{36}$/)
    await expect(store.get(secretRef)).resolves.toBe(SECRET)
    await expect(store.has(secretRef)).resolves.toBe(true)
  })

  it('reemplaza el secreto si se guarda de nuevo bajo la misma secretRef', async () => {
    const { store } = setup()
    const secretRef = await store.save('uno')

    await expect(store.save('dos', secretRef)).resolves.toBe(secretRef)

    await expect(store.get(secretRef)).resolves.toBe('dos')
  })

  it('devuelve undefined / false para una secretRef inexistente', async () => {
    const { store } = setup()

    await expect(store.get('no-existe')).resolves.toBeUndefined()
    await expect(store.has('no-existe')).resolves.toBe(false)
    await expect(store.delete('no-existe')).resolves.toBe(false)
  })

  it('no escribe el secreto en claro ni en base64 trivial en disco', async () => {
    const { store, files } = setup()

    await store.save(SECRET)

    const onDisk = files.get(FILE_PATH)
    expect(onDisk).toBeDefined()
    expect(onDisk).not.toContain(SECRET)
    expect(onDisk).not.toContain(Buffer.from(SECRET).toString('base64'))
    expect(onDisk).not.toContain(Buffer.from(SECRET).toString('hex'))
    expect(JSON.parse(onDisk!)).toMatchObject({ version: 1, secrets: expect.any(Object) })
  })

  it('falla de forma segura sin cifrado disponible y no escribe nada', async () => {
    const { store, files } = setup({ encryption: false })

    const error = await store.save(SECRET).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(CredentialStoreError)
    expect((error as CredentialStoreError).code).toBe('ENCRYPTION_UNAVAILABLE')
    expect(files.size).toBe(0)
  })

  it('falla de forma segura si encryptString lanza, sin filtrar el secreto', async () => {
    const { store, safeStorage, files } = setup()
    safeStorage.encryptString = () => {
      throw new Error(`fallo cifrando ${SECRET}`)
    }

    const error = await store.save(SECRET).catch((e: unknown) => e)

    expect((error as CredentialStoreError).code).toBe('ENCRYPTION_UNAVAILABLE')
    expect((error as Error).message).not.toContain(SECRET)
    expect(files.size).toBe(0)
  })

  it('no recupera secretos si el cifrado deja de estar disponible', async () => {
    const { store, safeStorage } = setup()
    const secretRef = await store.save(SECRET)
    safeStorage.available = false

    await expect(store.get(secretRef)).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' })
  })

  it('reporta DECRYPT_FAILED sin exponer el ciphertext si el descifrado falla', async () => {
    const { store, files } = setup()
    const secretRef = await store.save(SECRET)
    const tampered = JSON.parse(files.get(FILE_PATH)!) as { secrets: Record<string, string> }
    tampered.secrets[secretRef] = Buffer.from('basura-no-cifrada-por-safestorage').toString(
      'base64',
    )
    files.set(FILE_PATH, JSON.stringify(tampered))

    const error = await store.get(secretRef).catch((e: unknown) => e)

    expect((error as CredentialStoreError).code).toBe('DECRYPT_FAILED')
    expect((error as Error).message).not.toContain(tampered.secrets[secretRef])
  })

  it('borra un secreto individual sin afectar a los demás', async () => {
    const { store } = setup()
    const a = await store.save('a')
    const b = await store.save('b')

    await expect(store.delete(a)).resolves.toBe(true)

    await expect(store.has(a)).resolves.toBe(false)
    await expect(store.get(b)).resolves.toBe('b')
  })

  it('clearAll elimina todos los secretos y el archivo, incluso sin cifrado', async () => {
    const { store, safeStorage, files } = setup()
    const a = await store.save('a')
    const b = await store.save('b')
    files.set(`${FILE_PATH}.tmp`, 'residuo')
    safeStorage.available = false

    await store.clearAll()

    expect(files.size).toBe(0)
    await expect(store.has(a)).resolves.toBe(false)
    await expect(store.has(b)).resolves.toBe(false)
  })

  it('clearAll sin archivo previo no falla', async () => {
    const { store } = setup()

    await expect(store.clearAll()).resolves.toBeUndefined()
  })

  describe('archivo corrupto', () => {
    it.each([
      ['JSON inválido', '{no es json'],
      ['vacío', ''],
      ['no es un objeto', '[1,2,3]'],
      ['sin secrets', '{"version":1}'],
      ['secrets no es un objeto', '{"version":1,"secrets":"x"}'],
    ])('se trata como vacío: %s', async (_name, content) => {
      const { store, files } = setup()
      files.set(FILE_PATH, content)

      await expect(store.has('cualquiera')).resolves.toBe(false)
      await expect(store.get('cualquiera')).resolves.toBeUndefined()

      const secretRef = await store.save(SECRET)
      await expect(store.get(secretRef)).resolves.toBe(SECRET)
    })

    it('ignora entradas con valor no string y conserva las válidas', async () => {
      const { store, safeStorage, files } = setup()
      const ciphertext = safeStorage.encryptString(SECRET).toString('base64')
      files.set(
        FILE_PATH,
        JSON.stringify({ version: 1, secrets: { bad: 42, good: ciphertext, '': ciphertext } }),
      )

      await expect(store.has('bad')).resolves.toBe(false)
      await expect(store.get('good')).resolves.toBe(SECRET)
    })

    it('un error de lectura distinto de ENOENT no se confunde con archivo vacío', async () => {
      const { store, files, hooks } = setup()
      const secretRef = await store.save(SECRET)
      const before = files.get(FILE_PATH)
      hooks.failRead = true

      const error = await store.save('otro').catch((e: unknown) => e)

      expect((error as CredentialStoreError).code).toBe('STORAGE_FAILED')
      expect((error as Error).message).not.toContain(FILE_PATH)
      hooks.failRead = false
      expect(files.get(FILE_PATH)).toBe(before)
      await expect(store.get(secretRef)).resolves.toBe(SECRET)
    })
  })

  describe('escritura atómica', () => {
    it('escribe en un temporal y lo renombra: no queda .tmp', async () => {
      const { store, files } = setup()

      await store.save(SECRET)

      expect([...files.keys()]).toEqual([FILE_PATH])
    })

    it('si falla el rename conserva el archivo anterior intacto y limpia el temporal', async () => {
      const { store, files, hooks } = setup()
      const secretRef = await store.save(SECRET)
      const before = files.get(FILE_PATH)
      hooks.failRename = true

      const error = await store.save('nuevo').catch((e: unknown) => e)

      expect((error as CredentialStoreError).code).toBe('STORAGE_FAILED')
      expect((error as Error).message).not.toContain('nuevo')
      expect(files.get(FILE_PATH)).toBe(before)
      expect([...files.keys()]).toEqual([FILE_PATH])
      hooks.failRename = false
      await expect(store.get(secretRef)).resolves.toBe(SECRET)
    })

    it('si falla el rename en un primer guardado no crea archivo final', async () => {
      const { store, files, hooks } = setup()
      hooks.failRename = true

      await expect(store.save(SECRET)).rejects.toMatchObject({ code: 'STORAGE_FAILED' })

      expect(files.size).toBe(0)
    })

    it('si falla la escritura del temporal no toca el archivo final', async () => {
      const { store, files, hooks } = setup()
      await store.save(SECRET)
      const before = files.get(FILE_PATH)
      hooks.failWrite = true

      await expect(store.save('otro')).rejects.toMatchObject({ code: 'STORAGE_FAILED' })

      expect(files.get(FILE_PATH)).toBe(before)
    })

    it('serializa guardados concurrentes sin perder ninguno', async () => {
      const { store } = setup()

      const refs = await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(`s${i}`)))

      const values = await Promise.all(refs.map((ref) => store.get(ref)))
      expect(values).toEqual(Array.from({ length: 20 }, (_, i) => `s${i}`))
    })
  })

  describe('validación de entrada', () => {
    it.each([
      ['vacío', ''],
      ['no string', 42 as unknown as string],
    ])('rechaza un secreto %s', async (_name, secret) => {
      const { store, files } = setup()

      await expect(store.save(secret)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(files.size).toBe(0)
    })

    it.each([
      ['vacía', ''],
      ['demasiado larga', 'x'.repeat(129)],
    ])('rechaza una secretRef %s', async (_name, ref) => {
      const { store } = setup()

      await expect(store.save(SECRET, ref)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(store.get(ref)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(store.has(ref)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(store.delete(ref)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    })

    it('trata __proto__ como una secretRef más, sin contaminar prototipos', async () => {
      const { store } = setup()

      await store.save(SECRET, '__proto__')

      await expect(store.get('__proto__')).resolves.toBe(SECRET)
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    })
  })
})

describe('createNodeCredentialFileSystem (disco real)', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('persiste con permisos 0600, sin dejar temporales, y sobrevive a un archivo preexistente permisivo', async () => {
    dir = await mkdtemp(join(tmpdir(), 'strata-cred-'))
    const filePath = credentialsFilePath(join(dir, 'nested'))
    const safeStorage = createFakeSafeStorage()
    const store = createCredentialStore({
      safeStorage,
      fileSystem: createNodeCredentialFileSystem(),
      filePath,
    })

    const secretRef = await store.save(SECRET)
    await writeFile(`${filePath}.tmp`, 'residuo', { mode: 0o644 })
    await store.save('otro')

    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(dir, 'nested'))).toEqual(['credentials.json'])
    expect(await readFile(filePath, 'utf8')).not.toContain(SECRET)
    await expect(store.get(secretRef)).resolves.toBe(SECRET)

    await store.clearAll()
    expect(await readdir(join(dir, 'nested'))).toEqual([])
  })
})
