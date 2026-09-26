import type { Locator, Page } from '@playwright/test'
import { expect, stubOpenDialog, type StrataApp } from './strata-app'

/** Atajo «Mod»: Cmd en macOS. */
export const MOD = 'ControlOrMeta'

export const editorOf = (page: Page, tabName: string): Locator =>
  page.getByRole('textbox', { name: `Editor SQL de ${tabName}` })

export const resultsGrid = (page: Page): Locator =>
  page.getByRole('grid', { name: 'Resultados de la consulta' })

export const executionStatus = (page: Page): Locator =>
  page.locator('[data-part="execution-indicator"]')

export const historyDialog = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Historial de consultas' })

export const settingsDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Ajustes' })

export const palette = (page: Page): Locator =>
  page.getByRole('dialog', { name: /^Paleta de comandos$/ })

export const toolbar = (page: Page): Locator => page.locator('[data-region="execution-toolbar"]')

/** Botón de la barra de ejecución; `exact` porque «Ejecutar» es también prefijo de «Ejecutar todo». */
export const toolbarButton = (page: Page, name: string): Locator =>
  toolbar(page).getByRole('button', { name, exact: true })

/** Chip de la barra de ejecución: el texto «Transacción activa» también está en la barra de estado. */
export const transactionChip = (page: Page): Locator =>
  toolbar(page).locator('[data-part="transaction-state"]')

export const statusBarTransaction = (page: Page): Locator =>
  page.getByRole('contentinfo', { name: 'Barra de estado' }).locator('[data-segment="transaction"]')

export const statusBarAccess = (page: Page): Locator =>
  page.getByRole('contentinfo', { name: 'Barra de estado' }).locator('[data-segment="access"]')

export const destructiveDialog = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Confirmar operación destructiva' })

export const messagesLog = (page: Page): Locator =>
  page.getByRole('log', { name: 'Mensajes de ejecución' })

/** Abre la pestaña «Mensajes» del panel de resultados (el log solo es visible con ella activa). */
export async function openMessages(page: Page): Promise<Locator> {
  await page.getByRole('tab', { name: /^Mensajes/ }).click()
  const log = messagesLog(page)
  await expect(log).toBeVisible()
  return log
}

/** Crea un perfil SQLite desde «Gestionar conexiones», eligiendo el archivo con el selector nativo sustituido. */
export async function createSqliteProfile(
  app: StrataApp,
  { name, file, readOnly = false }: { name: string; file: string; readOnly?: boolean },
): Promise<void> {
  const { page } = app
  await stubOpenDialog(app, file)

  await page.getByRole('button', { name: 'Gestionar conexiones' }).click()
  const manager = page.getByRole('dialog', { name: 'Gestionar conexiones' })
  await manager.getByRole('button', { name: 'Nueva conexión' }).click()

  const form = page.getByRole('dialog', { name: 'Nueva conexión' })
  await form.getByLabel('Nombre', { exact: true }).fill(name)
  await form.getByLabel('Motor', { exact: true }).selectOption('sqlite')
  await form.getByRole('button', { name: 'Elegir archivo…' }).click()
  await expect(form.getByLabel('Archivo SQLite', { exact: true })).toHaveValue(file)
  if (readOnly) await form.getByRole('checkbox', { name: 'Solo lectura' }).check()
  await form.getByRole('button', { name: 'Crear conexión' }).click()

  await expect(form).toBeHidden()
  await expect(
    manager.getByRole('list', { name: 'Conexiones guardadas' }).getByRole('listitem'),
  ).toContainText(name)
  await manager.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await expect(manager).toBeHidden()
}

export interface PostgresProfileInput {
  name: string
  host: string
  port: number
  user: string
  database: string
  /** Sin contraseña salvo que el servidor la exija: guardarla con el CredentialStore real dispara un diálogo de Keychain. */
  password?: string | null
  readOnly?: boolean
}

