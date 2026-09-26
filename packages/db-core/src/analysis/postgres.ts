import {
  callsFunction,
  containsDml,
  DDL,
  DML,
  hasLockingClause,
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

const READ_COMMANDS: ReadonlySet<string> = new Set(['SELECT', 'VALUES', 'TABLE', 'WITH'])
const DML_COMMANDS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  // COPY may write to a table or run a program, CALL/DO/EXECUTE run code that cannot be inspected here.
  'COPY',
  'CALL',
  'DO',
  'EXECUTE',
])
const DDL_COMMANDS: ReadonlySet<string> = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'COMMENT',
  'GRANT',
  'REVOKE',
  'REINDEX',
  'CLUSTER',
  'VACUUM',
  'ANALYZE',
  'ANALYSE',
  'REFRESH',
  'REASSIGN',
  'SECURITY',
  'IMPORT',
])
const MODE_COMMANDS: ReadonlySet<string> = new Set(['SET', 'RESET', 'DISCARD'])
const TRANSACTION_COMMANDS: ReadonlySet<string> = new Set([
  'BEGIN',
  'START',
  'COMMIT',
  'END',
  'ROLLBACK',
  'ABORT',
  'SAVEPOINT',
  'RELEASE',
])

// set_config() can switch default_transaction_read_only off from inside a SELECT, so it is a mode change.
const MODE_FUNCTIONS: ReadonlySet<string> = new Set(['SET_CONFIG'])
const WRITE_FUNCTIONS: ReadonlySet<string> = new Set([
  'NEXTVAL',
  'SETVAL',
  'LO_IMPORT',
  'LO_EXPORT',
  'LO_CREATE',
  'LO_CREAT',
  'LO_UNLINK',
  'LO_PUT',
  'LO_FROM_BYTEA',
  'LO_TRUNCATE',
  'LOWRITE',
  'PG_TERMINATE_BACKEND',
  'PG_CANCEL_BACKEND',
  'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE',
  'PG_SWITCH_WAL',
  'PG_CREATE_RESTORE_POINT',
])
const WRITE_FUNCTION_PREFIXES: readonly string[] = [
  'DBLINK',
  'PG_STAT_RESET',
  'PG_FILE_',
  'PG_CREATE_',
  'PG_DROP_',
]

const isWriteFunction = (name: string): boolean =>
  WRITE_FUNCTIONS.has(name) || WRITE_FUNCTION_PREFIXES.some((prefix) => name.startsWith(prefix))

function classifyRead(tokens: readonly SqlToken[]): Classification {
  if (containsDml(tokens)) {
    // "SELECT ... INTO" creates a table; anything else that reached here contains INSERT/UPDATE/DELETE/MERGE.
    const createsTable = hasWord(tokens, 'INTO') && !hasWord(tokens, 'INSERT', 'MERGE')
    return {
      ...(createsTable ? DDL : DML),
      isDestructive: hasUnfilteredDeleteOrUpdate(tokens),
    }
  }
  const changesMode = callsFunction(tokens, (name) => MODE_FUNCTIONS.has(name))
  const isWrite = hasLockingClause(tokens) || callsFunction(tokens, isWriteFunction)
  return { ...QUERY, isWrite, changesMode }
}

// EXPLAIN only plans the statement; ANALYZE (bare or as an option, whatever its value) also runs it.
function classifyExplain(tokens: readonly SqlToken[]): Classification {
  let index = 1
  let analyze = false
  if (isPunct(tokens[index], '(')) {
    let depth = 0
    for (; index < tokens.length; index++) {
      const token = tokens[index]
      if (isPunct(token, '(')) depth++
      else if (isPunct(token, ')') && --depth === 0) {
        index++
        break
      } else if (isWord(token, 'ANALYZE') || isWord(token, 'ANALYSE')) analyze = true
    }
  } else {
    while (['ANALYZE', 'ANALYSE', 'VERBOSE'].includes(tokens[index]?.value ?? '')) {
      if (tokens[index]?.value !== 'VERBOSE') analyze = true
      index++
    }
  }
  if (!analyze) return QUERY
  const inner = tokens.slice(index)
  return inner.length === 0 ? UNKNOWN : classifyPostgres(inner)
}

export function classifyPostgres(all: readonly SqlToken[]): Classification {
  const tokens = withoutLeadingParens(all)
  const first = tokens[0]?.kind === 'word' ? tokens[0].value : undefined
  const second = tokens[1]?.kind === 'word' ? tokens[1].value : undefined
  if (first === undefined) return UNKNOWN

  if (READ_COMMANDS.has(first)) return classifyRead(all)
  if (first === 'SHOW') return QUERY
  if (first === 'EXPLAIN') return classifyExplain(tokens)
  if (DML_COMMANDS.has(first)) {
    return { ...DML, isDestructive: hasUnfilteredDeleteOrUpdate(tokens) }
  }
  if (first === 'ALTER' && second === 'SYSTEM') return MODE_CHANGE
  if (DDL_COMMANDS.has(first)) return { ...DDL, isDestructive: isDestructiveDdl(first, tokens) }
  if (MODE_COMMANDS.has(first)) return MODE_CHANGE
  if (TRANSACTION_COMMANDS.has(first)) {
    // Two-phase commit (PREPARE TRANSACTION, COMMIT/ROLLBACK PREPARED) is not plain transaction control.
    if (second === 'PREPARED') return UNKNOWN
    // BEGIN/START TRANSACTION READ WRITE overrides default_transaction_read_only for that transaction.
    const opensTransaction = first === 'BEGIN' || first === 'START'
    return opensTransaction && hasWord(tokens, 'WRITE')
      ? { ...TRANSACTION, changesMode: true }
      : TRANSACTION
  }
  return UNKNOWN
}
