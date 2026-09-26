import { dirname } from 'node:path'
import { AdapterError, createNormalizedError } from '@strata/db-core'

export interface StorageFileSystem {
  /** Debe rechazar con `{ code: 'ENOENT' }` si el archivo no existe. */
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** No falla si el archivo no existe. */
  rm(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export const STORAGE_FILE_MODE = 0o600

/**
 * Archivo JSON de un almacén local: lectura, escritura atómica (temporal + rename, permisos 0600) y copia
 * del original dañado. No conoce el formato del contenido y falla siempre con un error de mensaje fijo:
 * nunca incluye la ruta ni la causa original.
 */
export interface JsonFile {
  /** `undefined` si el archivo no existe. Un error de E/S no prueba que el archivo sea inválido: se lanza. */
  read(): Promise<string | undefined>
  write(data: string): Promise<void>
  /** Conserva el original ilegible para poder recuperarlo: la próxima escritura sobrescribe el archivo. */
  keepCorruptCopy(raw: string): Promise<void>
}

export interface JsonFileDependencies {
  fileSystem: StorageFileSystem
  filePath: string
  /** Mensaje seguro que llega al renderer cuando falla la E/S. */
  failureMessage: string
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export function createJsonFile({
  fileSystem,
  filePath,
  failureMessage,
}: JsonFileDependencies): JsonFile {
  const tempPath = `${filePath}.tmp`
  const backupPath = `${filePath}.corrupt`
  const failure = () => new AdapterError(createNormalizedError('internal_error', failureMessage))

  return {
    async read() {
      try {
        return await fileSystem.readFile(filePath)
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw failure()
      }
    },

    async write(data) {
      try {
        await fileSystem.mkdir(dirname(filePath))
        await fileSystem.writeFile(tempPath, data, STORAGE_FILE_MODE)
        await fileSystem.rename(tempPath, filePath)
      } catch {
        await fileSystem.rm(tempPath).catch(() => undefined)
        throw failure()
      }
    },

    async keepCorruptCopy(raw) {
      await fileSystem.writeFile(backupPath, raw, STORAGE_FILE_MODE).catch(() => undefined)
    },
  }
}

/** Cola de promesas: serializa lecturas y escrituras de un almacén para no perder actualizaciones. */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve()
  return (task) => {
    const result = queue.then(task, task)
    queue = result.catch(() => undefined)
    return result
  }
}
