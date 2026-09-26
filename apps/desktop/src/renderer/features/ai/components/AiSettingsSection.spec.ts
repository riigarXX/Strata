import { DEFAULT_PREFERENCES, type Preferences } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, type Pinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcFail } from '../../../../shared/ipc-result'
import { createFakeDb, installFakeDb } from '../../connections/testing/fake-db'
import { usePreferencesStore } from '../../preferences'
import SettingsDialog from '../../settings/components/SettingsDialog.vue'
import { useSettingsStore } from '../../settings/stores/settings'
import { EMBEDDINGS, PULL_FAILED_ERROR, QWEN, stubAi, type FakeAiOptions } from '../testing/fake-ai'
import { useAiStore } from '../stores/ai'

let wrapper: VueWrapper | undefined
let pinia: Pinia
let fake: ReturnType<typeof createFakeDb>
let backend: ReturnType<typeof stubAi>
let opener: HTMLButtonElement

const enabled = (overrides: Partial<Preferences['ai']> = {}): Preferences => ({
  ...DEFAULT_PREFERENCES,
  ai: { ...DEFAULT_PREFERENCES.ai, enabled: true, ...overrides },
})

interface SetupOptions {
  preferences?: Preferences
  ai?: FakeAiOptions
}

async function setup({ preferences, ai }: SetupOptions = {}) {
  fake = createFakeDb(preferences ? { preferences } : {})
  installFakeDb(fake.db)
  backend = stubAi(fake, ai)
  pinia = createPinia()
  opener = document.createElement('button')
  opener.textContent = 'Abrir'
  document.body.append(opener)
  wrapper = mount(SettingsDialog, { global: { plugins: [pinia] }, attachTo: document.body })
  await usePreferencesStore(pinia).load()
  await flushPromises()
}

async function open(section: 'ai' | null = 'ai') {
  opener.focus()
  useSettingsStore(pinia).open(section)
  await flushPromises()
}

async function close() {
  useSettingsStore(pinia).close()
  await flushPromises()
}

const dialog = () => wrapper!.get<HTMLDialogElement>('[data-dialog="settings"]')
const section = () => dialog().get('[data-section="ai"]')
const part = (name: string) => section().get(`[data-part="${name}"]`)
const has = (name: string) => section().find(`[data-part="${name}"]`).exists()
const action = (name: string) => section().get<HTMLButtonElement>(`[data-action="${name}"]`)
const hasAction = (name: string) => section().find(`[data-action="${name}"]`).exists()
const control = (name: string) =>
  section().get<HTMLInputElement & HTMLSelectElement>(`[name="${name}"]`)
const status = () => dialog().get('[data-part="settings-status"]')
const progressbar = () => section().get('[role="progressbar"]')
const saved = () => fake.storedPreferences().ai

// Un clic real deja el foco en el botón (y `trigger('click')` no): así se prueba lo que ve el usuario.
async function press(name: string) {
  action(name).element.focus()
  await action(name).trigger('click')
}

async function toggle(on: boolean) {
  await control('aiEnabled').setValue(on)
  await flushPromises()
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'db')
  vi.restoreAllMocks()
})

