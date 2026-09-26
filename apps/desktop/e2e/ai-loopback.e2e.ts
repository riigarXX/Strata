import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { ask, askResult, enableAi } from './support/ai'
import { expect, test, type RecordedRequest } from './support/fake-ollama'
import { execFixtureDatabase, readUserDataFile } from './support/strata-app'
import { connectFixture, executionStatus, MOD, resultsGrid, settingsDialog } from './support/ui'

// La frontera de la IA local (ADR 0012): la app solo habla con el bucle local, solo con las rutas de Ollama que necesita y
// solo envía el esquema y la pregunta. Los valores «canario» son únicos y reconocibles: si alguno aparece en lo que recibe el
// servidor falso, una fila (o un valor por defecto) se ha filtrado.

const CANARY_SETUP = `
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    holder TEXT NOT NULL,
    iban TEXT NOT NULL,
    amount INTEGER NOT NULL,
    memo TEXT NOT NULL DEFAULT 'CANARY-DEFAULT-c0ffee'
  );
  INSERT INTO payments (id, holder, iban, amount, memo) VALUES
    (1, 'CANARY-HOLDER-8f21b7', 'ES91-CANARY-4417-0000-31', 7741029, 'CANARY-MEMO-d94e0a');
  INSERT INTO payments (id, holder, iban, amount) VALUES
    (2, 'CANARY-HOLDER-2c6e40', 'ES91-CANARY-9902-0000-77', 5530871);
`

// Lo que hay en las filas (incluida la suma que devuelve la segunda consulta) y en los valores por defecto.
const CANARY_VALUES = [
  'CANARY-HOLDER-8f21b7',
  'CANARY-HOLDER-2c6e40',
  'ES91-CANARY-4417-0000-31',
  'ES91-CANARY-9902-0000-77',
  'CANARY-MEMO-d94e0a',
  'CANARY-DEFAULT-c0ffee',
  '7741029',
  '5530871',
  '13271900',
  'Ada',
  'Grace',
  'Linus',
  'kernel',
  'Analytical Engine',
]

const EXPECTED_ROUTES = ['GET /api/tags', 'GET /api/version', 'POST /api/chat', 'POST /api/pull']

// Cabeceras que llevarían una credencial o una sesión: la app no envía ninguna.
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']

const route = (request: RecordedRequest): string => `${request.method} ${request.path}`

const savedBaseUrl = async (page: Page): Promise<string> =>
  (await page.evaluate(
    `window.db.preferences.get().then((result) => result.data.ai.baseUrl)`,
  )) as string

