import { DEFAULT_PREFERENCES, type NormalizedError, type Preferences } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcFail, ipcOk } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { usePreferencesStore } from '../../preferences'
import { useSettingsStore, type SettingsSection } from '../stores/settings'
import SettingsDialog from './SettingsDialog.vue'

const STORAGE_ERROR: NormalizedError = {
  code: 'internal_error',
  message: 'Could not access the saved preferences',
  retryable: true,
}

let wrapper: VueWrapper | undefined
let pinia: Pinia
let fake: ReturnType<typeof createFakeDb>
let opener: HTMLButtonElement

interface SetupOptions {
  preferences?: Preferences
  load?: boolean
}

async function setup({ preferences, load = true }: SetupOptions = {}) {
  fake = createFakeDb(preferences ? { preferences } : {})
  installFakeDb(fake.db)
  pinia = createPinia()
  opener = document.createElement('button')
  opener.textContent = 'Abrir'
  document.body.append(opener)
  wrapper = mount(SettingsDialog, { global: { plugins: [pinia] }, attachTo: document.body })
  if (load) await usePreferencesStore(pinia).load()
  await flushPromises()
  return { wrapper, settings: useSettingsStore(pinia), preferences: usePreferencesStore(pinia) }
}

async function open(section: SettingsSection | null = null) {
  opener.focus()
  useSettingsStore(pinia).open(section)
  await flushPromises()
}

const dialog = () => wrapper!.get<HTMLDialogElement>('[data-dialog="settings"]')
const isOpen = () => dialog().element.open
const field = (name: string) => dialog().get<HTMLInputElement>(`[name="${name}"]`)
const radio = (value: string) => dialog().get<HTMLInputElement>(`[name="theme"][value="${value}"]`)
const status = () => dialog().get('[data-part="settings-status"]')
const clearDialog = () => wrapper!.get<HTMLDialogElement>('[data-dialog="clear-history"]')

async function commit(name: string, value: string) {
  await field(name).setValue(value)
  await field(name).trigger('change')
  await flushPromises()
}

beforeEach(() => {
  Reflect.deleteProperty(window, 'confirm')
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'db')
  vi.restoreAllMocks()
})

describe('structure and accessibility', () => {
  it('is a closed modal dialog until opened, labelled by its title and described', async () => {
    await setup()
    expect(isOpen()).toBe(false)

    await open()
    expect(isOpen()).toBe(true)
    const title = dialog().get('h2')
    expect(title.text()).toBe('Ajustes')
    expect(dialog().attributes('aria-labelledby')).toBe(title.attributes('id'))
    expect(document.getElementById(dialog().attributes('aria-describedby')!)).not.toBeNull()
  })

  it('has the four sections, each labelled by its own heading', async () => {
    await setup()
    await open()
    const sections = dialog().findAll('section')
    expect(sections.map((section) => section.attributes('data-section'))).toEqual([
      'appearance',
      'execution',
      'history',
      'ai',
    ])
    expect(sections.map((section) => section.get('h3').text())).toEqual([
      'Apariencia',
      'Ejecución',
      'Historial',
      'IA local',
    ])
    for (const section of sections) {
      expect(section.attributes('aria-labelledby')).toBe(section.get('h3').attributes('id'))
    }
  })

  it('labels every control and points each one to its help text', async () => {
    await setup()
    await open()
    const controls = dialog().findAll<HTMLInputElement>('input:not([type="radio"]), select')
    expect(controls.map((control) => control.attributes('name'))).toEqual([
      'timeoutSeconds',
      'maxRows',
      'confirmDestructive',
      'historyEnabled',
      'historyRetentionDays',
      'aiEnabled',
      'aiProvider',
      'aiBaseUrl',
      'aiModel',
    ])
    for (const control of controls) {
      expect(control.element.labels?.length, control.attributes('name')).toBeGreaterThan(0)
      const help = control.attributes('aria-describedby')!
      expect(help, control.attributes('name')).toBeTruthy()
      for (const id of help.split(' ')) expect(document.getElementById(id)).not.toBeNull()
    }
  })

  it('has a polite status region that is always present', async () => {
    await setup()
    await open()
    expect(status().attributes('role')).toBe('status')
    expect(status().attributes('aria-live')).toBe('polite')
    expect(status().text()).toBe('')
  })
})

