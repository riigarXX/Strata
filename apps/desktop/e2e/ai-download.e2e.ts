import type { Locator, Page } from '@playwright/test'
import { enableAi } from './support/ai'
import { expect, test, type FakeOllama, type FakePull } from './support/fake-ollama'
import { MOD, settingsDialog } from './support/ui'

// La descarga del modelo recomendado desde Ajustes ▸ IA local, con un Ollama falso que emite el NDJSON de `/api/pull`
// línea a línea: el test decide cuándo llega cada capa. No se descarga nada real ni se toca el Ollama del equipo.

const MODEL = 'qwen3:14b'
const MB = 1_000_000

const aiSection = (page: Page): Locator =>
  settingsDialog(page).getByRole('region', { name: 'IA local' })
const downloadGroup = (page: Page): Locator =>
  aiSection(page).getByRole('group', { name: 'Modelo recomendado' })
const downloadButton = (page: Page): Locator =>
  downloadGroup(page).getByRole('button', { name: /^(Descargar|Volver a descargar) qwen3:14b/ })
const cancelButton = (page: Page): Locator =>
  downloadGroup(page).getByRole('button', { name: 'Cancelar descarga' })
const progressBar = (page: Page): Locator => downloadGroup(page).getByRole('progressbar')

/** El servidor falso sin el modelo instalado y con `/api/pull` en manos del test. */
function withoutModel(ollama: FakeOllama): void {
  ollama.models = []
  ollama.holdPull = true
}

