import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { ask, askDialog, askResult, enableAi } from '../support/ai'
import { expect, test } from '../support/fake-ollama'
import { type StrataApp } from '../support/strata-app'
import {
  connectProfile,
  createSqliteProfile,
  editorOf,
  executionStatus,
  MOD,
  openQueryTab,
  palette,
  resizeWindow,
  resultsGrid,
  settingsDialog,
} from '../support/ui'

// Capturas del README (docs/screenshots). No es un test: se ejecuta con `pnpm screenshots`.
const OUTPUT_DIR = path.resolve(__dirname, '../../../../docs/screenshots')
const DEMO_SCRIPT = path.join(__dirname, 'create-demo-db.mjs')
const ELECTRON_BINARY = createRequire(__filename)('electron') as string

const WIDTH = 1440
const HEIGHT = 900
const THEMES = ['dark', 'light'] as const
type Theme = (typeof THEMES)[number]

const REPORT_SQL = `SELECT c.nombre AS categoria,
       COUNT(DISTINCT p.id) AS pedidos,
       SUM(l.cantidad) AS libros,
       ROUND(SUM(l.cantidad * l.precio_unitario), 2) AS ingresos
FROM lineas_pedido l
JOIN pedidos p ON p.id = l.pedido_id
JOIN libros b ON b.id = l.libro_id
JOIN categorias c ON c.id = b.categoria_id
WHERE p.estado <> 'cancelado'
GROUP BY c.nombre
ORDER BY ingresos DESC`

const ASK_SQL = `SELECT cl.nombre, cl.ciudad, COUNT(p.id) AS pedidos
FROM clientes cl
JOIN pedidos p ON p.cliente_id = cl.id
GROUP BY cl.id
ORDER BY pedidos DESC
LIMIT 10`

async function prepare(
  app: StrataApp,
  dbFile: string,
  theme: Theme,
  ollamaUrl: string,
): Promise<void> {
  const { page } = app
  await enableAi(app, ollamaUrl)
  await page.evaluate(`window.db.preferences.update({ appearance: { theme: '${theme}' } })`)
  // Playwright emula `light` por defecto y taparía el tema real de la app.
  await page.emulateMedia({ colorScheme: null })
  await resizeWindow(app, WIDTH, HEIGHT)
  await expect
    .poll(() => page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches))
    .toBe(theme === 'dark')
  await createSqliteProfile(app, { name: 'Librería', file: dbFile })
  await connectProfile(page, 'Librería')
}

async function shot(page: Page, name: string, theme: Theme): Promise<void> {
  // Sin caret parpadeante ni animaciones a medias: la captura tiene que ser estable.
  await page.waitForTimeout(400)
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${name}-${theme}.png`),
    animations: 'disabled',
    caret: 'initial',
  })
}

for (const theme of THEMES) {
  test(`capturas en tema ${theme}`, async ({ launchApp, workDir, ollama }) => {
    mkdirSync(OUTPUT_DIR, { recursive: true })
    const dbFile = path.join(workDir, 'libreria.db')
    execFileSync(ELECTRON_BINARY, [DEMO_SCRIPT, dbFile], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    const app = await launchApp()
    const { page } = app
    await prepare(app, dbFile, theme, ollama.url)

    await openQueryTab(page, 'Consulta 1')

    // Esquema con dos tablas desplegadas.
    const tree = page.getByRole('tree', { name: 'Esquema de Librería' })
    await expect(tree.getByRole('treeitem', { name: 'libros tabla' })).toBeVisible()
    for (const table of ['pedidos', 'libros']) {
      await tree.getByRole('treeitem', { name: `${table} tabla` }).click()
      await page.keyboard.press('ArrowRight')
    }
    await shot(page, 'schema-browser', theme)

    // Editor con consulta y resultados.
    await editorOf(page, 'Consulta 1').fill(REPORT_SQL)
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText('Novela')
    await shot(page, 'editor-results', theme)

    // Paleta de comandos sobre el editor.
    await page.keyboard.press(`${MOD}+K`)
    await expect(palette(page)).toBeVisible()
    await shot(page, 'command-palette', theme)
    await page.keyboard.press('Escape')
    await expect(palette(page)).toBeHidden()

    // Panel «Preguntar» con el Ollama falso.
    await editorOf(page, 'Consulta 1').click()
    ollama.answer = ASK_SQL
    await ask(page, '¿Qué clientes han hecho más pedidos?')
    await expect(askResult(page)).toBeVisible()
    await expect(askDialog(page).locator('[data-part="generated-sql"]')).toContainText('LIMIT 10')
    await shot(page, 'ask-ai', theme)
    await page.keyboard.press('Escape')
    await expect(askDialog(page)).toBeHidden()

    // Ajustes.
    await page.keyboard.press(`${MOD}+,`)
    await expect(settingsDialog(page)).toBeVisible()
    await settingsDialog(page)
      .getByRole('radio', { name: theme === 'dark' ? 'Oscuro' : 'Claro' })
      .check()
    // Marcar el radio desplaza el diálogo; se vuelve arriba para que se vea «Apariencia».
    await settingsDialog(page).evaluate((dialog) => {
      for (const el of [dialog, ...dialog.querySelectorAll('*')]) el.scrollTop = 0
    })
    await shot(page, 'settings', theme)

    expect(app.errors).toEqual([])
  })
}
