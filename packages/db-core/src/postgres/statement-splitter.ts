export interface SqlStatement {
  readonly text: string
  // First keyword, upper-cased (SELECT, CREATE, ...), or 'SQL' when there is none.
  readonly command: string
}

export const WORD_START = /[A-Za-z_\u0080-￿]/
export const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/
export const TAG_PART = /[A-Za-z0-9_\u0080-￿]/

export function skipLineComment(sql: string, from: number): number {
  const newline = sql.indexOf('\n', from)
  return newline === -1 ? sql.length : newline
}

// Unlike SQLite, PostgreSQL block comments nest: /* a /* b */ c */ is a single comment.
export function skipBlockComment(sql: string, from: number): number {
  let depth = 1
  let i = from + 2
  while (i < sql.length && depth > 0) {
    if (sql.charAt(i) === '/' && sql.charAt(i + 1) === '*') {
      depth++
      i += 2
    } else if (sql.charAt(i) === '*' && sql.charAt(i + 1) === '/') {
      depth--
      i += 2
    } else {
      i++
    }
  }
  return i
}

// A doubled quote is the escape inside '...' and "..."; an unterminated literal swallows the rest so the server reports it.
// With `backslash` (E'...') a backslash also escapes the next character.
export function skipQuoted(sql: string, from: number, backslash = false): number {
  const quote = sql.charAt(from)
  let i = from + 1
  while (i < sql.length) {
    const ch = sql.charAt(i)
    if (backslash && ch === '\\') {
      i += 2
    } else if (ch === quote) {
      if (sql.charAt(i + 1) === quote) {
        i += 2
      } else {
        return i + 1
      }
    } else {
      i++
    }
  }
  return sql.length
}

// A dollar-quote opener is $$ or $tag$; the tag cannot start with a digit, so $1 stays a parameter marker.
export function dollarQuoteDelimiter(sql: string, from: number): string | undefined {
  let i = from + 1
  if (sql.charAt(i) !== '$') {
    if (!WORD_START.test(sql.charAt(i))) {
      return undefined
    }
    while (i < sql.length && TAG_PART.test(sql.charAt(i))) {
      i++
    }
    if (sql.charAt(i) !== '$') {
      return undefined
    }
  }
  return sql.slice(from, i + 1)
}

export function skipDollarQuoted(sql: string, from: number, delimiter: string): number {
  const end = sql.indexOf(delimiter, from + delimiter.length)
  return end === -1 ? sql.length : end + delimiter.length
}

export function readWord(sql: string, from: number): string {
  let i = from + 1
  while (i < sql.length && WORD_PART.test(sql.charAt(i))) {
    i++
  }
  return sql.slice(from, i)
}

function isRoutineStatement(words: readonly string[]): boolean {
  return words[0] === 'CREATE' && (words.includes('FUNCTION') || words.includes('PROCEDURE'))
}

// The server takes one statement per request, so a document is split with PostgreSQL's own lexical rules:
// a ';' inside a literal, a comment, a dollar-quoted body or a BEGIN ATOMIC ... END body does not end the statement.
// Assumes standard_conforming_strings = on (the default): backslashes are only special inside E'...'.
export function splitPostgresStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = []
  let start = 0
  let hasContent = false
  let words: string[] = []
  let inAtomicBody = false
  let caseDepth = 0
  let previousWord = ''
  let i = 0

  const finishStatement = (end: number): void => {
    if (hasContent) {
      statements.push({ text: sql.slice(start, end).trim(), command: words[0] ?? 'SQL' })
    }
    start = end + 1
    hasContent = false
    words = []
    inAtomicBody = false
    caseDepth = 0
    previousWord = ''
  }

  while (i < sql.length) {
    const ch = sql.charAt(i)

    if (/\s/.test(ch)) {
      i++
    } else if (ch === '-' && sql.charAt(i + 1) === '-') {
      i = skipLineComment(sql, i)
    } else if (ch === '/' && sql.charAt(i + 1) === '*') {
      i = skipBlockComment(sql, i)
    } else if (ch === "'" || ch === '"') {
      hasContent = true
      i = skipQuoted(sql, i)
      previousWord = ''
    } else if (ch === '$') {
      hasContent = true
      const delimiter = dollarQuoteDelimiter(sql, i)
      i = delimiter === undefined ? i + 1 : skipDollarQuoted(sql, i, delimiter)
      previousWord = ''
    } else if (ch === ';' && !inAtomicBody) {
      finishStatement(i)
      i++
    } else if (WORD_START.test(ch)) {
      const word = readWord(sql, i)
      const upper = word.toUpperCase()
      hasContent = true
      i += word.length

      // E'...' is the only prefix that changes how a string is scanned.
      if (upper === 'E' && sql.charAt(i) === "'") {
        i = skipQuoted(sql, i, true)
        previousWord = ''
        continue
      }

      if (words.length < 6) {
        words.push(upper)
      }
      if (inAtomicBody) {
        if (upper === 'CASE') {
          caseDepth++
        } else if (upper === 'END') {
          if (caseDepth > 0) {
            caseDepth--
          } else {
            inAtomicBody = false
          }
        }
      } else if (upper === 'ATOMIC' && previousWord === 'BEGIN' && isRoutineStatement(words)) {
        inAtomicBody = true
      }
      previousWord = upper
    } else {
      hasContent = true
      previousWord = ''
      i++
    }
  }

  finishStatement(sql.length)
  return statements
}
