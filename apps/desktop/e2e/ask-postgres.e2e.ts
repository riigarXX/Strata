import { randomBytes } from 'node:crypto'
import { ask, askDialog, askError, askResult, enableAi, questionBox, sqlTabs } from './support/ai'
import { expect, test } from './support/fake-ollama'
import { acquirePostgres, pgQuery, type PostgresAvailability } from './support/postgres'
import type { StrataApp } from './support/strata-app'
import {
  connectProfile,
  createPostgresProfile,
  editorOf,
  executionStatus,
  MOD,
  openQueryTab,
  resultsGrid,
  runSql,
  toolbarButton,
  transactionChip,
} from './support/ui'

// El panel «Preguntar» contra PostgreSQL de punta a punta (ADR 0012, «ejecución de solo lectura reforzada por main»): la
// consulta de lectura se ejecuta dentro de `BEGIN READ ONLY` con `ROLLBACK` siempre, aunque el analizador de texto no
// vea que una función escribe. El servidor lo decide `acquirePostgres`: STRATA_TEST_PG_URL, un contenedor efímero de
// Docker o nada (el spec se salta); STRATA_E2E_SKIP_PG=1 lo omite.

const PROFILE = 'PG'
const TAB = 'Consulta 1'

let postgres: Extract<PostgresAvailability, { available: true }> | null = null
let schema = ''
let counter = 0

const target = () => {
  if (!postgres) throw new Error('PostgreSQL no está disponible')
  return postgres.target
}

/** Función VOLATILE que inserta en su propia tabla: para el analizador es un `SELECT` cualquiera. */
async function writerFunction(): Promise<{ call: string; count: () => Promise<unknown> }> {
  const id = counter++
  const audit = `${schema}.audit_${id}`
  const fn = `${schema}.mi_funcion_${id}`
  await pgQuery(
    target(),
    `create table ${audit} (id serial primary key, note text not null);
     create function ${fn}() returns int language plpgsql volatile as $$
       begin insert into ${audit} (note) values ('escrito por una consulta'); return 1; end
     $$`,
  )
  return {
    call: `SELECT ${fn}() AS resultado`,
    count: async () =>
      (await pgQuery(target(), `select count(*)::int as n from ${audit}`))[0]?.['n'],
  }
}

async function connectPostgres(app: StrataApp): Promise<void> {
  const { host, port, user, database, password } = target()
  await createPostgresProfile(app.page, { name: PROFILE, host, port, user, database, password })
  await connectProfile(app.page, PROFILE)
  await openQueryTab(app.page, TAB)
}

