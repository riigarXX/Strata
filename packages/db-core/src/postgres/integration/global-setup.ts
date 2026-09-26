import { randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client } from 'pg'
import type { TestProject } from 'vitest/node'
import {
  isDockerAvailable,
  removeRunContainers,
  removeRunContainersSync,
  removeStaleContainers,
  startPostgresContainer,
} from './docker'
import type { PgTarget, PgTargetBase } from './target'

declare module 'vitest' {
  export interface ProvidedContext {
    pgTargets: PgTarget[]
  }
}

// The supported minimum (ADR 0003) and the current major.
const DOCKER_IMAGES = ['postgres:13', 'postgres:17']
const READY_TIMEOUT_MS = 120_000

const secret = (): string => randomBytes(12).toString('hex')

async function waitUntilReady(target: PgTargetBase): Promise<Client> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    // The image starts a temporary server on a unix socket while it initializes, so only a TCP connection proves the real one is up.
    const client = new Client({
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.adminUser,
      password: target.adminPassword,
      connectionTimeoutMillis: 2000,
    })
    client.on('error', () => undefined)
    try {
      await client.connect()
      return client
    } catch (error) {
      await client.end().catch(() => undefined)
      if (Date.now() > deadline) {
        throw new Error('PostgreSQL did not become ready in time', { cause: error })
      }
      await sleep(500)
    }
  }
}

async function prepareTarget(
  base: PgTargetBase,
): Promise<{ target: PgTarget; dropRoles: () => Promise<void> }> {
  const admin = await waitUntilReady(base)
  const suffix = randomBytes(4).toString('hex')
  const appUser = `strata_app_${suffix}`
  const limitedUser = `strata_limited_${suffix}`
  const appPassword = secret()
  const limitedPassword = secret()
  try {
    const { rows } = await admin.query<{ version: string }>(
      `SELECT current_setting('server_version') AS version`,
    )
    await admin.query(`CREATE ROLE ${appUser} LOGIN PASSWORD '${appPassword}'`)
    await admin.query(`CREATE ROLE ${limitedUser} LOGIN PASSWORD '${limitedPassword}'`)
    await admin.query(`GRANT CREATE ON DATABASE "${base.database}" TO ${appUser}`)
    const target: PgTarget = {
      ...base,
      version: rows[0]?.version.split(' ')[0] ?? 'unknown',
      appUser,
      appPassword,
      limitedUser,
      limitedPassword,
    }
    return {
      target,
      dropRoles: async () => {
        const cleanup = await waitUntilReady(base)
        try {
          // Objects the test roles still own would block DROP ROLE.
          await cleanup.query(`DROP OWNED BY ${appUser}, ${limitedUser}`)
          await cleanup.query(`DROP ROLE IF EXISTS ${appUser}, ${limitedUser}`)
        } finally {
          await cleanup.end()
        }
      },
    }
  } finally {
    await admin.end()
  }
}

function targetFromUrl(url: string): PgTargetBase {
  const parsed = new URL(url)
  return {
    label: 'external server',
    host: parsed.hostname,
    port: parsed.port === '' ? 5432 : Number(parsed.port),
    database: decodeURIComponent(parsed.pathname.slice(1)) || 'postgres',
    adminUser: decodeURIComponent(parsed.username),
    adminPassword: decodeURIComponent(parsed.password),
    tls: false,
  }
}

// Provides the PostgreSQL servers the integration suites run against: STRATA_TEST_PG_URL when set, otherwise throwaway
// Docker containers for the minimum supported version (13) and the current one (17). With neither, the suites skip.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const externalUrl = process.env.STRATA_TEST_PG_URL
  const runId = randomBytes(6).toString('hex')
  const cleanups: (() => Promise<void>)[] = []

  const teardown = async (): Promise<void> => {
    process.removeListener('exit', onExit)
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup().catch((error: unknown) => {
        console.warn('Integration teardown step failed:', error)
      })
    }
  }

  const onExit = (): void => {
    if (!externalUrl) removeRunContainersSync(runId)
  }
  process.on('exit', onExit)

  try {
    if (externalUrl) {
      const { target, dropRoles } = await prepareTarget(targetFromUrl(externalUrl))
      cleanups.push(dropRoles)
      project.provide('pgTargets', [target])
      return teardown
    }

    if (!(await isDockerAvailable())) {
      console.warn(
        '\n[strata] PostgreSQL integration tests SKIPPED: no Docker daemon is reachable and STRATA_TEST_PG_URL is not set.\n',
      )
      project.provide('pgTargets', [])
      return teardown
    }

    await removeStaleContainers()
    cleanups.push(() => removeRunContainers(runId))
    const adminPassword = secret()
    const targets = await Promise.all(
      DOCKER_IMAGES.map(async (image) => {
        const major = image.split(':')[1] ?? 'latest'
        const container = await startPostgresContainer({
          image,
          name: `strata-test-pg${major}-${runId}`,
          runId,
          password: adminPassword,
        })
        const { target } = await prepareTarget({
          label: `PostgreSQL ${major}`,
          host: '127.0.0.1',
          port: container.port,
          database: 'postgres',
          adminUser: 'postgres',
          adminPassword,
          tls: true,
        })
        return target
      }),
    )
    project.provide('pgTargets', targets)
    return teardown
  } catch (error) {
    await teardown()
    throw error
  }
}
