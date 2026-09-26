import {
  DescribeTableRequestSchema,
  IPC_CHANNELS,
  ListSchemasRequestSchema,
  ListTablesRequestSchema,
  SchemaInfoSchema,
  TableDetailsSchema,
  TableInfoSchema,
} from '@strata/contracts'
import type { ConnectionManager } from '../services/connection-manager'
import {
  arrayOf,
  createSecureHandlerFactory,
  type IpcHandler,
  type SecureHandlerDependencies,
} from './secure-handler'

export interface MetadataHandlersDependencies extends SecureHandlerDependencies {
  connectionManager: Pick<ConnectionManager, 'listSchemas' | 'listTables' | 'describeTable'>
}

/** Un handler por canal de `IPC_CHANNELS.metadata`; la sesión se resuelve en el ConnectionManager. */
export function createMetadataHandlers({
  connectionManager,
  ...security
}: MetadataHandlersDependencies): Readonly<Record<string, IpcHandler>> {
  const channels = IPC_CHANNELS.metadata
  const secure = createSecureHandlerFactory(security)

  return {
    [channels.schemas]: secure({
      input: ListSchemasRequestSchema,
      output: arrayOf(SchemaInfoSchema),
      run: (input) => connectionManager.listSchemas(input),
    }),
    [channels.tables]: secure({
      input: ListTablesRequestSchema,
      output: arrayOf(TableInfoSchema),
      run: (input) => connectionManager.listTables(input),
    }),
    [channels.describe]: secure({
      input: DescribeTableRequestSchema,
      output: TableDetailsSchema,
      run: (input) => connectionManager.describeTable(input),
    }),
  }
}
