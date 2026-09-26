import { Client, type ClientConfig } from 'pg'
import type { ResolvedPostgresProfile } from '../adapter'
import { AdapterError, createNormalizedError } from '../normalization'
import { toAdapterError, type PostgresRedactionContext } from './errors'

// ADR 0003.
export const POSTGRES_MINIMUM_MAJOR_VERSION = 13

const CONNECTION_TIMEOUT_MS = 10_000
const APPLICATION_NAME = 'Strata'

export interface ConnectedClient {
  readonly client: Client
  readonly serverVersion: string
  readonly serverVersionNumber: number
  // Target of pg_cancel_backend; pg does not type the client's own processID.
  readonly backendPid: number
}

export function redactionContextForPostgres(
  profile: ResolvedPostgresProfile,
): PostgresRedactionContext {
  return {
    host: profile.host,
    user: profile.user,
    database: profile.database,
    secrets: profile.password === undefined ? [] : [profile.password],
  }
}

// 'require' encrypts without verifying the certificate (libpq's sslmode=require); only 'verify-full' checks chain and host name.
function sslOptions(mode: ResolvedPostgresProfile['ssl']): ClientConfig['ssl'] {
  switch (mode) {
    case 'disable':
      return false
    case 'require':
      return { rejectUnauthorized: false }
    case 'verify-full':
      return { rejectUnauthorized: true }
  }
}

// default_transaction_read_only is a startup parameter, so there is no window in which the session could write.
// It is defense in depth only: the user can still SET it back, and main remains the enforcer (ADR 0004).
export function clientConfigFor(
  profile: ResolvedPostgresProfile,
  options: { readonly readOnly: boolean },
): ClientConfig {
  return {
    host: profile.host,
    port: profile.port,
    user: profile.user,
    database: profile.database,
    password: profile.password,
    ssl: sslOptions(profile.ssl),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    application_name: APPLICATION_NAME,
    keepAlive: true,
    ...(options.readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
  }
}

// 170004 -> 17.4. Only meaningful from PostgreSQL 10, which is far below the supported minimum.
export function formatVersionNumber(versionNumber: number): string {
  return `${Math.floor(versionNumber / 10000)}.${versionNumber % 10000}`
}

export function isSupportedPostgresVersion(
  versionNumber: number,
  minimumMajor: number = POSTGRES_MINIMUM_MAJOR_VERSION,
): boolean {
  return Number.isInteger(versionNumber) && Math.floor(versionNumber / 10000) >= minimumMajor
}

export async function closeClient(client: Client): Promise<void> {
  try {
    await client.end()
  } catch {
    // The connection is already gone; there is nothing left to release.
  }
}

// The client is created with an 'error' listener already attached: an idle connection that the server drops would otherwise crash main.
export async function openClient(
  config: ClientConfig,
  context: PostgresRedactionContext,
  minimumMajor: number,
): Promise<ConnectedClient> {
  const client = new Client(config)
  client.on('error', () => undefined)
  try {
    await client.connect()
    const { rows } = await client.query<{ number: string; text: string; pid: number }>(
      `SELECT current_setting('server_version_num') AS number,
              current_setting('server_version') AS text,
              pg_backend_pid() AS pid`,
    )
    const serverVersionNumber = Number(rows[0]?.number)
    if (!isSupportedPostgresVersion(serverVersionNumber, minimumMajor)) {
      throw new AdapterError(
        createNormalizedError(
          'unsupported_version',
          `PostgreSQL ${rows[0]?.text.split(' ')[0] ?? 'unknown'} is not supported; version ${minimumMajor} or later is required`,
        ),
      )
    }
    return {
      client,
      serverVersion: formatVersionNumber(serverVersionNumber),
      serverVersionNumber,
      backendPid: Number(rows[0]?.pid),
    }
  } catch (error) {
    await closeClient(client)
    throw toAdapterError(error, context, 'connection_failed')
  }
}

// A second connection is the only way to reach a backend that is busy running a query (pg_cancel_backend, pg_type lookups).
export async function withAuxiliaryClient<T>(
  config: ClientConfig,
  context: PostgresRedactionContext,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(config)
  client.on('error', () => undefined)
  try {
    await client.connect()
    return await work(client)
  } catch (error) {
    throw toAdapterError(error, context, 'connection_failed')
  } finally {
    await closeClient(client)
  }
}
