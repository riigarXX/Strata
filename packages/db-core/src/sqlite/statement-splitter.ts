export interface SqlStatement {
  readonly text: string
  // First keyword, upper-cased (SELECT, CREATE, ...), or 'SQL' when there is none.
  readonly command: string
}

export const WORD_START = /[A-Za-z_\u0080-￿]/
export const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/

export function skipLineComment(sql: string, from: number): number {
  const newline = sql.indexOf('\n', from)
  return newline === -1 ? sql.length : newline
}

export function skipBlockComment(sql: string, from: number): number {
  const end = sql.indexOf('*/', from + 2)
  return end === -1 ? sql.length : end + 2
}

// A doubled quote is the escape inside '...', "..." and `...`; an unterminated literal swallows the rest so SQLite reports it.
export function skipQuoted(sql: string, from: number): number {
  const quote = sql.charAt(from)
  let i = from + 1
  while (i < sql.length) {
    if (sql.charAt(i) === quote) {
      if (sql.charAt(i + 1) === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return sql.length
}

// Bracket identifiers ([name]) have no escape sequence.
export function skipBracketed(sql: string, from: number): number {
  const end = sql.indexOf(']', from + 1)
  return end === -1 ? sql.length : end + 1
}

export function readWord(sql: string, from: number): string {
  let i = from + 1
  while (i < sql.length && WORD_PART.test(sql.charAt(i))) {
    i++
  }
  return sql.slice(from, i)
}

function isTriggerStatement(words: readonly string[]): boolean {
  const [first, second, third] = words
  if (first !== 'CREATE') {
    return false
  }
  return (
    second === 'TRIGGER' || ((second === 'TEMP' || second === 'TEMPORARY') && third === 'TRIGGER')
  )
}

// better-sqlite3 prepares one statement at a time, so a document must be split with SQLite's own lexical rules:
// a ';' inside a literal, a comment or a CREATE TRIGGER ... BEGIN ... END body does not end the statement.
export function splitSqliteStatements(sql: string): SqlStatement[] {
  const statements: SqlStatement[] = []
  let start = 0
  let hasContent = false
  let words: string[] = []
  let inTriggerBody = false
  let caseDepth = 0
  let previous = ''
  let i = 0

  const finishStatement = (end: number): void => {
    if (hasContent) {
      statements.push({ text: sql.slice(start, end).trim(), command: words[0] ?? 'SQL' })
    }
    start = end + 1
    hasContent = false
    words = []
    inTriggerBody = false
    caseDepth = 0
    previous = ''
  }

  while (i < sql.length) {
    const ch = sql.charAt(i)

    if (/\s/.test(ch)) {
      i++
    } else if (ch === '-' && sql.charAt(i + 1) === '-') {
      i = skipLineComment(sql, i)
    } else if (ch === '/' && sql.charAt(i + 1) === '*') {
      i = skipBlockComment(sql, i)
    } else if (ch === "'" || ch === '"' || ch === '`') {
      hasContent = true
      i = skipQuoted(sql, i)
      previous = ch
    } else if (ch === '[') {
      hasContent = true
      i = skipBracketed(sql, i)
      previous = ']'
    } else if (ch === ';' && !inTriggerBody) {
      finishStatement(i)
      i++
    } else if (WORD_START.test(ch)) {
      const word = readWord(sql, i)
      const upper = word.toUpperCase()
      hasContent = true
      i += word.length

      // A word after '.' is a qualified name (NEW.end), never a keyword.
      if (previous !== '.') {
        if (words.length < 3) {
          words.push(upper)
        }
        if (inTriggerBody) {
          if (upper === 'CASE') {
            caseDepth++
          } else if (upper === 'END') {
            if (caseDepth > 0) {
              caseDepth--
            } else {
              inTriggerBody = false
            }
          }
        } else if (upper === 'BEGIN' && isTriggerStatement(words)) {
          inTriggerBody = true
        }
      }
      previous = word.charAt(word.length - 1)
    } else {
      hasContent = true
      previous = ch
      i++
    }
  }

  finishStatement(sql.length)
  return statements
}
