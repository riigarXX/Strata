import { describe, expect, it, vi } from 'vitest'
import { createAppOrigin, resolveDevServerUrl } from './app-origin'
import { buildCsp } from './csp'
import { hardenWebContents } from './navigation-guard'
import { assertTrustedSender, isTrustedSender, type IpcSenderLike } from './sender-validation'
import { createWebPreferences } from './web-preferences'

const ENTRY_URL = 'app://strata/index.html'
const prodOrigin = createAppOrigin()
const devOrigin = createAppOrigin({ devServerUrl: 'http://localhost:5173' })

describe('createWebPreferences', () => {
  it('activa el aislamiento y desactiva Node en el renderer', () => {
    const prefs = createWebPreferences('/app/out/preload/index.js')

    expect(prefs).toMatchObject({
      preload: '/app/out/preload/index.js',
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    })
  })
})

describe('createAppOrigin', () => {
  it('en producción solo permite la página de la app en app://strata', () => {
    expect(prodOrigin.isAllowedUrl('app://strata/index.html')).toBe(true)
    expect(prodOrigin.isAllowedUrl('app://strata/')).toBe(true)
    expect(prodOrigin.isAllowedUrl('app://strata/index.html#/x?y=1')).toBe(true)
    expect(prodOrigin.isAllowedUrl('file:///etc/passwd')).toBe(false)
    expect(prodOrigin.isAllowedUrl('https://example.com')).toBe(false)
    expect(prodOrigin.isAllowedUrl('http://localhost:5173')).toBe(false)
    expect(prodOrigin.isAllowedUrl('not a url')).toBe(false)
  })

  it('en desarrollo solo permite el origen del dev server', () => {
    expect(devOrigin.isAllowedUrl('http://localhost:5173/')).toBe(true)
    expect(devOrigin.isAllowedUrl('http://localhost:5173/some/route')).toBe(true)
    expect(devOrigin.isAllowedUrl('http://localhost:9999/')).toBe(false)
    expect(devOrigin.isAllowedUrl('http://evil.test:5173/')).toBe(false)
    expect(devOrigin.isAllowedUrl(ENTRY_URL)).toBe(false)
  })

  it.each([
    'app://strata/other.html',
    'app://strata/assets/index-abc.js',
    'app://strata/index.html/extra',
    'app://strata/../index.html/x',
    'app://strata/INDEX.HTML',
    'app://evil/index.html',
    'app://strata.evil.test/index.html',
    'app://strata:8080/index.html',
    'app://user@strata/index.html',
    'app://user:pass@strata/index.html',
    'app:///index.html',
    'app:index.html',
    'file:///app/out/renderer/index.html',
    'file://strata/index.html',
    'https://strata/index.html',
    'about:blank',
    'about:srcdoc',
    'data:text/html,<h1>x</h1>',
    'blob:app://strata/3f1c2c1e-0000-4000-8000-000000000000',
    'filesystem:app://strata/temporary/x',
    'javascript:alert(1)',
    'ftp://example.com/index.html',
    'devtools://devtools/bundled/inspector.html',
    '',
    'file://',
  ])('en producción rechaza %s', (url) => {
    expect(prodOrigin.isAllowedUrl(url)).toBe(false)
  })

  it.each([
    'blob:http://localhost:5173/3f1c2c1e-0000-4000-8000-000000000000',
    'filesystem:http://localhost:5173/temporary/x',
    'app://strata/index.html',
    'data:text/html,<h1>x</h1>',
    'about:blank',
    'http://localhost:5173.evil.test/',
    'http://user@evil.test:5173/',
    'https://localhost:5173/',
    'ws://localhost:5173/',
  ])('en desarrollo rechaza %s', (url) => {
    expect(devOrigin.isAllowedUrl(url)).toBe(false)
  })
})

describe('resolveDevServerUrl', () => {
  it('en un build empaquetado ignora la variable de entorno, sea cual sea', () => {
    for (const rendererUrl of ['http://localhost:5173', 'https://evil.test', 'basura', '']) {
      expect(resolveDevServerUrl({ isPackaged: true, rendererUrl })).toBeUndefined()
    }
  })

  it('sin variable de entorno no hay dev server', () => {
    expect(resolveDevServerUrl({ isPackaged: false, rendererUrl: undefined })).toBeUndefined()
    expect(resolveDevServerUrl({ isPackaged: false, rendererUrl: '' })).toBeUndefined()
  })

  it.each(['http://localhost:5173', 'http://127.0.0.1:5173/', 'http://[::1]:5173'])(
    'en desarrollo acepta el loopback %s',
    (rendererUrl) => {
      expect(resolveDevServerUrl({ isPackaged: false, rendererUrl })).toBe(rendererUrl)
    },
  )

  it.each([
    'https://evil.test/',
    'http://192.168.1.10:5173',
    'file:///app/index.html',
    'javascript:1',
    'no es url',
  ])('en desarrollo rechaza %s', (rendererUrl) => {
    expect(() => resolveDevServerUrl({ isPackaged: false, rendererUrl })).toThrow(
      /ELECTRON_RENDERER_URL/,
    )
  })

  it('la app empaquetada construye origen y CSP de producción aunque el entorno pida el dev server', () => {
    const devServerUrl = resolveDevServerUrl({
      isPackaged: true,
      rendererUrl: 'http://localhost:5173',
    })
    const origin = createAppOrigin({ devServerUrl })

    expect(origin.isAllowedUrl('http://localhost:5173/')).toBe(false)
    expect(origin.isAllowedUrl(ENTRY_URL)).toBe(true)
    expect(buildCsp(devServerUrl)).toBe(buildCsp())
  })
})

