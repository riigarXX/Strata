import type { MatchRange } from '@strata/commands'

export interface Segment {
  text: string
  match: boolean
}

/** Parte `text` en trozos alternos (sin coincidencia / con ella) según rangos ordenados y sin solaparse. */
export function splitByRanges(text: string, ranges: readonly MatchRange[]): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  for (const { start, end } of ranges) {
    const from = Math.max(start, cursor)
    const to = Math.min(end, text.length)
    if (to <= from) continue
    if (from > cursor) segments.push({ text: text.slice(cursor, from), match: false })
    segments.push({ text: text.slice(from, to), match: true })
    cursor = to
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments.length > 0 ? segments : [{ text, match: false }]
}
