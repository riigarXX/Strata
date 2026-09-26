import { describe, expect, it } from 'vitest'
import { editDistance, fuzzyMatch, searchItems, type MatchRange } from './fuzzy'

const highlighted = (text: string, ranges: readonly MatchRange[]): string[] =>
  ranges.map((range) => text.slice(range.start, range.end))

describe('fuzzyMatch scoring', () => {
  it('ranks exact > prefix > word start > substring > subsequence', () => {
    const exact = fuzzyMatch('tabla', 'Tabla')!.score
    const prefix = fuzzyMatch('tab', 'Tabla nueva')!.score
    const wordStart = fuzzyMatch('nue', 'Tabla nueva')!.score
    const substring = fuzzyMatch('ueva', 'Tabla nueva')!.score
    const subsequence = fuzzyMatch('tnv', 'Tabla nueva')!.score
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(subsequence)
    expect(subsequence).toBeGreaterThan(0)
  })

  it('returns null when the query does not match', () => {
    expect(fuzzyMatch('xyz', 'Nueva pestaña')).toBeNull()
    expect(fuzzyMatch('pv', 'Nueva pestaña')).toBeNull()
    expect(fuzzyMatch('a', '')).toBeNull()
    expect(fuzzyMatch('nueva pestañas', 'Nueva pestaña')).toBeNull()
  })

  it('matches everything with an empty query', () => {
    expect(fuzzyMatch('', 'Cualquier cosa')).toEqual({ score: 0, ranges: [] })
    expect(fuzzyMatch('   ', 'Cualquier cosa')).toEqual({ score: 0, ranges: [] })
  })

  it('ignores case and diacritics on both sides', () => {
    expect(fuzzyMatch('pestana', 'Nueva pestaña SQL')).not.toBeNull()
    expect(fuzzyMatch('PESTAÑA', 'nueva pestana sql')).not.toBeNull()
    expect(fuzzyMatch('conexion', 'Gestionar conexiones')).not.toBeNull()
    expect(fuzzyMatch('éxito', 'exito')!.score).toBe(1000)
  })

  it('prefers shorter texts among equal prefix matches and earlier positions among substrings', () => {
    expect(fuzzyMatch('ej', 'Ejecutar')!.score).toBeGreaterThan(
      fuzzyMatch('ej', 'Ejecutar todo el documento')!.score,
    )
    expect(fuzzyMatch('ec', 'xecx')!.score).toBeGreaterThan(fuzzyMatch('ec', 'xxxxecx')!.score)
  })

  it('requires every word of the query, in any order', () => {
    expect(fuzzyMatch('sql nueva', 'Nueva pestaña SQL')).not.toBeNull()
    expect(fuzzyMatch('nueva zzz', 'Nueva pestaña SQL')).toBeNull()
  })

  it('averages the words so a long query does not outrank a better match', () => {
    const both = fuzzyMatch('nueva pest', 'Nueva pestaña')!.score
    expect(both).toBeLessThanOrEqual(900)
    expect(both).toBeGreaterThan(700)
  })

  it('treats separators such as dots, underscores and hyphens as word starts', () => {
    const dotted = fuzzyMatch('users', 'public.users')!
    expect(dotted.score).toBeGreaterThan(700)
    expect(fuzzyMatch('ord', 'user_orders')!.score).toBeGreaterThan(700)
    expect(fuzzyMatch('ord', 'reorder')!.score).toBeLessThan(700)
  })

  it('does not treat a single missing letter as a match', () => {
    expect(fuzzyMatch('z', 'Nueva pestaña')).toBeNull()
    expect(fuzzyMatch('nv', 'Nueva')).not.toBeNull()
  })

  it('keeps subsequence scores below every contiguous match', () => {
    const longSubsequence = fuzzyMatch('nuevapestanasql', 'Nueva pestaña SQL')!
    expect(longSubsequence.score).toBeLessThanOrEqual(500)
    expect(fuzzyMatch('sql', 'x sql')!.score).toBeGreaterThan(longSubsequence.score)
  })

  it('prefers a subsequence anchored at word starts over a scattered one', () => {
    const anchored = fuzzyMatch('nps', 'Nueva pestaña SQL')!.score
    const scattered = fuzzyMatch('nps', 'nxxxxxxxxpxxxxxxxxs')!.score
    expect(anchored).toBeGreaterThan(scattered)
  })
})

