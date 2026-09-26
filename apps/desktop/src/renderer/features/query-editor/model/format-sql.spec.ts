import { describe, expect, it } from 'vitest'
import { formatSql } from './format-sql'

describe('formatSql', () => {
  it('lays out the query and separates statements with a blank line', async () => {
    expect(await formatSql('select a, b from t where a = 1; select 2', 'sqlite')).toBe(
      'select\n  a,\n  b\nfrom\n  t\nwhere\n  a = 1;\n\nselect\n  2',
    )
  })

  it('uses the PostgreSQL dialect only for postgres sessions', async () => {
    const query = 'select a::int from t'
    expect(await formatSql(query, 'postgres')).toBe('select\n  a::int\nfrom\n  t')
    await expect(formatSql(query, 'sqlite')).rejects.toThrow('Parse error')
    await expect(formatSql(query, null)).rejects.toThrow('Parse error')
  })
})