describe('structure and accessibility', () => {
  it('adds a section «IA local» labelled by its own heading, after the history', async () => {
    await setup()
    await open(null)
    const sections = dialog().findAll('section')
    expect(sections.map((item) => item.attributes('data-section'))).toEqual([
      'appearance',
      'execution',
      'history',
      'ai',
    ])
    expect(section().get('h3').text()).toBe('IA local')
    expect(section().attributes('aria-labelledby')).toBe(section().get('h3').attributes('id'))
  })

  it('is off by default and explains in one sentence what leaves for the model', async () => {
    await setup()
    await open()
    const switcher = control('aiEnabled')
    expect(switcher.attributes('role')).toBe('switch')
    expect(switcher.element.checked).toBe(false)
    expect(switcher.element.labels?.[0]?.textContent).toContain('Activar el asistente de IA local')
    const help = document.getElementById(switcher.attributes('aria-describedby')!)!.textContent!
    expect(help).toMatch(/esquema y tu pregunta/)
    expect(help).toMatch(/nunca los resultados/)
    expect(help).toMatch(/en este equipo/)
  })

  it('labels every control and points each one to its help text', async () => {
    await setup()
    await open()
    for (const name of ['aiEnabled', 'aiProvider', 'aiBaseUrl', 'aiModel']) {
      const item = control(name)
      expect(item.element.labels?.length, name).toBeGreaterThan(0)
      for (const id of item.attributes('aria-describedby')!.split(' ')) {
        expect(document.getElementById(id), name).not.toBeNull()
      }
    }
    expect(action('probe-ai').text()).toBe('Probar conexión')
  })

  it('has a polite status region that is always present and quiet', async () => {
    await setup()
    await open()
    const live = part('ai-live')
    expect(live.attributes('role')).toBe('status')
    expect(live.attributes('aria-live')).toBe('polite')
    expect(live.text()).toBe('')
  })

  it('puts the focus on the switch when opened on this section', async () => {
    await setup()
    await open('ai')
    expect(document.activeElement).toBe(control('aiEnabled').element)
  })

  it('uses only native controls, so the whole section works with the keyboard', async () => {
    await setup()
    await open()
    const tags = section()
      .findAll('input, select, button')
      .map((item) => item.element.tagName)
    expect(tags).toEqual(['INPUT', 'SELECT', 'INPUT', 'BUTTON', 'SELECT', 'BUTTON'])
    for (const item of section().findAll('input, select, button')) {
      expect(item.attributes('tabindex')).toBeUndefined()
    }
  })
})

describe('activation', () => {
  it('does not touch the network while the assistant is off', async () => {
    await setup()
    await open()
    expect(fake.ai.status).not.toHaveBeenCalled()
    expect(fake.ai.listModels).not.toHaveBeenCalled()
    expect(part('connection').text()).toBe('Sin comprobar.')
  })

  it('turns it on, saves it and looks for the servers by itself', async () => {
    await setup()
    await open()

    await toggle(true)

    expect(fake.preferences.update).toHaveBeenCalledWith({ ai: { enabled: true } })
    expect(saved().enabled).toBe(true)
    expect(status().text()).toBe('Guardado')
    expect(part('connection').text()).toBe(
      'Alcanzable en http://127.0.0.1:11434 · versión 0.12.3 · 2 modelos.',
    )
    expect(part('connection').attributes('data-state')).toBe('reachable')
  })

  it('turns it off again and forgets what was checked', async () => {
    await setup({ preferences: enabled() })
    await open()
    expect(part('connection').attributes('data-state')).toBe('reachable')

    await toggle(false)

    expect(saved().enabled).toBe(false)
    expect(part('connection').text()).toBe('Sin comprobar.')
  })

  it('reverts the switch and tells the user when saving fails', async () => {
    await setup()
    await open()
    fake.preferences.update.mockResolvedValueOnce(
      ipcFail({ code: 'internal_error', message: 'Could not save', retryable: true }),
    )

    await toggle(true)

    expect(control('aiEnabled').element.checked).toBe(false)
    expect(dialog().get('[data-part="settings-problem"]').text()).toMatch(/No se pudo guardar/)
  })

  it('checks on its own when it opens already enabled', async () => {
    await setup({ preferences: enabled() })
    await open()
    expect(fake.ai.status).toHaveBeenCalledTimes(1)
    expect(part('connection').attributes('data-state')).toBe('reachable')
  })
})

