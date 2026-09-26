import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, readUserDataFile, test, type StrataApp } from './support/strata-app'
import { acquirePostgres, pgQuery, type PostgresAvailability } from './support/postgres'
import {
  connectProfile,
  createPostgresProfile,
  destructiveDialog,
  executionStatus,
  expectTargetSize,
  MOD,
  openMessages,
  openQueryTab,
  resizeWindow,
  resultsGrid,
  runSql,
  statusBarAccess,
  statusBarTransaction,
  submitSql,
  toolbar,
  toolbarButton,
  transactionChip,
} from './support/ui'

const PROFILE = 'PG'
const TAB = 'Consulta 1'

// El servidor lo decide `acquirePostgres`: STRATA_TEST_PG_URL, un contenedor efímero de Docker o nada (el spec se salta).
let postgres: Extract<PostgresAvailability, { available: true }> | null = null
let schema = ''
let tableCounter = 0

const target = () => {
  if (!postgres) throw new Error('PostgreSQL no está disponible')
  return postgres.target
}

/** Tabla nueva (`id`, `name`) con tres filas en el esquema de la ejecución: cada test muta la suya. */
async function freshTable(): Promise<string> {
  const table = `${schema}.t${tableCounter++}`
  await pgQuery(
    target(),
    `create table ${table} (id int primary key, name text not null);
     insert into ${table} values (1, 'Ada'), (2, 'Grace'), (3, 'Linus')`,
  )
  return table
}

async function rowCount(table: string): Promise<unknown> {
  return (await pgQuery(target(), `select count(*)::int as n from ${table}`))[0]?.['n']
}

async function connectPostgres(
  app: StrataApp,
  { name = PROFILE, readOnly = false }: { name?: string; readOnly?: boolean } = {},
): Promise<void> {
  const { host, port, user, database, password } = target()
  await createPostgresProfile(app.page, { name, host, port, user, database, password, readOnly })
  await connectProfile(app.page, name)
  await openQueryTab(app.page, TAB)
}

