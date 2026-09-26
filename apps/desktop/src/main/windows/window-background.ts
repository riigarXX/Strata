export type ThemeMode = 'dark' | 'light'

/** Parte de `@strata/design-tokens/tokens.json` que necesita main. */
export type ThemeTokens = Record<
  ThemeMode,
  { surface: { canvas: { $value: string } }; spacing: { header: { $value: string } } }
>

export function themeMode(shouldUseDarkColors: boolean): ThemeMode {
  return shouldUseDarkColors ? 'dark' : 'light'
}

/** Color de fondo de la ventana antes de que pinte el renderer: el `surface.canvas` del tema activo. */
export function resolveWindowBackground(tokens: ThemeTokens, mode: ThemeMode): string {
  return tokens[mode].surface.canvas.$value
}

/** Altura de la barra superior en px (`spacing.header`), para centrar los semáforos de macOS en ella. */
export function headerHeight(tokens: ThemeTokens): number {
  return Number.parseFloat(tokens.dark.spacing.header.$value)
}

const TRAFFIC_LIGHT_DIAMETER = 12
const TRAFFIC_LIGHT_INSET_X = 16

export function trafficLightPosition(tokens: ThemeTokens): { x: number; y: number } {
  return {
    x: TRAFFIC_LIGHT_INSET_X,
    y: Math.round((headerHeight(tokens) - TRAFFIC_LIGHT_DIAMETER) / 2),
  }
}