describe('provider and address', () => {
  it('offers the three providers with their names', async () => {
    await setup()
    await open()
    const options = control('aiProvider')
      .findAll('option')
      .map((option) => [option.attributes('value'), option.text()])
    expect(options).toEqual([
      ['ollama', 'Ollama'],
      ['lmstudio', 'LM Studio'],
      ['custom', 'Personalizado (compatible con OpenAI)'],
    ])
    expect(control('aiProvider').element.value).toBe('ollama')
  })

  it('switches to LM Studio, proposes its address and explains how to start it when it is off', async () => {
    await setup({ preferences: enabled() })
    await open()

    await control('aiProvider').setValue('lmstudio')
    await flushPromises()

    expect(fake.preferences.update).toHaveBeenCalledWith({
      ai: { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' },
    })
    expect(control('aiBaseUrl').element.value).toBe('http://127.0.0.1:1234')
    expect(part('connection').text()).toContain('No alcanzable en http://127.0.0.1:1234.')
    expect(part('connection').text()).toContain('LM Studio')
    expect(part('connection').attributes('data-state')).toBe('unreachable')
    expect(part('also-running').text()).toContain('Ollama (http://127.0.0.1:11434)')
  })

  it('lists the models of LM Studio when it runs and keeps qwen3:14b flagged as missing there', async () => {
    await setup({ preferences: enabled(), ai: { lmstudio: { reachable: true } } })
    await open()

    await control('aiProvider').setValue('lmstudio')
    await flushPromises()

    expect(part('connection').text()).toBe('Alcanzable en http://127.0.0.1:1234 · 1 modelo.')
    const options = control('aiModel').findAll('option')
    expect(options.map((option) => option.text())).toEqual([
      'qwen3:14b · no está en este servidor',
      'qwen/qwen3.8-27b',
    ])
    expect(control('aiModel').element.value).toBe('qwen3:14b')
    expect(part('connection').element.closest('section')).not.toBeNull()
  })

  it('accepts a loopback address for a custom server and saves it in its canonical form', async () => {
    await setup({ preferences: enabled() })
    await open()
    await control('aiProvider').setValue('custom')
    await flushPromises()

    await control('aiBaseUrl').setValue('  HTTP://localhost:9000/v1/ ')
    await control('aiBaseUrl').trigger('change')
    await flushPromises()

    expect(fake.preferences.update).toHaveBeenLastCalledWith({
      ai: { baseUrl: 'http://localhost:9000/v1' },
    })
    expect(control('aiBaseUrl').element.value).toBe('http://localhost:9000/v1')
    expect(section().find('.form-field__error').exists()).toBe(false)
  })

  it('commits the address with Enter', async () => {
    await setup()
    await open()
    await control('aiBaseUrl').setValue('http://127.0.0.1:12345')
    await control('aiBaseUrl').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(saved().baseUrl).toBe('http://127.0.0.1:12345')
  })

  it.each([
    ['http://192.168.1.5:11434', /de este equipo/],
    ['http://127.0.0.1@evil.com:11434', /de este equipo/],
    ['http://127.0.0.1', /puerto/],
    ['http://127.0.0.1:80', /entre 1024 y 65535/],
    ['', /Escribe la dirección/],
  ])('rejects %j in the client with a clear message and saves nothing', async (value, message) => {
    await setup()
    await open()
    fake.preferences.update.mockClear()

    await control('aiBaseUrl').setValue(value)
    await control('aiBaseUrl').trigger('change')
    await flushPromises()

    const input = control('aiBaseUrl')
    expect(input.attributes('aria-invalid')).toBe('true')
    const error = section().get('.form-field__error')
    expect(error.text()).toMatch(message)
    expect(input.attributes('aria-describedby')).toContain(error.attributes('id'))
    expect(fake.preferences.update).not.toHaveBeenCalled()
    expect(saved().baseUrl).toBe('http://127.0.0.1:11434')
  })

  it('clears the error as soon as the address is valid again', async () => {
    await setup()
    await open()
    await control('aiBaseUrl').setValue('http://example.com:11434')
    await control('aiBaseUrl').trigger('change')
    expect(section().find('.form-field__error').exists()).toBe(true)

    await control('aiBaseUrl').setValue('http://127.0.0.1:11434')

    expect(section().find('.form-field__error').exists()).toBe(false)
    expect(control('aiBaseUrl').attributes('aria-invalid')).toBeUndefined()
  })

  it('does not carry a discarded draft into the next opening', async () => {
    await setup()
    await open()
    await control('aiBaseUrl').setValue('http://example.com:11434')
    await control('aiBaseUrl').trigger('change')
    await close()

    await open()

    expect(control('aiBaseUrl').element.value).toBe('http://127.0.0.1:11434')
    expect(section().find('.form-field__error').exists()).toBe(false)
  })
})

describe('probing the connection', () => {
  it('asks for the servers and the models, shows the result and announces it once', async () => {
    await setup()
    await open()

    await action('probe-ai').trigger('click')
    await flushPromises()

    expect(fake.ai.status).toHaveBeenCalledTimes(1)
    expect(fake.ai.listModels).toHaveBeenCalledWith({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
    })
    const expected = 'Alcanzable en http://127.0.0.1:11434 · versión 0.12.3 · 2 modelos.'
    expect(part('connection').text()).toBe(expected)
    expect(part('ai-live').text()).toBe(expected)
  })

  it('shows «no alcanzable» with how to start the server when nothing answers', async () => {
    await setup({ ai: { ollama: { reachable: false } } })
    await open()

    await action('probe-ai').trigger('click')
    await flushPromises()

    expect(part('connection').text()).toBe(
      'No alcanzable en http://127.0.0.1:11434. Abre la aplicación de Ollama o ejecuta «ollama serve» en una terminal.',
    )
    expect(part('connection').attributes('data-state')).toBe('unreachable')
    expect(part('ai-live').text()).toContain('No alcanzable')
  })

  it('shows a checking state and blocks a second click meanwhile', async () => {
    await setup()
    await open()
    let release: () => void = () => undefined
    fake.ai.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, data: { providers: [] } })
        }),
    )

    await action('probe-ai').trigger('click')
    expect(part('connection').text()).toBe('Comprobando…')
    expect(action('probe-ai').attributes('aria-disabled')).toBe('true')
    expect(action('probe-ai').text()).toBe('Comprobando…')
    await action('probe-ai').trigger('click')
    expect(fake.ai.status).toHaveBeenCalledTimes(1)

    release()
    await flushPromises()
    expect(action('probe-ai').attributes('aria-disabled')).toBeUndefined()
  })

  it('works while the assistant is still off: that is how the user finds what to activate', async () => {
    await setup()
    await open()

    await action('probe-ai').trigger('click')
    await flushPromises()

    expect(saved().enabled).toBe(false)
    expect(part('connection').attributes('data-state')).toBe('reachable')
    expect(control('aiModel').findAll('option')).toHaveLength(1)
  })

  it('probes what is typed and saves it when valid; an invalid address is not probed and gets the focus', async () => {
    await setup({ preferences: enabled() })
    await open()
    fake.ai.status.mockClear()
    fake.ai.listModels.mockClear()

    await control('aiBaseUrl').setValue('http://10.0.0.5:11434')
    await action('probe-ai').trigger('click')
    await flushPromises()

    expect(fake.ai.status).not.toHaveBeenCalled()
    expect(fake.ai.listModels).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(control('aiBaseUrl').element)
    expect(section().get('.form-field__error').text()).toMatch(/de este equipo/)

    await control('aiBaseUrl').setValue('http://127.0.0.1:11435')
    await action('probe-ai').trigger('click')
    await flushPromises()

    expect(saved().baseUrl).toBe('http://127.0.0.1:11435')
    expect(fake.ai.listModels).toHaveBeenLastCalledWith({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11435',
    })
    expect(part('connection').text()).toContain('No alcanzable en http://127.0.0.1:11435')
  })

  it('reports a failure of the check itself without leaking the technical message', async () => {
    await setup()
    await open()
    fake.ai.status.mockResolvedValueOnce(
      ipcFail({ code: 'internal_error', message: 'boom at /secret/path', retryable: true }),
    )
    fake.ai.listModels.mockResolvedValueOnce(
      ipcFail({ code: 'internal_error', message: 'boom at /secret/path', retryable: true }),
    )

    await action('probe-ai').trigger('click')
    await flushPromises()

    expect(part('connection').text()).toMatch(/error inesperado/)
    expect(section().text()).not.toContain('/secret/path')
  })
})

