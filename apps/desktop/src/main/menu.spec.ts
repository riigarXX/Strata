import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { buildMenuTemplate } from './menu'

const base = { appName: 'Strata', isMac: true, isDev: false }

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ])
}

// Roles con acelerador propio que chocan con los atajos del workspace o los globales previstos.
const COLLIDING_ROLES = [
  'close',
  'closeWindow',
  'windowMenu',
  'fileMenu',
  'viewMenu',
  'zoomIn',
  'zoomOut',
]

describe('buildMenuTemplate', () => {
  it('has the app, edit and window menus on macOS', () => {
    const roles = buildMenuTemplate(base).map((item) => item.role)
    expect(roles).toEqual(['appMenu', 'editMenu', 'window'])
  })

  it('omits the app menu outside macOS', () => {
    expect(buildMenuTemplate({ ...base, isMac: false }).map((item) => item.role)).toEqual([
      'editMenu',
      'window',
    ])
  })

  it('adds view/reload only in development', () => {
    const labels = (isDev: boolean) =>
      buildMenuTemplate({ ...base, isDev }).map((item) => item.label)
    expect(labels(false)).not.toContain('Ver')
    expect(labels(true)).toContain('Ver')
    const view = buildMenuTemplate({ ...base, isDev: true }).find((item) => item.label === 'Ver')
    expect((view?.submenu as MenuItemConstructorOptions[]).map((item) => item.role)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
    ])
  })

  it.each([true, false])(
    'never binds Cmd+W, Cmd+T, Ctrl+Tab, Cmd+1..9 or K/P/L (dev=%s)',
    (isDev) => {
      const items = flatten(buildMenuTemplate({ ...base, isDev }))
      expect(
        items.map((item) => item.role).filter((role) => COLLIDING_ROLES.includes(role ?? '')),
      ).toEqual([])
      expect(items.filter((item) => item.accelerator !== undefined)).toEqual([])
    },
  )
})
