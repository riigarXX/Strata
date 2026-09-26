import { dirname } from 'node:path'
import { ConnectionProfileSchema, type ConnectionProfile } from '@strata/contracts'

export class ProfileStoreError extends Error {
  constructor() {
    // Mensaje fijo: nunca incluye la ruta ni la causa original.
    super('No se pudo acceder al almacén de perfiles de conexión')
    this.name = 'ProfileStoreError'
  }
}

export interface ProfileFileSystem {
  /** Debe rechazar con `{ code: 'ENOENT' }` si el archivo no existe. */
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** No falla si el archivo no existe. */
  rm(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export interface ProfileStoreDependencies {
  fileSystem: ProfileFileSystem
  filePath: string
}

/** Perfiles públicos (sin secretos): los secretos viven en el CredentialStore (ADR 0009). */
export interface ProfileStore {
  list(): Promise<ConnectionProfile[]>
  get(id: string): Promise<ConnectionProfile | undefined>
  /** Inserta o reemplaza por `id`. */
  save(profile: ConnectionProfile): Promise<void>
  /** `true` si existía. */
  remove(id: string): Promise<boolean>
}

const FILE_MODE = 0o600
const FILE_VERSION = 1

type Profiles = Map<string, ConnectionProfile>

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

interface ParsedProfiles {
  profiles: Profiles
  /** `true` si el archivo no era JSON válido o alguna entrada no superó el schema. */
  damaged: boolean
}

function parseProfiles(raw: string): ParsedProfiles {
  const profiles: Profiles = new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { profiles, damaged: true }
  }
  const entries: unknown =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { profiles?: unknown }).profiles
      : undefined
  if (!Array.isArray(entries)) return { profiles, damaged: true }

  let damaged = false
  for (const entry of entries) {
    const result = ConnectionProfileSchema.safeParse(entry)
    if (result.success && !profiles.has(result.data.id)) {
      profiles.set(result.data.id, result.data)
    } else {
      damaged = true
    }
  }
  return { profiles, damaged }
}

function serializeProfiles(profiles: Profiles): string {
  return JSON.stringify({ version: FILE_VERSION, profiles: [...profiles.values()] }, null, 2)
}

export function createProfileStore({
  fileSystem,
  filePath,
}: ProfileStoreDependencies): ProfileStore {
  const tempPath = `${filePath}.tmp`
  const backupPath = `${filePath}.corrupt`
  let cache: Profiles | undefined
  // Cola de promesas: serializa lecturas y escrituras para no perder actualizaciones.
  let queue: Promise<unknown> = Promise.resolve()

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task)
    queue = result.catch(() => undefined)
    return result
  }

  async function load(): Promise<Profiles> {
    if (cache) return cache

    let raw: string
    try {
      raw = await fileSystem.readFile(filePath)
    } catch (error) {
      if (isNotFound(error)) return (cache = new Map())
      // Un error de E/S no prueba que el archivo sea inválido: no se sustituye por uno vacío.
      throw new ProfileStoreError()
    }

    const { profiles, damaged } = parseProfiles(raw)
    if (damaged) {
      // Se conserva el original para poder recuperarlo: la próxima escritura sobrescribe `filePath`.
      await fileSystem.writeFile(backupPath, raw, FILE_MODE).catch(() => undefined)
    }
    return (cache = profiles)
  }

  async function persist(next: Profiles): Promise<void> {
    try {
      await fileSystem.mkdir(dirname(filePath))
      await fileSystem.writeFile(tempPath, serializeProfiles(next), FILE_MODE)
      await fileSystem.rename(tempPath, filePath)
    } catch {
      await fileSystem.rm(tempPath).catch(() => undefined)
      throw new ProfileStoreError()
    }
    cache = next
  }

  return {
    list: () => serialize(async () => [...(await load()).values()]),

    get: (id) => serialize(async () => (await load()).get(id)),

    save: (profile) =>
      serialize(async () => {
        const next = new Map(await load())
        next.set(profile.id, ConnectionProfileSchema.parse(profile))
        await persist(next)
      }),

    remove: (id) =>
      serialize(async () => {
        const next = new Map(await load())
        if (!next.delete(id)) return false
        await persist(next)
        return true
      }),
  }
}
