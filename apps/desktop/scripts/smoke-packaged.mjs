#!/usr/bin/env node
// Smoke test del paquete de macOS: lanza el .app real y comprueba por CDP la política de seguridad final.
// Node >= 22 (WebSocket y fetch globales); la única dependencia es @electron/fuses (devDependency de apps/desktop) para leer los fuses. Uso: node apps/desktop/scripts/smoke-packaged.mjs [ruta/al/Strata.app]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_RELEASE_DIR = path.resolve(SCRIPT_DIR, '../release/mac-arm64')

export const EXPECTED_DB_SECTIONS = [
  'connections',
  'metadata',
  'query',
  'transactions',
  'preferences',
  'history',
  'ai',
]
export const FORBIDDEN_GLOBALS = ['require', 'process', 'Buffer', 'ipcRenderer', 'electron']
export const SIMULATIONS = ['extra-db-section', 'file-protocol-fuse-on']
export const APP_ORIGIN = 'app://strata'
// Fuses que fija electron-builder.yml (ADR 0011 para el último). Los demás se dejan como vienen de Electron.
export const EXPECTED_FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
}
// Rutas que intentan salir de out/renderer o listar directorios: ninguna debe responder 200.
export const FORBIDDEN_PATHS = [
  '/../main/index.js',
  '/%2e%2e/main/index.js',
  '/assets/%2e%2e/%2e%2e/main/index.js',
  '/assets%2f..%2f..%2fmain%2findex.js',
  '/%2fetc/hosts',
  '/assets/',
  '/assets',
]

const TARGET_TIMEOUT_MS = 30_000
const MOUNT_TIMEOUT_MS = 20_000
const SETTLE_MS = 1_500
const EXIT_GRACE_MS = 5_000
const OUTPUT_TAIL_LINES = 40

// --- Lógica pura -------------------------------------------------------------------------------

export function parseCliArgs(argv, env = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'simulate-failure': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (positionals.length > 1) throw new Error('Se esperaba como máximo una ruta al .app.')
  const simulate = values['simulate-failure'] ?? env.STRATA_SMOKE_SIMULATE ?? null
  if (simulate !== null && !SIMULATIONS.includes(simulate)) {
    throw new Error(`Simulación desconocida «${simulate}». Válidas: ${SIMULATIONS.join(', ')}.`)
  }
  return { appPath: positionals[0] ?? null, simulate, help: values.help === true }
}

function listApps(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`No existe el directorio ${dir}.`)
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.app') && statSync(path.join(dir, name)).isDirectory())
    .map((name) => path.join(dir, name))
}

export function locatePackagedApp({ appPath = null, releaseDir = DEFAULT_RELEASE_DIR } = {}) {
  const target = appPath === null ? releaseDir : path.resolve(appPath)
  let appDir
  if (target.endsWith('.app')) {
    if (!existsSync(target)) throw new Error(`No existe ${target}.`)
    appDir = target
  } else {
    const apps = listApps(target)
    if (apps.length === 0) {
      throw new Error(
        `No hay ningún .app en ${target}. Constrúyelo con: pnpm build && pnpm --filter @strata/desktop run pack`,
      )
    }
    if (apps.length > 1) {
      throw new Error(`Hay varios .app en ${target}; indica cuál por argumento.`)
    }
    appDir = apps[0]
  }

  const macosDir = path.join(appDir, 'Contents', 'MacOS')
  if (!existsSync(macosDir)) throw new Error(`${appDir} no es un paquete de macOS válido.`)
  const binaries = readdirSync(macosDir)
  const preferred = path.basename(appDir, '.app')
  const executableName = binaries.includes(preferred) ? preferred : binaries[0]
  if (executableName === undefined) throw new Error(`${macosDir} está vacío.`)
  return { appDir, executable: path.join(macosDir, executableName) }
}

/** Elige el target de página de la lista de `/json/list` de CDP (ignora workers, devtools y páginas sin websocket). */
export function pickPageTarget(list) {
  if (!Array.isArray(list)) return null
  const pages = list.filter(
    (target) =>
      target !== null &&
      typeof target === 'object' &&
      target.type === 'page' &&
      typeof target.webSocketDebuggerUrl === 'string' &&
      typeof target.url === 'string' &&
      !target.url.startsWith('devtools://'),
  )
  return pages[0] ?? null
}