test.describe('panel «Preguntar» con PostgreSQL (contenedor efímero o STRATA_TEST_PG_URL)', () => {
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
    schema = `strata_e2e_ai_${randomBytes(4).toString('hex')}`
    await pgQuery(
      acquired.target,
      `create schema ${schema};
       create table ${schema}.people (id int primary key, name text not null, age int);
       insert into ${schema}.people values (1, 'Ada', 36), (2, 'Grace', 45), (3, 'Linus', null)`,
    )
  })

  test.afterAll(async () => {
    if (!postgres) return
    await pgQuery(postgres.target, `drop schema if exists ${schema} cascade`).catch(() => undefined)
    await postgres.release()
    postgres = null
  })

  test('un SELECT del modelo se ejecuta solo, dentro de una transacción de solo lectura que no deja rastro', async ({
    launchApp,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectPostgres(app)

    ollama.answer = `SELECT id, name FROM ${schema}.people ORDER BY id`
    await ask(page, '¿Quiénes son las personas?')
    await expect(askResult(page).locator('[data-part="risk-chip"]')).toContainText(
      'Riesgo: Lectura',
    )
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('tab', { name: 'IA: ¿Quiénes son las personas?', selected: true }),
    ).toBeVisible()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText('Grace')
    // El esquema que llegó al modelo es el de PostgreSQL (con el esquema propio de la ejecución) y sin filas.
    const sent = ollama.requestsTo('/api/chat')[0]?.body ?? ''
    expect(sent).toContain('people')
    for (const value of ['Ada', 'Grace', 'Linus']) expect(sent).not.toContain(value)

    // Prueba directa de `enforceReadOnly`: lo que ve la propia sesión mientras se ejecuta la consulta de la IA.
    ollama.answer = "SELECT current_setting('transaction_read_only') AS solo_lectura"
    await ask(page, '¿La transacción es de solo lectura?')
    await expect(askResult(page).locator('[data-part="risk-chip"]')).toContainText('Lectura')
    await page.keyboard.press('Escape')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText(/\bon\b/)

    // Lo que el usuario ejecuta a mano no va en modo solo lectura, y la sesión no queda en una transacción.
    await page.getByRole('tab', { name: TAB }).click()
    await runSql(page, TAB, "select current_setting('transaction_read_only') as solo_lectura")
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText(/\boff\b/)
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    expect(app.errors).toEqual([])
  })

  test('una función VOLATILE que escribe, llamada desde un SELECT, falla en solo lectura y no escribe nada', async ({
    launchApp,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectPostgres(app)
    const writer = await writerFunction()
    ollama.answer = writer.call

    await ask(page, 'llama a mi función')
    // Para el analizador de texto es una lectura cualquiera: se autoejecuta y la barrera es el servidor.
    await expect(askResult(page).locator('[data-part="risk-chip"]')).toContainText(
      'Riesgo: Lectura',
    )
    await page.keyboard.press('Escape')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
    await expect(page.locator('[data-part="error"]')).toContainText(/read-only transaction/i)
    await expect(resultsGrid(page)).toBeHidden()
    expect(await writer.count()).toBe(0)

    // Control: sin la marca de la IA, la misma sentencia escribe de verdad (no es un test vacío).
    await page.getByRole('tab', { name: TAB }).click()
    await runSql(page, TAB, writer.call)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(await writer.count()).toBe(1)
    expect(app.errors).toEqual([])
  })

  test('con una transacción abierta por el usuario la consulta se abre pero no se ejecuta sola', async ({
    launchApp,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectPostgres(app)
    await toolbarButton(page, 'Iniciar transacción').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')

    ollama.answer = `SELECT id, name FROM ${schema}.people ORDER BY id`
    await ask(page, 'lista las personas')
    const result = askResult(page)
    await expect(result.locator('[data-part="risk-chip"]')).toContainText('Riesgo: Lectura')
    // El esquema se lee dentro de la transacción abierta: el modelo lo recibe y la transacción no se toca.
    expect(ollama.requestsTo('/api/chat')[0]?.body ?? '').toContain('people')
    await expect(result.locator('[data-part="run-outcome"]')).toContainText(
      'hay una transacción abierta en esta conexión',
    )
    await page.keyboard.press('Escape')

    const title = 'IA: lista las personas'
    await expect(editorOf(page, title)).toContainText(`FROM ${schema}.people ORDER BY id`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')
    await expect(resultsGrid(page)).toBeHidden()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')

    // Ejecutarla es decisión del usuario, dentro de su transacción, que sigue abierta.
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText('Grace')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'active')
    expect(app.errors).toEqual([])
  })

  test('con la transacción abortada no llama al modelo, explica cómo salir y tras revertir pregunta con normalidad', async ({
    launchApp,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectPostgres(app)
    await toolbarButton(page, 'Iniciar transacción').click()
    await runSql(page, TAB, 'select 1/0')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'aborted')

    ollama.answer = `SELECT id, name FROM ${schema}.people ORDER BY id`
    await ask(page, 'lista las personas')
    await expect(askError(page)).toContainText(
      'Hay una transacción abortada en esta conexión: pulsa «Revertir» o escribe ROLLBACK antes de preguntar.',
    )
    // Ni «salida no válida» ni lo que dice el servidor; nada se abre y el texto de la pregunta se conserva.
    await expect(askError(page)).not.toContainText('no devolvió una consulta SQL válida')
    await expect(askDialog(page)).not.toContainText('current transaction is aborted')
    await expect(askDialog(page).locator('[data-part="risk-chip"]')).toHaveCount(0)
    await expect(sqlTabs(page)).toHaveCount(1)
    await expect(questionBox(page)).toHaveValue('lista las personas')
    // El modelo no recibió ninguna petición: el error se detecta antes de armar el esquema.
    expect(ollama.requestsTo('/api/chat')).toHaveLength(0)
    expect(ollama.abortedChats).toBe(0)

    await page.keyboard.press('Escape')
    await expect(askDialog(page)).toBeHidden()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'aborted')

    await toolbarButton(page, 'Revertir').click()
    await expect(transactionChip(page)).toHaveAttribute('data-state', 'none')
    await ask(page, 'lista las personas')
    await expect(askResult(page).locator('[data-part="risk-chip"]')).toContainText(
      'Riesgo: Lectura',
    )
    await page.keyboard.press('Escape')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText('Grace')
    expect(ollama.requestsTo('/api/chat')).toHaveLength(1)
    expect(app.errors).toEqual([])
  })
})
