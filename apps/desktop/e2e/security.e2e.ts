import { expect, test } from './support/strata-app'
import { expectedDbSections, runSecurityProbe } from './support/security-probe'

// Superficie exacta de `window.db`: cualquier método nuevo, quitado o renombrado en el preload debe verse aquí.
const DB_SURFACE = {
  connections: [
    'connect',
    'create',
    'delete',
    'disconnect',
    'list',
    'pickSqliteFile',
    'test',
    'update',
  ],
  metadata: ['describeTable', 'listSchemas', 'listTables'],
  query: ['ack', 'cancel', 'execute', 'onEvent'],
  transactions: ['begin', 'commit', 'rollback'],
  preferences: ['get', 'update'],
  history: ['clear', 'delete', 'list', 'onChange'],
  ai: ['cancel', 'generateSql', 'listModels', 'onPullProgress', 'pullModel', 'status'],
}

const FORBIDDEN_GLOBALS = ['require', 'process', 'Buffer', 'ipcRenderer', 'electron', 'module']

test('la BrowserWindow principal tiene aislamiento y sandbox activos', async ({ launchApp }) => {
  const { electronApp } = await launchApp()

  const preferences = await electronApp.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows()
    if (!window) throw new Error('No hay ventana principal.')
    // Existe en runtime (lo que Electron aplicó de verdad a esta ventana) aunque no figure en los tipos.
    const contents = window.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>
    }
    return contents.getLastWebPreferences()
  })

  expect(preferences).toMatchObject({
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  })
})

test('window.db expone exactamente la superficie prevista y nada de Node ni de Electron', async ({
  launchApp,
}) => {
  const { page } = await launchApp()

  expect(await expectedDbSections()).toEqual(Object.keys(DB_SURFACE))

  const exposed = await page.evaluate((forbidden) => {
    const db = (window as unknown as { db?: Record<string, Record<string, unknown>> }).db
    return {
      sections: db ? Object.keys(db) : null,
      methods: Object.fromEntries(
        Object.entries(db ?? {}).map(([section, api]) => [section, Object.keys(api).sort()]),
      ),
      kinds: Object.fromEntries(
        Object.entries(db ?? {}).flatMap(([section, api]) =>
          Object.entries(api).map(([name, member]) => [`${section}.${name}`, typeof member]),
        ),
      ),
      forbiddenGlobals: forbidden.filter(
        (name) => typeof (window as unknown as Record<string, unknown>)[name] !== 'undefined',
      ),
    }
  }, FORBIDDEN_GLOBALS)

  expect(exposed.sections).toEqual(Object.keys(DB_SURFACE))
  expect(exposed.methods).toEqual(DB_SURFACE)
  expect(Object.values(exposed.kinds).every((kind) => kind === 'function')).toBe(true)
  expect(exposed.forbiddenGlobals).toEqual([])
})

test('la política de seguridad del renderer se cumple (sonda compartida con el smoke del paquete)', async ({
  launchApp,
}) => {
  const { page } = await launchApp()

  const checks = await runSecurityProbe(page)

  expect(checks.length).toBeGreaterThan(0)
  const failed = checks.filter((check) => !check.ok)
  expect(failed, failed.map((check) => `${check.name}: ${check.detail}`).join('\n')).toEqual([])
})

test('el renderer se sirve por app://strata, no por file://', async ({ launchApp }) => {
  const { page, electronApp } = await launchApp()

  expect(page.url()).toBe('app://strata/index.html')
  const location = await page.evaluate(() => ({
    origin: window.location.origin,
    secureContext: window.isSecureContext,
  }))
  expect(location).toEqual({ origin: 'app://strata', secureContext: true })

  const frameUrls = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.webContents.mainFrame.url),
  )
  expect(frameUrls).toEqual(['app://strata/index.html'])
})

test('ninguna ventana puede cargar file:// ni siquiera desde main (filtro de peticiones)', async ({
  launchApp,
}) => {
  const { electronApp } = await launchApp()

  const outcome = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const probe = new BrowserWindow({ show: false })
    try {
      await probe.loadURL('file:///etc/hosts')
      return 'cargó file:///etc/hosts'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      probe.destroy()
    }
  })

  expect(outcome).toContain('ERR_BLOCKED_BY_CLIENT')
})

test('app:// solo sirve out/renderer: sin .., sin listado y solo GET y HEAD', async ({
  launchApp,
}) => {
  const { page } = await launchApp()

  const responses = await page.evaluate(async () => {
    const status = async (path: string, init?: RequestInit): Promise<number | string> => {
      try {
        return (await fetch(window.location.origin + path, init)).status
      } catch (error) {
        return error instanceof Error ? error.name : String(error)
      }
    }
    return {
      root: await status('/'),
      head: await status('/index.html', { method: 'HEAD' }),
      post: await status('/index.html', { method: 'POST', body: 'x' }),
      put: await status('/index.html', { method: 'PUT', body: 'x' }),
      dotdot: await status('/../main/index.js'),
      encodedDotDot: await status('/%2e%2e/main/index.js'),
      encodedSlash: await status('/assets%2f..%2f..%2fmain%2findex.js'),
      directory: await status('/assets/'),
      directoryNoSlash: await status('/assets'),
      missing: await status('/assets/nope.js'),
      sourceMap: await status('/assets/nope.js.map'),
    }
  })

  expect(responses).toEqual({
    root: 200,
    head: 200,
    post: 405,
    put: 405,
    dotdot: 404,
    encodedDotDot: 404,
    encodedSlash: 404,
    directory: 404,
    directoryNoSlash: 404,
    missing: 404,
    sourceMap: 404,
  })
})
