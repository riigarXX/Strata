import { realpath } from 'node:fs/promises'
import { expect, test } from './support/strata-app'

test('arranca la app con su ventana principal, sin errores de consola', async ({
  launchApp,
  userDataDir,
}) => {
  const app = await launchApp()
  const { page, electronApp } = app

  await expect(page).toHaveTitle('Strata')
  await expect(page.getByRole('heading', { name: 'Strata', level: 1 })).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Barra lateral' })).toBeVisible()
  await expect(page.getByRole('contentinfo', { name: 'Barra de estado' })).toContainText(
    'Sin conexión',
  )

  // Playwright se engancha cuando la ventana ya existe: recargar hace que el arranque completo, con la
  // CSP y la carga del preload, ocurra con los listeners de consola puestos.
  await page.reload()
  await expect(page.getByRole('contentinfo', { name: 'Barra de estado' })).toContainText(
    'Sin conexión',
  )

  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      title: window.getTitle(),
      visible: window.isVisible(),
    })),
  )
  expect(windows).toEqual([{ title: 'Strata', visible: true }])

  // El aislamiento: la app usa la carpeta temporal del test y no ~/Library/Application Support/Strata.
  const userData = await electronApp.evaluate(({ app: electronMain }) =>
    electronMain.getPath('userData'),
  )
  expect(await realpath(userData)).toBe(await realpath(userDataDir))

  expect(app.errors).toEqual([])
})

test('la ventana tiene un tamaño mínimo y no se puede encoger por debajo', async ({
  launchApp,
}) => {
  const app = await launchApp()
  const { electronApp } = app

  const [minWidth, minHeight] = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getMinimumSize(),
  )
  expect(minWidth).toBe(720)
  expect(minHeight).toBe(560)

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setSize(300, 200)
  })
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize()),
    )
    .toEqual([minWidth, minHeight])

  expect(app.errors).toEqual([])
})