/** Convierte la respuesta de `Runtime.evaluate` en su valor, o lanza con el texto de la excepción. */
export function unwrapEvaluation(result) {
  if (result === null || typeof result !== 'object') {
    throw new Error('Respuesta de Runtime.evaluate inválida.')
  }
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    const text = details.exception?.description ?? details.exception?.value ?? details.text
    throw new Error(`La evaluación lanzó una excepción: ${String(text)}`)
  }
  if (!result.result || !('value' in result.result)) {
    throw new Error('La evaluación no devolvió un valor serializable.')
  }
  return result.result.value
}

const check = (name, ok, detail) => ({ name, ok, detail })
const asArray = (value) => (Array.isArray(value) ? value : null)

export function evaluateProbe(probe, cspViolations) {
  const p = probe !== null && typeof probe === 'object' ? probe : {}
  const results = []

  const sections = asArray(p.dbSections)
  if (sections === null) {
    results.push(check('window.db expone solo las secciones previstas', false, 'window.db ausente'))
  } else {
    const missing = EXPECTED_DB_SECTIONS.filter((name) => !sections.includes(name))
    const extra = sections.filter((name) => !EXPECTED_DB_SECTIONS.includes(name))
    const detail =
      missing.length === 0 && extra.length === 0
        ? sections.join(', ')
        : `faltan [${missing.join(', ')}], sobran [${extra.join(', ')}]`
    results.push(
      check(
        'window.db expone solo las secciones previstas',
        missing.length === 0 &&
          extra.length === 0 &&
          sections.length === EXPECTED_DB_SECTIONS.length,
        detail,
      ),
    )
  }

  const leaked = asArray(p.forbiddenGlobals)
  results.push(
    check(
      'el renderer no ve require/process/Buffer/ipcRenderer',
      leaked !== null && leaked.length === 0,
      leaked === null
        ? 'sin datos'
        : leaked.length === 0
          ? 'ninguno'
          : `expuestos: ${leaked.join(', ')}`,
    ),
  )

  results.push(
    check(
      'CSP de producción: new Function lanza EvalError',
      p.newFunction?.blocked === true && p.newFunction?.name === 'EvalError',
      p.newFunction?.blocked === true
        ? String(p.newFunction.name)
        : p.newFunction
          ? 'new Function se ejecutó'
          : 'sin datos',
    ),
  )

  results.push(
    check(
      `el renderer se sirve desde ${APP_ORIGIN} (no desde file://)`,
      p.origin?.href?.startsWith(`${APP_ORIGIN}/`) === true && p.origin?.origin === APP_ORIGIN,
      p.origin ? `${p.origin.origin} (${p.origin.href})` : 'sin datos',
    ),
  )

  results.push(
    check(
      "fetch('file:///etc/hosts') bloqueado",
      p.fileFetch?.blocked === true,
      p.fileFetch ? String(p.fileFetch.detail) : 'sin datos',
    ),
  )

  results.push(
    check(
      'navegar a file:///etc/hosts no cambia la página',
      p.fileNavigation?.blocked === true,
      p.fileNavigation ? String(p.fileNavigation.detail) : 'sin datos',
    ),
  )

  const escapes = asArray(p.pathEscapes)
  results.push(
    check(
      'rutas con .., %2e%2e y directorios no se sirven',
      escapes !== null && escapes.length > 0 && escapes.every((entry) => entry.served === false),
      escapes === null
        ? 'sin datos'
        : escapes.map((entry) => `${entry.path} -> ${entry.result}`).join('; '),
    ),
  )

  results.push(
    check(
      'la respuesta de app:// lleva la CSP como cabecera y ninguna cabecera CORS',
      p.headers?.csp?.includes("default-src 'self'") === true &&
        p.headers?.csp?.includes('unsafe-inline') === false &&
        p.headers?.cors === null &&
        p.headers?.postStatus === 405,
      p.headers
        ? `csp ${p.headers.csp ? 'presente' : 'ausente'}, acao ${p.headers.cors ?? 'ausente'}, POST ${p.headers.postStatus}`
        : 'sin datos',
    ),
  )

  results.push(
    check(
      'un recurso propio se sirve',
      p.ownResource?.ok === true,
      p.ownResource ? String(p.ownResource.detail) : 'sin datos',
    ),
  )

  results.push(
    check(
      'window.open devuelve null',
      p.windowOpen?.isNull === true,
      p.windowOpen ? String(p.windowOpen.type) : 'sin datos',
    ),
  )

  results.push(
    check(
      'permisos denegados (geolocalización)',
      p.geolocation?.outcome === 'denied',
      p.geolocation ? `${p.geolocation.outcome} (código ${p.geolocation.code})` : 'sin datos',
    ),
  )

  results.push(
    check(
      'window.db.preferences.get() responde ok',
      p.preferences?.ok === true,
      p.preferences ? (p.preferences.ok ? 'ok' : String(p.preferences.detail)) : 'sin datos',
    ),
  )

  const violations = asArray(cspViolations)
  results.push(
    check(
      '0 violaciones de CSP en el arranque',
      violations !== null && violations.length === 0,
      violations === null
        ? 'sin datos'
        : violations.length === 0
          ? 'ninguna'
          : violations.map((v) => `${v.directive} -> ${v.blocked}`).join('; '),
    ),
  )

  return results
}

