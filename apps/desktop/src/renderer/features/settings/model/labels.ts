import type { HistoryRetentionDays, ThemePreference } from '@strata/contracts'

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'Sistema',
  dark: 'Oscuro',
  light: 'Claro',
}

const RETENTION_UNLIMITED = 'unlimited'

/** Valor del `<select>` de retención: los días como texto o `unlimited` para conservar sin límite. */
export function retentionToValue(days: HistoryRetentionDays): string {
  return days === null ? RETENTION_UNLIMITED : String(days)
}

export function retentionLabel(days: HistoryRetentionDays): string {
  return days === null ? 'Sin límite' : `${days} días`
}
