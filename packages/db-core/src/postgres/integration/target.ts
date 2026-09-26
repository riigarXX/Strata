// A PostgreSQL server the integration suites can run against (a Docker container or the one in STRATA_TEST_PG_URL).
export interface PgTargetBase {
  readonly label: string
  readonly host: string
  readonly port: number
  readonly database: string
  // Superuser (or an account with CREATEROLE): used only to create the test roles and inspect pg_stat_activity.
  readonly adminUser: string
  readonly adminPassword: string
  // The server accepts TLS (only the Docker containers are started with it).
  readonly tls: boolean
}

export interface PgTarget extends PgTargetBase {
  // Owns its own schemas and can create objects; the role every suite works as.
  readonly appUser: string
  readonly appPassword: string
  // Can connect but was granted nothing: the source of permission_denied.
  readonly limitedUser: string
  readonly limitedPassword: string
  readonly version: string
}