/** Crea un perfil PostgreSQL desde «Gestionar conexiones» rellenando el formulario (SSL queda en «Desactivado», su valor por defecto). */
export async function createPostgresProfile(
  page: Page,
  { name, host, port, user, database, password = null, readOnly = false }: PostgresProfileInput,
): Promise<void> {
  await page.getByRole('button', { name: 'Gestionar conexiones' }).click()
  const manager = page.getByRole('dialog', { name: 'Gestionar conexiones' })
  await manager.getByRole('button', { name: 'Nueva conexión' }).click()

  const form = page.getByRole('dialog', { name: 'Nueva conexión' })
  await form.getByLabel('Nombre', { exact: true }).fill(name)
  await form.getByLabel('Motor', { exact: true }).selectOption('postgres')
  await form.getByLabel('Host', { exact: true }).fill(host)
  await form.getByLabel('Puerto', { exact: true }).fill(String(port))
  await form.getByLabel('Usuario', { exact: true }).fill(user)
  await form.getByLabel('Base de datos', { exact: true }).fill(database)
  if (password !== null) await form.getByLabel('Contraseña', { exact: true }).fill(password)
  if (readOnly) await form.getByRole('checkbox', { name: 'Solo lectura' }).check()
  await form.getByRole('button', { name: 'Crear conexión' }).click()

  await expect(form).toBeHidden()
  await expect(
    manager.getByRole('list', { name: 'Conexiones guardadas' }).getByRole('listitem'),
  ).toContainText(name)
  await manager.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await expect(manager).toBeHidden()
}

export async function connectProfile(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `Conectar ${name}` }).click()
  await expect(page.getByRole('button', { name: `Desconectar ${name}` })).toBeVisible()
}

export async function openQueryTab(page: Page, tabName: string): Promise<void> {
  await page.getByRole('button', { name: 'Nueva pestaña SQL' }).click()
  await expect(page.getByRole('tab', { name: tabName, selected: true })).toBeVisible()
}

/** Escribe el SQL y lo lanza con el atajo (`Mod+Enter` o, con `all`, `Mod+Shift+Enter`) sin esperar al final: para las ejecuciones que piden confirmación o se cancelan. */
export async function submitSql(
  page: Page,
  tabName: string,
  sql: string,
  { all = false }: { all?: boolean } = {},
): Promise<void> {
  const editor = editorOf(page, tabName)
  await editor.fill(sql)
  // Cada línea del editor es un elemento propio: el texto que ve el locator no lleva los saltos de línea.
  await expect(editor).toContainText(sql.replaceAll('\n', ''))
  await page.keyboard.press(all ? `${MOD}+Shift+Enter` : `${MOD}+Enter`)
}

/** Escribe el SQL en el editor de la pestaña y lo ejecuta con Mod+Enter; espera al final de la ejecución. */
export async function runSql(page: Page, tabName: string, sql: string): Promise<void> {
  await submitSql(page, tabName, sql)
  await expect(executionStatus(page)).toHaveAttribute('data-state', /^(done|error)$/)
}

/** Conexión completa: perfil nuevo, conectado y con una pestaña vacía lista para escribir. */
export async function connectFixture(
  app: StrataApp,
  file: string,
  { name = 'Fixture' }: { name?: string } = {},
): Promise<void> {
  await createSqliteProfile(app, { name, file })
  await connectProfile(app.page, name)
  await openQueryTab(app.page, 'Consulta 1')
}

/** WCAG 2.5.8 (Target Size Minimum, AA): el área clicable de un control mide al menos 24×24 px. */
const MIN_TARGET = 24

export async function expectTargetSize(target: Locator, label: string): Promise<void> {
  const box = (await target.boundingBox())!
  expect(box.width, `ancho de ${label}`).toBeGreaterThanOrEqual(MIN_TARGET)
  expect(box.height, `alto de ${label}`).toBeGreaterThanOrEqual(MIN_TARGET)
}

/** Fija el tamaño del área de contenido de la ventana y espera a que el renderer lo refleje. */
export async function resizeWindow(app: StrataApp, width: number, height = 720): Promise<void> {
  await app.electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
    },
    { width, height },
  )
  await expect.poll(() => app.page.evaluate(() => window.innerWidth)).toBe(width)
}