test.describe('PostgreSQL (contenedor efímero o STRATA_TEST_PG_URL)', () => {
  test.beforeAll(async () => {
    // Cubre la descarga de la imagen la primera vez.
    test.setTimeout(10 * 60_000)
    const acquired = await acquirePostgres()
    if (!acquired.available) {
      process.stderr.write(`[e2e] PostgreSQL omitido: ${acquired.reason}\n`)
      test.skip(true, acquired.reason)
      return
    }
    postgres = acquired
    schema = `strata_e2e_${randomBytes(4).toString('hex')}`
    await pgQuery(
      acquired.target,
      `create schema ${schema};
       create table ${schema}.people (id int primary key, name text not null, age int);
       insert into ${schema}.people values (1, 'Ada', 36), (2, 'Grace', 45), (3, 'Linus', null);
       create table ${schema}.projects (id int primary key, title text not null, owner_id int references ${schema}.people(id))`,
    )
  })

  test.afterAll(async () => {
    if (!postgres) return
    // En un contenedor todo desaparece con él; en un servidor externo solo se retira el esquema propio.
    await pgQuery(postgres.target, `drop schema if exists ${schema} cascade`).catch(() => undefined)
    await postgres.release()
    postgres = null
  })

  test('crea el perfil sin contraseña, conecta, muestra el esquema y desconecta', async ({
    launchApp,
    userDataDir,
  }) => {
    const app = await launchApp()
    const { page } = app
    const { host, port, user, database, password } = target()

    await createPostgresProfile(page, { name: PROFILE, host, port, user, database, password })
    const saved = page.getByRole('list', { name: 'Conexiones guardadas' }).getByRole('listitem')
    await expect(saved).toContainText(PROFILE)
    await expect(saved).toContainText('PostgreSQL')
    await expect(saved).toContainText('Desconectado')
    if (password === null) {
      // Sin contraseña no se toca el almacén de credenciales (y con él, el Keychain).
      expect(existsSync(path.join(userDataDir, 'credentials.json'))).toBe(false)
      expect(JSON.stringify(await readUserDataFile(userDataDir, 'connections.json'))).not.toContain(
        'secretRef',
      )
    }

    await connectProfile(page, PROFILE)
    await expect(saved).toContainText('Conectado')
    await expect(
      page.getByRole('status').filter({ hasText: `Conectado a «${PROFILE}»` }),
    ).toBeVisible()
    const statusBar = page.getByRole('contentinfo', { name: 'Barra de estado' })
    await expect(statusBar).toContainText(/Conexión:\s*PG\s*PostgreSQL/)
    await expect(statusBar).toContainText(new RegExp(`Base de datos:\\s*${database}`))
    await expect(statusBarAccess(page)).toContainText('Lectura y escritura')
    await expect(statusBarTransaction(page)).toContainText('Sin transacción')

    await openQueryTab(page, TAB)
    const tree = page.getByRole('tree', { name: `Esquema de ${PROFILE}` })
    await expect(tree.getByRole('treeitem', { name: 'public', exact: true })).toBeVisible()
    await tree.getByRole('treeitem', { name: schema, exact: true }).click()
    await expect(tree.getByRole('treeitem', { name: 'Tablas (2)' })).toBeVisible()
    await expect(tree.getByRole('treeitem', { name: 'people tabla' })).toBeVisible()
    await expect(tree.getByRole('treeitem', { name: 'projects tabla' })).toBeVisible()
    await tree.getByRole('treeitem', { name: 'people tabla' }).click()
    await expect(tree.getByRole('treeitem', { name: 'Columnas (3)' })).toBeVisible()
    await expect(
      tree.getByRole('treeitem', { name: 'id integer clave primaria NOT NULL' }),
    ).toBeVisible()
    await expect(tree.getByRole('treeitem', { name: 'name text NOT NULL' })).toBeVisible()

    await page.getByRole('button', { name: `Desconectar ${PROFILE}` }).click()
    await expect(page.getByRole('button', { name: `Conectar ${PROFILE}` })).toBeVisible()
    await expect(saved).toContainText('Desconectado')
    await expect(statusBar).toContainText('Sin conexión')
    await expect(tree).toBeHidden()
    await expect(executionStatus(page)).toHaveText('Sin conexión: no se puede ejecutar.')
    expect(app.errors).toEqual([])
  })

  test('ejecuta un SELECT y muestra filas, NULL y cabeceras', async ({ launchApp }) => {
    const app = await launchApp()
    const { page } = app
    await connectPostgres(app)

    await runSql(page, TAB, `select id, name, age from ${schema}.people order by id`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    const grid = resultsGrid(page)
    await expect(grid).toBeVisible()
    await expect(grid.getByRole('columnheader')).toHaveCount(4)
    await expect(grid.getByRole('row', { name: '1 1 Ada 36' })).toBeVisible()
    await expect(grid.getByRole('row', { name: '2 2 Grace 45' })).toBeVisible()
    await expect(grid.getByRole('row', { name: '3 3 Linus NULL' })).toBeVisible()
    await expect(
      page.getByRole('status').filter({ hasText: 'Resultado completo: 3 filas' }),
    ).toBeVisible()
    expect(app.errors).toEqual([])
  })

  test('un error fuera de una transacción se muestra y no deja la conexión inservible', async ({
    launchApp,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectPostgres(app)

    await runSql(page, TAB, 'select 1/0')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
    await expect(page.locator('[data-part="error"]')).toContainText('division by zero')
    // Sin transacción explícita PostgreSQL no queda abortado: no hay nada que revertir.
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await expect(toolbar(page).locator('[data-hint="revert-first"]')).toBeHidden()

    await runSql(page, TAB, 'select 2 as dos')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(app.errors).toEqual([])
  })

  test('transacción: confirmar persiste y revertir descarta, verificado desde otra conexión', async ({
    launchApp,
  }) => {
    const app = await launchApp()
    const { page } = app
    const table = await freshTable()
    await connectPostgres(app)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await expect(statusBarTransaction(page)).toContainText('Transacción activa')
    await runSql(page, TAB, `insert into ${table} values (10, 'Hopper')`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    // Otra conexión (aislamiento READ COMMITTED) no ve la fila antes de confirmar.
    expect(await rowCount(table)).toBe(3)

    await toolbarButton(page, 'Confirmar').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await expect(statusBarTransaction(page)).toContainText('Sin transacción')
    expect(await rowCount(table)).toBe(4)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await runSql(
      page,
      TAB,
      `insert into ${table} values (11, 'Perdida'); update ${table} set name = 'X' where id = 1`,
    )
    await toolbarButton(page, 'Revertir').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(await rowCount(table)).toBe(4)
    expect(app.errors).toEqual([])
  })

  test('transacción abortada de PostgreSQL: el chip lo indica, se recupera con Revertir y lo hecho antes no persiste', async ({
    launchApp,
  }) => {
    const app = await launchApp()
    const { page } = app
    const table = await freshTable()
    await connectPostgres(app)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    // La segunda sentencia falla dentro de la transacción: PostgreSQL la marca como abortada.
    await runSql(
      page,
      TAB,
      `insert into ${table} values (10, 'Antes'); select 1/0; insert into ${table} values (11, 'Nunca')`,
    )
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
    await expect(page.locator('[data-part="error"]')).toContainText('division by zero')

    await expect(transactionChip(page)).toHaveAttribute('data-state', 'aborted')
    await expect(transactionChip(page)).toHaveText('Transacción abortada')
    await expect(statusBarTransaction(page)).toContainText('Transacción abortada: hay que revertir')
    await expect(statusBarTransaction(page).locator('[data-state]')).toHaveAttribute(
      'data-state',
      'aborted',
    )
    const hint = toolbar(page).locator('[data-hint="revert-first"]')
    await expect(hint).toHaveText(
      'Transacción abortada: solo puedes ejecutar ROLLBACK o pulsar «Revertir».',
    )
    await expect(hint).toHaveAttribute('role', 'status')

    // Con el ancho mínimo de la ventana el aviso (más largo) cabe en una línea y la barra de estado no pasa a dos.
    const wide = await page.evaluate(() => window.innerWidth)
    await resizeWindow(app, 720)
    const compact = (await hint.boundingBox())!
    expect(compact.height, 'aviso de transacción abortada a 720 px').toBeLessThan(32)
    expect((await toolbar(page).boundingBox())!.height, 'barra de ejecución a 720 px').toBeLessThan(
      110,
    )
    expect(
      (await page.getByRole('contentinfo', { name: 'Barra de estado' }).boundingBox())!.height,
      'barra de estado a 720 px',
    ).toBeLessThan(34)
    await expectTargetSize(toolbarButton(page, 'Revertir'), '«Revertir» a 720 px')
    await resizeWindow(app, wide)

    // Solo se puede revertir: iniciar otra o confirmar quedan bloqueados y explican por qué.
    await expect(toolbarButton(page, 'Iniciar transacción')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    await expect(toolbarButton(page, 'Confirmar')).toHaveAttribute('aria-disabled', 'true')
    await expect(toolbarButton(page, 'Revertir')).not.toHaveAttribute('aria-disabled', 'true')
    await toolbarButton(page, 'Confirmar').click({ force: true })
    await expect(executionStatus(page)).toHaveText(
      'No se puede operar con la transacción: La transacción está abortada: solo se puede revertir.',
    )

    // «Ejecutar» sigue habilitado (admite un ROLLBACK a mano) y su descripción accesible es el aviso; cualquier otra
    // sentencia se rechaza en el renderer, sin llegar al servidor (que respondería «current transaction is aborted»).
    await expect(toolbarButton(page, 'Ejecutar')).not.toHaveAttribute('aria-disabled', 'true')
    await expect(toolbarButton(page, 'Ejecutar')).toHaveAccessibleDescription(
      // El aviso lleva delante un glifo generado por CSS (el color no es el único canal).
      /Transacción abortada: solo puedes ejecutar ROLLBACK o pulsar «Revertir»\.$/,
    )
    for (const all of [false, true]) {
      await submitSql(page, TAB, 'select 2 as dos', { all })
      await expect(executionStatus(page)).toHaveAttribute('data-state', 'blocked')
      await expect(executionStatus(page)).toHaveText(
        'No se puede ejecutar: la transacción está abortada y solo admite ROLLBACK. Escríbelo o pulsa «Revertir».',
      )
      await expect(page.locator('[data-part="error"]')).not.toContainText(
        'current transaction is aborted',
      )
      await expect(page.locator('[data-part="error"]')).toContainText('division by zero')
      await expect(transactionChip(page)).toHaveAttribute('data-state', 'aborted')
    }

    await toolbarButton(page, 'Revertir').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await expect(statusBarTransaction(page)).toContainText('Sin transacción')
    await expect(hint).toBeHidden()
    await expect(toolbarButton(page, 'Iniciar transacción')).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
    // Ni la sentencia anterior al error ni la posterior llegaron a la tabla.
    expect(await rowCount(table)).toBe(3)

    await runSql(page, TAB, `select count(*) as n from ${table}`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page).getByRole('gridcell', { name: '3', exact: true })).toBeVisible()
    expect(app.errors).toEqual([])
  })

  test('una transacción abortada también se cierra con un ROLLBACK escrito en el editor', async ({
    launchApp,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectPostgres(app)

    await runSql(page, TAB, 'begin; select 1/0')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'aborted')

    await runSql(page, TAB, 'rollback')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await expect(toolbar(page).locator('[data-hint="revert-first"]')).toBeHidden()
    expect(app.errors).toEqual([])
  })

  test('con la transacción abortada solo pasan las sentencias de cierre: ROLLBACK TO SAVEPOINT la recupera y COMMIT equivale a revertir', async ({
    launchApp,
  }) => {
    const app = await launchApp()
    const { page } = app
    const table = await freshTable()
    await connectPostgres(app)
    const hint = toolbar(page).locator('[data-hint="revert-first"]')

    await runSql(
      page,
      TAB,
      `begin; insert into ${table} values (10, 'Antes'); savepoint sp; insert into ${table} values (11, 'Despues'); select 1/0`,
    )
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'aborted')

    await submitSql(page, TAB, `insert into ${table} values (12, 'Rechazada')`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'blocked')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'aborted')

    // Volver al savepoint mantiene la transacción viva y lo hecho antes de él.
    await runSql(page, TAB, 'rollback to savepoint sp')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await expect(hint).toBeHidden()
    await runSql(page, TAB, 'commit')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(await rowCount(table)).toBe(4)

    // COMMIT con la transacción abortada equivale a revertir: nada de lo hecho en ella persiste.
    await runSql(page, TAB, `begin; insert into ${table} values (13, 'Perdida'); select 1/0`)
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'aborted')
    await runSql(page, TAB, 'commit')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(await rowCount(table)).toBe(4)
    expect(app.errors).toEqual([])
  })

  test('cancelar una consulta de PostgreSQL la detiene en el servidor y la conexión sigue usable', async ({
    launchApp,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectPostgres(app)

    await submitSql(page, TAB, 'select pg_sleep(120)')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'running')
    // La consulta está de verdad en marcha en el servidor.
    const sleeping = `select count(*)::int as n from pg_stat_activity where pid <> pg_backend_pid() and state = 'active' and query like 'select pg_sleep(120)%'`
    await expect.poll(async () => (await pgQuery(target(), sleeping))[0]?.['n']).toBe(1)

    await toolbarButton(page, 'Cancelar').click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'cancelled')
    await expect(executionStatus(page)).toContainText('La última ejecución se canceló')
    await expect.poll(async () => (await pgQuery(target(), sleeping))[0]?.['n']).toBe(0)
    await expect(await openMessages(page)).toContainText('Ejecución cancelada')

    await page.getByRole('tab', { name: 'Resultados', exact: true }).click()
    await runSql(page, TAB, 'select 1 as uno')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(app.errors).toEqual([])
  })

  test('un perfil de solo lectura rechaza las escrituras, deja leer y admite transacciones', async ({
    launchApp,
  }) => {
    const app = await launchApp()
    const { page } = app
    const table = await freshTable()
    await connectPostgres(app, { name: 'PG lectura', readOnly: true })
    await expect(statusBarAccess(page)).toContainText('Solo lectura')

    await runSql(page, TAB, `select name from ${table} order by id`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page).getByRole('gridcell', { name: 'Grace' })).toBeVisible()

    await runSql(page, TAB, `delete from ${table} where id = 1`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
    await expect(page.locator('[data-part="error"]')).toContainText(
      'Conexión de solo lectura: Only read statements are allowed on a read-only connection',
    )
    await runSql(page, TAB, `truncate ${table}`)
    await expect(destructiveDialog(page)).toBeHidden()
    await expect(page.locator('[data-part="error"]')).toContainText('Conexión de solo lectura')
    expect(await rowCount(table)).toBe(3)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await toolbarButton(page, 'Revertir').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(app.errors).toEqual([])
  })

  test('TRUNCATE y DELETE sin WHERE piden confirmación y, en una transacción, se pueden revertir', async ({
    launchApp,
  }) => {
    const app = await launchApp()
    const { page } = app
    const table = await freshTable()
    await connectPostgres(app)
    const dialog = destructiveDialog(page)

    await submitSql(page, TAB, `truncate ${table}`)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('listitem')).toContainText('Vacía la tabla entera')
    await dialog.getByRole('button', { name: 'Cancelar' }).click()
    await expect(dialog).toBeHidden()
    expect(await rowCount(table)).toBe(3)

    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    await page.keyboard.press(`${MOD}+Enter`)
    await dialog.getByRole('button', { name: 'Ejecutar de todos modos' }).click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    // TRUNCATE toma un bloqueo exclusivo: otra conexión no puede ni contar hasta que la transacción termine, así que se mira desde la propia sesión.
    await runSql(page, TAB, `select count(*) as n from ${table}`)
    await expect(resultsGrid(page).getByRole('gridcell', { name: '0', exact: true })).toBeVisible()
    await toolbarButton(page, 'Revertir').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(await rowCount(table)).toBe(3)

    await submitSql(page, TAB, `delete from ${table}`)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('listitem')).toContainText('Borra filas sin cláusula WHERE')
    await dialog.getByRole('button', { name: 'Ejecutar de todos modos' }).click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(await openMessages(page)).toContainText('DELETE · 3 filas afectadas')
    expect(await rowCount(table)).toBe(0)
    expect(app.errors).toEqual([])
  })
})
