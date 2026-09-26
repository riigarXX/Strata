/** Rango `[start, end)` sobre las posiciones UTF-16 del texto original, listo para resaltar. */
export interface MatchRange {
  readonly start: number
  readonly end: number
}

export interface TextMatch {
  readonly score: number
  readonly ranges: readonly MatchRange[]
}

/** Bandas de puntuación: cada nivel supera siempre al siguiente, sea cual sea el texto. */
const EXACT = 1000
const PREFIX = 900
const WORD_PREFIX = 800
const SUBSTRING = 600
const SUBSEQUENCE_MAX = 500

interface Folded {
  /** Minúsculas y sin diacríticos: «Pestaña» → «pestana». */
  readonly text: string
  /** Para cada carácter plegado, dónde empieza y acaba su carácter original. */
  readonly starts: readonly number[]
  readonly ends: readonly number[]
  readonly wordStart: readonly boolean[]
}

function fold(original: string): Folded {
  let text = ''
  const starts: number[] = []
  const ends: number[] = []
  let position = 0
  for (const char of original) {
    const plain = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    for (let unit = 0; unit < plain.length; unit += 1) {
      text += plain[unit]
      starts.push(position)
      ends.push(position + char.length)
    }
    position += char.length
  }
  const wordStart = Array.from(
    text,
    (_, index) => index === 0 || !/[\p{L}\p{N}]/u.test(text[index - 1]!),
  )
  return { text, starts, ends, wordStart }
}

function rangesOf(folded: Folded, indices: readonly number[]): MatchRange[] {
  const ranges: MatchRange[] = []
  for (const index of indices) {
    const start = folded.starts[index]!
    const end = folded.ends[index]!
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end) {
      if (end > last.end) ranges[ranges.length - 1] = { start: last.start, end }
    } else {
      ranges.push({ start, end })
    }
  }
  return ranges
}

function isSubsequence(token: string, text: string): boolean {
  let at = 0
  for (const char of text) {
    if (char === token[at]) at += 1
    if (at === token.length) return true
  }
  return token.length === 0
}

const CHAR_SCORE = 10
const WORD_START_BONUS = 15
const FIRST_CHAR_BONUS = 8
const CONSECUTIVE_BONUS = 12
const GAP_PENALTY = 1

/** Mejor alineación de `token` como subsecuencia de `folded`, en O(token·texto), con la que se resaltan letras sueltas. */
function bestSubsequence(
  token: string,
  folded: Folded,
): { score: number; indices: number[] } | null {
  const { text } = folded
  const n = text.length
  const m = token.length
  if (m > n || !isSubsequence(token, text)) return null

  const charScore = (index: number): number =>
    CHAR_SCORE +
    (folded.wordStart[index] ? WORD_START_BONUS : 0) +
    (index === 0 ? FIRST_CHAR_BONUS : 0)

  // ends[j][i]: mejor puntuación con token[j] casado en text[i]; from[j][i]: dónde casó token[j-1].
  const ends: number[][] = []
  const from: number[][] = []
  // Mejor puntuación de casar token[j-1] en algún k <= i, descontando el salto hasta i, y su k.
  let carry: { score: number; at: number }[] = []

  for (let j = 0; j < m; j += 1) {
    const row = new Array<number>(n).fill(Number.NEGATIVE_INFINITY)
    const back = new Array<number>(n).fill(-1)
    const nextCarry: { score: number; at: number }[] = new Array(n)
    let running = { score: Number.NEGATIVE_INFINITY, at: -1 }

    for (let i = 0; i < n; i += 1) {
      if (text[i] === token[j]) {
        if (j === 0) {
          row[i] = charScore(i)
        } else if (i > 0) {
          const before = ends[j - 1]![i - 1]!
          const consecutive = before + CONSECUTIVE_BONUS
          const gapped = carry[i - 1]!
          if (consecutive >= gapped.score && before > Number.NEGATIVE_INFINITY) {
            row[i] = charScore(i) + consecutive
            back[i] = i - 1
          } else if (gapped.score > Number.NEGATIVE_INFINITY) {
            row[i] = charScore(i) + gapped.score
            back[i] = gapped.at
          }
        }
      }
      running = {
        score: Math.max(running.score - GAP_PENALTY, row[i]!),
        at: row[i]! >= running.score - GAP_PENALTY ? i : running.at,
      }
      nextCarry[i] = running
    }
    ends.push(row)
    from.push(back)
    carry = nextCarry
  }

  let bestIndex = -1
  let best = Number.NEGATIVE_INFINITY
  const last = ends[m - 1]!
  for (let i = 0; i < n; i += 1) {
    if (last[i]! > best) {
      best = last[i]!
      bestIndex = i
    }
  }
  if (bestIndex < 0) return null

  const indices: number[] = new Array(m)
  let cursor = bestIndex
  for (let j = m - 1; j >= 0; j -= 1) {
    indices[j] = cursor
    cursor = from[j]![cursor]!
  }
  return { score: Math.min(SUBSEQUENCE_MAX, Math.max(1, best)), indices }
}