/** Convierte el estado de los fuses del binario en `{ nombre: true | false | null }` (null = heredado o eliminado). */
export async function readFuses(appDir) {
  const { getCurrentFuseWire, FuseV1Options, FuseState } = await import('@electron/fuses')
  const wire = await getCurrentFuseWire(appDir)
  return Object.fromEntries(
    Object.keys(EXPECTED_FUSES).map((name) => {
      const state = wire[FuseV1Options[name]]
      return [name, state === FuseState.ENABLE ? true : state === FuseState.DISABLE ? false : null]
    }),
  )
}

export function evaluateFuses(fuses, simulate = null) {
  const actual = { ...fuses }
  if (simulate === 'file-protocol-fuse-on') actual.GrantFileProtocolExtraPrivileges = true
  const label = (value) => (value === null ? 'sin fijar' : value ? 'on' : 'off')
  const results = [
    check(
      'fuse GrantFileProtocolExtraPrivileges desactivado',
      actual.GrantFileProtocolExtraPrivileges === false,
      label(actual.GrantFileProtocolExtraPrivileges ?? null),
    ),
  ]
  const wrong = Object.entries(EXPECTED_FUSES)
    .filter(
      ([name, expected]) =>
        name !== 'GrantFileProtocolExtraPrivileges' && actual[name] !== expected,
    )
    .map(
      ([name, expected]) =>
        `${name}: esperado ${label(expected)}, actual ${label(actual[name] ?? null)}`,
    )
  results.push(
    check(
      'resto de fuses según electron-builder.yml',
      wrong.length === 0,
      wrong.length === 0 ? 'sin cambios' : wrong.join('; '),
    ),
  )
  return results
}

export function summarize(results) {
  const failed = results.filter((r) => !r.ok)
  const lines = results.map((r) => `  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`)
  const verdict =
    failed.length === 0
      ? `Smoke OK: ${results.length}/${results.length} comprobaciones.`
      : `Smoke FALLIDO: ${failed.length} de ${results.length} comprobaciones fallan.`
  return {
    ok: failed.length === 0 && results.length > 0,
    failed,
    text: [...lines, verdict].join('\n'),
  }
}

export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- Código que se ejecuta dentro de la página (se serializa con toString, no toca el entorno de Node) ---

/* global window, document -- solo los usan cspListenerSource y pageProbe, que corren en el renderer */

// Se instala antes de cargar el documento; no debe fallar nunca, o la sonda no cuenta violaciones.
function cspListenerSource() {
  window.__cspv = []
  document.addEventListener(
    'securitypolicyviolation',
    (event) => {
      window.__cspv.push({ directive: event.violatedDirective, blocked: event.blockedURI })
    },
    true,
  )
}

