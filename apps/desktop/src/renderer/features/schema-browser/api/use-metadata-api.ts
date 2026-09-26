import { SchemaInfoSchema, TableDetailsSchema, TableInfoSchema } from '@strata/contracts'
import type { DbApi } from '../../../../shared/db-api'
import { settleIpc as settle } from '../../../composables/settle-ipc'

export type MetadataApi = DbApi['metadata']

const SchemaListSchema = SchemaInfoSchema.array()
const TableListSchema = TableInfoSchema.array()

/**
 * Envuelve `window.db.metadata`: ningún método lanza y las respuestas se revalidan con los schemas
 * de `@strata/contracts` antes de llegar al store.
 */
export function useMetadataApi(): MetadataApi {
  const db = () => window.db.metadata

  return {
    listSchemas: (request) => settle(() => db().listSchemas(request), SchemaListSchema),
    listTables: (request) => settle(() => db().listTables(request), TableListSchema),
    describeTable: (request) => settle(() => db().describeTable(request), TableDetailsSchema),
  }
}
