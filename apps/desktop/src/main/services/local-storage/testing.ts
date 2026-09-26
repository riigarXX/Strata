import type { StorageFileSystem } from './json-file'

// Doble en memoria compartido por los tests de los almacenes locales.
export function createMemoryStorage() {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  const hooks = { failWrite: false, failRename: false, failRead: false }
  const fileSystem: StorageFileSystem = {
    async readFile(path) {
      if (hooks.failRead) throw Object.assign(new Error('EIO'), { code: 'EIO' })
      const content = files.get(path)
      if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return content
    },
    async writeFile(path, data, mode) {
      if (hooks.failWrite) throw new Error('disk full')
      files.set(path, data)
      modes.set(path, mode)
    },
    async rename(from, to) {
      if (hooks.failRename) throw new Error('rename failed')
      const content = files.get(from)
      if (content === undefined) throw new Error('missing source')
      files.delete(from)
      files.set(to, content)
      modes.set(to, modes.get(from) ?? 0)
      modes.delete(from)
    },
    async rm(path) {
      files.delete(path)
      modes.delete(path)
    },
    async mkdir() {},
  }
  return { files, modes, hooks, fileSystem }
}
