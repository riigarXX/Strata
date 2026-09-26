// Comandos con palabra clave suelta («Do», «Set», «Show», «Grant»…): el analizador los tipifica por la primera palabra,
// así que una frase que empiece igual pasa por sentencia. Cada comando declara la forma sintáctica mínima que lo hace SQL.
const IDENT = String.raw`(?:"[^"]+"|[\w$]+)`
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`
const IDENT_LIST = String.raw`${IDENT}(?:\s*,\s*${IDENT})*`
const OPTIONS = String.raw`(?:\s*\([^)]*\))?`

const FORMS: Readonly<Record<string, RegExp>> = {
  DO: /^do\s+(?:language\s+\S+\s+)?(?:\$|e?')/i,
  CALL: new RegExp(String.raw`^call\s+${QUALIFIED}\s*\(`, 'i'),
  EXECUTE: new RegExp(String.raw`^execute\s+${IDENT}\s*(?:\(|$)`, 'i'),
  SET: new RegExp(
    String.raw`^set\s+(?:(?:session|local)\s+)?(?:time\s+zone\b|names\b|role\b|schema\b|transaction\b|constraints\b|session\s+(?:authorization|characteristics)\b|${QUALIFIED}\s*(?:=|to\b))`,
    'i',
  ),
  RESET: new RegExp(
    String.raw`^reset\s+(?:all|role|session\s+authorization|${QUALIFIED})\s*$`,
    'i',
  ),
  DISCARD: /^discard\s+(?:all|plans|sequences|temp|temporary)\s*$/i,
  SHOW: new RegExp(
    String.raw`^show\s+(?:all|time\s+zone|transaction\s+isolation\s+level|session\s+authorization|${QUALIFIED})\s*$`,
    'i',
  ),
  VACUUM: new RegExp(
    String.raw`^(?:vacuum|analy[sz]e)(?:${OPTIONS}|\s+(?:full|freeze|verbose|analy[sz]e|skip_locked)\b)*(?:\s+${QUALIFIED}${OPTIONS}(?:\s*,\s*${QUALIFIED}${OPTIONS})*)?(?:\s+into\s+'[^']*')?\s*$`,
    'i',
  ),
  GRANT: new RegExp(
    String.raw`^grant\s+(?:.+\s+on\s+\S|${IDENT_LIST}\s+to\s+${IDENT_LIST}(?:\s+with\s+.*)?$)`,
    'i',
  ),
  REVOKE: new RegExp(
    String.raw`^revoke\s+(?:.+\s+on\s+\S|(?:\w+\s+option\s+for\s+)?${IDENT_LIST}\s+from\s+${IDENT_LIST}(?:\s+.*)?$)`,
    'i',
  ),
  COMMENT: /^comment\s+on\s+\S/i,
  REFRESH: /^refresh\s+materialized\s+view\b/i,
  REASSIGN: /^reassign\s+owned\s+by\b/i,
  SECURITY: /^security\s+label\b/i,
  IMPORT: /^import\s+foreign\s+schema\b/i,
  MERGE: /^merge\s+into\b/i,
  COPY: new RegExp(
    String.raw`^copy\s+(?:\([\s\S]*\)|${QUALIFIED}${OPTIONS})\s+(?:from|to)\s+(?:stdin|stdout|program\b|')`,
    'i',
  ),
  TABLE: new RegExp(String.raw`^table\s+(?:only\s+)?${QUALIFIED}\s*$`, 'i'),
  VALUES: /^values\s*\(/i,
  REPLACE: /^replace\s+into\b/i,
  START: /^start\s+transaction\b/i,
  BEGIN: transactionForm('begin'),
  COMMIT: transactionForm('commit'),
  END: transactionForm('end'),
  ABORT: transactionForm('abort'),
  ROLLBACK: transactionForm('rollback'),
  SAVEPOINT: new RegExp(String.raw`^savepoint\s+${IDENT}\s*$`, 'i'),
  RELEASE: new RegExp(String.raw`^release(?:\s+savepoint)?\s+${IDENT}\s*$`, 'i'),
  REINDEX: new RegExp(
    String.raw`^reindex${OPTIONS}(?:\s+(?:index|table|schema|database|system|concurrently)\b)*(?:\s+${QUALIFIED})?\s*$`,
    'i',
  ),
  CLUSTER: new RegExp(
    String.raw`^cluster(?:\s+verbose)?(?:\s+${QUALIFIED}(?:\s+using\s+${IDENT})?)?\s*$`,
    'i',
  ),
  ATTACH: /^attach\s+(?:database\s+)?\S+\s+as\s+\S/i,
  DETACH: new RegExp(String.raw`^detach(?:\s+database)?\s+${IDENT}\s*$`, 'i'),
  PRAGMA: new RegExp(String.raw`^pragma\s+(?:${IDENT}\s*\.\s*)?${IDENT}\s*(?:=|\(|$)`, 'i'),
  EXPLAIN:
    /^explain\s+(?:query\s+plan\s+)?(?:\(|(?:analy[sz]e|verbose)\b|(?:select|with|insert|update|delete|values|table|merge|create|declare|execute)\b)/i,
}

function transactionForm(keyword: string): RegExp {
  const tail = String.raw`(?:work|transaction|immediate|deferred|exclusive|isolation\s+level\s+(?:read\s+(?:un)?committed|repeatable\s+read|serializable)|read\s+(?:only|write)|(?:not\s+)?deferrable|and\s+(?:no\s+)?chain|to\s+(?:savepoint\s+)?${IDENT}|prepared\s+'[^']*')`
  return new RegExp(String.raw`^${keyword}(?:\s*,?\s+${tail})*\s*$`, 'i')
}

// Palabras que abren SQL sin ambigüedad: con ellas no hace falta más comprobación que la del analizador.
const STRONG_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
])

const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/
// Ningún SQL termina en punto o cierre de interrogación/exclamación ni lleva signos de apertura españoles.
const SENTENCE_PUNCTUATION = /[.?!…]\s*$|[¿¡]/
const SQL_SYNTAX = /[=()'"`*<>|%$+/\\@#[\]{}]/

/**
 * Comprobación estructural para sentencias que el analizador tipificó por su primera palabra: false si el texto es prosa
 * que casualmente empieza con un comando (p. ej. «Do you mean…?»). Nunca se aplica a SELECT, INSERT y demás palabras fuertes.
 */
export function hasStatementForm(text: string): boolean {
  const body = text.replace(LEADING_COMMENTS, '').replace(/[\s;]+$/, '')
  const keyword = /^[A-Za-z]+/.exec(body)?.[0].toUpperCase()
  if (keyword === undefined || STRONG_KEYWORDS.has(keyword)) return true

  const form = FORMS[keyword]
  if (form !== undefined && !form.test(body)) return false
  return !(SENTENCE_PUNCTUATION.test(body) && !SQL_SYNTAX.test(body) && /\s/.test(body))
}
