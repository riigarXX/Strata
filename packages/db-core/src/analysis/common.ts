import type { SqlToken } from './tokens'

export type SqlStatementType = 'query' | 'dml' | 'ddl' | 'transaction' | 'session' | 'other'

export interface Classification {
  readonly type: SqlStatementType
  // May change data or schema (or has an effect that cannot be ruled out); unrecognized statements count as writes.
  readonly isWrite: boolean
  // Changes the session or server mode: SET/RESET, ALTER SYSTEM, PRAGMA writes, a READ WRITE transaction, set_config().
  readonly changesMode: boolean
  readonly isDestructive: boolean
}

export const QUERY: Classification = {
  type: 'query',
  isWrite: false,
  changesMode: false,
  isDestructive: false,
}
export const TRANSACTION: Classification = { ...QUERY, type: 'transaction' }
export const UNKNOWN: Classification = { ...QUERY, type: 'other', isWrite: true }
export const MODE_CHANGE: Classification = { ...QUERY, type: 'session', changesMode: true }
export const DDL: Classification = { ...QUERY, type: 'ddl', isWrite: true }
export const DML: Classification = { ...QUERY, type: 'dml', isWrite: true }

export const isWord = (token: SqlToken | undefined, value?: string): boolean =>
  token?.kind === 'word' && (value === undefined || token.value === value)

export const isPunct = (token: SqlToken | undefined, value: string): boolean =>
  token?.kind === 'punct' && token.value === value

// Leading parentheses are skipped so "(SELECT 1) UNION ..." is read by its first keyword.
export function withoutLeadingParens(tokens: readonly SqlToken[]): readonly SqlToken[] {
  let start = 0
  while (isPunct(tokens[start], '(')) start++
  return tokens.slice(start)
}

export const hasWord = (tokens: readonly SqlToken[], ...values: string[]): boolean =>
  tokens.some((token) => token.kind === 'word' && values.includes(token.value))

// Words that let a read statement modify data: DML inside a CTE, SELECT ... INTO, row locks.
const DML_WORDS: readonly string[] = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO']

export function containsDml(tokens: readonly SqlToken[]): boolean {
  return tokens.some((token, index) => {
    if (token.kind !== 'word' || !DML_WORDS.includes(token.value)) return false
    // The UPDATE of a locking clause is not a statement: hasLockingClause reports it.
    const previous = tokens[index - 1]
    return !(token.value === 'UPDATE' && (isWord(previous, 'FOR') || isWord(previous, 'KEY')))
  })
}

// SELECT ... FOR UPDATE / FOR SHARE / FOR KEY SHARE / FOR NO KEY UPDATE take row locks, which a read-only session rejects.
export function hasLockingClause(tokens: readonly SqlToken[]): boolean {
  return tokens.some(
    (token, index) =>
      isWord(token, 'FOR') &&
      ['UPDATE', 'SHARE', 'KEY', 'NO'].includes(tokens[index + 1]?.value ?? '') &&
      tokens[index + 1]?.kind === 'word',
  )
}

// Names (upper-cased) of functions called with side effects a read-only session must not reach.
export function callsFunction(
  tokens: readonly SqlToken[],
  matches: (name: string) => boolean,
): boolean {
  return tokens.some(
    (token, index) =>
      (token.kind === 'word' || token.kind === 'ident') &&
      isPunct(tokens[index + 1], '(') &&
      matches(token.value),
  )
}

// DELETE/UPDATE that is not the trailing part of ON DELETE/ON UPDATE (foreign keys), FOR UPDATE, DO UPDATE (upsert) or a MERGE branch.
const NOT_A_STATEMENT_HEAD: ReadonlySet<string> = new Set([
  'ON',
  'FOR',
  'DO',
  'KEY',
  'THEN',
  'AFTER',
  'BEFORE',
  'OF',
])

// A DELETE or UPDATE with no WHERE at its own nesting level, wherever it appears (including inside a CTE).
export function hasUnfilteredDeleteOrUpdate(tokens: readonly SqlToken[]): boolean {
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (isPunct(token, '(')) depth++
    else if (isPunct(token, ')')) depth--
    else if (isWord(token, 'DELETE') || isWord(token, 'UPDATE')) {
      const previous = tokens[i - 1]
      if (previous?.kind === 'word' && NOT_A_STATEMENT_HEAD.has(previous.value)) continue
      if (!hasWhereAtLevel(tokens, i + 1, depth)) return true
    }
  }
  return false
}

function hasWhereAtLevel(tokens: readonly SqlToken[], from: number, level: number): boolean {
  let depth = level
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i]
    if (isPunct(token, '(')) depth++
    else if (isPunct(token, ')')) {
      depth--
      if (depth < level) return false
    } else if (depth === level && isWord(token, 'WHERE')) return true
  }
  return false
}

export function isDestructiveDdl(first: string, tokens: readonly SqlToken[]): boolean {
  if (first === 'DROP' || first === 'TRUNCATE') return true
  return first === 'ALTER' && hasWord(tokens, 'DROP')
}

export type Classifier = (tokens: readonly SqlToken[]) => Classification