describe('hardenWebContents', () => {
  function setup() {
    const handlers = new Map<string, (event: { preventDefault(): void }, url: string) => void>()
    let openHandler: (() => { action: string }) | undefined
    const webContents = {
      on: vi.fn((name: string, handler: never) => {
        handlers.set(name, handler)
        return webContents
      }),
      setWindowOpenHandler: vi.fn((handler: () => { action: string }) => {
        openHandler = handler
      }),
    }
    hardenWebContents(webContents as never, prodOrigin)
    return { handlers, openHandler: () => openHandler }
  }

  it.each(['will-navigate', 'will-redirect'])('%s bloquea destinos externos', (name) => {
    const { handlers } = setup()
    const blocked = { preventDefault: vi.fn() }
    handlers.get(name)?.(blocked, 'https://example.com')
    expect(blocked.preventDefault).toHaveBeenCalledOnce()

    const allowed = { preventDefault: vi.fn() }
    handlers.get(name)?.(allowed, ENTRY_URL)
    expect(allowed.preventDefault).not.toHaveBeenCalled()
  })

  it('will-frame-navigate bloquea la navegación de subframes hacia destinos externos', () => {
    const { handlers } = setup()
    const blocked = { preventDefault: vi.fn(), url: 'https://example.com' }
    handlers.get('will-frame-navigate')?.(blocked as never, '')
    expect(blocked.preventDefault).toHaveBeenCalledOnce()

    const allowed = { preventDefault: vi.fn(), url: ENTRY_URL }
    handlers.get('will-frame-navigate')?.(allowed as never, '')
    expect(allowed.preventDefault).not.toHaveBeenCalled()
  })

  it('will-attach-webview se cancela siempre', () => {
    const { handlers } = setup()
    const event = { preventDefault: vi.fn() }
    handlers.get('will-attach-webview')?.(event, '')
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('window.open se deniega siempre', () => {
    const { openHandler } = setup()
    expect(openHandler()?.()).toEqual({ action: 'deny' })
  })
})

describe('isTrustedSender', () => {
  const mainFrame = { url: ENTRY_URL }
  const webContents = { mainFrame }
  const validEvent = (): IpcSenderLike => ({ sender: webContents, senderFrame: mainFrame })

  it('acepta el frame principal de la ventana principal con origen permitido', () => {
    expect(isTrustedSender(validEvent(), webContents, prodOrigin)).toBe(true)
  })

  it('rechaza un origen no permitido', () => {
    const frame = { url: 'https://evil.test/' }
    const event = { sender: { mainFrame: frame }, senderFrame: frame }
    expect(isTrustedSender(event, event.sender, prodOrigin)).toBe(false)
  })

  it('rechaza otra ventana, subframes, frames destruidos y ausencia de ventana', () => {
    expect(isTrustedSender(validEvent(), { mainFrame }, prodOrigin)).toBe(false)
    expect(isTrustedSender(validEvent(), null, prodOrigin)).toBe(false)
    expect(
      isTrustedSender(
        { sender: webContents, senderFrame: { url: mainFrame.url } },
        webContents,
        prodOrigin,
      ),
    ).toBe(false)
    expect(
      isTrustedSender({ sender: webContents, senderFrame: null }, webContents, prodOrigin),
    ).toBe(false)
  })
})

describe('isTrustedSender: orígenes límite', () => {
  function senderAt(url: string): IpcSenderLike & { sender: { mainFrame: { url: string } } } {
    const frame = { url }
    return { sender: { mainFrame: frame }, senderFrame: frame }
  }

  it.each([
    'file:///etc/passwd',
    'file:///app/out/renderer/index.html',
    'app://strata/other.html',
    'app://evil/index.html',
    'about:blank',
    'data:text/html,<script>1</script>',
    'blob:app://strata/0b6c0b4e-0000-4000-8000-000000000000',
    'https://example.com/',
    'http://localhost:5173/',
    '',
  ])('en producción rechaza un frame principal en %s', (url) => {
    const event = senderAt(url)
    expect(isTrustedSender(event, event.sender, prodOrigin)).toBe(false)
    expect(() => assertTrustedSender(event, event.sender, prodOrigin)).toThrow(
      'IPC sender not allowed',
    )
  })

  it('en desarrollo acepta el dev server y rechaza el index.html empaquetado y otros puertos', () => {
    const ok = senderAt('http://localhost:5173/')
    expect(isTrustedSender(ok, ok.sender, devOrigin)).toBe(true)
    for (const url of [ENTRY_URL, 'http://localhost:4000/']) {
      const event = senderAt(url)
      expect(isTrustedSender(event, event.sender, devOrigin)).toBe(false)
    }
  })

  it('el mensaje de rechazo es fijo y no cita la URL del remitente', () => {
    const event = senderAt('https://evil.test/?token=abc')
    expect(() => assertTrustedSender(event, event.sender, prodOrigin)).toThrow(
      /^IPC sender not allowed$/,
    )
  })
})

describe('buildCsp', () => {
  it('la política de producción no relaja scripts ni estilos', () => {
    const csp = buildCsp()
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('ws:')
  })

  it('solo en desarrollo permite estilos inline y el websocket del dev server', () => {
    const csp = buildCsp('http://localhost:5173')
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("connect-src 'self' ws://localhost:5173")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toMatch(/script-src 'self'(;|$)/)
  })

  it('en ningún modo admite orígenes remotos, comodines ni scripts inline o eval', () => {
    for (const csp of [buildCsp(), buildCsp('http://localhost:5173')]) {
      const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1]
      expect(scriptSrc).toBe("'self'")
      expect(csp).not.toMatch(/(^|[\s;])(\*|https?:|wss?:\/\/(?!localhost))/)
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("frame-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).toContain("base-uri 'none'")
    }
  })
})
