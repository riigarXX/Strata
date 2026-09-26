import { describe, expect, it } from 'vitest'
import { qualifiedTableName, quoteIdentifier } from './identifiers'

describe('quoteIdentifier (postgres)', () => {
  const quote = (name: string) => quoteIdentifier('postgres', name)

  it('leaves simple lowercase identifiers bare', () => {
    expect(quote('users')).toBe('users')
    expect(quote('_tmp')).toBe('_tmp')
    expect(quote('order_items2')).toBe('order_items2')
  })

  it('quotes identifiers that the server would fold or reject', () => {
    expect(quote('Users')).toBe('"Users"')
    expect(quote('userId')).toBe('"userId"')
    expect(quote('my table')).toBe('"my table"')
    expect(quote('order-items')).toBe('"order-items"')
    expect(quote('2fast')).toBe('"2fast"')
    expect(quote('a$b')).toBe('"a$b"')
    expect(quote('café')).toBe('"café"')
    expect(quote('')).toBe('""')
    expect(quote(' padded ')).toBe('" padded "')
  })

  it('doubles embedded double quotes', () => {
    expect(quote('say "hi"')).toBe('"say ""hi"""')
    expect(quote('"')).toBe('""""')
  })

  it('quotes reserved words regardless of case, but not non-reserved ones', () => {
    expect(quote('user')).toBe('"user"')
    expect(quote('order')).toBe('"order"')
    expect(quote('select')).toBe('"select"')
    expect(quote('table')).toBe('"table"')
    expect(quote('left')).toBe('"left"')
    expect(quote('name')).toBe('name')
    expect(quote('type')).toBe('type')
    expect(quote('time')).toBe('time')
    expect(quote('users')).toBe('users')
  })

  it('does not treat a quote or newline as part of a bare identifier', () => {
    expect(quote('a\nb')).toBe('"a\nb"')
    expect(quote('a;drop table x')).toBe('"a;drop table x"')
  })
})

describe('quoteIdentifier (sqlite)', () => {
  const quote = (name: string) => quoteIdentifier('sqlite', name)

  it('leaves case-insensitive identifiers bare, uppercase included', () => {
    expect(quote('users')).toBe('users')
    expect(quote('Users')).toBe('Users')
    expect(quote('order_items')).toBe('order_items')
  })

  it('quotes spaces, hyphens, leading digits and embedded quotes', () => {
    expect(quote('my table')).toBe('"my table"')
    expect(quote('order-items')).toBe('"order-items"')
    expect(quote('1st')).toBe('"1st"')
    expect(quote('a"b')).toBe('"a""b"')
    expect(quote('')).toBe('""')
  })

  it('quotes keywords in any case', () => {
    expect(quote('index')).toBe('"index"')
    expect(quote('Group')).toBe('"Group"')
    expect(quote('TABLE')).toBe('"TABLE"')
    expect(quote('values')).toBe('"values"')
  })
})

describe('qualifiedTableName', () => {
  it('always qualifies with the schema in postgres', () => {
    expect(qualifiedTableName('postgres', { schema: 'public', name: 'users' })).toBe('public.users')
    expect(qualifiedTableName('postgres', { schema: 'Sales', name: 'Order Items' })).toBe(
      '"Sales"."Order Items"',
    )
    expect(qualifiedTableName('postgres', { schema: 'public', name: 'user' })).toBe('public."user"')
  })

  it('omits the default `main` schema in sqlite', () => {
    expect(qualifiedTableName('sqlite', { schema: 'main', name: 'users' })).toBe('users')
    expect(qualifiedTableName('sqlite', { schema: 'main', name: 'My Table' })).toBe('"My Table"')
  })

  it('keeps qualifying temp and attached databases in sqlite', () => {
    expect(qualifiedTableName('sqlite', { schema: 'temp', name: 'scratch' })).toBe('"temp".scratch')
    expect(qualifiedTableName('sqlite', { schema: 'archive', name: 'old' })).toBe('archive.old')
    expect(qualifiedTableName('sqlite', { schema: 'archive db', name: 't' })).toBe('"archive db".t')
  })
})