describe('keyboard and focus', () => {
  it.each([
    [null, 'input[name="theme"]:checked'],
    ['appearance', 'input[name="theme"]:checked'],
    ['execution', 'input[name="timeoutSeconds"]'],
    ['history', 'input[name="historyEnabled"]'],
    ['ai', 'input[name="aiEnabled"]'],
  ] as const)('opening on %s puts the focus on its first control', async (section, selector) => {
    await setup()
    await open(section)
    expect(document.activeElement).toBe(dialog().get(selector).element)
  })

  it('follows the saved theme when focusing the first control', async () => {
    await setup({
      preferences: {
        history: { enabled: true, retentionDays: 30 },
        appearance: { theme: 'light' },
        execution: { timeoutSeconds: 30, maxRows: 10_000, confirmDestructive: true },
        ai: DEFAULT_PREFERENCES.ai,
      },
    })
    await open()
    expect(document.activeElement).toBe(radio('light').element)
  })

  it('Escape (cancel) closes it and gives the focus back to what opened it', async () => {
    await setup()
    await open('execution')

    await dialog().trigger('cancel')
    await flushPromises()

    expect(isOpen()).toBe(false)
    expect(useSettingsStore(pinia).isOpen).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('the Close button closes it and returns the focus', async () => {
    await setup()
    await open()
    await dialog().get('[data-action="close-settings"]').trigger('click')
    await flushPromises()
    expect(isOpen()).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('reopening starts clean: no leftover feedback, errors or drafts', async () => {
    const { preferences } = await setup()
    await open('execution')
    await preferences.setTheme('dark')
    await flushPromises()
    expect(status().text()).toBe('Guardado')
    await commit('maxRows', '0')
    expect(status().text()).toBe('')

    await dialog().trigger('cancel')
    await flushPromises()
    await open('execution')

    expect(status().text()).toBe('')
    expect(field('maxRows').element.value).toBe('10000')
    expect(dialog().findAll('.form-field__error')).toHaveLength(0)
  })
})

describe('appearance', () => {
  it('is a radio group with a legend: System, Dark, Light', async () => {
    await setup()
    await open()
    const group = dialog().get('fieldset')
    expect(group.get('legend').text()).toBe('Tema')
    const radios = group.findAll<HTMLInputElement>('input[type="radio"]')
    expect(radios.map((entry) => entry.attributes('value'))).toEqual(['system', 'dark', 'light'])
    expect(new Set(radios.map((entry) => entry.attributes('name'))).size).toBe(1)
    expect(group.findAll('label').map((label) => label.text())).toEqual([
      'Sistema',
      'Oscuro',
      'Claro',
    ])
    expect(radios.map((entry) => entry.element.checked)).toEqual([true, false, false])
  })

  it('choosing a theme saves it in main and says so', async () => {
    const { preferences } = await setup()
    await open()

    await radio('dark').setValue()
    await flushPromises()

    expect(fake.preferences.update).toHaveBeenCalledWith({ appearance: { theme: 'dark' } })
    expect(fake.storedPreferences().appearance.theme).toBe('dark')
    expect(preferences.theme).toBe('dark')
    expect(radio('dark').element.checked).toBe(true)
    expect(status().text()).toBe('Guardado')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('reflects a theme changed elsewhere (\\theme, the palette)', async () => {
    const { preferences } = await setup()
    await open()
    await preferences.setTheme('light')
    await flushPromises()
    expect(radio('light').element.checked).toBe(true)
    expect(radio('system').element.checked).toBe(false)
  })

  it('goes back to the previous theme and shows the error when it cannot be saved', async () => {
    await setup()
    await open()
    fake.preferences.update.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    await radio('dark').setValue()
    await flushPromises()

    expect(radio('system').element.checked).toBe(true)
    expect(radio('dark').element.checked).toBe(false)
    const problem = dialog().get('[data-part="settings-problem"]')
    expect(problem.attributes('role')).toBe('alert')
    expect(problem.text()).toContain('No se pudo guardar el cambio')
    expect(status().text()).not.toBe('Guardado')
  })
})

describe('execution', () => {
  it('shows the saved values', async () => {
    await setup({
      preferences: {
        history: { enabled: true, retentionDays: 30 },
        appearance: { theme: 'system' },
        execution: { timeoutSeconds: 45, maxRows: 2_500, confirmDestructive: false },
        ai: DEFAULT_PREFERENCES.ai,
      },
    })
    await open()
    expect(field('timeoutSeconds').element.value).toBe('45')
    expect(field('maxRows').element.value).toBe('2500')
    expect(field('confirmDestructive').element.checked).toBe(false)
  })

  it('saves a valid value when the field is committed', async () => {
    await setup()
    await open('execution')
    await commit('timeoutSeconds', '60')
    expect(fake.preferences.update).toHaveBeenCalledWith({ execution: { timeoutSeconds: 60 } })
    expect(status().text()).toBe('Guardado')

    await commit('maxRows', '100000')
    expect(fake.storedPreferences().execution).toMatchObject({
      timeoutSeconds: 60,
      maxRows: 100_000,
    })
  })

  it('Enter commits the field without submitting anything', async () => {
    await setup()
    await open('execution')
    await field('maxRows').setValue('321')
    await field('maxRows').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(fake.storedPreferences().execution.maxRows).toBe(321)
  })

  it.each([
    ['timeoutSeconds', '0'],
    ['timeoutSeconds', '301'],
    ['timeoutSeconds', '30.5'],
    ['timeoutSeconds', ''],
    ['maxRows', '100001'],
    ['maxRows', '-1'],
    ['maxRows', 'abc'],
  ])('rejects %s = %j with an error on that field and saves nothing', async (name, value) => {
    await setup()
    await open('execution')
    await commit(name, value)

    const input = field(name)
    expect(input.attributes('aria-invalid')).toBe('true')
    const error = dialog().get(`#${input.attributes('aria-describedby')!.split(' ').at(-1)}`)
    expect(error.classes()).toContain('form-field__error')
    expect(error.text()).toContain('número entero entre')
    expect(fake.preferences.update).not.toHaveBeenCalled()
    expect(dialog().get('[data-part="settings-problem"]').attributes('role')).toBe('alert')
  })

  it('clears the error as soon as the text is valid again and saves on commit', async () => {
    await setup()
    await open('execution')
    await commit('timeoutSeconds', '0')
    expect(field('timeoutSeconds').attributes('aria-invalid')).toBe('true')

    await field('timeoutSeconds').setValue('90')
    expect(field('timeoutSeconds').attributes('aria-invalid')).toBeUndefined()
    await field('timeoutSeconds').trigger('change')
    await flushPromises()

    expect(fake.storedPreferences().execution.timeoutSeconds).toBe(90)
    expect(dialog().find('[data-part="settings-problem"]').exists()).toBe(false)
  })

  it('does not call main when the value did not change', async () => {
    await setup()
    await open('execution')
    await commit('timeoutSeconds', '30')
    expect(fake.preferences.update).not.toHaveBeenCalled()
  })

  it('puts the previous value back when saving fails', async () => {
    await setup()
    await open('execution')
    fake.preferences.update.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))

    await commit('maxRows', '500')

    expect(field('maxRows').element.value).toBe('10000')
    expect(dialog().get('[data-part="settings-problem"]').text()).toContain(
      'Could not access the saved preferences',
    )
  })

  it('toggles the destructive confirmation', async () => {
    const { preferences } = await setup()
    await open('execution')
    await field('confirmDestructive').setValue(false)
    await flushPromises()
    expect(preferences.confirmDestructive).toBe(false)
    expect(fake.storedPreferences().execution.confirmDestructive).toBe(false)
    expect(status().text()).toBe('Guardado')
  })
})

describe('history', () => {
  it('turns saving the history on or off', async () => {
    const { preferences } = await setup()
    await open('history')
    expect(field('historyEnabled').element.checked).toBe(true)

    await field('historyEnabled').setValue(false)
    await flushPromises()

    expect(fake.preferences.update).toHaveBeenCalledWith({ history: { enabled: false } })
    expect(preferences.historyEnabled).toBe(false)
  })

  it('offers 7, 30, 90 days or no limit, with 30 selected by default', async () => {
    await setup()
    await open('history')
    const select = dialog().get<HTMLSelectElement>('select[name="historyRetentionDays"]')
    expect(select.findAll('option').map((option) => option.text())).toEqual([
      '7 días',
      '30 días',
      '90 días',
      'Sin límite',
    ])
    expect(select.element.value).toBe('30')
  })

  it('saves the retention, including no limit (null), and warns about it', async () => {
    await setup()
    await open('history')
    const select = dialog().get<HTMLSelectElement>('select[name="historyRetentionDays"]')

    await select.setValue('7')
    await flushPromises()
    expect(fake.preferences.update).toHaveBeenLastCalledWith({ history: { retentionDays: 7 } })

    await select.setValue('unlimited')
    await flushPromises()
    expect(fake.preferences.update).toHaveBeenLastCalledWith({ history: { retentionDays: null } })
    expect(fake.storedPreferences().history.retentionDays).toBeNull()
    expect(dialog().text()).toContain('no caduca nunca')
  })

  describe('clearing the history', () => {
    it('asks for its own confirmation, warns that it is irreversible and never uses window.confirm', async () => {
      await setup()
      const confirm = vi.fn(() => true)
      Object.defineProperty(window, 'confirm', { value: confirm, configurable: true })
      await open('history')

      await dialog().get('[data-action="clear-history"]').trigger('click')
      await flushPromises()

      expect(clearDialog().element.open).toBe(true)
      expect(clearDialog().text()).toContain('irreversible')
      expect(clearDialog().attributes('aria-labelledby')).toBeTruthy()
      expect(fake.history.clear).not.toHaveBeenCalled()
      expect(confirm).not.toHaveBeenCalled()
      expect(
        clearDialog().get('[data-action="cancel-clear-history"]').attributes('autofocus'),
      ).toBeDefined()
    })

    it('cancelling clears nothing and returns the focus to the button', async () => {
      await setup()
      await open('history')
      const trigger = dialog().get<HTMLButtonElement>('[data-action="clear-history"]')
      trigger.element.focus()
      await trigger.trigger('click')
      await flushPromises()

      await clearDialog().get('[data-action="cancel-clear-history"]').trigger('click')
      await flushPromises()

      expect(clearDialog().element.open).toBe(false)
      expect(isOpen()).toBe(true)
      expect(fake.history.clear).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(trigger.element)
    })

    it('Escape only closes the confirmation, not the settings', async () => {
      await setup()
      await open('history')
      await dialog().get('[data-action="clear-history"]').trigger('click')
      await flushPromises()

      // El evento nativo `cancel` no burbujea: solo lo recibe el diálogo de arriba.
      clearDialog().element.dispatchEvent(new Event('cancel', { cancelable: true }))
      await flushPromises()

      expect(clearDialog().element.open).toBe(false)
      expect(isOpen()).toBe(true)
    })

    it('confirming clears the history and announces how many entries were removed', async () => {
      await setup()
      fake.history.clear.mockResolvedValueOnce(ipcOk({ deleted: 3 }))
      await open('history')
      await dialog().get('[data-action="clear-history"]').trigger('click')
      await flushPromises()

      await clearDialog().get('[data-action="confirm-clear-history"]').trigger('click')
      await flushPromises()

      expect(fake.history.clear).toHaveBeenCalledTimes(1)
      expect(clearDialog().element.open).toBe(false)
      expect(status().text()).toBe('Historial vaciado: 3 consultas eliminadas')
    })

    it('says so when there was nothing to clear', async () => {
      await setup()
      await open('history')
      await dialog().get('[data-action="clear-history"]').trigger('click')
      await flushPromises()
      await clearDialog().get('[data-action="confirm-clear-history"]').trigger('click')
      await flushPromises()
      expect(status().text()).toBe('El historial ya estaba vacío')
    })

    it('keeps the confirmation open with an alert when clearing fails', async () => {
      await setup()
      fake.history.clear.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))
      await open('history')
      await dialog().get('[data-action="clear-history"]').trigger('click')
      await flushPromises()

      await clearDialog().get('[data-action="confirm-clear-history"]').trigger('click')
      await flushPromises()

      expect(clearDialog().element.open).toBe(true)
      const alert = clearDialog().get('[data-part="clear-error"]')
      expect(alert.attributes('role')).toBe('alert')
      expect(alert.text()).toContain('No se pudo vaciar el historial')
    })
  })
})

describe('loading', () => {
  it('offers a retry when the saved settings could not be read', async () => {
    await setup({ load: false })
    fake.preferences.get.mockResolvedValueOnce(ipcFail(STORAGE_ERROR))
    const preferences = usePreferencesStore(pinia)
    await preferences.load()
    await open()

    const error = dialog().get('[data-part="load-error"]')
    expect(error.attributes('role')).toBe('alert')

    await dialog().get('[data-action="retry-load"]').trigger('click')
    await flushPromises()

    expect(preferences.status).toBe('ready')
    expect(dialog().find('[data-part="load-error"]').exists()).toBe(false)
  })
})