function matchFolded(token: string, folded: Folded, allowSubsequence = true): TextMatch | null {
  const { text } = folded
  if (token === '' || token.length > text.length) return null

  const span = (start: number): number[] =>
    Array.from({ length: token.length }, (_, k) => start + k)

  if (text === token) return { score: EXACT, ranges: rangesOf(folded, span(0)) }
  if (text.startsWith(token)) {
    const extra = Math.min(text.length - token.length, 99)
    return { score: PREFIX - extra * 0.5, ranges: rangesOf(folded, span(0)) }
  }
  for (let at = 1; at <= text.length - token.length; at += 1) {
    if (folded.wordStart[at] && text.startsWith(token, at)) {
      return { score: WORD_PREFIX - Math.min(at, 99) * 0.5, ranges: rangesOf(folded, span(at)) }
    }
  }
  const inside = text.indexOf(token)
  if (inside >= 0) {
    return { score: SUBSTRING - Math.min(inside, 99) * 0.5, ranges: rangesOf(folded, span(inside)) }
  }
  if (!allowSubsequence || token.length < 2) return null
  const sparse = bestSubsequence(token, folded)
  return sparse ? { score: sparse.score, ranges: rangesOf(folded, sparse.indices) } : null
}

function tokensOf(query: string): string[] {
  return fold(query)
    .text.split(/\s+/)
    .filter((token) => token !== '')
}

function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: MatchRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end }
    } else {
      merged.push(range)
    }
  }
  return merged
}

/**
 * Casa `query` con `text`. Cada palabra de la consulta debe aparecer (en cualquier orden); puntuación por
 * palabra: texto exacto > prefijo del texto > inicio de palabra > subcadena > subsecuencia (letras
 * salteadas). Sin diacríticos ni mayúsculas. `null` si no casa; con consulta vacía casa con puntuación 0.
 */
export function fuzzyMatch(query: string, text: string): TextMatch | null {
  const tokens = tokensOf(query)
  if (tokens.length === 0) return { score: 0, ranges: [] }
  const folded = fold(text)
  let total = 0
  const ranges: MatchRange[] = []
  for (const token of tokens) {
    const match = matchFolded(token, folded)
    if (!match) return null
    total += match.score
    ranges.push(...match.ranges)
  }
  return { score: total / tokens.length, ranges: mergeRanges(ranges) }
}

export interface SearchFields {
  /** Texto principal: el que se muestra y se resalta. */
  text: string
  keywords?: readonly string[]
  category?: string
  description?: string
}

export interface SearchOptions<T> {
  fields(item: T): SearchFields
  /** Orden de las categorías para desempatar: las primeras de la lista ganan. */
  categoryOrder?: readonly string[]
  /** Cuanto mayor, más reciente; desempata antes que la categoría. */
  recency?(item: T): number
  limit?: number
}

export type MatchedField = 'text' | 'keywords' | 'category' | 'description'

