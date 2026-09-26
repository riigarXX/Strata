import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export type CredentialStoreErrorCode =
  'ENCRYPTION_UNAVAILABLE' | 'INVALID_INPUT' | 'DECRYPT_FAILED' | 'STORAGE_FAILED'

// Mensajes fijos: nunca incluyen el secreto, la ruta ni la causa original.
const ERROR_MESSAGES: Record<CredentialStoreErrorCode, string> = {
  ENCRYPTION_UNAVAILABLE: 'El cifrado seguro del sistema no está disponible',
  INVALID_INPUT: 'Entrada no válida para el almacén de credenciales',
  DECRYPT_FAILED: 'No se pudo descifrar el secreto guardado',
  STORAGE_FAILED: 'No se pudo acceder al almacén de credenciales',
}

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreErrorCode

  constructor(code: CredentialStoreErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'CredentialStoreError'
    this.code = code
  }
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface CredentialFileSystem {
  /** Debe rechazar con `{ code: 'ENOENT' }` si el archivo no existe. */
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** No falla si el archivo no existe. */
  rm(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export interface CredentialStoreDependencies {
  safeStorage: SafeStorageLike
  fileSystem: CredentialFileSystem
  filePath: string
  generateSecretRef?: () => string
}

export interface CredentialStore {
  /** Cifra y guarda el secreto; devuelve la `secretRef` (generada si no se indica, reemplaza si ya existe). */
  save(secret: string, secretRef?: string): Promise<string>
  /** Solo para uso interno de main. `undefined` si la referencia no existe. */
  get(secretRef: string): Promise<string | undefined>
  has(secretRef: string): Promise<boolean>
  /** `true` si existía. */
  delete(secretRef: string): Promise<boolean>
  clearAll(): Promise<void>
}

const FILE_MODE = 0o600
const FILE_VERSION = 1
const MAX_SECRET_REF_LENGTH = 128

type Entries = Map<string, string>

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isValidSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_REF_LENGTH
}

// Un archivo ilegible o con forma inesperada se trata como vacío: no debe tirar la app.
function parseEntries(raw: string): Entries {
  const entries: Entries = new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return entries
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return entries
  const secrets: unknown = (parsed as { secrets?: unknown }).secrets
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) return entries
  for (const [ref, ciphertext] of Object.entries(secrets)) {
    if (isValidSecretRef(ref) && typeof ciphertext === 'string') entries.set(ref, ciphertext)
  }
  return entries
}

function serializeEntries(entries: Entries): string {
  return JSON.stringify({ version: FILE_VERSION, secrets: Object.fromEntries(entries) })
}

export function createCredentialStore({
  safeStorage,
  fileSystem,
  filePath,
  generateSecretRef = randomUUID,
}: CredentialStoreDependencies): CredentialStore {
  const tempPath = `${filePath}.tmp`
  // Cola de promesas: serializa lecturas-modificaciones-escrituras para no perder actualizaciones.
  let queue: Promise<unknown> = Promise.resolve()

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task)
    queue = result.catch(() => undefined)
    return result
  }

  async function readEntries(): Promise<Entries> {
    try {
      return parseEntries(await fileSystem.readFile(filePath))
    } catch (error) {
      if (isNotFound(error)) return new Map()
      throw new CredentialStoreError('STORAGE_FAILED')
    }
  }

  async function writeEntries(entries: Entries): Promise<void> {
    try {
      await fileSystem.mkdir(dirname(filePath))
      await fileSystem.writeFile(tempPath, serializeEntries(entries), FILE_MODE)
      await fileSystem.rename(tempPath, filePath)
    } catch {
      await fileSystem.rm(tempPath).catch(() => undefined)
      throw new CredentialStoreError('STORAGE_FAILED')
    }
  }

  function assertEncryptionAvailable(): void {
    if (!safeStorage.isEncryptionAvailable())
      throw new CredentialStoreError('ENCRYPTION_UNAVAILABLE')
  }

  function assertSecretRef(secretRef: unknown): asserts secretRef is string {
    if (!isValidSecretRef(secretRef)) throw new CredentialStoreError('INVALID_INPUT')
  }

  return {
    save(secret, secretRef = generateSecretRef()) {
      return serialize(async () => {
        assertSecretRef(secretRef)
        if (typeof secret !== 'string' || secret.length === 0) {
          throw new CredentialStoreError('INVALID_INPUT')
        }
        assertEncryptionAvailable()

        let ciphertext: string
        try {
          ciphertext = safeStorage.encryptString(secret).toString('base64')
        } catch {
          throw new CredentialStoreError('ENCRYPTION_UNAVAILABLE')
        }

        const entries = await readEntries()
        entries.set(secretRef, ciphertext)
        await writeEntries(entries)
        return secretRef
      })
    },

    get(secretRef) {
      return serialize(async () => {
        assertSecretRef(secretRef)
        const ciphertext = (await readEntries()).get(secretRef)
        if (ciphertext === undefined) return undefined
        assertEncryptionAvailable()
        try {
          return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
        } catch {
          throw new CredentialStoreError('DECRYPT_FAILED')
        }
      })
    },

    has(secretRef) {
      return serialize(async () => {
        assertSecretRef(secretRef)
        return (await readEntries()).has(secretRef)
      })
    },

    delete(secretRef) {
      return serialize(async () => {
        assertSecretRef(secretRef)
        const entries = await readEntries()
        if (!entries.delete(secretRef)) return false
        await writeEntries(entries)
        return true
      })
    },

    clearAll() {
      return serialize(async () => {
        try {
          await fileSystem.rm(filePath)
          await fileSystem.rm(tempPath)
        } catch {
          throw new CredentialStoreError('STORAGE_FAILED')
        }
      })
    },
  }
}
