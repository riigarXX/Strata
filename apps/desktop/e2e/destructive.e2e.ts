import { expect, queryFixtureDatabase, test } from './support/strata-app'
import {
  connectFixture,
  destructiveDialog,
  editorOf,
  executionStatus,
  MOD,
  openMessages,
  runSql,
  settingsDialog,
  submitSql,
  toolbarButton,
  transactionChip,
} from './support/ui'

const count = (file: string, table: string): unknown =>
  queryFixtureDatabase(file, `select count(*) as n from ${table}`)[0]?.['n']

const tableExists = (file: string, table: string): boolean =>
  queryFixtureDatabase(file, `select name from sqlite_master where name = '${table}'`).length > 0

const CONFIRM = 'Ejecutar de todos modos'

test.describe('confirmación de sentencias destructivas (ADR 0004)', () => {
  test('DELETE sin WHERE: cancelar no ejecuta y confirmar sí', async ({ launchApp, fixtureDb }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await submitSql(page, 'Consulta 1', 'delete from projects')
    const dialog = destructiveDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Esta sentencia puede eliminar datos')
    await expect(dialog.getByRole('listitem')).toHaveCount(1)
    await expect(dialog.getByRole('listitem')).toContainText('delete from projects')
    await expect(dialog.getByRole('listitem')).toContainText('Borra filas sin cláusula WHERE')
    // El diálogo se abre con el foco en «Cancelar»: un Enter sin querer no ejecuta nada.
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')

    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await expect(dialog).toBeHidden()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')
    await expect(editorOf(page, 'Consulta 1')).toBeFocused()
    expect(count(fixtureDb, 'projects')).toBe(1)

    await page.keyboard.press(`${MOD}+Enter`)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: CONFIRM }).click()
    await expect(dialog).toBeHidden()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(await openMessages(page)).toContainText('DELETE · 1 fila afectada')
    expect(count(fixtureDb, 'projects')).toBe(0)
    expect(app.errors).toEqual([])
  })

  test('Escape cierra el diálogo sin ejecutar', async ({ launchApp, fixtureDb }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await submitSql(page, 'Consulta 1', 'update people set score = 0')
    const dialog = destructiveDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('listitem')).toContainText('Modifica todas las filas')

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')
    expect(queryFixtureDatabase(fixtureDb, 'select score from people order by id')).toEqual([
      { score: 9.5 },
      { score: 8.25 },
      { score: 7 },
    ])
    expect(app.errors).toEqual([])
  })

  test('UPDATE sin WHERE pide confirmación con el botón Ejecutar; con WHERE se ejecuta directamente', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    const dialog = destructiveDialog(page)

    await runSql(page, 'Consulta 1', 'update people set score = 1 where id = 1')
    await expect(dialog).toBeHidden()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await runSql(page, 'Consulta 1', 'delete from projects where id = 1')
    await expect(dialog).toBeHidden()
    expect(count(fixtureDb, 'projects')).toBe(0)

    await editorOf(page, 'Consulta 1').fill('update people set score = 0')
    await toolbarButton(page, 'Ejecutar').click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: CONFIRM }).click()
    await expect(dialog).toBeHidden()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(queryFixtureDatabase(fixtureDb, 'select distinct score from people')).toEqual([
      { score: 0 },
    ])
    expect(app.errors).toEqual([])
  })

  test('DROP TABLE pide confirmación, no borra al cancelar y sí al confirmar', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await submitSql(page, 'Consulta 1', 'drop table projects')
    const dialog = destructiveDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('listitem')).toContainText('Elimina objetos de la base de datos')
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await expect(dialog).toBeHidden()
    expect(tableExists(fixtureDb, 'projects')).toBe(true)

    await page.keyboard.press(`${MOD}+Enter`)
    await dialog.getByRole('button', { name: CONFIRM }).click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(tableExists(fixtureDb, 'projects')).toBe(false)
    expect(app.errors).toEqual([])
  })

  test('varias sentencias: la confirmación lista solo las destructivas y ejecuta el documento entero', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    const script = [
      'select 1;',
      'delete from projects;',
      "insert into people (id, name) values (10, 'Hopper');",
      'update people set age = 1;',
      'drop table projects',
    ].join(' ')
    await submitSql(page, 'Consulta 1', script, { all: true })
    const dialog = destructiveDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Estas 3 sentencias pueden eliminar datos')
    const items = dialog.getByRole('listitem')
    await expect(items).toHaveCount(3)
    await expect(items.nth(0)).toContainText('delete from projects')
    await expect(items.nth(1)).toContainText('update people set age = 1')
    await expect(items.nth(2)).toContainText('drop table projects')
    await expect(dialog).not.toContainText('select 1')
    await expect(dialog).not.toContainText('insert into people')

    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await expect(dialog).toBeHidden()
    expect(count(fixtureDb, 'people')).toBe(3)
    expect(count(fixtureDb, 'projects')).toBe(1)

    await page.keyboard.press(`${MOD}+Shift+Enter`)
    await dialog.getByRole('button', { name: CONFIRM }).click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(await openMessages(page)).toContainText('Ejecución completada: 5 sentencias')
    expect(count(fixtureDb, 'people')).toBe(4)
    expect(queryFixtureDatabase(fixtureDb, 'select distinct age from people')).toEqual([{ age: 1 }])
    expect(tableExists(fixtureDb, 'projects')).toBe(false)
    expect(app.errors).toEqual([])
  })

  test('«Ejecutar todo» confirma el documento entero aunque la selección sea inocua', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    const editor = editorOf(page, 'Consulta 1')

    await editor.fill('select 1;\ndelete from projects;')
    await expect(editor).toContainText('delete from projects')
    // Solo se selecciona la primera línea: «Ejecutar» corre la selección y «Ejecutar todo», el documento.
    await page.keyboard.press(`${MOD}+ArrowUp`)
    await page.keyboard.press('Shift+End')

    const dialog = destructiveDialog(page)
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(dialog).toBeHidden()
    expect(count(fixtureDb, 'projects')).toBe(1)

    await toolbarButton(page, 'Ejecutar todo').click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('listitem')).toHaveCount(1)
    await expect(dialog.getByRole('listitem')).toContainText('delete from projects')
    await dialog.getByRole('button', { name: CONFIRM }).click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(count(fixtureDb, 'projects')).toBe(0)
    expect(app.errors).toEqual([])
  })

  test('con más de diez sentencias destructivas la lista se resume', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    const script = Array.from({ length: 12 }, () => 'delete from projects;').join(' ')
    await submitSql(page, 'Consulta 1', script, { all: true })
    const dialog = destructiveDialog(page)
    await expect(dialog).toContainText('Estas 12 sentencias pueden eliminar datos')
    await expect(dialog.getByRole('listitem')).toHaveCount(10)
    await expect(dialog).toContainText('y 2 más.')
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await expect(dialog).toBeHidden()
    expect(count(fixtureDb, 'projects')).toBe(1)
    expect(app.errors).toEqual([])
  })

  test('dentro de una transacción el DELETE también pide confirmación y se puede revertir', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')

    await submitSql(page, 'Consulta 1', 'delete from projects')
    const dialog = destructiveDialog(page)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: CONFIRM }).click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    // Sin confirmar la transacción, otra conexión sigue viendo las filas.
    expect(count(fixtureDb, 'projects')).toBe(1)

    await toolbarButton(page, 'Revertir').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(count(fixtureDb, 'projects')).toBe(1)
    expect(app.errors).toEqual([])
  })

  test('desactivar la confirmación en Ajustes ejecuta las destructivas sin preguntar', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await page.keyboard.press(`${MOD}+,`)
    const settings = settingsDialog(page)
    const confirmation = settings.getByRole('checkbox', {
      name: 'Confirmar operaciones destructivas',
    })
    await expect(confirmation).toBeChecked()
    await confirmation.uncheck()
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()

    await runSql(page, 'Consulta 1', 'delete from projects')
    await expect(destructiveDialog(page)).toBeHidden()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(count(fixtureDb, 'projects')).toBe(0)
    expect(app.errors).toEqual([])
  })
})
