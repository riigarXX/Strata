import {
  callsFunction,
  containsDml,
  DDL,
  DML,
  hasUnfilteredDeleteOrUpdate,
  hasWord,
  isDestructiveDdl,
  isPunct,
  isWord,
  MODE_CHANGE,
  QUERY,
  TRANSACTION,
  UNKNOWN,
  withoutLeadingParens,
  type Classification,
} from './common'
import type { SqlToken } from './tokens'

const DML_COMMANDS: ReadonlySet<string> = new Set(['INSERT', 'REPLACE', 'UPDATE', 'DELETE'])
const DDL_COMMANDS: ReadonlySet<string> = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'REINDEX',
  'ANALYZE',
  'VACUUM',
  'ATTACH',
  'DETACH',
])
const TRANSACTION_COMMANDS: ReadonlySet<string> = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
])

// PRAGMAs that only report state: allowed as "PRAGMA name" (no value) and, for those that take a table or index name, as "PRAGMA name(arg)".
const READ_PRAGMAS: ReadonlySet<string> = new Set([
  'DATABASE_LIST',
  'COLLATION_LIST',
  'COMPILE_OPTIONS',
  'FUNCTION_LIST',
  'MODULE_LIST',
  'PRAGMA_LIST',
  'FREELIST_COUNT',
  'PAGE_COUNT',
  'PAGE_SIZE',
  'ENCODING',
  'USER_VERSION',
  'APPLICATION_ID',
  'SCHEMA_VERSION',
  'DATA_VERSION',
  'FOREIGN_KEYS',
  'JOURNAL_MODE',
  'SYNCHRONOUS',
  'CACHE_SIZE',
  'BUSY_TIMEOUT',
  'QUERY_ONLY',
  'READ_UNCOMMITTED',
  'MAX_PAGE_COUNT',
  'LOCKING_MODE',
  'AUTO_VACUUM',
  'TEMP_STORE',
  'RECURSIVE_TRIGGERS',
  'SECURE_DELETE',
  'DEFER_FOREIGN_KEYS',
])
const READ_PRAGMAS_WITH_ARGUMENT: ReadonlySet<string> = new Set([
  'TABLE_INFO',
  'TABLE_XINFO',
  'TABLE_LIST',
  'INDEX_LIST',
  'INDEX_INFO',
  'INDEX_XINFO',
  'FOREIGN_KEY_LIST',
  'FOREIGN_KEY_CHECK',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
])

function isReadPragma(tokens: readonly SqlToken[]): boolean {
  // PRAGMA [schema.]name [= value | (value)]
  const qualified = isPunct(tokens[2], '.')
  const nameToken = tokens[qualified ? 3 : 1]
  const rest = tokens.slice(qualified ? 4 : 2)
  if (nameToken?.kind !== 'word') return false
  const name = nameToken.value

  if (rest.length === 0) return READ_PRAGMAS.has(name) || READ_PRAGMAS_WITH_ARGUMENT.has(name)
  const parenthesized = isPunct(rest[0], '(') && isPunct(rest[rest.length - 1], ')')
  return (
    READ_PRAGMAS_WITH_ARGUMENT.has(name) &&
    parenthesized &&
    !rest.some((token) => isPunct(token, '='))
  )
}

// A bare REPLACE (not the replace() function) starts REPLACE INTO, which is an INSERT.
function hasReplaceStatement(tokens: readonly SqlToken[]): boolean {
  return tokens.some((token, i) => isWord(token, 'REPLACE') && !isPunct(tokens[i + 1], '('))
}

function classifyRead(tokens: readonly SqlToken[]): Classification {
  if (containsDml(tokens) || hasReplaceStatement(tokens)) {
    return { ...DML, isDestructive: hasUnfilteredDeleteOrUpdate(tokens) }
  }
  // load_extension() is disabled by default but must never be reachable in a read-only session.
  return { ...QUERY, isWrite: callsFunction(tokens, (name) => name === 'LOAD_EXTENSION') }
}

export function classifySqlite(all: readonly SqlToken[]): Classification {
  const tokens = withoutLeadingParens(all)
  const first = tokens[0]?.kind === 'word' ? tokens[0].value : undefined
  if (first === undefined) return UNKNOWN

  if (first === 'SELECT' || first === 'VALUES' || first === 'WITH') return classifyRead(all)
  // EXPLAIN and EXPLAIN QUERY PLAN only compile the statement: nothing is executed.
  if (first === 'EXPLAIN') return QUERY
  if (DML_COMMANDS.has(first)) {
    return { ...DML, isDestructive: hasUnfilteredDeleteOrUpdate(tokens) }
  }
  if (DDL_COMMANDS.has(first)) return { ...DDL, isDestructive: isDestructiveDdl(first, tokens) }
  if (first === 'PRAGMA') return isReadPragma(tokens) ? QUERY : MODE_CHANGE
  if (TRANSACTION_COMMANDS.has(first)) {
    // BEGIN IMMEDIATE/EXCLUSIVE take the write lock up front.
    return first === 'BEGIN' && hasWord(tokens, 'IMMEDIATE', 'EXCLUSIVE')
      ? { ...TRANSACTION, changesMode: true }
      : TRANSACTION
  }
  return UNKNOWN
}