export interface SearchResult<T> {
  readonly item: T
  /** Posición de `item` en la lista original. */
  readonly index: number
  readonly score: number
  /** Rangos sobre `fields(item).text`. */
  readonly ranges: readonly MatchRange[]
  /** Campos donde casó alguna palabra, para explicar por qué aparece un resultado sin coincidencia en el título. */
  readonly matchedOn: readonly MatchedField[]
}

// Coincidir en un campo secundario vale menos que en el texto principal.
const FIELD_WEIGHT = { text: 1, keywords: 0.6, category: 0.4, description: 0.3 } as const

interface FoldedFields {
  text: Folded
  keywords: Folded[]
  category: Folded | null
  description: Folded | null
}

function foldFields(fields: SearchFields): FoldedFields {
  return {
    text: fold(fields.text),
    keywords: (fields.keywords ?? []).map(fold),
    category: fields.category === undefined ? null : fold(fields.category),
    description: fields.description === undefined ? null : fold(fields.description),
  }
}

/**
 * Filtra y ordena `items` por `query`. Las letras salteadas solo valen en el texto principal: en
 * palabras clave, categoría y descripción casaría casi cualquier cosa.
 * Con la consulta vacía devuelve todos: por recencia y categoría si se
 * dan, y si no en su orden original. El orden es estable: a igual puntuación, recencia, categoría y posición.
 */
export function searchItems<T>(
  items: readonly T[],
  query: string,
  options: SearchOptions<T>,
): SearchResult<T>[] {
  const tokens = tokensOf(query)
  const results: SearchResult<T>[] = []

  items.forEach((item, index) => {
    if (tokens.length === 0) {
      results.push({ item, index, score: 0, ranges: [], matchedOn: [] })
      return
    }
    const folded = foldFields(options.fields(item))
    let total = 0
    const ranges: MatchRange[] = []
    const matchedOn = new Set<MatchedField>()

    for (const token of tokens) {
      const inText = matchFolded(token, folded.text)
      const candidates: [MatchedField, TextMatch | null][] = [
        ['text', inText],
        ...folded.keywords.map((keyword): [MatchedField, TextMatch | null] => [
          'keywords',
          matchFolded(token, keyword, false),
        ]),
        ['category', folded.category ? matchFolded(token, folded.category, false) : null],
        ['description', folded.description ? matchFolded(token, folded.description, false) : null],
      ]
      let best = 0
      let bestField: MatchedField | undefined
      for (const [field, match] of candidates) {
        const weighted = match ? match.score * FIELD_WEIGHT[field] : 0
        if (weighted > best) {
          best = weighted
          bestField = field
        }
      }
      if (bestField === undefined) return
      total += best
      matchedOn.add(bestField)
      if (inText) ranges.push(...inText.ranges)
    }
    results.push({
      item,
      index,
      score: total / tokens.length,
      ranges: mergeRanges(ranges),
      matchedOn: [...matchedOn],
    })
  })

  const categoryRank = (item: T): number => {
    const order = options.categoryOrder
    if (!order) return 0
    const at = order.indexOf(options.fields(item).category ?? '')
    return at < 0 ? order.length : at
  }
  const recencyOf = options.recency ?? (() => 0)

  results.sort(
    (a, b) =>
      b.score - a.score ||
      recencyOf(b.item) - recencyOf(a.item) ||
      categoryRank(a.item) - categoryRank(b.item) ||
      a.index - b.index,
  )
  return options.limit === undefined ? results : results.slice(0, options.limit)
}

/** Distancia de edición de Damerau-Levenshtein (con transposiciones) para sugerir «¿quisiste decir…?». */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const rows = a.length + 1
  const cols = b.length + 1
  const table: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(
        table[i - 1]![j]! + 1,
        table[i]![j - 1]! + 1,
        table[i - 1]![j - 1]! + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, table[i - 2]![j - 2]! + 1)
      }
      table[i]![j] = value
    }
  }
  return table[a.length]![b.length]!
}
