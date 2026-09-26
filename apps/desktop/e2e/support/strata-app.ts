import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

const APP_DIR = path.resolve(__dirname, '../..')
const FIXTURE_SCRIPT = path.join(__dirname, 'create-fixture-db.mjs')
const QUERY_FIXTURE_SCRIPT = path.join(__dirname, 'query-fixture-db.mjs')
const EXEC_FIXTURE_SCRIPT = path.join(__dirname, 'exec-fixture-db.mjs')
// El paquete `electron` exporta la ruta del binario real, no un shim.
const ELECTRON_BINARY = createRequire(__filename)('electron') as string

export interface StrataApp {
  electronApp: ElectronApplication
  page: Page
  userDataDir: string
  /** Mensajes `console.error` y excepciones no capturadas del renderer desde que se creó la ventana. */
  errors: string[]
  close(): Promise<void>
}

export interface LaunchOptions {
  userDataDir?: string
}

interface Fixtures {
  /** Carpeta temporal del test: contiene el userData y el archivo SQLite; se borra al terminar. */
  workDir: string
  userDataDir: string
  /** Ruta de una base SQLite creada al vuelo (tablas `people` y `projects`). */
  fixtureDb: string
  launchApp(options?: LaunchOptions): Promise<StrataApp>
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // Con esta variable el binario arranca como un Node normal; con la otra el build cargaría un dev server.
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_RENDERER_URL']
  return env
}

export function createFixtureDatabase(target: string): void {
  execFileSync(ELECTRON_BINARY, [FIXTURE_SCRIPT, target], {
    env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/** Ejecuta SQL de preparación (varias sentencias) sobre la base fixture; llámalo antes de arrancar la app. */
export function execFixtureDatabase(file: string, sql: string): void {
  execFileSync(ELECTRON_BINARY, [EXEC_FIXTURE_SCRIPT, file, sql], {
    env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/** Lee la base fixture por una conexión independiente de la de la app: lo que ve otra sesión, o sea, lo que hay confirmado en disco. */
export function queryFixtureDatabase(file: string, sql: string): Record<string, unknown>[] {
  const stdout = execFileSync(ELECTRON_BINARY, [QUERY_FIXTURE_SCRIPT, file, sql], {
    env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return JSON.parse(stdout) as Record<string, unknown>[]
}

async function launchStrata(userDataDir: string): Promise<StrataApp> {
  const electronApp = await electron.launch({
    executablePath: ELECTRON_BINARY,
    // `.` resuelve el `main` del package.json de la app: el build sin empaquetar de `out/`.
    args: ['.', `--user-data-dir=${userDataDir}`, '--use-mock-keychain'],
    cwd: APP_DIR,
    env: cleanEnv(),
    timeout: 30_000,
  })

  const errors: string[] = []
  const watched = new WeakSet<Page>()
  const watch = (window: Page): void => {
    if (watched.has(window)) return
    watched.add(window)
    window.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
    })
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  }
  electronApp.on('window', watch)
  electronApp.windows().forEach(watch)

  const page = await electronApp.firstWindow()
  watch(page)
  // Los atajos globales se registran al montar la app: sin esperar, una tecla pulsada nada más arrancar se pierde.
  await page.getByRole('contentinfo', { name: 'Barra de estado' }).waitFor()

  return {
    electronApp,
    page,
    userDataDir,
    errors,
    async close() {
      const child = electronApp.process()
      try {
        await electronApp.close()
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    },
  }
}

export const test = base.extend<Fixtures>({
  // Playwright exige desestructurar el primer argumento, aunque este fixture no dependa de ninguno.
  // eslint-disable-next-line no-empty-pattern
  workDir: async ({}, use) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'strata-e2e-'))
    await use(dir)
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  },

  userDataDir: async ({ workDir }, use) => {
    const dir = path.join(workDir, 'user-data')
    await mkdir(dir)
    await use(dir)
  },

  fixtureDb: async ({ workDir }, use) => {
    const file = path.join(workDir, 'fixture.db')
    createFixtureDatabase(file)
    await use(file)
  },

  launchApp: async ({ userDataDir }, use) => {
    const launched: StrataApp[] = []
    await use(async (options = {}) => {
      const app = await launchStrata(options.userDataDir ?? userDataDir)
      launched.push(app)
      return app
    })
    for (const app of launched) await app.close().catch(() => undefined)
  },
})

export { expect } from '@playwright/test'

/** Sustituye el selector nativo de archivos, que un test no puede accionar, por una respuesta fija. */
export async function stubOpenDialog(app: StrataApp, filePath: string): Promise<void> {
  await app.electronApp.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] })
  }, filePath)
}

export async function readUserDataFile(userDataDir: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(userDataDir, name), 'utf8'))
  } catch {
    return null
  }
}
