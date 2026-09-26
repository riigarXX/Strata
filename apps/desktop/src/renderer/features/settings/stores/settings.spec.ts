import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from './settings'

beforeEach(() => setActivePinia(createPinia()))

describe('settings store', () => {
  it('starts closed and opens on the requested section', () => {
    const settings = useSettingsStore()
    expect(settings.isOpen).toBe(false)

    settings.open('execution')
    expect(settings.isOpen).toBe(true)
    expect(settings.section).toBe('execution')
  })

  it('opens from the beginning when no section is given, forgetting the previous one', () => {
    const settings = useSettingsStore()
    settings.open('history')
    settings.close()
    settings.open()
    expect(settings.isOpen).toBe(true)
    expect(settings.section).toBeNull()
  })
})
