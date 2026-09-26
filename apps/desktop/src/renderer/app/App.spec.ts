import { DEFAULT_PREFERENCES } from '@strata/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeDb, installFakeDb } from '../features/connections/testing/fake-db'
import { usePreferencesStore } from '../features/preferences'
import App from './App.vue'

afterEach(() => {
  Reflect.deleteProperty(window, 'db')
})

describe('App', () => {
  it('renders the Strata title and the connections screen', async () => {
    installFakeDb(createFakeDb().db)
    const wrapper = mount(App, { global: { plugins: [createPinia()] } })
    await flushPromises()

    expect(wrapper.get('h1').text()).toBe('Strata')
    expect(wrapper.get('section').text()).toContain('Conexiones')
    expect(wrapper.text()).toContain('Todavía no hay conexiones')
  })

  it('loads the saved preferences at startup without setting data-theme (main drives the theme)', async () => {
    const fake = createFakeDb({
      preferences: {
        history: { enabled: false, retentionDays: 7 },
        appearance: { theme: 'light' },
        execution: { timeoutSeconds: 45, maxRows: 250, confirmDestructive: false },
        ai: DEFAULT_PREFERENCES.ai,
      },
    })
    installFakeDb(fake.db)
    const pinia = createPinia()
    mount(App, { global: { plugins: [pinia] } })
    await flushPromises()

    const preferences = usePreferencesStore(pinia)
    expect(fake.preferences.get).toHaveBeenCalledTimes(1)
    expect(preferences.status).toBe('ready')
    expect(preferences.theme).toBe('light')
    expect(preferences.timeoutSeconds).toBe(45)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('starts with the defaults and an error state when the preferences cannot be read', async () => {
    const fake = createFakeDb()
    fake.preferences.get.mockRejectedValueOnce(new Error('sender rejected'))
    installFakeDb(fake.db)
    const pinia = createPinia()
    mount(App, { global: { plugins: [pinia] } })
    await flushPromises()

    expect(usePreferencesStore(pinia).status).toBe('error')
    expect(usePreferencesStore(pinia).theme).toBe('system')
  })
})
