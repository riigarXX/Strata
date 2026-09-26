// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createAppOrigin } from './app-origin'
import { installAppPolicy } from './app-policy'
import { hardenSession } from './session-policy'

const appOrigin = createAppOrigin()

function fakeSession() {
  const state: {
    request?: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void
    check?: () => boolean
    device?: () => boolean
    displayMedia?: (request: unknown, callback: (streams: object) => void) => void
    headers?: (details: unknown, callback: (response: unknown) => void) => void
    beforeRequest?: (
      details: { url: string },
      callback: (response: { cancel: boolean }) => void,
    ) => void
  } = {}
  const session = {
    setPermissionRequestHandler: vi.fn((handler: typeof state.request) => {
      state.request = handler
    }),
    setPermissionCheckHandler: vi.fn((handler: typeof state.check) => {
      state.check = handler
    }),
    setDevicePermissionHandler: vi.fn((handler: typeof state.device) => {
      state.device = handler
    }),
    setDisplayMediaRequestHandler: vi.fn((handler: typeof state.displayMedia) => {
      state.displayMedia = handler
    }),
    webRequest: {
      onHeadersReceived: vi.fn((handler: typeof state.headers) => {
        state.headers = handler
      }),
      onBeforeRequest: vi.fn((handler: typeof state.beforeRequest) => {
        state.beforeRequest = handler
      }),
    },
  }
  return { session, state }
}

const PERMISSIONS = [
  'media',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'clipboard-read',
  'clipboard-sanitized-write',
  'display-capture',
  'fullscreen',
  'openExternal',
  'hid',
  'serial',
  'usb',
  'idle-detection',
  'unknown',
]

describe('hardenSession', () => {
  it('deniega todas las peticiones y comprobaciones de permisos, incluido el portapapeles', () => {
    const { session, state } = fakeSession()
    hardenSession(session as never, { devServerUrl: undefined })

    for (const permission of PERMISSIONS) {
      const callback = vi.fn()
      state.request?.({}, permission, callback)
      expect(callback).toHaveBeenCalledExactlyOnceWith(false)
      expect(state.check?.()).toBe(false)
    }
  })

  it('deniega los dispositivos y la captura de pantalla', () => {
    const { session, state } = fakeSession()
    hardenSession(session as never, { devServerUrl: undefined })

    expect(state.device?.()).toBe(false)
    const callback = vi.fn()
    state.displayMedia?.({}, callback)
    expect(callback).toHaveBeenCalledExactlyOnceWith({})
  })

  it('instala la CSP de producción por defecto y solo relaja estilos con un dev server', () => {
    const production = fakeSession()
    hardenSession(production.session as never, { devServerUrl: undefined })
    const dev = fakeSession()
    hardenSession(dev.session as never, { devServerUrl: 'http://localhost:5173' })

    const policyOf = (state: ReturnType<typeof fakeSession>['state']): string => {
      let headers: Record<string, string[]> = {}
      state.headers?.({ responseHeaders: { 'content-security-policy': ['x'] } }, (response) => {
        headers = (response as { responseHeaders: Record<string, string[]> }).responseHeaders
      })
      expect(Object.keys(headers).filter((name) => /content-security-policy/i.test(name))).toEqual([
        'Content-Security-Policy',
      ])
      return headers['Content-Security-Policy']?.[0] ?? ''
    }

    expect(policyOf(production.state)).not.toContain('unsafe-inline')
    expect(policyOf(dev.state)).toContain("style-src 'self' 'unsafe-inline'")
  })
})

describe('hardenSession: peticiones', () => {
  it('cancela toda petición file: y solo deja pasar el host de la app en app://', () => {
    const { session, state } = fakeSession()
    hardenSession(session as never, { devServerUrl: undefined })
    const cancelled = (url: string): boolean => {
      let result: boolean | undefined
      state.beforeRequest?.({ url }, (response) => {
        result = response.cancel
      })
      return result as boolean
    }

    expect(cancelled('file:///etc/hosts')).toBe(true)
    expect(cancelled('file:///app/out/renderer/assets/index.js')).toBe(true)
    expect(cancelled('app://evil/assets/index.js')).toBe(true)
    expect(cancelled('app://strata/assets/index.js')).toBe(false)
  })
})

describe('installAppPolicy', () => {
  function setup(devServerUrl?: string) {
    const app = new EventEmitter()
    installAppPolicy(app as never, { appOrigin, devServerUrl })
    return app
  }

  it('endurece cada webContents que se crea, sea de la ventana o de cualquier otro origen', () => {
    const app = setup()
    const created = () => {
      const handlers = new Map<string, unknown>()
      return {
        handlers,
        on: vi.fn((name: string, handler: unknown) => handlers.set(name, handler)),
        setWindowOpenHandler: vi.fn(),
      }
    }

    for (const webContents of [created(), created()]) {
      app.emit('web-contents-created', {}, webContents)
      expect([...webContents.handlers.keys()].sort()).toEqual([
        'will-attach-webview',
        'will-frame-navigate',
        'will-navigate',
        'will-redirect',
      ])
      expect(webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
    }
  })

  it('aplica la política de permisos y la CSP a las sesiones que se creen después', () => {
    const app = setup()
    const { session, state } = fakeSession()

    app.emit('session-created', session)

    const callback = vi.fn()
    state.request?.({}, 'media', callback)
    expect(callback).toHaveBeenCalledWith(false)
    expect(session.webRequest.onHeadersReceived).toHaveBeenCalledOnce()
  })

  it('nunca acepta un error de certificado', () => {
    const app = setup()
    const event = { preventDefault: vi.fn() }
    const callback = vi.fn()

    app.emit(
      'certificate-error',
      event,
      {},
      'https://example.com',
      'net::ERR_CERT_DATE_INVALID',
      {},
      callback,
    )

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('no elige un certificado de cliente por su cuenta', () => {
    const app = setup()
    const event = { preventDefault: vi.fn() }
    const callback = vi.fn()

    app.emit('select-client-certificate', event, {}, 'https://example.com', [{}], callback)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledExactlyOnceWith()
  })
})
