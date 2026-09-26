import { expect, queryFixtureDatabase, test, type StrataApp } from './support/strata-app'
import {
  connectProfile,
  createSqliteProfile,
  destructiveDialog,
  executionStatus,
  openMessages,
  openQueryTab,
  resultsGrid,
  runSql,
  statusBarAccess,
  statusBarTransaction,
  toolbarButton,
  transactionChip,
} from './support/ui'

const READ_ONLY_MESSAGE = 'Only read statements are allowed on a read-only connection'
const MODE_CHANGE_MESSAGE =
  'This statement changes the session mode and is not allowed on a read-only connection'

async function connectReadOnly(app: StrataApp, file: string): Promise<void> {
  await createSqliteProfile(app, { name: 'Lectura', file, readOnly: true })
  await connectProfile(app.page, 'Lectura')
  await openQueryTab(app.page, 'Consulta 1')
}

/** La ejecución se rechaza antes de arrancar: error claro en el panel y en los mensajes, sin resultados. */
async function expectRejected(app: StrataApp, detail = READ_ONLY_MESSAGE): Promise<void> {
  const { page } = app
  await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
  const alert = page.locator('[data-part="error"]')
  await expect(alert).toContainText('La ejecución falló.')
  await expect(alert).toContainText(`Conexión de solo lectura: ${detail}`)
  await expect(alert).toHaveAttribute('role', 'alert')
  await expect(resultsGrid(page)).toBeHidden()
}

test.describe('perfil de solo lectura (ADR 0004)', () => {
  test('el perfil lo marca y la sesión muestra «Solo lectura» en la barra de estado', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await createSqliteProfile(app, { name: 'Lectura', file: fixtureDb, readOnly: true })
    const saved = page.getByRole('list', { name: 'Conexiones guardadas' }).getByRole('listitem')
    await expect(saved).toContainText('Solo lectura')

    await connectProfile(page, 'Lectura')
    await expect(statusBarAccess(page)).toContainText('Solo lectura')
    await expect(statusBarAccess(page).locator('[data-read-only]')).toHaveAttribute(
      'data-read-only',
      'true',
    )
    expect(app.errors).toEqual([])
  })

  test('los SELECT funcionan y devuelven filas', async ({ launchApp, fixtureDb }) => {
    const app = await launchApp()
    const { page } = app
    await connectReadOnly(app, fixtureDb)

    await runSql(page, 'Consulta 1', 'select id, name from people order by id')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page).getByRole('gridcell', { name: 'Grace' })).toBeVisible()
    await expect(page.locator('[data-part="error"]')).toBeHidden()

    // Las lecturas menos evidentes (CTE y EXPLAIN) también pasan la lista de permitidos.
    await runSql(page, 'Consulta 1', 'with t as (select 1 as n) select n from t')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await runSql(page, 'Consulta 1', 'explain query plan select * from people')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(app.errors).toEqual([])
  })

  for (const [kind, sql, message] of [
    ['INSERT', "insert into people (id, name) values (10, 'Hopper')", READ_ONLY_MESSAGE],
    ['UPDATE con WHERE', 'update people set age = 1 where id = 1', READ_ONLY_MESSAGE],
    ['DELETE con WHERE', 'delete from projects where id = 1', READ_ONLY_MESSAGE],
    ['CREATE TABLE', 'create table extra (id integer)', READ_ONLY_MESSAGE],
    [
      'un CTE que escribe',
      "with t(n) as (select 10) insert into people (id, name) select n, 'x' from t",
      READ_ONLY_MESSAGE,
    ],
    ['PRAGMA que escribe', 'pragma user_version = 7', MODE_CHANGE_MESSAGE],
  ] as const) {
    test(`rechaza ${kind} con un mensaje claro y no toca la base`, async ({
      launchApp,
      fixtureDb,
    }) => {
      const app = await launchApp()
      const { page } = app
      await connectReadOnly(app, fixtureDb)

      await runSql(page, 'Consulta 1', sql)
      await expectRejected(app, message)
      await expect(await openMessages(page)).toContainText('Conexión de solo lectura')
      expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from people')).toEqual([
        { n: 3 },
      ])
      expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from projects')).toEqual([
        { n: 1 },
      ])
      expect(queryFixtureDatabase(fixtureDb, 'pragma user_version')).toEqual([{ user_version: 0 }])
      expect(
        queryFixtureDatabase(fixtureDb, "select name from sqlite_master where name = 'extra'"),
      ).toEqual([])
      expect(app.errors).toEqual([])
    })
  }

  test('una sola sentencia de escritura rechaza todo el documento: ni siquiera corren los SELECT', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectReadOnly(app, fixtureDb)

    await runSql(page, 'Consulta 1', 'select 1; delete from projects where id = 1; select 2')
    await expectRejected(app)
    await expect(page.locator('[data-part="run-summary"]')).toBeHidden()
    expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from projects')).toEqual([
      { n: 1 },
    ])
    expect(app.errors).toEqual([])
  })

  test('un DELETE sin WHERE se bloquea directamente: no se pide confirmación', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectReadOnly(app, fixtureDb)

    await runSql(page, 'Consulta 1', 'delete from projects')
    await expect(destructiveDialog(page)).toBeHidden()
    await expectRejected(app)
    expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from projects')).toEqual([
      { n: 1 },
    ])
    expect(app.errors).toEqual([])
  })

  test('tras un rechazo la conexión sigue usable', async ({ launchApp, fixtureDb }) => {
    const app = await launchApp()
    const { page } = app
    await connectReadOnly(app, fixtureDb)

    await runSql(page, 'Consulta 1', 'drop table projects')
    await expectRejected(app)
    await runSql(page, 'Consulta 1', 'select title from projects')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(
      resultsGrid(page).getByRole('gridcell', { name: 'Analytical Engine' }),
    ).toBeVisible()
    await expect(page.locator('[data-part="error"]')).toBeHidden()
    expect(app.errors).toEqual([])
  })

  test('las transacciones funcionan: se pueden iniciar y cerrar, y dentro solo se lee', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectReadOnly(app, fixtureDb)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await expect(statusBarTransaction(page)).toContainText('Transacción activa')
    await expect(statusBarAccess(page)).toContainText('Solo lectura')

    await runSql(page, 'Consulta 1', 'select count(*) as n from people')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await runSql(page, 'Consulta 1', "insert into people (id, name) values (10, 'Hopper')")
    await expectRejected(app)
    // El rechazo previo al arranque no toca la transacción abierta.
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')

    await toolbarButton(page, 'Confirmar').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await toolbarButton(page, 'Revertir').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')

    // Un BEGIN y un COMMIT escritos en el editor también están permitidos: el control de transacciones no escribe.
    await runSql(page, 'Consulta 1', 'begin; select 1')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await runSql(page, 'Consulta 1', 'commit')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from people')).toEqual([{ n: 3 }])
    expect(app.errors).toEqual([])
  })

  test('el mismo perfil sin la marca sí escribe: la diferencia es solo el perfil', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await createSqliteProfile(app, { name: 'Escritura', file: fixtureDb })
    await connectProfile(page, 'Escritura')
    await openQueryTab(page, 'Consulta 1')
    await expect(statusBarAccess(page)).toContainText('Lectura y escritura')

    await runSql(page, 'Consulta 1', "insert into people (id, name) values (10, 'Hopper')")
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from people')).toEqual([{ n: 4 }])
    expect(app.errors).toEqual([])
  })
})
