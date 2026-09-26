import {
  dollarQuoteDelimiter,
  readWord as readPostgresWord,
  skipBlockComment as skipPostgresBlockComment,
  skipDollarQuoted,
  skipLineComment as skipPostgresLineComment,
  skipQuoted as skipPostgresQuoted,
  WORD_START as POSTGRES_WORD_START,
} from '../postgres/statement-splitter'
import {
  readWord as readSqliteWord,
  skipBlockComment as skipSqliteBlockComment,
  skipBracketed,
  skipLineComment as skipSqliteLineComment,
  skipQuoted as skipSqliteQuoted,
  WORD_START as SQLITE_WORD_START,
} from '../sqlite/statement-splitter'

// 'word' is a bare keyword or identifier (upper-cased); 'ident' a quoted identifier (upper-cased content);
// 'string' any literal (its content is never inspected, so a keyword inside one can never be mistaken for code).
export type SqlTokenKind = 'word' | 'ident' | 'string' | 'number' | 'punct'

export interface SqlToken {
  readonly kind: SqlTokenKind
  readonly value: string
}

const NUMBER_PART = /[0-9A-Za-z_.]/
const DIGIT = /[0-9]/

// A number is one token so that "1." can never be read as a number followed by a stray "." and a keyword.
function readNumber(sql: string, from: number): number {
  let i = from + 1
  while (i < sql.length) {
    const ch = sql.charAt(i)
    const exponentSign = (ch === '+' || ch === '-') && /[eE]/.test(sql.charAt(i - 1))
    if (!NUMBER_PART.test(ch) && !exponentSign) break
    i++
  }
  return i
}

function unquote(sql: string, start: number, end: number, quote: string): string {
  const closed = end - start >= 2 && sql.charAt(end - 1) === quote
  const inner = sql.slice(start + 1, closed ? end - 1 : end)
  return inner
    .split(quote + quote)
    .join(quote)
    .toUpperCase()
}

interface Scanner {
  readonly wordStart: RegExp
  readonly readWord: (sql: string, from: number) => string
  readonly skipLineComment: (sql: string, from: number) => number
  readonly skipBlockComment: (sql: string, from: number) => number
  // Consumes whatever is dialect specific (dollar quotes, brackets, backticks, E'...'); undefined when `ch` is not one of them.
  readonly special: (sql: string, from: number, tokens: SqlToken[]) => number | undefined
}

function tokenize(sql: string, scanner: Scanner): SqlToken[] {
  const tokens: SqlToken[] = []
  let i = 0

  while (i < sql.length) {
    const ch = sql.charAt(i)

    if (/\s/.test(ch)) {
      i++
    } else if (ch === '-' && sql.charAt(i + 1) === '-') {
      i = scanner.skipLineComment(sql, i)
    } else if (ch === '/' && sql.charAt(i + 1) === '*') {
      i = scanner.skipBlockComment(sql, i)
    } else if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(sql.charAt(i + 1)))) {
      const end = readNumber(sql, i)
      tokens.push({ kind: 'number', value: sql.slice(i, end) })
      i = end
    } else {
      const next = scanner.special(sql, i, tokens)
      if (next !== undefined) {
        i = next
      } else if (scanner.wordStart.test(ch)) {
        const word = scanner.readWord(sql, i)
        tokens.push({ kind: 'word', value: word.toUpperCase() })
        i += word.length
      } else {
        tokens.push({ kind: 'punct', value: ch })
        i++
      }
    }
  }
  return tokens
}

const postgresScanner: Scanner = {
  wordStart: POSTGRES_WORD_START,
  readWord: readPostgresWord,
  skipLineComment: skipPostgresLineComment,
  // PostgreSQL block comments nest.
  skipBlockComment: skipPostgresBlockComment,
  special(sql, from, tokens) {
    const ch = sql.charAt(from)
    if (ch === "'") {
      tokens.push({ kind: 'string', value: '' })
      return skipPostgresQuoted(sql, from)
    }
    if (ch === '"') {
      const end = skipPostgresQuoted(sql, from)
      tokens.push({ kind: 'ident', value: unquote(sql, from, end, '"') })
      return end
    }
    if (ch === '$') {
      const delimiter = dollarQuoteDelimiter(sql, from)
      if (delimiter === undefined) return undefined
      tokens.push({ kind: 'string', value: '' })
      return skipDollarQuoted(sql, from, delimiter)
    }
    // E'...' is the only prefix that changes how a string is scanned (backslash escapes).
    if ((ch === 'E' || ch === 'e') && sql.charAt(from + 1) === "'") {
      const previous = sql.charAt(from - 1)
      if (from === 0 || !/[A-Za-z0-9_$\u0080-￿]/.test(previous)) {
        tokens.push({ kind: 'string', value: '' })
        return skipPostgresQuoted(sql, from + 1, true)
      }
    }
    return undefined
  },
}

const sqliteScanner: Scanner = {
  wordStart: SQLITE_WORD_START,
  readWord: readSqliteWord,
  skipLineComment: skipSqliteLineComment,
  skipBlockComment: skipSqliteBlockComment,
  special(sql, from, tokens) {
    const ch = sql.charAt(from)
    if (ch === "'") {
      tokens.push({ kind: 'string', value: '' })
      return skipSqliteQuoted(sql, from)
    }
    if (ch === '"' || ch === '`') {
      const end = skipSqliteQuoted(sql, from)
      tokens.push({ kind: 'ident', value: unquote(sql, from, end, ch) })
      return end
    }
    if (ch === '[') {
      const end = skipBracketed(sql, from)
      const closed = sql.charAt(end - 1) === ']' && end - from >= 2
      tokens.push({
        kind: 'ident',
        value: sql.slice(from + 1, closed ? end - 1 : end).toUpperCase(),
      })
      return end
    }
    return undefined
  },
}

export const tokenizePostgres = (sql: string): SqlToken[] => tokenize(sql, postgresScanner)
export const tokenizeSqlite = (sql: string): SqlToken[] => tokenize(sql, sqliteScanner)
