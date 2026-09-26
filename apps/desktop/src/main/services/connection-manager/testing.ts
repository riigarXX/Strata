import type {
  SchemaInfo,
  Session,
  TableDetails,
  TableInfo,
  TableRef,
  TestConnectionResult,
} from '@strata/contracts'
import type {
  AdapterCapabilities,
  DatabaseAdapter,
  ResolvedConnectionProfile,
} from '@strata/db-core'
import type { CredentialStore } from '../credential-store'
import type { ProfileFileSystem } from './profile-store'

// Dobles compartidos por los tests del ConnectionManager y de los handlers IPC.

export function createMemoryFileSystem() {
  const files = new Map<string, string>()
  const hooks = { failWrite: false, failRename: false, failRead: false }
  const fileSystem: ProfileFileSystem = {
    async readFile(path) {
      if (hooks.failRead) throw Object.assign(new Error('EIO'), { code: 'EIO' })
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

export function createFakeCredentialStore() {
  const secrets = new Map<string, string>()
  let counter = 0
  const calls = { save: 0, get: 0, delete: 0 }
  const store: Pick<CredentialStore, 'save' | 'get' | 'delete'> = {
    async save(secret, secretRef = `secret-${++counter}`) {
      calls.save++
      secrets.set(secretRef, secret)
      return secretRef
    },
    async get(secretRef) {
      calls.get++
      return secrets.get(secretRef)
    },
    async delete(secretRef) {
      calls.delete++
      return secrets.delete(secretRef)
    },
  }
  return { store, secrets, calls }
}

const CAPABILITIES: AdapterCapabilities = {
  cancellation: false,
  schemas: false,
  explain: false,
  transactions: false,
  readOnlyMode: false,
}

export interface FakeAdapter extends DatabaseAdapter {
  readonly tested: ResolvedConnectionProfile[]
  readonly connected: ResolvedConnectionProfile[]
  readonly disconnected: string[]
  behavior: {
    test: (profile: ResolvedConnectionProfile) => Promise<TestConnectionResult>
    connect: (profile: ResolvedConnectionProfile) => Promise<Session>
    disconnect: (sessionId: string) => Promise<void>
    listSchemas: (sessionId: string) => Promise<SchemaInfo[]>
    listTables: (sessionId: string, schema?: string) => Promise<TableInfo[]>
    describeTable: (sessionId: string, table: TableRef) => Promise<TableDetails>
  }
}

export const FAKE_TABLE: TableInfo = { schema: 'public', name: 'users', kind: 'table' }

export const FAKE_TABLE_DETAILS: TableDetails = {
  table: FAKE_TABLE,
  columns: [{ name: 'id', dataType: 'integer', nullable: false, defaultValue: null }],
  primaryKey: { name: 'users_pkey', columns: ['id'] },
  foreignKeys: [],
  indexes: [{ name: 'users_pkey', columns: ['id'], unique: true }],
}

export function createFakeAdapter(engine: 'postgres' | 'sqlite'): FakeAdapter {
  let counter = 0
  const unsupported = () => {
    throw new Error('not implemented in the fake adapter')
  }
  const adapter: FakeAdapter = {
    engine,
    capabilities: CAPABILITIES,
    tested: [],
    connected: [],
    disconnected: [],
    behavior: {
      test: async () => ({ ok: true, serverVersion: '16.2', latencyMs: 4 }),
      // El adapter dice `readOnly: false` a propósito: main debe imponer el valor del perfil.
      connect: async (profile) => ({
        sessionId: `${engine}-session-${++counter}`,
        profileId: profile.id,
        engine,
        serverVersion: '16.2',
        readOnly: false,
        transaction: 'none',
      }),
      disconnect: async () => {},
      listSchemas: async () => [{ name: 'public' }],
      listTables: async () => [FAKE_TABLE],
      describeTable: async () => FAKE_TABLE_DETAILS,
    },
    async testConnection(profile) {
      adapter.tested.push(profile)
      return adapter.behavior.test(profile)
    },
    async connect(profile) {
      adapter.connected.push(profile)
      return adapter.behavior.connect(profile)
    },
    async disconnect(sessionId) {
      adapter.disconnected.push(sessionId)
      return adapter.behavior.disconnect(sessionId)
    },
    execute: unsupported,
    cancel: unsupported,
    listSchemas: (sessionId) => adapter.behavior.listSchemas(sessionId),
    listTables: (sessionId, schema) => adapter.behavior.listTables(sessionId, schema),
    describeTable: (sessionId, table) => adapter.behavior.describeTable(sessionId, table),
    begin: unsupported,
    commit: unsupported,
    rollback: unsupported,
    transactionState: unsupported,
  }
  return adapter
}