describe('fuzzyMatch ranges', () => {
  it('highlights the matched prefix', () => {
    const match = fuzzyMatch('nue', 'Nueva pestaña')!
    expect(match.ranges).toEqual([{ start: 0, end: 3 }])
    expect(highlighted('Nueva pestaña', match.ranges)).toEqual(['Nue'])
  })

  it('highlights a word start in the middle', () => {
    expect(fuzzyMatch('pest', 'Nueva pestaña')!.ranges).toEqual([{ start: 6, end: 10 }])
  })

  it('reports ranges over the original text, diacritics included', () => {
    const text = 'Nueva pestaña SQL'
    const match = fuzzyMatch('pestana', text)!
    expect(highlighted(text, match.ranges)).toEqual(['pestaña'])
  })

  it('highlights scattered letters of a subsequence and merges adjacent ones', () => {
    const text = 'Nueva pestaña SQL'
    const match = fuzzyMatch('nps', text)!
    expect(highlighted(text, match.ranges)).toEqual(['N', 'p', 'S'])
    const run = fuzzyMatch('nvp', 'Nueva pestaña')!
    expect(run.ranges.length).toBeGreaterThan(0)
    for (const range of run.ranges) expect(range.end).toBeGreaterThan(range.start)
  })

  it('combines the ranges of several words, sorted and merged', () => {
    const text = 'Nueva pestaña SQL'
    const match = fuzzyMatch('sql nueva', text)!
    expect(highlighted(text, match.ranges)).toEqual(['Nueva', 'SQL'])
    const overlap = fuzzyMatch('nue nueva', 'Nueva pestaña')!
    expect(overlap.ranges).toEqual([{ start: 0, end: 5 }])
  })

  it('never splits a surrogate pair', () => {
    const text = '📊 Tablas'
    const match = fuzzyMatch('tab', text)!
    expect(highlighted(text, match.ranges)).toEqual(['Tab'])
    expect(fuzzyMatch('📊', text)!.ranges).toEqual([{ start: 0, end: 2 }])
  })
})

interface Item {
  id: string
  title: string
  category?: string
  keywords?: string[]
  description?: string
  recent?: number
}

const fields = (item: Item) => ({
  text: item.title,
  ...(item.category === undefined ? {} : { category: item.category }),
  ...(item.keywords === undefined ? {} : { keywords: item.keywords }),
  ...(item.description === undefined ? {} : { description: item.description }),
})

const ids = (results: { item: Item }[]) => results.map((result) => result.item.id)