async function openAiSettings(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+,`)
  await expect(aiSection(page)).toBeVisible()
}

/** Pulsa «Descargar» cuando el guardado de los ajustes ha terminado y devuelve la descarga que abrió la app. */
async function startDownload(page: Page, ollama: FakeOllama): Promise<FakePull> {
  await expect(downloadButton(page)).not.toHaveAttribute('aria-disabled', 'true')
  await downloadButton(page).click()
  return ollama.nextPull()
}

/** Termina una descarga con éxito, con el modelo ya instalado para cuando la app vuelva a listar. */
function finish(ollama: FakeOllama, pull: FakePull): void {
  pull.send({ status: 'verifying sha256 digest' })
  pull.send({ status: 'writing manifest' })
  pull.send({ status: 'success' })
  ollama.models = [{ name: MODEL, size: 123 }]
  pull.end()
}

test.describe('descarga del modelo desde Ajustes ▸ IA local', () => {
  test('activar la IA, apuntar al servidor y descargar con una barra que solo avanza', async ({
    launchApp,
    ollama,
  }) => {
    withoutModel(ollama)
    const app = await launchApp()
    const { page } = app
    await openAiSettings(page)

    // Desactivada de fábrica: no se puede descargar y el motivo está a la vista.
    await expect(downloadButton(page)).toHaveAttribute('aria-disabled', 'true')
    await expect(downloadGroup(page)).toContainText(
      'Activa la IA local para poder descargar modelos.',
    )

    const address = aiSection(page).getByRole('textbox', { name: 'Dirección del servidor' })
    await address.fill(ollama.url)
    await address.press('Enter')
    await aiSection(page).getByRole('switch', { name: 'Activar el asistente de IA local' }).check()
    await expect(aiSection(page).locator('[data-part="connection"]')).toContainText(
      `Alcanzable en ${ollama.url} · versión 9.9.9 · sin modelos.`,
    )

    const pull = await startDownload(page, ollama)
    expect(JSON.parse(pull.request.body)).toEqual({ model: MODEL, stream: true })
    await expect(cancelButton(page)).toBeFocused()
    // Sin haber recibido aún ningún tamaño, la barra es indeterminada.
    await expect(progressBar(page)).toHaveAttribute('aria-valuetext', 'Preparando la descarga…')
    await expect(progressBar(page)).not.toHaveAttribute('aria-valuenow', /.*/)

    pull.send({ status: 'pulling manifest' })
    // Dos capas que se alternan: el avance es la suma de ambas. Cada línea cambia de capa (o la completa)
    // porque main descarta las repetidas de la misma capa que llegan con menos de 200 ms de diferencia.
    const steps = [
      {
        layer: 'pulling aaa',
        completed: 25 * MB,
        now: '25',
        text: 'Descargando 25 % · 25 MB de 100 MB',
      },
      {
        layer: 'pulling bbb',
        completed: 50 * MB,
        now: '37',
        text: 'Descargando 37 % · 75 MB de 200 MB',
      },
      {
        layer: 'pulling aaa',
        completed: 100 * MB,
        now: '75',
        text: 'Descargando 75 % · 150 MB de 200 MB',
      },
      {
        layer: 'pulling bbb',
        completed: 100 * MB,
        now: '100',
        text: 'Descargando 100 % · 200 MB de 200 MB',
      },
    ]
    for (const step of steps) {
      pull.send({ status: step.layer, total: 100 * MB, completed: step.completed })
      await expect(progressBar(page)).toHaveAttribute('aria-valuenow', step.now)
      await expect(progressBar(page)).toHaveAttribute('aria-valuetext', step.text)
      await expect(downloadGroup(page).locator('[data-part="progress-text"]')).toHaveText(step.text)
    }
    // Una línea que llegase con menos avance (capa reiniciada) no hace retroceder la barra: al pasar a verificar, sigue en 100.
    pull.send({ status: 'pulling aaa', total: 100 * MB, completed: 10 * MB })
    pull.send({ status: 'verifying sha256 digest' })
    await expect(progressBar(page)).toHaveAttribute(
      'aria-valuetext',
      'Verificando la descarga… 100 %',
    )
    await expect(progressBar(page)).toHaveAttribute('aria-valuenow', '100')
    await expect(progressBar(page)).toHaveAttribute('aria-valuemin', '0')
    await expect(progressBar(page)).toHaveAttribute('aria-valuemax', '100')
    await expect(progressBar(page)).toHaveAccessibleName(`Descargando ${MODEL}`)

    finish(ollama, pull)
    await expect(progressBar(page)).toBeHidden()
    await expect(downloadGroup(page).getByText(`${MODEL} está instalado.`)).toBeVisible()
    await expect(downloadButton(page)).toBeHidden()
    await expect(aiSection(page).locator('[data-part="ai-live"]')).toHaveText(
      `${MODEL} descargado.`,
    )
    // La lista de modelos se refresca sola y el recién descargado queda elegido.
    const models = aiSection(page).getByRole('combobox', { name: 'Modelo', exact: true })
    await expect(models.getByRole('option', { name: `${MODEL} · 123 B` })).toHaveCount(1)
    await expect(models).toHaveValue(MODEL)

    // Toda la descarga fue contra el servidor falso, con una sola petición a `/api/pull`.
    expect(ollama.requestsTo('/api/pull')).toHaveLength(1)
    expect(app.errors).toEqual([])
  })

  test('cancelar detiene la descarga en el servidor y se puede volver a intentar', async ({
    launchApp,
    ollama,
  }) => {
    withoutModel(ollama)
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await openAiSettings(page)

    const first = await startDownload(page, ollama)
    first.send({ status: 'pulling aaa', total: 100 * MB, completed: 25 * MB })
    await expect(progressBar(page)).toHaveAttribute('aria-valuenow', '25')

    await cancelButton(page).click()
    await expect.poll(() => first.clientClosed).toBe(true)
    await expect(downloadGroup(page).locator('[data-part="cancelled"]')).toHaveText(
      'Descarga cancelada.',
    )
    await expect(progressBar(page)).toBeHidden()
    await expect(aiSection(page).locator('[data-part="ai-live"]')).toHaveText('Descarga cancelada.')
    await expect(downloadButton(page)).toHaveText(`Volver a descargar ${MODEL} (~9 GB)`)
    await expect(downloadButton(page)).toBeFocused()

    const second = await startDownload(page, ollama)
    await expect(downloadGroup(page).locator('[data-part="cancelled"]')).toBeHidden()
    second.send({ status: 'pulling aaa', total: 100 * MB, completed: 10 * MB })
    await expect(progressBar(page)).toHaveAttribute('aria-valuenow', '10')
    finish(ollama, second)
    await expect(downloadGroup(page).getByText(`${MODEL} está instalado.`)).toBeVisible()
    expect(ollama.requestsTo('/api/pull')).toHaveLength(2)
    expect(app.errors).toEqual([])
  })

  test('un error del servidor y una descarga cortada se explican y se pueden reintentar', async ({
    launchApp,
    ollama,
  }) => {
    withoutModel(ollama)
    const app = await launchApp()
    const { page } = app
    await enableAi(app, ollama.url)
    await openAiSettings(page)
    const alert = downloadGroup(page).getByRole('alert')

    const missing = await startDownload(page, ollama)
    missing.send({ error: 'pull model manifest: file does not exist' })
    await expect(alert).toContainText('No se pudo descargar el modelo.')
    await expect(alert).toContainText('Ollama no encuentra ese modelo en su biblioteca.')
    await expect(alert).not.toContainText('file does not exist')
    await expect(progressBar(page)).toBeHidden()
    await expect(downloadButton(page)).toHaveText(`Volver a descargar ${MODEL} (~9 GB)`)
    await expect(downloadButton(page)).toBeFocused()

    const dropped = await startDownload(page, ollama)
    await expect(alert).toBeHidden()
    dropped.send({ status: 'pulling aaa', total: 100 * MB, completed: 10 * MB })
    await expect(progressBar(page)).toHaveAttribute('aria-valuenow', '10')
    dropped.abort()
    await expect(alert).toContainText('No se pudo completar la descarga.')
    await expect(alert).toContainText('Comprueba que Ollama sigue en marcha')
    await expect(progressBar(page)).toBeHidden()
    await expect(downloadGroup(page).getByText(`${MODEL} está instalado.`)).toBeHidden()

    // Una respuesta que termina sin `success` tampoco cuenta como descargada.
    const unfinished = await startDownload(page, ollama)
    await expect(alert).toBeHidden()
    unfinished.send({ status: 'pulling aaa', total: 100 * MB, completed: 50 * MB })
    unfinished.end()
    await expect(alert).toContainText('No se pudo completar la descarga.')
    await expect(downloadGroup(page).getByText(`${MODEL} está instalado.`)).toBeHidden()
    expect(app.errors).toEqual([])
  })
})
