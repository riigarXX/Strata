import { PostgreSQL, SQLite, StandardSQL } from '@codemirror/lang-sql'
import { describe, expect, it } from 'vitest'
import { formatterDialect, highlightDialect } from './dialects'

describe('dialects', () => {
  it('maps each engine to its CodeMirror dialect, defaulting to standard SQL', () => {
    expect(highlightDialect('postgres')).toBe(PostgreSQL)
    expect(highlightDialect('sqlite')).toBe(SQLite)
    expect(highlightDialect(null)).toBe(StandardSQL)
  })

  it('maps each engine to its sql-formatter dialect, defaulting to standard SQL', () => {
    expect(formatterDialect('postgres')).toBe('postgresql')
    expect(formatterDialect('sqlite')).toBe('sqlite')
    expect(formatterDialect(null)).toBe('sql')
  })
})
