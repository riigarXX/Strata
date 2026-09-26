import type { Locator, Page } from '@playwright/test'
import { expect, type StrataApp } from './strata-app'
import { MOD } from './ui'

export const askDialog = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Preguntar a la base' })

export const questionBox = (page: Page): Locator =>
  askDialog(page).getByRole('textbox', { name: 'Tu pregunta' })

export const sqlTabs = (page: Page): Locator =>
  page.getByRole('tablist', { name: 'Pestañas SQL' }).getByRole('tab')

/** Resultado del panel una vez generada la consulta (`data-state="ready"`). */
export const askResult = (page: Page): Locator => askDialog(page).locator('[data-state="ready"]')

/** Mensaje de error del panel (`data-state="error"`). */
export const askError = (page: Page): Locator => askDialog(page).locator('[data-state="error"]')

/** Activa el asistente en main apuntando al servidor dado y recarga la ventana: el renderer lee las preferencias solo al arrancar. */
export async function enableAi(app: StrataApp, baseUrl: string): Promise<void> {
  await app.page.evaluate(
    `window.db.preferences.update({ ai: { enabled: true, baseUrl: ${JSON.stringify(baseUrl)} } })`,
  )
  await app.page.reload()
}

/** Abre el panel con el atajo, escribe la pregunta y la envía con `Mod+Enter`. */
export async function ask(page: Page, question: string): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+A`)
  await expect(askDialog(page)).toBeVisible()
  await expect(questionBox(page)).toBeFocused()
  await questionBox(page).fill(question)
  await page.keyboard.press(`${MOD}+Enter`)
}