test.describe('solo bucle local, solo esquema y pregunta', () => {
  test('todas las peticiones llegan a 127.0.0.1, a las rutas esperadas y sin un solo valor de las filas', async ({
    launchApp,
    fixtureDb,
    ollama,
  }) => {
    execFixtureDatabase(fixtureDb, CANARY_SETUP)
    ollama.models = []
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)

    // Ajustes: probar la conexión y descargar el modelo (contra el servidor falso, que lo da por bueno).
    await page.keyboard.press(`${MOD}+,`)
    const settings = settingsDialog(page)
    await settings.getByRole('button', { name: 'Probar conexión' }).click()
    await expect(settings.locator('[data-part="connection"]')).toContainText(
      `Alcanzable en ${ollama.url} · versión 9.9.9`,
    )
    const download = settings.getByRole('button', { name: /^Descargar qwen3:14b/ })
    await expect(download).not.toHaveAttribute('aria-disabled', 'true')
    await download.click()
    await expect(settings.getByText('qwen3:14b está instalado.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()

    // Preguntar: las filas llegan al renderer (se ven en el grid) pero nunca al modelo.
    await connectFixture(app, fixtureDb)
    ollama.answer = 'SELECT * FROM payments ORDER BY id'
    await ask(page, '¿Qué pagos hay registrados?')
    await expect(askResult(page).locator('[data-part="risk-chip"]')).toContainText('Lectura')
    await page.keyboard.press('Escape')
    await expect(executionStatus(page)).toHaveAttribute('data-state', 'done')
    await expect(resultsGrid(page)).toContainText('CANARY-HOLDER-8f21b7')
    await expect(resultsGrid(page)).toContainText('7741029')

    ollama.answer = 'SELECT sum(amount) AS total FROM payments'
    await ask(page, '¿Cuánto suman?')
    await expect(askResult(page).locator('[data-part="risk-chip"]')).toContainText('Lectura')
    await page.keyboard.press('Escape')
    await expect(resultsGrid(page)).toContainText('13271900')

    // Todo lo que llegó al servidor falso: bucle local, rutas esperadas, sin credenciales.
    expect(ollama.requests.length).toBeGreaterThan(0)
    for (const request of ollama.requests) {
      const label = route(request)
      expect(request.host, label).toBe(new URL(ollama.url).host)
      expect(request.localAddress, label).toBe('127.0.0.1')
      expect(request.remoteAddress, label).toBe('127.0.0.1')
      for (const header of CREDENTIAL_HEADERS)
        expect(request.headers[header], label).toBeUndefined()
    }
    expect([...new Set(ollama.requests.map(route))].sort()).toEqual(EXPECTED_ROUTES)

    // La descarga solo dice qué modelo quiere.
    expect(JSON.parse(ollama.requestsTo('/api/pull')[0]?.body ?? '')).toEqual({
      model: 'qwen3:14b',
      stream: true,
    })

    // Cada pregunta lleva el esquema (nombres, tipos, claves) y la pregunta, y ningún valor.
    const chats = ollama.requestsTo('/api/chat')
    expect(chats).toHaveLength(2)
    const questions = ['¿Qué pagos hay registrados?', '¿Cuánto suman?']
    for (const [index, chat] of chats.entries()) {
      const body = JSON.parse(chat.body) as { messages: { role: string; content: string }[] }
      expect(body.messages.map((message) => message.role)).toEqual(['system', 'user'])
      const user = body.messages[1]?.content ?? ''
      expect(user).toContain('TABLE payments(')
      expect(user).toContain('holder')
      expect(user).toContain(questions[index] ?? '')
    }
    for (const request of ollama.requests) {
      for (const value of CANARY_VALUES) {
        expect(request.body, `${route(request)} no debe contener «${value}»`).not.toContain(value)
      }
      expect(request.body, route(request)).not.toMatch(/canary/i)
    }
    expect(app.errors).toEqual([])
  })

  const REJECTED = [
    {
      url: 'http://evil.example.com:11434',
      reason: /Solo se admiten direcciones de este equipo/,
    },
    {
      url: 'http://127.0.0.1@evil.example.com:11434',
      reason: /Solo se admiten direcciones de este equipo/,
    },
    {
      url: 'http://localhost.evil.com:11434',
      reason: /Solo se admiten direcciones de este equipo/,
    },
    { url: 'http://0.0.0.0:11434', reason: /Solo se admiten direcciones de este equipo/ },
    { url: 'http://127.0.0.1', reason: /Indica el puerto/ },
    { url: 'http://127.0.0.1:80', reason: /El puerto debe estar entre 1024 y 65535/ },
    { url: 'ftp://127.0.0.1:2121', reason: /Empieza por http:\/\// },
  ]

  test('una dirección que no es de bucle local se rechaza en Ajustes sin guardarla ni conectar', async ({
    launchApp,
    userDataDir,
    ollama,
  }) => {
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await page.keyboard.press(`${MOD}+,`)
    const settings = settingsDialog(page)
    const address = settings.getByRole('textbox', { name: 'Dirección del servidor' })
    await expect(address).toHaveValue(ollama.url)
    await expect(settings.locator('[data-part="connection"]')).toContainText('Alcanzable')
    ollama.clearRequests()

    for (const { url, reason } of REJECTED) {
      await address.fill(url)
      await address.press('Enter')
      await expect(address, url).toHaveAttribute('aria-invalid', 'true')
      await expect(address, url).toHaveAccessibleDescription(reason)
      // «Probar conexión» con una dirección inválida no sale a ninguna parte: vuelve al campo.
      await settings.getByRole('button', { name: 'Probar conexión' }).click()
      await expect(address, url).toBeFocused()
    }

    // Lo guardado sigue siendo la dirección buena, en main y en disco, y no salió ni una petición.
    expect(await savedBaseUrl(page)).toBe(ollama.url)
    expect(await readUserDataFile(userDataDir, 'preferences.json')).toMatchObject({
      preferences: { ai: { baseUrl: ollama.url } },
    })
    expect(ollama.requests).toEqual([])
    expect(app.errors).toEqual([])
  })

  test('una dirección de fuera escrita a mano en preferences.json se repone y se conserva una copia', async ({
    launchApp,
    userDataDir,
  }) => {
    const file = path.join(userDataDir, 'preferences.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        preferences: { ai: { enabled: true, baseUrl: 'http://evil.example.com:11434' } },
      }),
    )
    const app = await launchApp()

    expect(await savedBaseUrl(app.page)).toBe('http://127.0.0.1:11434')
    expect(existsSync(`${file}.corrupt`)).toBe(true)
    expect(app.errors).toEqual([])
  })
})
