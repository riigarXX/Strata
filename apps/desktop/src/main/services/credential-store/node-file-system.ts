import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialFileSystem } from './credential-store'

export const CREDENTIALS_FILE_NAME = 'credentials.json'

export function credentialsFilePath(userDataPath: string): string {
  return join(userDataPath, CREDENTIALS_FILE_NAME)
}

export function createNodeCredentialFileSystem(): CredentialFileSystem {
  return {
    readFile: (path) => readFile(path, 'utf8'),

    async writeFile(path, data, mode) {
      const handle = await open(path, 'w', mode)
      try {
        // `open` no cambia los permisos de un archivo preexistente.
        await handle.chmod(mode)
        await handle.writeFile(data, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    },

    rename: (from, to) => rename(from, to),
    rm: (path) => rm(path, { force: true }),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true })
    },
  }
}
