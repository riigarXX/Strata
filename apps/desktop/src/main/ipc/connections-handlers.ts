import {
  ConnectionProfileInputSchema,
  ConnectionProfileListSchema,
  ConnectionProfileSchema,
  ConnectionProfileUpdateSchema,
  ConnectRequestSchema,
  DeleteProfileRequestSchema,
  DisconnectRequestSchema,
  IPC_CHANNELS,
  PickSqliteFileResultSchema,
  SessionSchema,
  TestConnectionRequestSchema,
  TestConnectionResultSchema,
} from '@strata/contracts'
import type { SqliteFilePicker, ConnectionManager } from '../services/connection-manager'
import {
  createSecureHandlerFactory,
  nothing,
  type IpcHandler,
  type SecureHandlerDependencies,
} from './secure-handler'

export interface ConnectionsHandlersDependencies extends SecureHandlerDependencies {
  connectionManager: ConnectionManager
  sqliteFilePicker: SqliteFilePicker
}

/**
 * Un handler por canal de `IPC_CHANNELS.connections`: valida el remitente, revalida el payload con el
 * schema de contracts (ADR 0008) y responde con el schema de salida, siempre dentro de un `IpcResult`.
 */
export function createConnectionsHandlers({
  connectionManager,
  sqliteFilePicker,
  ...security
}: ConnectionsHandlersDependencies): Readonly<Record<string, IpcHandler>> {
  const channels = IPC_CHANNELS.connections
  const secure = createSecureHandlerFactory(security)

  return {
    [channels.list]: secure({
      input: nothing,
      output: ConnectionProfileListSchema,
      run: () => connectionManager.listProfiles(),
    }),
    [channels.create]: secure({
      input: ConnectionProfileInputSchema,
      output: ConnectionProfileSchema,
      run: (input) => connectionManager.createProfile(input),
    }),
    [channels.update]: secure({
      input: ConnectionProfileUpdateSchema,
      output: ConnectionProfileSchema,
      run: (input) => connectionManager.updateProfile(input),
    }),
    [channels.delete]: secure({
      input: DeleteProfileRequestSchema,
      output: nothing,
      run: (input) => connectionManager.deleteProfile(input),
    }),
    [channels.test]: secure({
      input: TestConnectionRequestSchema,
      output: TestConnectionResultSchema,
      run: (input) => connectionManager.testConnection(input),
    }),
    [channels.connect]: secure({
      input: ConnectRequestSchema,
      output: SessionSchema,
      run: (input) => connectionManager.connect(input),
    }),
    [channels.disconnect]: secure({
      input: DisconnectRequestSchema,
      output: nothing,
      run: (input) => connectionManager.disconnect(input),
    }),
    [channels.pickSqliteFile]: secure({
      input: nothing,
      output: PickSqliteFileResultSchema,
      run: async () => ({ filePath: await sqliteFilePicker.pick() }),
    }),
  }
}
