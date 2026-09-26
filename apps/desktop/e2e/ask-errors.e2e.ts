import { expect, test } from './support/fake-ollama'
import { ask, askDialog, askError, askResult, enableAi, questionBox, sqlTabs } from './support/ai'
import { queryFixtureDatabase } from './support/strata-app'
import {
  connectFixture,
  editorOf,
  executionStatus,
  MOD,
  resultsGrid,
  settingsDialog,
} from './support/ui'

// Qué ve el usuario en el panel «Preguntar» cuando el servidor de modelos falla o el modelo devuelve algo raro.
// Cada error se explica con palabras de la interfaz (nunca con lo que diga el servidor) y no abre pestañas.

const OPEN_SETTINGS = 'Abrir ajustes de IA'

test.describe('el panel «Preguntar» ante errores del servidor y respuestas raras', () => {
  test('con el servidor caído (conexión rechazada) lo explica y ofrece los ajustes de IA', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    // El puerto queda cerrado: nada escucha, así que el sistema rechaza la conexión.
    await ollama.close()

    await ask(page, '¿Cuántas personas hay?')
    await expect(askError(page)).toContainText('No se pudo conectar con el servidor de modelos')
    await expect(questionBox(page)).toBeFocused()
    await expect(sqlTabs(page)).toHaveCount(1)

    await askError(page).getByRole('button', { name: OPEN_SETTINGS }).click()
    await expect(askDialog(page)).toBeHidden()
    await expect(settingsDialog(page).getByRole('heading', { name: 'IA local' })).toBeVisible()
    expect(app.errors).toEqual([])
  })

  test('un modelo no instalado (404 del servidor) se explica sin repetir lo que dice el servidor', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.chatStatus = 404

    await ask(page, '¿Cuántas personas hay?')
    await expect(askError(page)).toContainText('El modelo elegido no está instalado')
    await expect(askError(page).getByRole('button', { name: OPEN_SETTINGS })).toBeVisible()
    await expect(askDialog(page)).not.toContainText('fake-server-says-something')
    await expect(sqlTabs(page)).toHaveCount(1)
    expect(app.errors).toEqual([])
  })

  // El tiempo máximo real de main son 120 s: aquí se ejercita el mismo código con el 504 que devuelve un servidor que agota el suyo.
  test('un tiempo agotado (504 del servidor) se explica y permite volver a intentarlo', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.chatStatus = 504

    await ask(page, '¿Cuántas personas hay?')
    await expect(askError(page)).toContainText('El modelo tardó demasiado en responder')
    await expect(askError(page).getByRole('button', { name: OPEN_SETTINGS })).toHaveCount(0)
    await expect(askDialog(page)).not.toContainText('fake-server-says-something')
    await expect(questionBox(page)).toHaveValue('¿Cuántas personas hay?')

    // Con el servidor recuperado, el mismo texto se puede reenviar.
    ollama.chatStatus = 200
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(askResult(page).locator('[data-part="risk-chip"]')).toContainText('Lectura')
    expect(app.errors).toEqual([])
  })

  test('el botón «Cancelar generación» abandona una respuesta lenta y main aborta la petición', async ({
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
    await askDialog(page).getByRole('button', { name: 'Cancelar generación' }).click()
    await expect(askDialog(page).locator('[data-state="cancelled"]')).toContainText(
      'No se ha abierto ni ejecutado nada',
    )
    await expect.poll(() => ollama.abortedChats).toBe(1)
    await expect(questionBox(page)).toBeFocused()
    await expect(questionBox(page)).toHaveValue('¿Cuántas personas hay?')
    await expect(sqlTabs(page)).toHaveCount(1)
    expect(app.errors).toEqual([])
  })

  test('una respuesta con dos sentencias se rechaza entera: no abre pestañas ni toca la base', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.answer = 'SELECT id FROM people; DELETE FROM people WHERE id = 1'

    await ask(page, 'lista y borra a Ada')
    await expect(askError(page)).toContainText('El modelo propuso varias sentencias')
    await expect(sqlTabs(page)).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')
    await expect(resultsGrid(page)).toBeHidden()
    expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from people')).toEqual([{ n: 3 }])
    expect(app.errors).toEqual([])
  })

  test('una respuesta sin ninguna sentencia se explica como salida no válida, distinta de «no puedo responder»', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.answer = '<think>No sé qué piden.</think>'

    await ask(page, 'blablabla')
    await expect(askError(page)).toContainText('El modelo no devolvió una consulta SQL válida')
    await expect(askError(page)).not.toContainText('no ha encontrado cómo responder')
    await expect(sqlTabs(page)).toHaveCount(1)
    expect(app.errors).toEqual([])
  })

  test('una respuesta que es prosa, sin SQL, se rechaza como salida no válida: no abre pestañas ni toca la base', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.answer = 'Lo siento, no sé qué quieres decir con eso.'

    await ask(page, 'blablabla')
    await expect(askError(page)).toContainText('El modelo no devolvió una consulta SQL válida')
    await expect(askError(page)).not.toContainText('no ha encontrado cómo responder')
    // Ni el texto del modelo ni un riesgo «Desconocida» llegan a la pantalla, y no hay pestaña nueva.
    await expect(askDialog(page)).not.toContainText('Lo siento')
    await expect(askDialog(page)).not.toContainText('Riesgo')
    await expect(sqlTabs(page)).toHaveCount(1)
    await expect(questionBox(page)).toHaveValue('blablabla')
    await page.keyboard.press('Escape')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'idle')
    await expect(resultsGrid(page)).toBeHidden()
    expect(queryFixtureDatabase(fixtureDb, 'select count(*) as n from people')).toEqual([{ n: 3 }])
    expect(app.errors).toEqual([])
  })

  test('el razonamiento <think> y las vallas ```sql se sanean: se avisa y solo queda la consulta', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await connectFixture(app, fixtureDb)
    ollama.answer = [
      '<think>El usuario quiere ver a las personas; miro la tabla people.</think>',
      '```sql',
      'SELECT id, name FROM people ORDER BY id',
      '```',
      '',
      'Esta consulta devuelve todas las personas.',
    ].join('\n')

    await ask(page, 'lista a las personas')
    const result = askResult(page)
    await expect(result.locator('[data-part="generated-sql"]')).toHaveText(
      'SELECT id, name FROM people ORDER BY id',
    )
    await expect(result.locator('[data-part="risk-chip"]')).toContainText('Riesgo: Lectura')
    const warnings = result.locator('[data-part="ask-warnings"]')
    await expect(warnings).toContainText('Se descartó el razonamiento')
    await expect(warnings).toContainText('Se limpió el formato de la respuesta')
    // Lo que dijo el modelo fuera de la consulta no llega a la pantalla.
    await expect(askDialog(page)).not.toContainText('miro la tabla')
    await expect(askDialog(page)).not.toContainText('Esta consulta devuelve')
    await page.keyboard.press('Escape')

    const title = 'IA: lista a las personas'
    await expect(editorOf(page, title)).toContainText('SELECT id, name FROM people ORDER BY id')
    await expect(editorOf(page, title)).not.toContainText('think')
    await expect(editorOf(page, title)).not.toContainText('```')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText('Grace')
    expect(app.errors).toEqual([])
  })
})
