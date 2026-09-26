import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const QUERY_SCRIPT = path.join(__dirname, 'pg-query.mjs')
const IMAGE = 'postgres:17'
const CONTAINER_LABEL = 'strata-test=e2e-postgres'
const STALE_AFTER_MS = 30 * 60 * 1000

export interface PostgresTarget {
  host: string
  port: number
  user: string
  /** `null` con el contenedor efímero (autenticación `trust`): el perfil se crea sin contraseña. */
  password: string | null
  database: string
  url: string
  source: 'url' | 'docker'
}

export type PostgresAvailability =
  | { available: true; target: PostgresTarget; release(): Promise<void> }
  | { available: false; reason: string }

async function docker(args: readonly string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('docker', [...args], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], 15_000)
    return true
  } catch {
    return false
  }
}

// Solo se tocan contenedores con la etiqueta de esta suite: nada más de la máquina se lista ni se elimina.
async function removeStaleContainers(): Promise<void> {
  const listed = await docker(['ps', '-aq', '--filter', `label=${CONTAINER_LABEL}`])
  for (const id of listed === '' ? [] : listed.split('\n')) {
    const created = await docker(['inspect', '--format', '{{.Created}}', id])
    if (Date.now() - Date.parse(created) > STALE_AFTER_MS) await docker(['rm', '-f', id])
  }
}

function targetFromUrl(raw: string): PostgresTarget {
  const url = new URL(raw)
  return {
    host: url.hostname,
    port: url.port === '' ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username) || 'postgres',
    password: url.password === '' ? null : decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
    url: raw,
    source: 'url',
  }
}

async function startContainer(): Promise<PostgresAvailability> {
  await removeStaleContainers().catch(() => undefined)
  const name = `strata-test-e2e-${randomBytes(4).toString('hex')}`
  const remove = (): Promise<unknown> => docker(['rm', '-f', name]).catch(() => undefined)
  try {
    await docker(
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '--label',
        CONTAINER_LABEL,
        // Sin contraseña: guardar una con el CredentialStore real dispara un diálogo de Keychain que bloquea (docs/DEVELOPMENT.md).
        '-e',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        // Puerto libre elegido por Docker, solo en loopback.
        '-p',
        '127.0.0.1::5432',
        IMAGE,
      ],
      // Incluye la descarga de la imagen si aún no está en la máquina.
      10 * 60 * 1000,
    )
    const mapping = await docker(['port', name, '5432/tcp'])
    const port = Number(mapping.split('\n')[0]?.split(':').pop())
    if (!Number.isInteger(port)) throw new Error(`No se pudo leer el puerto publicado de ${name}`)
    const target: PostgresTarget = {
      host: '127.0.0.1',
      port,
      user: 'postgres',
      password: null,
      database: 'postgres',
      url: `postgres://postgres@127.0.0.1:${port}/postgres`,
      source: 'docker',
    }
    await pgQuery(target, 'select 1')
    return { available: true, target, release: async () => void (await remove()) }
  } catch (error) {
    await remove()
    throw error
  }
}

/**
 * Localiza o levanta el PostgreSQL de los E2E. Orden: `STRATA_E2E_SKIP_PG=1` lo omite; `STRATA_TEST_PG_URL` usa ese servidor;
 * si no, un contenedor efímero si Docker responde. Sin ninguno de los dos devuelve el motivo para saltar el spec.
 */
export async function acquirePostgres(): Promise<PostgresAvailability> {
  if (process.env['STRATA_E2E_SKIP_PG'] === '1') {
    return {
      available: false,
      reason: 'STRATA_E2E_SKIP_PG=1: los E2E de PostgreSQL están desactivados.',
    }
  }
  const url = process.env['STRATA_TEST_PG_URL']
  if (url) {
    return { available: true, target: targetFromUrl(url), release: () => Promise.resolve() }
  }
  if (!(await isDockerAvailable())) {
    return {
      available: false,
      reason:
        'No hay PostgreSQL: define STRATA_TEST_PG_URL o arranca Docker para levantar un contenedor efímero.',
    }
  }
  return startContainer()
}

/** Ejecuta SQL por una conexión independiente de la app; devuelve las filas de la última sentencia. */
export async function pgQuery(
  target: Pick<PostgresTarget, 'url'>,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const { stdout } = await execFileAsync(process.execPath, [QUERY_SCRIPT, target.url, sql], {
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  })
  return JSON.parse(stdout) as Record<string, unknown>[]
}