async function pageProbe(options) {
  const out = {}
  const errorName = (error) => (error && error.name ? String(error.name) : String(error))

  out.dbSections = window.db ? Object.keys(window.db) : null
  if (out.dbSections && options.simulate === 'extra-db-section') out.dbSections.push('rogue')

  out.forbiddenGlobals = options.forbiddenGlobals.filter(
    (name) => typeof window[name] !== 'undefined',
  )

  try {
    new Function('return 1')()
    out.newFunction = { blocked: false, name: null }
  } catch (error) {
    out.newFunction = { blocked: true, name: errorName(error) }
  }

  out.origin = { href: window.location.href, origin: window.location.origin }

  try {
    const response = await fetch('file:///etc/hosts')
    out.fileFetch = { blocked: false, detail: `respondió ${response.status}` }
  } catch (error) {
    out.fileFetch = { blocked: true, detail: errorName(error) }
  }

  try {
    const element = document.querySelector('script[src], link[rel="stylesheet"][href]')
    const url = element ? element.src || element.href : null
    if (!url) throw new Error('sin recurso propio en el documento')
    const response = await fetch(url)
    const body = await response.text()
    out.ownResource = {
      ok: response.ok && body.length > 0,
      detail: `${new URL(url).pathname.split('/').pop()} ${response.status} (${body.length} bytes)`,
    }
  } catch (error) {
    out.ownResource = { ok: false, detail: `no se pudo leer: ${errorName(error)}` }
  }

  out.pathEscapes = []
  for (const path of options.forbiddenPaths) {
    try {
      const response = await fetch(window.location.origin + path)
      out.pathEscapes.push({
        path,
        served: response.status === 200,
        result: String(response.status),
      })
    } catch (error) {
      out.pathEscapes.push({ path, served: false, result: errorName(error) })
    }
  }

  try {
    const page = await fetch(window.location.href)
    const post = await fetch(window.location.href, { method: 'POST', body: 'x' })
    out.headers = {
      csp: page.headers.get('content-security-policy'),
      cors: page.headers.get('access-control-allow-origin'),
      postStatus: post.status,
    }
  } catch (error) {
    out.headers = { csp: null, cors: errorName(error), postStatus: null }
  }

  const opened = window.open('https://example.com/')
  out.windowOpen = { isNull: opened === null, type: opened === null ? 'null' : typeof opened }
  if (opened && typeof opened.close === 'function') opened.close()

  out.geolocation = await new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ outcome: 'unavailable', code: null })
    navigator.geolocation.getCurrentPosition(
      () => resolve({ outcome: 'granted', code: null }),
      (error) => resolve({ outcome: error.code === 1 ? 'denied' : 'error', code: error.code }),
      { timeout: 4000 },
    )
  })

  try {
    const response = await window.db.preferences.get()
    out.preferences = {
      ok: response.ok === true,
      detail: response.ok === true ? 'ok' : `error ${response.error && response.error.code}`,
    }
  } catch (error) {
    out.preferences = { ok: false, detail: `lanzó ${errorName(error)}` }
  }

  // Al final: si la navegación prosperara, la página se descargaría y la sonda no podría seguir.
  const before = window.location.href
  window.location.href = 'file:///etc/hosts'
  await new Promise((resolve) => setTimeout(resolve, 500))
  out.fileNavigation = {
    blocked: window.location.href === before && document.getElementById('app') !== null,
    detail:
      window.location.href === before ? 'la página no cambió' : `navegó a ${window.location.href}`,
  }

  return out
}

export function buildProbeExpression(simulate = null) {
  const options = {
    simulate,
    forbiddenGlobals: FORBIDDEN_GLOBALS,
    forbiddenPaths: FORBIDDEN_PATHS,
  }
  return `(${pageProbe.toString()})(${JSON.stringify(options)})`
}

export const CSP_LISTENER_SOURCE = `(${cspListenerSource.toString()})()`

// --- CDP mínimo sobre el WebSocket global ------------------------------------------------------

