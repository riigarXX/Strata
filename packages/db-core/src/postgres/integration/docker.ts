import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const CONTAINER_LABEL = 'strata-test=db-core-postgres'
const STALE_AFTER_MS = 30 * 60 * 1000

export async function docker(args: readonly string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('docker', [...args], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker(['info', '--format', '{{.ServerVersion}}'], 15_000)
    return true
  } catch {
    return false
  }
}

// Only containers carrying this suite's own label are ever touched: nothing else on the machine is listed, stopped or removed.
async function containerIds(...filters: string[]): Promise<string[]> {
  const args = ['ps', '-aq', '--filter', `label=${CONTAINER_LABEL}`]
  for (const filter of filters) {
    args.push('--filter', filter)
  }
  const output = await docker(args)
  return output === '' ? [] : output.split('\n')
}

export async function removeRunContainers(runId: string): Promise<void> {
  const ids = await containerIds(`label=strata-test-run=${runId}`)
  if (ids.length > 0) {
    await docker(['rm', '-f', ...ids])
  }
}

// Last resort when the process exits without going through the async teardown.
export function removeRunContainersSync(runId: string): void {
  const listed = spawnSync(
    'docker',
    [
      'ps',
      '-aq',
      '--filter',
      `label=${CONTAINER_LABEL}`,
      '--filter',
      `label=strata-test-run=${runId}`,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  )
  const ids = listed.stdout?.split('\n').filter((id) => id !== '') ?? []
  if (ids.length > 0) {
    spawnSync('docker', ['rm', '-f', ...ids], { timeout: 30_000 })
  }
}

// A run killed with SIGKILL cannot clean up after itself; its containers are removed by the next run once they are clearly abandoned.
export async function removeStaleContainers(): Promise<void> {
  for (const id of await containerIds()) {
    const created = await docker(['inspect', '--format', '{{.Created}}', id])
    if (Date.now() - Date.parse(created) > STALE_AFTER_MS) {
      await docker(['rm', '-f', id])
    }
  }
}

export interface StartedContainer {
  readonly name: string
  readonly port: number
}

// The image ships no TLS setup, so a throwaway self-signed certificate is generated inside the container before the normal entrypoint runs.
const TLS_STARTUP = [
  'openssl req -new -x509 -days 2 -nodes -subj /CN=localhost -keyout /tmp/server.key -out /tmp/server.crt >/dev/null 2>&1',
  'chown postgres:postgres /tmp/server.key /tmp/server.crt',
  'chmod 600 /tmp/server.key',
  'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key',
].join(' && ')

export async function startPostgresContainer(options: {
  readonly image: string
  readonly name: string
  readonly runId: string
  readonly password: string
}): Promise<StartedContainer> {
  await docker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      options.name,
      '--label',
      CONTAINER_LABEL,
      '--label',
      `strata-test-run=${options.runId}`,
      '-e',
      `POSTGRES_PASSWORD=${options.password}`,
      '-p',
      '127.0.0.1::5432',
      '--entrypoint',
      'sh',
      options.image,
      '-c',
      TLS_STARTUP,
    ],
    // Includes the image pull when it is not on the machine yet.
    10 * 60 * 1000,
  )
  const mapping = await docker(['port', options.name, '5432/tcp'])
  const port = Number(mapping.split('\n')[0]?.split(':').pop())
  if (!Number.isInteger(port)) {
    throw new Error(`Could not read the published port of ${options.name}`)
  }
  return { name: options.name, port }
}