describe('model', () => {
  it('lists the models that generate text, with their size, and leaves out the embedding ones', async () => {
    await setup({ preferences: enabled() })
    await open()

    const select = control('aiModel')
    expect(select.findAll('option').map((option) => option.text())).toEqual(['qwen3:14b · 9,3 GB'])
    expect(select.element.value).toBe('qwen3:14b')
    expect(select.attributes('aria-busy')).toBeUndefined()
    // Con el modelo guardado disponible ya no hay aviso (antes advertía de los embeddings, que ahora ni salen).
    expect(select.attributes('aria-describedby')).toBeUndefined()
    expect(section().text()).not.toMatch(/nomic-embed-text|embeddings/)
  })

  it('shows an embedding model saved by hand with its reason, and asks to choose another', async () => {
    await setup({ preferences: enabled({ model: 'nomic-embed-text' }) })
    await open()

    const select = control('aiModel')
    expect(select.findAll('option').map((option) => option.text())).toEqual([
      'nomic-embed-text · es de embeddings: no genera SQL',
      'qwen3:14b · 9,3 GB',
    ])
    expect(select.element.value).toBe('nomic-embed-text')
    const hint = document.getElementById(select.attributes('aria-describedby')!)!.textContent!
    expect(hint).toMatch(/«nomic-embed-text» es un modelo de embeddings y no genera SQL/)
  })

  it('treats a server with only embedding models as having none to choose', async () => {
    await setup({ preferences: enabled(), ai: { ollama: { models: [EMBEDDINGS] } } })
    await open()

    const hint = document.getElementById(control('aiModel').attributes('aria-describedby')!)!
    expect(hint.textContent).toMatch(
      /no tiene modelos de texto instalados.*Descarga el recomendado/,
    )
    expect(
      control('aiModel')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual(['qwen3:14b · no está en este servidor'])
  })

  it('shows the default model before anything has been checked and asks to probe', async () => {
    await setup()
    await open()

    expect(
      control('aiModel')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual(['qwen3:14b'])
    expect(control('aiModel').element.value).toBe('qwen3:14b')
    const hint = document.getElementById(control('aiModel').attributes('aria-describedby')!)!
    expect(hint.textContent).toMatch(/Probar conexión/)
  })

  it('saves the model the user picks', async () => {
    await setup({
      preferences: enabled(),
      ai: { ollama: { models: [QWEN, { ...QWEN, name: 'llama3.2:3b' }] } },
    })
    await open()

    await control('aiModel').setValue('llama3.2:3b')
    await flushPromises()

    expect(fake.preferences.update).toHaveBeenCalledWith({ ai: { model: 'llama3.2:3b' } })
    expect(saved().model).toBe('llama3.2:3b')
    expect(status().text()).toBe('Guardado')
  })

  it('keeps a saved model that the server does not have and says so', async () => {
    await setup({ preferences: enabled({ model: 'llama3:8b' }) })
    await open()

    expect(
      control('aiModel')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual(['llama3:8b · no está en este servidor', 'qwen3:14b · 9,3 GB'])
    expect(control('aiModel').element.value).toBe('llama3:8b')
    const hint = document.getElementById(control('aiModel').attributes('aria-describedby')!)!
    expect(hint.textContent).toContain('«llama3:8b» no está en este servidor')
  })

  it('shows an empty state when the server has no models, pointing to the download for Ollama', async () => {
    await setup({ preferences: enabled(), ai: { ollama: { models: [] } } })
    await open()

    const hint = document.getElementById(control('aiModel').attributes('aria-describedby')!)!
    expect(hint.textContent).toMatch(
      /no tiene modelos de texto instalados.*Descarga el recomendado/,
    )
  })

  it('shows the error of the model list next to the field', async () => {
    await setup({
      preferences: enabled(),
      ai: { ollama: { listError: { code: 'timeout', message: 'slow', retryable: true } } },
    })
    await open()

    const error = section().get('.form-field__error')
    expect(error.text()).toMatch(/tardó demasiado/)
    expect(control('aiModel').attributes('aria-describedby')).toContain(error.attributes('id'))
  })

  it('marks the field as busy while the list loads', async () => {
    await setup()
    await open()
    let release: () => void = () => undefined
    fake.ai.listModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, data: [] })
        }),
    )
    await action('probe-ai').trigger('click')

    expect(control('aiModel').attributes('aria-busy')).toBe('true')
    release()
    await flushPromises()
    expect(control('aiModel').attributes('aria-busy')).toBeUndefined()
  })
})

