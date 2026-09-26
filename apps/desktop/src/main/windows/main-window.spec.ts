// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const constructed = vi.hoisted(() => [] as Record<string, unknown>[])

vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      constructed.push(options)
    }
    once = vi.fn()
    loadURL = vi.fn(() => Promise.resolve())
    setBackgroundColor = vi.fn()
    show = vi.fn()
  },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), off: vi.fn() },
}))

const { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, createMainWindow } = await import('./main-window')

beforeEach(() => {
  constructed.length = 0
})

describe('createMainWindow', () => {
  it('creates the window with a minimum size, so the editor toolbar never loses its second line', () => {
    createMainWindow({ devServerUrl: undefined })
    expect(constructed).toHaveLength(1)
    expect(constructed[0]).toMatchObject({
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
    })
  })

  it('opens larger than the minimum, so the minimum only bites when the user shrinks it', () => {
    createMainWindow({ devServerUrl: undefined })
    const { width, height } = constructed[0] as { width: number; height: number }
    expect(width).toBeGreaterThan(MIN_WINDOW_WIDTH)
    expect(height).toBeGreaterThan(MIN_WINDOW_HEIGHT)
  })

  it('keeps the security-relevant web preferences alongside the size', () => {
    createMainWindow({ devServerUrl: undefined })
    expect(constructed[0]).toMatchObject({
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
  })
})
