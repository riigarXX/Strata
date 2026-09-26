// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../local-storage/testing'
import { createPreferencesStore } from './preferences-store'
import { bindNativeThemeSource, type ThemeSourceTarget } from './theme-source'

const FILE_PATH = '/user-data/preferences.json'

function setup() {
  const memory = createMemoryStorage()
  const store = createPreferencesStore({ fileSystem: memory.fileSystem, filePath: FILE_PATH })
  const assignments: string[] = []
  let source: ThemeSourceTarget['themeSource'] = 'system'
  const nativeTheme: ThemeSourceTarget = {
    get themeSource() {
      return source
    },
    set themeSource(value) {
      assignments.push(value)
      source = value
    },
  }
  return { memory, store, nativeTheme, assignments }
}

describe('bindNativeThemeSource', () => {
  it('fija el tema guardado antes de devolver el control (antes de crear la ventana)', async () => {
    const { store, nativeTheme, memory } = setup()
    await store.update({ appearance: { theme: 'dark' } })

    const fresh = createPreferencesStore({ fileSystem: memory.fileSystem, filePath: FILE_PATH })
    await bindNativeThemeSource(fresh, nativeTheme)

    expect(nativeTheme.themeSource).toBe('dark')
  })

  it('con las preferencias por defecto sigue al sistema', async () => {
    const { store, nativeTheme } = setup()
    await bindNativeThemeSource(store, nativeTheme)
    expect(nativeTheme.themeSource).toBe('system')
  })

  it('cambia la fuente en cada actualización que cambia el tema y solo entonces', async () => {
    const { store, nativeTheme, assignments } = setup()
    await bindNativeThemeSource(store, nativeTheme)
    assignments.length = 0

    await store.update({ appearance: { theme: 'light' } })
    expect(nativeTheme.themeSource).toBe('light')

    await store.update({ execution: { maxRows: 500 } })
    await store.update({ appearance: { theme: 'light' } })
    expect(assignments).toEqual(['light'])

    await store.update({ appearance: { theme: 'system' } })
    expect(nativeTheme.themeSource).toBe('system')
  })

  it('no toca la fuente si la escritura falla: el tema no se ha guardado', async () => {
    const { store, nativeTheme, memory } = setup()
    await bindNativeThemeSource(store, nativeTheme)
    memory.hooks.failWrite = true

    await expect(store.update({ appearance: { theme: 'dark' } })).rejects.toThrow()

    expect(nativeTheme.themeSource).toBe('system')
  })

  it('si las preferencias no se pueden leer arranca siguiendo al sistema', async () => {
    const { store, nativeTheme, memory } = setup()
    memory.hooks.failRead = true

    await expect(bindNativeThemeSource(store, nativeTheme)).resolves.toBeTypeOf('function')

    expect(nativeTheme.themeSource).toBe('system')
  })

  it('devuelve la función que la desengancha', async () => {
    const { store, nativeTheme } = setup()
    const unbind = await bindNativeThemeSource(store, nativeTheme)
    unbind()

    await store.update({ appearance: { theme: 'dark' } })

    expect(nativeTheme.themeSource).toBe('system')
  })
})
