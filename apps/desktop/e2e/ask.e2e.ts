import { expect, test } from './support/fake-ollama'
import { ask, askDialog, askResult, enableAi, questionBox, sqlTabs } from './support/ai'
import { queryFixtureDatabase } from './support/strata-app'
import {
  connectFixture,
  connectProfile,
  createSqliteProfile,
  destructiveDialog,
  editorOf,
  executionStatus,
  MOD,
  openQueryTab,
  resultsGrid,
  runSql,
  settingsDialog,
  toolbarButton,
} from './support/ui'

// El panel «Preguntar» de punta a punta: app real, IPC, main, adapter SQLite y un Ollama falso en el bucle local.
// Ningún test usa un modelo: lo que «responde» el servidor lo decide cada test.

/** Todo lo que un test podría alterar de la base fixture, leído por una conexión independiente de la de la app. */
const snapshot = (file: string) => ({
  people: queryFixtureDatabase(file, 'select * from people order by id'),
  projects: queryFixtureDatabase(file, 'select * from projects order by id'),
  schema: queryFixtureDatabase(file, 'select type, name, sql from sqlite_master order by name'),
})

test.describe('panel «Preguntar a la base»', () => {
  test('una pregunta de lectura abre una pestaña nueva, se ejecuta sola y muestra el resultado', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)

    await ask(page, '¿Cuántas personas hay?')
    const result = askResult(page)
    await expect(result).toBeVisible()
    await expect(result.locator('[data-part="risk-chip"]')).toContainText('Riesgo: Lectura')
    await expect(result.locator('[data-part="generated-sql"]')).toHaveText(
      'SELECT id, name FROM people ORDER BY id',
    )
    await expect(askDialog(page).locator('[data-part="ask-status"]')).toContainText(
      'Consulta lista, riesgo: lectura.',
    )

    await page.keyboard.press('Escape')
    await expect(askDialog(page)).toBeHidden()

    const title = 'IA: ¿Cuántas personas hay?'
    await expect(page.getByRole('tab', { name: title, selected: true })).toBeVisible()
    await expect(editorOf(page, title)).toContainText('SELECT id, name FROM people ORDER BY id')
    await expect(editorOf(page, title)).toBeFocused()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText('Grace')

    // Al modelo solo le llegaron el esquema y la pregunta: ninguna fila.
    const sent = ollama.requests.map((request) => request.body).join('\n')
    expect(sent).toContain('people')
    for (const value of ['Ada', 'Grace', 'Linus', 'kernel']) expect(sent).not.toContain(value)
    expect(app.errors).toEqual([])
  })

  test('una consulta destructiva se abre en una pestaña nueva sin ejecutarse y la base queda intacta', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.answer = 'DELETE FROM people'

    await ask(page, 'borra a todas las personas')
    const result = askResult(page)
    await expect(result.locator('[data-part="risk-chip"]')).toContainText('Destructiva')
    await expect(result.locator('[data-part="run-outcome"]')).toContainText('No se ha ejecutado')
    await page.keyboard.press('Escape')

    const title = 'IA: borra a todas las personas'
    await expect(page.getByRole('tab', { name: title, selected: true })).toBeVisible()
    await expect(editorOf(page, title)).toContainText('DELETE FROM people')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')
    await expect(resultsGrid(page)).toBeHidden()

    // Nada se ejecutó: las tres filas siguen ahí.
    await page.getByRole('tab', { name: 'Consulta 1' }).click()
    await runSql(page, 'Consulta 1', 'select count(*) as n from people')
    await expect(resultsGrid(page)).toContainText('3')
    expect(app.errors).toEqual([])
  })

  const NOT_AUTO_RUN = [
    {
      kind: 'escritura (UPDATE con WHERE)',
      sql: "UPDATE people SET name = 'Zed' WHERE id = 1",
      risk: 'Escritura',
    },
    {
      kind: 'escritura (INSERT)',
      sql: "INSERT INTO people (id, name) VALUES (9, 'Nueva')",
      risk: 'Escritura',
    },
    { kind: 'destructiva (DROP TABLE)', sql: 'DROP TABLE projects', risk: 'Destructiva' },
    {
      kind: 'destructiva (UPDATE sin WHERE)',
      sql: 'UPDATE people SET age = 0',
      risk: 'Destructiva',
    },
    { kind: 'desconocida (BEGIN)', sql: 'BEGIN', risk: 'Desconocida' },
  ]

  for (const { kind, sql, risk } of NOT_AUTO_RUN) {
    test(`una consulta ${kind} se abre sin ejecutarse y la base queda intacta`, async ({
      launchApp,
      fixtureDb,
      ollama,
    }) => {
      const app = await launchApp()
      const { page } = app
      await enableAi(app, ollama.url)
      await connectFixture(app, fixtureDb)
      const before = snapshot(fixtureDb)
      ollama.answer = sql

      await ask(page, 'haz un cambio')
      const result = askResult(page)
      await expect(result.locator('[data-part="risk-chip"]')).toContainText(`Riesgo: ${risk}`)
      await expect(result.locator('[data-part="generated-sql"]')).toHaveText(sql)
      await expect(result.locator('[data-part="run-outcome"]')).toContainText('No se ha ejecutado')
      await page.keyboard.press('Escape')

      await expect(
        page.getByRole('tab', { name: 'IA: haz un cambio', selected: true }),
      ).toBeVisible()
      await expect(editorOf(page, 'IA: haz un cambio')).toContainText(sql)
      await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')
      await expect(resultsGrid(page)).toBeHidden()
      expect(snapshot(fixtureDb)).toEqual(before)
      expect(app.errors).toEqual([])
    })
  }

  test('ejecutar a mano lo que propuso la IA pasa por la confirmación destructiva de siempre', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.answer = 'DELETE FROM projects'

    await ask(page, 'borra todos los proyectos')
    await expect(askResult(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')

    await page.keyboard.press(`${MOD}+Enter`)
    const confirmation = destructiveDialog(page)
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Cancelar' }).click()
    await expect(confirmation).toBeHidden()
    expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from projects')).toEqual([
      { n: 1 },
    ])

    await page.keyboard.press(`${MOD}+Enter`)
    await confirmation.getByRole('button', { name: 'Ejecutar de todos modos' }).click()
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from projects')).toEqual([
      { n: 0 },
    ])
    expect(app.errors).toEqual([])
  })

  test('en un perfil de solo lectura la lectura se ejecuta y todo lo demás sale bloqueado sin tocar la base', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await createSqliteProfile(app, { name: 'Lectura', file: fixtureDb, readOnly: true })
    await connectProfile(page, 'Lectura')
    await openQueryTab(page, 'Consulta 1')
    const before = snapshot(fixtureDb)

    ollama.answer = 'SELECT id, name FROM people ORDER BY id'
    await ask(page, 'lista las personas')
    await expect(askResult(page).locator('[data-part="risk-chip"]')).toContainText('Lectura')
    await page.keyboard.press('Escape')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText('Grace')

    const blocked = [
      {
        question: 'cambia el nombre de Ada',
        sql: "UPDATE people SET name = 'x' WHERE id = 1",
        risk: 'Escritura',
      },
      { question: 'borra todo', sql: 'DELETE FROM people', risk: 'Destructiva' },
      { question: 'abre una transacción', sql: 'BEGIN', risk: 'Desconocida' },
    ]
    for (const { question, sql, risk } of blocked) {
      ollama.answer = sql
      await ask(page, question)
      const result = askResult(page)
      await expect(result.locator('[data-part="risk-chip"]')).toContainText(risk)
      await expect(result.locator('[data-part="blocked-reason"]')).toContainText('solo lectura')
      await expect(result.locator('[data-part="run-outcome"]')).toContainText(
        'no se puede ejecutar',
      )
      await page.keyboard.press('Escape')
      await expect(askDialog(page)).toBeHidden()
      await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')
      await expect(resultsGrid(page)).toBeHidden()
    }

    // La barrera real es main: aunque el usuario lance a mano la escritura bloqueada, se rechaza.
    await page.getByRole('tab', { name: 'IA: cambia el nombre de Ada' }).click()
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'error')
    await expect(page.locator('[data-part="error"]')).toContainText('Conexión de solo lectura')

    expect(snapshot(fixtureDb)).toEqual(before)
    expect(app.errors).toEqual([])
  })

  test('cannot_answer se explica con palabras de la interfaz y no abre pestañas', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.answer = '-- CANNOT_ANSWER'

    await ask(page, '¿Cuál es el sentido de la vida?')
    await expect(askDialog(page).locator('[data-state="error"]')).toContainText(
      'no ha encontrado cómo responder',
    )
    await expect(questionBox(page)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(sqlTabs(page)).toHaveCount(1)
    expect(app.errors).toEqual([])
  })

  test('Escape cancela una generación en curso, conserva la pregunta y el siguiente Escape cierra', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.chatDelayMs = 20_000

    await ask(page, '¿Cuántas personas hay?')
    await expect(askDialog(page).locator('[data-state="generating"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(askDialog(page).locator('[data-state="cancelled"]')).toBeVisible()
    // Cancelar no solo suelta la interfaz: main aborta la petición al modelo.
    await expect.poll(() => ollama.abortedChats).toBe(1)
    await expect(questionBox(page)).toHaveValue('¿Cuántas personas hay?')
    await expect(askDialog(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(askDialog(page)).toBeHidden()
    await expect(sqlTabs(page)).toHaveCount(1)
    await expect(editorOf(page, 'Consulta 1')).toBeFocused()
    expect(app.errors).toEqual([])
  })

  test('con la IA desactivada de fábrica solo explica y ofrece los ajustes de IA', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)

    await page.keyboard.press(`${MOD}+Shift+A`)
    const notice = askDialog(page).locator('[data-part="ask-prerequisite"]')
    await expect(notice).toContainText('La IA local está desactivada')
    await notice.getByRole('button', { name: 'Abrir ajustes de IA' }).click()
    await expect(askDialog(page)).toBeHidden()
    await expect(settingsDialog(page)).toBeVisible()
    await expect(settingsDialog(page).getByRole('heading', { name: 'IA local' })).toBeVisible()
    expect(ollama.requests).toEqual([])
    expect(app.errors).toEqual([])
  })

  test('el botón «Preguntar a la base» de la barra abre el diálogo y Escape devuelve el foco al editor', async ({
    launchApp,
    fixtureDb,
  }) => {
    const app = await launchApp()
    const { page } = app
    await connectFixture(app, fixtureDb)
    const button = toolbarButton(page, 'Preguntar a la base con IA')

    await expect(button).toHaveAttribute('aria-keyshortcuts', /Shift\+A$/)
    await button.click()
    await expect(askDialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(askDialog(page)).toBeHidden()
    await expect(editorOf(page, 'Consulta 1')).toBeFocused()
    expect(app.errors).toEqual([])
  })
})