describe('downloading the recommended model', () => {
  const ollamaWithoutQwen: SetupOptions = {
    preferences: enabled(),
    ai: { ollama: { models: [] } },
  }

  it('offers the download of qwen3:14b for Ollama', async () => {
    await setup(ollamaWithoutQwen)
    await open()
    expect(action('download-model').text()).toBe('Descargar qwen3:14b (~9 GB)')
    expect(action('download-model').attributes('aria-disabled')).toBeUndefined()
    expect(has('installed')).toBe(false)
  })

  it('says it is installed and offers no download when the model is there', async () => {
    await setup({ preferences: enabled() })
    await open()
    expect(part('installed').text()).toBe('qwen3:14b está instalado.')
    expect(hasAction('download-model')).toBe(false)
  })

  it('shows an accessible progress bar with percentage and bytes, and moves the focus to cancel', async () => {
    await setup(ollamaWithoutQwen)
    await open()

    await press('download-model')
    await flushPromises()

    expect(fake.ai.pullModel).toHaveBeenCalledWith({
      requestId: backend.pull.activeRequestId(),
      model: 'qwen3:14b',
    })
    const bar = progressbar()
    expect(bar.attributes('aria-valuemin')).toBe('0')
    expect(bar.attributes('aria-valuemax')).toBe('100')
    expect(bar.attributes('aria-valuenow')).toBeUndefined()
    expect(bar.attributes('aria-valuetext')).toBe('Preparando la descarga…')
    const label = document.getElementById(bar.attributes('aria-labelledby')!)!
    expect(label.textContent).toContain('Descargando')
    expect(label.textContent).toContain('qwen3:14b')
    expect(document.activeElement).toBe(action('cancel-pull').element)
    expect(part('ai-live').text()).toBe('Descargando qwen3:14b…')

    backend.pull.emit('pulling manifest')
    backend.pull.emit('pulling abc', 4_200_000_000, 9_276_000_000)
    await flushPromises()

    expect(bar.attributes('aria-valuenow')).toBe('45')
    expect(bar.attributes('aria-valuetext')).toBe('Descargando 45 % · 4,2 GB de 9,3 GB')
    expect(part('progress-text').text()).toBe('Descargando 45 % · 4,2 GB de 9,3 GB')
    expect(bar.get('.ai-progress__fill').attributes('style')).toContain('45%')
    expect(part('ai-live').text()).toBe('Descargando qwen3:14b…')
  })

  it('does not go through the layers of the model as if each were a new download', async () => {
    await setup(ollamaWithoutQwen)
    await open()
    await press('download-model')
    await flushPromises()

    backend.pull.emit('pulling big', 9_000, 9_000)
    backend.pull.emit('pulling small', 0, 100)
    await flushPromises()

    expect(progressbar().attributes('aria-valuenow')).toBe('100')
  })

  it('cancels with the button: shows «Descarga cancelada.», announces it and returns the focus to download', async () => {
    await setup(ollamaWithoutQwen)
    await open()
    await press('download-model')
    await flushPromises()
    const requestId = backend.pull.activeRequestId()

    await press('cancel-pull')
    await flushPromises()

    expect(fake.ai.cancel).toHaveBeenCalledWith({ requestId })
    expect(section().find('[role="progressbar"]').exists()).toBe(false)
    expect(part('cancelled').text()).toBe('Descarga cancelada.')
    expect(part('ai-live').text()).toBe('Descarga cancelada.')
    expect(section().find('[role="alert"]').exists()).toBe(false)
    expect(document.activeElement).toBe(action('download-model').element)
    expect(action('download-model').text()).toBe('Volver a descargar qwen3:14b (~9 GB)')
  })

  it('shows the cancelling state and does not cancel twice', async () => {
    await setup(ollamaWithoutQwen)
    await open()
    await press('download-model')
    await flushPromises()
    let release: () => void = () => undefined
    fake.ai.cancel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, data: { requestId: 'r', outcome: 'requested' } })
        }),
    )

    await press('cancel-pull')
    expect(action('cancel-pull').text()).toBe('Cancelando…')
    expect(action('cancel-pull').attributes('aria-disabled')).toBe('true')
    await press('cancel-pull')
    expect(fake.ai.cancel).toHaveBeenCalledTimes(1)

    release()
    backend.pull.fail({ code: 'cancelled', message: 'x', retryable: false })
    await flushPromises()
  })

  it('finishes: says it is installed, refreshes the list, announces it and moves the focus to the model', async () => {
    await setup(ollamaWithoutQwen)
    await open()
    await press('download-model')
    await flushPromises()
    fake.ai.listModels.mockClear()

    backend.pull.finish()
    await flushPromises()

    expect(part('installed').text()).toBe('qwen3:14b está instalado.')
    expect(hasAction('download-model')).toBe(false)
    expect(fake.ai.listModels).toHaveBeenCalledTimes(1)
    expect(
      control('aiModel')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual(['qwen3:14b · 9,3 GB'])
    expect(part('ai-live').text()).toBe('qwen3:14b descargado.')
    expect(document.activeElement).toBe(control('aiModel').element)
  })

  it('does not steal the focus when the user is elsewhere as the download finishes', async () => {
    await setup(ollamaWithoutQwen)
    await open()
    await press('download-model')
    await flushPromises()
    control('aiBaseUrl').element.focus()

    backend.pull.finish()
    await flushPromises()

    expect(document.activeElement).toBe(control('aiBaseUrl').element)
  })

  it('reports a failed download in an alert, with a retry, and returns the focus', async () => {
    await setup(ollamaWithoutQwen)
    await open()
    await press('download-model')
    await flushPromises()

    backend.pull.fail(PULL_FAILED_ERROR)
    await flushPromises()

    const alert = part('download-error')
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toContain('No se pudo descargar el modelo.')
    expect(alert.text()).toMatch(/Ollama sigue en marcha/)
    expect(alert.text()).toMatch(/espacio libre/)
    expect(alert.text()).not.toContain('The model download failed')
    expect(part('ai-live').text()).toMatch(/espacio libre/)
    expect(document.activeElement).toBe(action('download-model').element)

    await press('download-model')
    await flushPromises()
    expect(section().find('[role="alert"]').exists()).toBe(false)
    expect(section().find('[role="progressbar"]').exists()).toBe(true)
    backend.pull.finish()
  })

  it('explains that Ollama does not know the model when the download says so', async () => {
    await setup(ollamaWithoutQwen)
    await open()
    await press('download-model')
    await flushPromises()

    backend.pull.fail({ code: 'not_found', message: 'x', retryable: false })
    await flushPromises()

    expect(part('download-error').text()).toMatch(/biblioteca/)
  })

  it('does not download while the assistant is off, and says why', async () => {
    await setup({ ai: { ollama: { models: [] } } })
    await open()
    await action('probe-ai').trigger('click')
    await flushPromises()

    const button = action('download-model')
    expect(button.attributes('aria-disabled')).toBe('true')
    const hint = document.getElementById(button.attributes('aria-describedby')!)!
    expect(hint.textContent).toBe('Activa la IA local para poder descargar modelos.')
    await button.trigger('click')
    expect(fake.ai.pullModel).not.toHaveBeenCalled()

    await toggle(true)
    expect(action('download-model').attributes('aria-disabled')).toBeUndefined()
  })

  it('does not offer downloads with LM Studio or a custom server', async () => {
    await setup({ preferences: enabled(), ai: { lmstudio: { reachable: true } } })
    await open()

    await control('aiProvider').setValue('lmstudio')
    await flushPromises()

    expect(hasAction('download-model')).toBe(false)
    expect(part('download-unavailable').text()).toMatch(/solo descarga modelos con Ollama/)
    expect(part('download-unavailable').text()).toContain('LM Studio')

    await control('aiProvider').setValue('custom')
    await flushPromises()
    expect(hasAction('download-model')).toBe(false)
  })

  it('says the download goes on when the settings are closed', async () => {
    await setup(ollamaWithoutQwen)
    await open()
    await press('download-model')
    await flushPromises()
    expect(section().text()).toContain('la descarga continúa')
  })
})

