import type { Page } from '@playwright/test'
import { expect, readUserDataFile, test, type StrataApp } from './support/strata-app'
import { MOD, settingsDialog } from './support/ui'

const themeSource = (app: StrataApp): Promise<string> =>
  app.electronApp.evaluate(({ nativeTheme }) => nativeTheme.themeSource)

// Playwright emula `prefers-color-scheme: light` por defecto; sin quitar la emulación el tema real de la app no se ve.
const prefersDark = async (page: Page): Promise<boolean> => {
  await page.emulateMedia({ colorScheme: null })
  return page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
}

test('el tema elegido en Ajustes se aplica y persiste al reabrir con el mismo userData', async ({
  launchApp,
  userDataDir,
}) => {
  const first = await launchApp()
  await first.page.keyboard.press(`${MOD}+,`)
  const dialog = settingsDialog(first.page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('radio', { name: 'Sistema' })).toBeChecked()
  expect(await themeSource(first)).toBe('system')

  await dialog.getByRole('radio', { name: 'Oscuro' }).check()
  await expect(dialog.getByRole('radio', { name: 'Oscuro' })).toBeChecked()
  await expect.poll(() => themeSource(first)).toBe('dark')
  await expect.poll(() => prefersDark(first.page)).toBe(true)
  await expect
    .poll(async () => (await readUserDataFile(userDataDir, 'preferences.json')) as unknown)
    .toMatchObject({ preferences: { appearance: { theme: 'dark' } } })
  expect(first.errors).toEqual([])
  await first.close()

  const second = await launchApp({ userDataDir })
  expect(await themeSource(second)).toBe('dark')
  expect(await prefersDark(second.page)).toBe(true)
  await second.page.keyboard.press(`${MOD}+,`)
  const reopened = settingsDialog(second.page)
  await expect(reopened.getByRole('radio', { name: 'Oscuro' })).toBeChecked()
  await expect(reopened.getByRole('radio', { name: 'Sistema' })).not.toBeChecked()
  expect(second.errors).toEqual([])
})

test('un userData nuevo arranca con las preferencias por defecto, aislado de otros tests', async ({
  launchApp,
}) => {
  const app = await launchApp()
  expect(await themeSource(app)).toBe('system')
  await app.page.keyboard.press(`${MOD}+,`)
  await expect(settingsDialog(app.page).getByRole('radio', { name: 'Sistema' })).toBeChecked()
  await expect(
    settingsDialog(app.page).getByRole('checkbox', { name: 'Guardar el historial de consultas' }),
  ).toBeChecked()
})
