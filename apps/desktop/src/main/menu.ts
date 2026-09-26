import { Menu, type MenuItemConstructorOptions } from 'electron'

export interface MenuOptions {
  appName: string
  isMac: boolean
  /** Ver/recargar solo existe en desarrollo. */
  isDev: boolean
}

// Sin roles `close`/`windowMenu` ni ningún acelerador propio: Cmd+W, Cmd+T, Ctrl+Tab y Cmd+1..9 deben
// llegar al renderer, no al menú nativo (que ataría Cmd+W a «Cerrar ventana»).
export function buildMenuTemplate({
  appName,
  isMac,
  isDev,
}: MenuOptions): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []

  if (isMac) template.push({ label: appName, role: 'appMenu' })

  template.push({ role: 'editMenu' })

  if (isDev) {
    template.push({
      label: 'Ver',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }],
    })
  }

  template.push({
    label: 'Ventana',
    role: 'window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [{ role: 'front' as const }] : []),
    ],
  })

  return template
}

export function installApplicationMenu(options: MenuOptions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(options)))
}
