import { expect, test } from './support/strata-app'
import {
  createSqliteProfile,
  editorOf,
  executionStatus,
  MOD,
  palette,
  resultsGrid,
} from './support/ui'

test('la paleta de comandos se abre con Mod+K, filtra los comandos y se cierra con Escape', async ({
  launchApp,
}) => {
  const { page, errors } = await launchApp()

  await page.keyboard.press(`${MOD}+K`)
  const dialog = palette(page)
  const input = dialog.getByRole('combobox', { name: 'Paleta de comandos' })
  await expect(dialog).toBeVisible()
  await expect(input).toBeFocused()
  await expect(dialog.getByRole('option', { name: /^Nueva pestaña SQL/ })).toBeVisible()

  await input.fill('historial')
  const option = dialog.getByRole('option', { name: /^Abrir historial/ })
  await expect(option).toBeVisible()
  await expect(option).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByRole('option', { name: /^Nueva pestaña SQL/ })).toBeHidden()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect(errors).toEqual([])
})

test('flujo solo con teclado: conectar, abrir pestaña, escribir, ir a una tabla y ejecutar', async ({
  launchApp,
  fixtureDb,
}) => {
  const app = await launchApp()
  const { page } = app
  // El perfil se crea con el ratón (hay que rellenar un formulario y elegir un archivo); el resto no lo usa.
  await createSqliteProfile(app, { name: 'Fixture', file: fixtureDb })

  // 1. Un comando interno desde la paleta: conecta el perfil sin tocar el ratón.
  await page.keyboard.press(`${MOD}+K`)
  await expect(palette(page)).toBeVisible()
  await page.keyboard.type('\\connect Fixture')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Desconectar Fixture' })).toBeVisible()
  await expect(palette(page)).toBeHidden()

  // 2. Pestaña nueva: el foco va directo a su editor, sin tener que enfocarlo con Mod+L.
  await page.keyboard.press(`${MOD}+T`)
  await expect(page.getByRole('tab', { name: 'Consulta 1', selected: true })).toBeVisible()
  const editor = editorOf(page, 'Consulta 1')
  await expect(editor).toBeFocused()

  // 3. Se escribe la consulta con teclas reales y el nombre de la tabla lo inserta la paleta de búsqueda.
  await page.keyboard.type('select title from ')
  await page.keyboard.press(`${MOD}+P`)
  const goto = page.getByRole('dialog', { name: 'Buscar tabla, vista o conexión' })
  await expect(goto).toBeVisible()
  await page.keyboard.type('projects')
  await expect(goto.getByRole('option', { name: /^main\.projects tabla/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Enter')
  await expect(goto).toBeHidden()
  await expect(editor).toBeFocused()
  await expect(editor).toContainText('select title from projects')

  // 4. Se ejecuta sin ratón y el resultado llega al grid.
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
  await expect(resultsGrid(page).getByRole('gridcell', { name: 'Analytical Engine' })).toBeVisible()
  await expect(resultsGrid(page).getByRole('columnheader', { name: 'title TEXT' })).toBeVisible()

  expect(app.errors).toEqual([])
})

test('las flechas del tablist mueven el foco entre pestañas sin llevarlo al editor', async ({
  launchApp,
}) => {
  const { page, errors } = await launchApp()

  await page.keyboard.press(`${MOD}+T`)
  await page.keyboard.press(`${MOD}+T`)
  await expect(page.getByRole('tab', { name: 'Consulta 2', selected: true })).toBeVisible()
  await expect(editorOf(page, 'Consulta 2')).toBeFocused()

  await page.getByRole('tab', { name: 'Consulta 2' }).focus()
  await page.keyboard.press('ArrowLeft')
  const first = page.getByRole('tab', { name: 'Consulta 1', selected: true })
  await expect(first).toBeVisible()
  await expect(first).toBeFocused()
  expect(errors).toEqual([])
})