describe('searchItems', () => {
  const items: Item[] = [
    { id: 'new', title: 'Nueva pestaña SQL', category: 'Pestañas', keywords: ['tab', 'crear'] },
    { id: 'close', title: 'Cerrar pestaña', category: 'Pestañas' },
    { id: 'run', title: 'Ejecutar', category: 'Consulta', description: 'Ejecuta la consulta' },
    { id: 'runAll', title: 'Ejecutar todo', category: 'Consulta' },
    { id: 'theme', title: 'Cambiar tema', category: 'Aplicación', keywords: ['oscuro', 'claro'] },
  ]

  it('returns everything in the original order for an empty query', () => {
    const results = searchItems(items, '', { fields })
    expect(ids(results)).toEqual(['new', 'close', 'run', 'runAll', 'theme'])
    expect(results.every((result) => result.score === 0 && result.ranges.length === 0)).toBe(true)
  })

  it('filters and orders by score, best first', () => {
    const results = searchItems(items, 'ejec', { fields })
    expect(ids(results)).toEqual(['run', 'runAll'])
    expect(results[0]!.ranges).toEqual([{ start: 0, end: 4 }])
  })

  it('finds by keyword, category or description when the title does not match', () => {
    expect(ids(searchItems(items, 'oscuro', { fields }))).toEqual(['theme'])
    expect(searchItems(items, 'oscuro', { fields })[0]!.matchedOn).toEqual(['keywords'])
    expect(searchItems(items, 'oscuro', { fields })[0]!.ranges).toEqual([])
    expect(ids(searchItems(items, 'aplicacion', { fields }))).toEqual(['theme'])
    expect(ids(searchItems(items, 'ejecuta la', { fields }))[0]).toBe('run')
  })

  it('ranks a title match above a keyword, category or description match of the same quality', () => {
    const results = searchItems(
      [
        { id: 'keyword', title: 'Otra cosa', keywords: ['tema'] },
        { id: 'title', title: 'Tema' },
        { id: 'category', title: 'Algo', category: 'Tema' },
        { id: 'description', title: 'Nada', description: 'Tema' },
      ],
      'tema',
      { fields },
    )
    expect(ids(results)).toEqual(['title', 'keyword', 'category', 'description'])
  })

  it('accepts a word in the title and another in a different field', () => {
    expect(ids(searchItems(items, 'pestana pestanas', { fields })).sort()).toEqual(['close', 'new'])
    expect(ids(searchItems(items, 'cerrar pest', { fields }))).toEqual(['close'])
    expect(ids(searchItems(items, 'sql crear', { fields }))).toEqual(['new'])
  })

  it('only allows skipped letters in the main text, not in secondary fields', () => {
    const list: Item[] = [
      { id: 'sparse-title', title: 'Cerrar pestaña' },
      {
        id: 'sparse-description',
        title: 'Otra cosa',
        description: 'Activa la pestaña de la derecha',
      },
    ]
    expect(ids(searchItems(list, 'cprn', { fields }))).toEqual([])
    expect(ids(searchItems(list, 'cpna', { fields }))).toEqual(['sparse-title'])
  })

  it('is stable: equal scores keep the original order', () => {
    const same = [
      { id: 'a', title: 'Abrir' },
      { id: 'b', title: 'Abrir' },
      { id: 'c', title: 'Abrir' },
    ]
    expect(ids(searchItems(same, 'abr', { fields }))).toEqual(['a', 'b', 'c'])
    expect(searchItems(same, 'abr', { fields }).map((result) => result.index)).toEqual([0, 1, 2])
  })

  it('breaks ties by recency first, then category order, then position', () => {
    const tied: Item[] = [
      { id: 'a', title: 'Abrir', category: 'B', recent: 0 },
      { id: 'b', title: 'Abrir', category: 'A', recent: 0 },
      { id: 'c', title: 'Abrir', category: 'B', recent: 5 },
      { id: 'd', title: 'Abrir', category: 'C', recent: 0 },
    ]
    const byRecency = searchItems(tied, 'abr', {
      fields,
      recency: (item) => item.recent ?? 0,
      categoryOrder: ['A', 'B'],
    })
    expect(ids(byRecency)).toEqual(['c', 'b', 'a', 'd'])

    const byCategory = searchItems(tied, 'abr', { fields, categoryOrder: ['C', 'B', 'A'] })
    expect(ids(byCategory)).toEqual(['d', 'a', 'c', 'b'])
  })

  it('never lets recency beat a better match', () => {
    const results = searchItems(
      [
        { id: 'weak', title: 'x abrir', recent: 100 },
        { id: 'strong', title: 'Abrir', recent: 0 },
      ],
      'abr',
      { fields, recency: (item) => item.recent ?? 0 },
    )
    expect(ids(results)).toEqual(['strong', 'weak'])
  })

  it('orders an empty query by recency and category too', () => {
    const results = searchItems(
      [
        { id: 'a', title: 'A', category: 'Z', recent: 0 },
        { id: 'b', title: 'B', category: 'Y', recent: 0 },
        { id: 'c', title: 'C', category: 'Z', recent: 9 },
      ],
      '',
      { fields, recency: (item) => item.recent ?? 0, categoryOrder: ['Y', 'Z'] },
    )
    expect(ids(results)).toEqual(['c', 'b', 'a'])
  })

  it('places unknown categories after the listed ones', () => {
    const results = searchItems(
      [
        { id: 'other', title: 'Abrir', category: 'Otra' },
        { id: 'known', title: 'Abrir', category: 'A' },
        { id: 'none', title: 'Abrir' },
      ],
      'abrir',
      { fields, categoryOrder: ['A'] },
    )
    expect(ids(results)).toEqual(['known', 'other', 'none'])
  })

  it('limits the number of results after ordering', () => {
    expect(ids(searchItems(items, '', { fields, limit: 2 }))).toEqual(['new', 'close'])
  })

  it('works on large collections without slowing down', () => {
    const many = Array.from({ length: 5000 }, (_, index) => ({
      id: String(index),
      title: `public.tabla_de_ejemplo_numero_${index}`,
    }))
    const started = Date.now()
    const results = searchItems(many, 'tdn4', { fields })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(results.length).toBeGreaterThan(0)
  })
})

describe('editDistance', () => {
  it('counts insertions, deletions, substitutions and transpositions', () => {
    expect(editDistance('tables', 'tables')).toBe(0)
    expect(editDistance('tabels', 'tables')).toBe(1)
    expect(editDistance('conect', 'connect')).toBe(1)
    expect(editDistance('themes', 'theme')).toBe(1)
    expect(editDistance('abc', 'xyz')).toBe(3)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('abc', '')).toBe(3)
  })
})
