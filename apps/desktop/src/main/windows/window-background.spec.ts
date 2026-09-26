import { describe, expect, it } from 'vitest'
import {
  headerHeight,
  resolveWindowBackground,
  themeMode,
  trafficLightPosition,
  type ThemeTokens,
} from './window-background'

const tokens: ThemeTokens = {
  dark: { surface: { canvas: { $value: '#0F172A' } }, spacing: { header: { $value: '52px' } } },
  light: { surface: { canvas: { $value: '#F8FAFC' } }, spacing: { header: { $value: '52px' } } },
}

describe('window background', () => {
  it('maps the native theme flag to a theme mode', () => {
    expect(themeMode(true)).toBe('dark')
    expect(themeMode(false)).toBe('light')
  })

  it('takes the canvas colour of the active theme from the tokens', () => {
    expect(resolveWindowBackground(tokens, 'dark')).toBe('#0F172A')
    expect(resolveWindowBackground(tokens, 'light')).toBe('#F8FAFC')
  })

  it('centres the traffic lights vertically in the header', () => {
    expect(headerHeight(tokens)).toBe(52)
    expect(trafficLightPosition(tokens)).toEqual({ x: 16, y: 20 })
  })
})

describe('real design tokens', () => {
  it('provide hex canvas colours Electron accepts and a pixel header height', async () => {
    const real = (await import('@strata/design-tokens/tokens.json')).default as ThemeTokens
    expect(resolveWindowBackground(real, 'dark')).toMatch(/^#[0-9A-Fa-f]{6}$/)
    expect(resolveWindowBackground(real, 'light')).toMatch(/^#[0-9A-Fa-f]{6}$/)
    expect(headerHeight(real)).toBeGreaterThan(0)
  })
})
