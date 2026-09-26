import { tokenVariables, type TokenPath, type ThemeName } from './tokens.generated'

export * from './tokens.generated'

export type ThemePreference = ThemeName | 'system'

export const THEME_ATTRIBUTE = 'data-theme'

export const SYSTEM_DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

export const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)'

export function cssVar(path: TokenPath): string {
  return `var(${tokenVariables[path]})`
}
