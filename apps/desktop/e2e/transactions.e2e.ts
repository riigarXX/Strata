import { expect, queryFixtureDatabase, test } from './support/strata-app'
import {
  connectFixture,
  executionStatus,
  openMessages,
  palette,
  MOD,
  runSql,
  statusBarTransaction,
  toolbar,
  toolbarButton,
  transactionChip,
} from './support/ui'

const COUNT_PEOPLE = 'select count(*) as n from people'
const INSERT_HOPPER = `insert into people (id, name) values (10, 'Hopper')`

const peopleCount = (file: string): unknown => queryFixtureDatabase(file, COUNT_PEOPLE)[0]?.['n']

test.describe('transacciones (SQLite)', () => {
  test('sin transacción el chip lo indica y solo se puede iniciar una', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await expect(transactionChip(page)).toHaveText('Sin transacción')
    await expect(statusBarTransaction(page)).toContainText('Sin transacción')

    await expect(toolbarButton(page, 'Iniciar transacción')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await expect(toolbarButton(page, 'Confirmar')).toHaveAttribute('aria-disabled', 'true')
    await expect(toolbarButton(page, 'Revertir')).toHaveAttribute('aria-disabled', 'true')

    // Un botón no disponible (aria-disabled, no `disabled`) sigue recibiendo el clic: no hace nada, pero explica por qué en el indicador.
    await toolbarButton(page, 'Confirmar').click({ force: true })
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'blocked')
    await expect(executionStatus(page)).toHaveText(
      'No se puede operar con la transacción: No hay ninguna transacción activa.',
    )
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(app.errors).toEqual([])
  })

  test('iniciar, escribir y confirmar: los datos persisten y el estado vuelve a «Sin transacción»', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await expect(transactionChip(page)).toHaveText('Transacción activa')
    // El texto existe en la barra de estado y en el chip: se comprueban cada uno en su sitio.
    await expect(statusBarTransaction(page)).toContainText('Transacción activa')
    await expect(statusBarTransaction(page).locator('[data-state]')).toHaveAttribute(
      'data-state',
      'active',
    )
    // Con una transacción abierta solo se puede confirmar o revertir.
    await expect(toolbarButton(page, 'Iniciar transacción')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await expect(toolbarButton(page, 'Confirmar')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(toolbarButton(page, 'Revertir')).not.toHaveAttribute('aria-disabled', 'true')

    await runSql(page, 'Consulta 1', INSERT_HOPPER)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    // Otra conexión al mismo archivo no ve la fila mientras la transacción no se confirma.
    expect(peopleCount(fixtureDb)).toBe(3)

    await toolbarButton(page, 'Confirmar').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await expect(transactionChip(page)).toHaveText('Sin transacción')
    await expect(statusBarTransaction(page)).toContainText('Sin transacción')
    await expect(toolbarButton(page, 'Confirmar')).toHaveAttribute('aria-disabled', 'true')
    expect(peopleCount(fixtureDb)).toBe(4)
    expect(queryFixtureDatabase(fixtureDb, 'select name from people where id = 10')).toEqual([
      { name: 'Hopper' },
    ])

    // Cada ejecución nueva vacía los mensajes de la pestaña: solo queda el de la última operación.
    await expect(await openMessages(page)).toContainText('Transacción confirmada.')
    expect(app.errors).toEqual([])
  })

  test('iniciar, escribir y revertir: los cambios no persisten', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await runSql(page, 'Consulta 1', `${INSERT_HOPPER}; update people set age = 99 where id = 1`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')

    // Dentro de la transacción la propia sesión sí ve sus cambios.
    await runSql(page, 'Consulta 1', COUNT_PEOPLE)
    await expect(page.getByRole('gridcell', { name: '4', exact: true })).toBeVisible()

    await toolbarButton(page, 'Revertir').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await expect(statusBarTransaction(page)).toContainText('Sin transacción')
    await expect(await openMessages(page)).toContainText('Transacción revertida.')

    await page.getByRole('tab', { name: 'Resultados', exact: true }).click()
    await runSql(page, 'Consulta 1', COUNT_PEOPLE)
    await expect(page.getByRole('gridcell', { name: '3', exact: true })).toBeVisible()
    expect(peopleCount(fixtureDb)).toBe(3)
    expect(queryFixtureDatabase(fixtureDb, 'select age from people where id = 1')).toEqual([
      { age: 36 },
    ])

    expect(app.errors).toEqual([])
  })

  test('en SQLite un error dentro de la transacción NO la aborta: sigue activa y se puede seguir escribiendo', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')

    // La segunda sentencia viola la clave primaria: la tercera no llega a ejecutarse.
    await runSql(
      page,
      'Consulta 1',
      `${INSERT_HOPPER}; insert into people (id, name) values (1, 'Duplicada'); insert into people (id, name) values (11, 'Nunca')`,
    )
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
    await expect(executionStatus(page)).toContainText('terminó con error')
    await expect(await openMessages(page)).toContainText('Error en la sentencia n.º 2')

    // El adaptador no tiene estado «abortada»: el chip sigue en «activa» y no aparece el aviso de revertir.
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await expect(transactionChip(page)).toHaveText('Transacción activa')
    await expect(statusBarTransaction(page)).toContainText('Transacción activa')
    await expect(toolbar(page).locator('[data-hint="revert-first"]')).toBeHidden()
    await expect(toolbarButton(page, 'Ejecutar')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(toolbarButton(page, 'Confirmar')).not.toHaveAttribute('aria-disabled', 'true')

    await runSql(page, 'Consulta 1', `insert into people (id, name) values (12, 'Despues')`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await toolbarButton(page, 'Confirmar').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')

    // Lo anterior al error se conserva al confirmar; la sentencia fallida y las posteriores no.
    expect(
      queryFixtureDatabase(fixtureDb, 'select id from people where id >= 10 order by id'),
    ).toEqual([{ id: 10 }, { id: 12 }])
    expect(app.errors).toEqual([])
  })

  test('un BEGIN y un COMMIT escritos en el editor actualizan el chip y la barra de estado', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await runSql(page, 'Consulta 1', `begin; ${INSERT_HOPPER}`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await expect(statusBarTransaction(page)).toContainText('Transacción activa')
    expect(peopleCount(fixtureDb)).toBe(3)

    await runSql(page, 'Consulta 1', 'commit')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await expect(statusBarTransaction(page)).toContainText('Sin transacción')
    expect(peopleCount(fixtureDb)).toBe(4)
    expect(app.errors).toEqual([])
  })

  test('los comandos de la paleta inician y revierten la transacción', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await page.keyboard.press(`${MOD}+K`)
    await palette(page).getByRole('combobox').fill('Iniciar transacción')
    await page.keyboard.press('Enter')
    await expect(palette(page)).toBeHidden()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')

    await page.keyboard.press(`${MOD}+K`)
    await palette(page).getByRole('combobox').fill('Revertir transacción')
    await page.keyboard.press('Enter')
    await expect(palette(page)).toBeHidden()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(app.errors).toEqual([])
  })

  test('el estado de la transacción se anuncia en regiones role=status con aria-live', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    // La barra de estado es la región que anuncia el cambio de transacción; el indicador de la barra de ejecución, el de la ejecución.
    await expect(statusBarTransaction(page)).toHaveAttribute('role', 'status')
    await expect(executionStatus(page)).toHaveAttribute('role', 'status')
    await expect(executionStatus(page)).toHaveAttribute('aria-live', 'polite')

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(statusBarTransaction(page)).toHaveText(/Transacción:\s*Transacción activa/)
    await toolbarButton(page, 'Revertir').click()
    await expect(statusBarTransaction(page)).toHaveText(/Transacción:\s*Sin transacción/)
    expect(app.errors).toEqual([])
  })
})