export async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error(`No se pudo abrir ${url}.`)), {
      once: true,
    })
  })

  let nextId = 1
  const pending = new Map()
  const waiters = new Map()

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      else entry.resolve(message.result)
      return
    }
    for (const resolve of waiters.get(message.method) ?? []) resolve(message.params)
    waiters.delete(message.method)
  })
  socket.addEventListener('close', () => {
    for (const entry of pending.values())
      entry.reject(new Error(`${entry.method}: conexión CDP cerrada.`))
    pending.clear()
  })

  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { method, resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      }),
    once: (method, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout esperando ${method}.`)), timeoutMs)
        const list = waiters.get(method) ?? []
        list.push((params) => {
          clearTimeout(timer)
          resolve(params)
        })
        waiters.set(method, list)
      }),
    close: () => socket.close(),
  }
}

async function evaluate(cdp, expression) {
  return unwrapEvaluation(
    await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: false,
      timeout: 20_000,
    }),
  )
}

// --- Proceso de la app -------------------------------------------------------------------------

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForPageTarget(port, child) {
  const deadline = Date.now() + TARGET_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`La app terminó con código ${child.exitCode} al arrancar.`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const target = pickPageTarget(await response.json())
      if (target) return target
    } catch {
      // El puerto de depuración aún no está abierto.
    }
    await sleep(250)
  }
  throw new Error(`La app no expuso un target de página en ${TARGET_TIMEOUT_MS / 1000} s.`)
}

const processesUsing = (userDataDir) =>
  spawnSync('pgrep', ['-f', '--', `user-data-dir=${escapeRegExp(userDataDir)}`], {
    encoding: 'utf8',
  }).stdout.trim()

// Un shim puede dejar vivo el proceso real (y los helpers de Chromium), así que se remata por --user-data-dir.
async function stopApp(child, userDataDir) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(EXIT_GRACE_MS)])
  }
  const pattern = `user-data-dir=${escapeRegExp(userDataDir)}`
  const deadline = Date.now() + EXIT_GRACE_MS
  while (processesUsing(userDataDir) && Date.now() < deadline) {
    spawnSync('pkill', ['-KILL', '-f', '--', pattern])
    await sleep(200)
  }
}

async function removeUserData(userDataDir) {
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

async function collectRun({ executable, simulate, log }) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'strata-smoke-'))
  const port = await findFreePort()
  const output = []
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL

  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      // Sin esto, el primer uso de safeStorage puede bloquear la ejecución con un diálogo del Keychain.
      '--use-mock-keychain',
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const capture = (chunk) => {
    output.push(...String(chunk).split('\n').filter(Boolean))
    if (output.length > OUTPUT_TAIL_LINES) output.splice(0, output.length - OUTPUT_TAIL_LINES)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.once('error', (error) => capture(`spawn: ${error.message}`))

  let cdp = null
  const stop = async () => {
    cdp?.close()
    await stopApp(child, userDataDir)
    await removeUserData(userDataDir)
  }
  const onSignal = () => {
    void stop().finally(() => process.exit(130))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    log(`Lanzando ${executable} (puerto ${port}, userData ${userDataDir})`)
    const target = await waitForPageTarget(port, child)
    cdp = await connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_LISTENER_SOURCE })

    const loaded = cdp.once('Page.loadEventFired', MOUNT_TIMEOUT_MS)
    await cdp.send('Page.reload', { ignoreCache: true })
    await loaded

    const mountDeadline = Date.now() + MOUNT_TIMEOUT_MS
    while (
      !(await evaluate(
        cdp,
        `Boolean(window.db) && (document.getElementById('app')?.childElementCount ?? 0) > 0`,
      ))
    ) {
      if (Date.now() > mountDeadline) throw new Error('El renderer no llegó a montar #app.')
      await sleep(200)
    }
    await sleep(SETTLE_MS)

    // Antes de la sonda: sus propias pruebas (new Function, fetch) generan violaciones a propósito.
    const cspViolations = await evaluate(cdp, 'window.__cspv ?? null')
    const probe = await evaluate(cdp, buildProbeExpression(simulate))
    return { results: evaluateProbe(probe, cspViolations), output }
  } catch (error) {
    return { error, output }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    await stop()
  }
}

async function main() {
  const usage =
    'Uso: node apps/desktop/scripts/smoke-packaged.mjs [ruta/a/Strata.app] [--simulate-failure=extra-db-section]'
  let args
  try {
    args = parseCliArgs(process.argv.slice(2), process.env)
  } catch (error) {
    console.error(`${error.message}\n${usage}`)
    return 2
  }
  if (args.help) {
    console.log(usage)
    return 0
  }
  if (process.platform !== 'darwin') {
    console.error('El smoke del paquete solo funciona en macOS (ADR 0002).')
    return 2
  }

  let app
  try {
    app = locatePackagedApp({ appPath: args.appPath })
  } catch (error) {
    console.error(error.message)
    return 2
  }

  const log = (line) => console.log(line)
  if (args.simulate) log(`MODO DE PRUEBA: simulando «${args.simulate}»; el smoke debe fallar.`)
  let fuseResults
  try {
    fuseResults = evaluateFuses(await readFuses(app.appDir), args.simulate)
  } catch (error) {
    fuseResults = [check('fuses legibles en el binario', false, error.message)]
  }
  const run = await collectRun({ executable: app.executable, simulate: args.simulate, log })

  if (run.error) {
    console.error(`Smoke FALLIDO: ${run.error.message}`)
    console.error(
      `Últimas líneas de la app:\n${run.output.map((line) => `  | ${line}`).join('\n')}`,
    )
    return 1
  }
  const summary = summarize([...fuseResults, ...run.results])
  console.log(summary.text)
  if (!summary.ok) {
    console.error(
      `Últimas líneas de la app:\n${run.output.map((line) => `  | ${line}`).join('\n')}`,
    )
  }
  return summary.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
