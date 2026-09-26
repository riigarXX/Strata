export { createPostgresAdapter, type PostgresAdapterOptions } from './adapter'
export { isSupportedPostgresVersion, POSTGRES_MINIMUM_MAJOR_VERSION } from './connection'
export { splitPostgresStatements, type SqlStatement } from './statement-splitter'