describe('progress subscription', () => {
  it('listens only while the settings are open', async () => {
    await setup()
    expect(fake.pullListenerCount()).toBe(0)

    await open()
    expect(fake.pullListenerCount()).toBe(1)

    await close()
    expect(fake.pullListenerCount()).toBe(0)

    await open()
    expect(fake.pullListenerCount()).toBe(1)
    await close()
    expect(fake.pullListenerCount()).toBe(0)
  })

  it('leaves no listener after several openings, closings and unmounting', async () => {
    await setup()
    for (let index = 0; index < 4; index += 1) {
      await open()
      await close()
    }
    expect(fake.pullListenerCount()).toBe(0)

    await open()
    wrapper!.unmount()
    wrapper = undefined
    expect(fake.pullListenerCount()).toBe(0)
  })

  it('keeps counting and shows the download in progress when reopened', async () => {
    await setup({ preferences: enabled(), ai: { ollama: { models: [] } } })
    await open()
    await press('download-model')
    await flushPromises()
    backend.pull.emit('pulling a', 100, 1000)
    await close()
    expect(fake.pullListenerCount()).toBe(0)

    await open()
    expect(progressbar().attributes('aria-valuenow')).toBe('10')
    backend.pull.emit('pulling a', 600, 1000)
    await flushPromises()

    expect(progressbar().attributes('aria-valuenow')).toBe('60')
    backend.pull.finish()
  })

  it('collects the result of a download that finished while the settings were closed', async () => {
    await setup({ preferences: enabled(), ai: { ollama: { models: [] } } })
    await open()
    await press('download-model')
    await flushPromises()
    await close()

    backend.pull.finish()
    await flushPromises()
    await open()

    expect(part('installed').text()).toBe('qwen3:14b está instalado.')
    expect(section().find('[role="progressbar"]').exists()).toBe(false)
  })

  it('opens clean after a download that ended with an error', async () => {
    await setup({ preferences: enabled(), ai: { ollama: { models: [] } } })
    await open()
    await press('download-model')
    await flushPromises()
    backend.pull.fail()
    await flushPromises()
    await close()

    await open()

    expect(has('download-error')).toBe(false)
    expect(action('download-model').text()).toBe('Descargar qwen3:14b (~9 GB)')
    expect(useAiStore(pinia).pull.phase).toBe('idle')
  })
})
