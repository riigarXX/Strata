// @vitest-environment node
import type { ConnectionProfile } from '@strata/contracts'
import { describe, expect, it } from 'vitest'
import { createProfileStore, ProfileStoreError } from './profile-store'
import { createMemoryFileSystem } from './testing'

const FILE_PATH = '/user-data/connections.json'
const CREDENTIALS_PATH = '/user-data/credentials.json'

const pg: ConnectionProfile = {
  id: 'p1',
  engine: 'postgres',
  name: 'PG',
  readOnly: false,
  host: 'localhost',
  port: 5432,
  user: 'me',
  database: 'app',
  ssl: 'disable',
  secretRef: 'ref-1',
}
const sqlite: ConnectionProfile = {
  id: 'p2',
  engine: 'sqlite',
  name: 'File',
  readOnly: true,
  filePath: '/Users/me/data.db',
}

function setup() {
  const memory = createMemoryFileSystem()
  const store = createProfileStore({ fileSystem: memory.fileSystem, filePath: FILE_PATH })
  return { memory, store }
}

describe('ProfileStore', () => {
  it('arranca vacío si el archivo no existe', async () => {
    const { store } = setup()
    expect(await store.list()).toEqual([])
    expect(await store.get('p1')).toBeUndefined()
  })

  it('guarda, reemplaza y elimina perfiles con escritura atómica', async () => {
    const { store, memory } = setup()

    await store.save(pg)
    await store.save(sqlite)
    await store.save({ ...pg, name: 'Renamed' })

    expect((await store.list()).map((profile) => profile.name)).toEqual(['Renamed', 'File'])
    expect(memory.files.has(`${FILE_PATH}.tmp`)).toBe(false)
    expect(await store.remove('p2')).toBe(true)
    expect(await store.remove('p2')).toBe(false)
    expect(JSON.parse(memory.files.get(FILE_PATH) ?? '')).toMatchObject({
      version: 1,
      profiles: [{ id: 'p1' }],
    })
  })

  it('un fallo al escribir conserva el archivo anterior y el estado en memoria', async () => {
    const { store, memory } = setup()
    await store.save(pg)
    const before = memory.files.get(FILE_PATH)

    memory.hooks.failRename = true
    await expect(store.save(sqlite)).rejects.toBeInstanceOf(ProfileStoreError)

    expect(memory.files.get(FILE_PATH)).toBe(before)
    expect(memory.files.has(`${FILE_PATH}.tmp`)).toBe(false)
    expect(await store.list()).toEqual([pg])
  })

  it('un archivo con JSON inválido se trata como vacío y se conserva una copia', async () => {
    const { store, memory } = setup()
    memory.files.set(FILE_PATH, '{"profiles": [')
    memory.files.set(CREDENTIALS_PATH, 'credentials-untouched')

    expect(await store.list()).toEqual([])
    await store.save(pg)

    expect(memory.files.get(`${FILE_PATH}.corrupt`)).toBe('{"profiles": [')
    expect(await store.list()).toEqual([pg])
    expect(memory.files.get(CREDENTIALS_PATH)).toBe('credentials-untouched')
  })

  it.each([
    ['un array', '[]'],
    ['sin lista de perfiles', '{"version":1}'],
    ['con perfiles que no es un array', '{"profiles":"x"}'],
  ])('un archivo %s se trata como corrupto', async (_name, raw) => {
    const { store, memory } = setup()
    memory.files.set(FILE_PATH, raw)

    expect(await store.list()).toEqual([])
    expect(memory.files.get(`${FILE_PATH}.corrupt`)).toBe(raw)
  })

  it('descarta solo las entradas inválidas o duplicadas y conserva el resto', async () => {
    const { store, memory } = setup()
    const raw = JSON.stringify({
      version: 1,
      profiles: [pg, { id: 'bad', engine: 'mysql' }, { ...sqlite, password: 'leak' }, pg, sqlite],
    })
    memory.files.set(FILE_PATH, raw)

    expect((await store.list()).map((profile) => profile.id)).toEqual(['p1', 'p2'])
    expect(memory.files.get(`${FILE_PATH}.corrupt`)).toBe(raw)
  })

  it('un error de E/S no sustituye el archivo por uno vacío y se puede reintentar', async () => {
    const { store, memory } = setup()
    memory.files.set(FILE_PATH, JSON.stringify({ version: 1, profiles: [pg] }))

    memory.hooks.failRead = true
    await expect(store.list()).rejects.toBeInstanceOf(ProfileStoreError)
    expect(memory.files.has(`${FILE_PATH}.corrupt`)).toBe(false)

    memory.hooks.failRead = false
    expect(await store.list()).toEqual([pg])
  })

  it('rechaza guardar un perfil con campos no permitidos, como una password', async () => {
    const { store } = setup()

    await expect(
      store.save({ ...pg, password: 'x' } as unknown as ConnectionProfile),
    ).rejects.toThrow()
    expect(await store.list()).toEqual([])
  })

  it('serializa escrituras concurrentes sin perder ninguna', async () => {
    const { store } = setup()

    await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.save({ ...sqlite, id: `p-${index}` })),
    )

    expect(await store.list()).toHaveLength(10)
  })
})
