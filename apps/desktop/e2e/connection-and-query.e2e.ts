import { expect, test } from './support/strata-app'
import {
  connectProfile,
  createSqliteProfile,
  editorOf,
  executionStatus,
  MOD,
  openQueryTab,
  resultsGrid,
} from './support/ui'

test('crea un perfil SQLite con un archivo fixture y conecta desde la UI', async ({
  launchApp,
  fixtureDb,
}) => {
  const app = await launchApp()
  const { page } = app

  await createSqliteProfile(app, { name: 'Fixture', file: fixtureDb })
  const saved = page.getByRole('list', { name: 'Conexiones guardadas' }).getByRole('listitem')
  await expect(saved).toContainText('Fixture')
  await expect(saved).toContainText('Desconectado')

  await connectProfile(page, 'Fixture')
  await expect(saved).toContainText('Conectado')
  await expect(page.getByRole('status').filter({ hasText: 'Conectado a «Fixture»' })).toBeVisible()

  const statusBar = page.getByRole('contentinfo', { name: 'Barra de estado' })
  await expect(statusBar).toContainText(/Conexión:\s*Fixture\s*SQLite/)
  await expect(statusBar).toContainText(/Base de datos:\s*fixture\.db/)
  await expect(statusBar).toContainText(/Acceso:\s*Lectura y escritura/)

  await openQueryTab(page, 'Consulta 1')
  const tree = page.getByRole('tree', { name: 'Esquema de Fixture' })
  await expect(tree.getByRole('treeitem', { name: 'people tabla' })).toBeVisible()
  await expect(tree.getByRole('treeitem', { name: 'projects tabla' })).toBeVisible()

  expect(app.errors).toEqual([])
})

test('ejecuta una consulta con Mod+Enter y muestra filas, NULL y cabeceras tipadas', async ({
  launchApp,
  fixtureDb,
}) => {
  const app = await launchApp()
  const { page } = app
  await createSqliteProfile(app, { name: 'Fixture', file: fixtureDb })
  await connectProfile(page, 'Fixture')
  await openQueryTab(page, 'Consulta 1')

  const editor = editorOf(page, 'Consulta 1')
  await editor.fill('select id, name, age, score, note from people order by id')
  await page.keyboard.press(`${MOD}+Enter`)

  const grid = resultsGrid(page)
  await expect(grid).toBeVisible()
  await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')

  const headers = grid.getByRole('columnheader')
  await expect(headers).toHaveCount(6)
  for (const [index, name] of [
    'Número de fila',
    'id INTEGER',
    'name TEXT',
    'age INTEGER',
    'score REAL',
    'note TEXT',
  ].entries()) {
    await expect(headers.nth(index)).toHaveAccessibleName(name)
  }

  const rows = grid.getByRole('row')
  await expect(rows.filter({ has: page.getByRole('rowheader') })).toHaveCount(3)
  await expect(grid.getByRole('row', { name: '2 2 Grace 45 8.25 NULL' })).toBeVisible()
  await expect(grid.getByRole('row', { name: '3 3 Linus NULL 7 kernel' })).toBeVisible()
  await expect(grid.getByRole('row', { name: '1 1 Ada 36 9.5 first' })).toBeVisible()
  await expect(grid.locator('[data-part="null"]')).toHaveCount(2)

  await expect(
    page.getByRole('status').filter({ hasText: 'Resultado completo: 3 filas' }),
  ).toBeVisible()
  expect(app.errors).toEqual([])
})
