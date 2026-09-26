import type { AiSqlRisk, AiSqlStatementType, AiWarning, Engine } from '@strata/contracts'
import { AI_SQL_MAX_LENGTH } from '@strata/contracts'
import { analyzeSql, type AnalyzedStatement } from '@strata/db-core'
import { aiError } from './errors'
import { hasStatementForm } from './statement-forms'

export interface ExtractedSql {
  text: string
  warnings: AiWarning[]
}

export interface ClassifiedSql {
  sql: string
  risk: AiSqlRisk
  statementType: AiSqlStatementType
  warnings: AiWarning[]
}

// Razonamiento de Qwen3 y afines. Un bloque sin cerrar (la respuesta se cortó pensando) se descarta hasta el final.
const THINK_BLOCK = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const UNCLOSED_THINK = /<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*$/i
// Algunas plantillas abren `<think>` en el propio prompt: la respuesta trae solo el cierre.
const ORPHAN_THINK_CLOSE = /^[\s\S]*<\/(?:think|thinking|reasoning)\s*>/i

const SQL_FENCE_LANGUAGES: ReadonlySet<string> = new Set([
  '',
  'sql',
  'sqlite',
  'postgres',
  'postgresql',
  'pgsql',
  'psql',
  'plpgsql',
])
const FENCE = /```([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)(?:```|$)/g

// Primera línea que empieza una sentencia con seguridad: una palabra suelta como «Show» o «Table» también abre frases.
const STATEMENT_START =
  /^[ \t]*(?:\(\s*)*(?:select\b|with\s+(?:recursive\s+)?(?:"[^"]+"|`[^`]+`|\w+)(?:\s*\([^)]*\))?\s+as\b|insert\s+into\b|replace\s+into\b|update\s+(?:"[^"]+"|`[^`]+`|[\w.]+)\s+set\b|delete\s+from\b|create\b|alter\s+table\b|drop\b|truncate\b|explain\b|show\b|pragma\b|values\s*\()/im

// Párrafo que cierra la respuesta con una explicación en lugar de más SQL.
const PROSE_OPENER =
  /^(?:this|these|the|note|notes|explanation|here|in this|it|it's|which|that|i|you|to|\*\*|#{1,6}\s|[-*]\s|\d+[.)]\s)/i

/**
 * La salida del modelo es texto no confiable: se le quitan el razonamiento, las vallas de código y la prosa
 * alrededor hasta dejar solo lo que parece una sentencia. Lo que queda todavía no es de fiar: `classifySql` lo analiza.
 */
export function extractSql(raw: string): ExtractedSql {
  const warnings = new Set<AiWarning>()
  let text = raw

  const withoutThinking = text
    .replace(THINK_BLOCK, '')
    .replace(UNCLOSED_THINK, '')
    .replace(ORPHAN_THINK_CLOSE, '')
  if (withoutThinking !== text) warnings.add('reasoning_removed')
  text = withoutThinking.trim()

  const fenced = firstSqlFence(text)
  if (fenced !== undefined) {
    warnings.add('formatting_removed')
    text = fenced
  } else {
    // Una valla sin salto de línea o sin cerrar, o todo el texto entre comillas invertidas simples.
    const unwrapped = text.replace(/```[A-Za-z]*/g, '').replace(/^`([^`\n]+)`$/, '$1')
    if (unwrapped !== text) warnings.add('formatting_removed')
    text = unwrapped
  }

  const start = STATEMENT_START.exec(text)
  if (start && start.index > 0) {
    text = text.slice(start.index)
    warnings.add('formatting_removed')
  }

  const withoutTrailingProse = dropTrailingProse(text)
  if (withoutTrailingProse !== text) warnings.add('formatting_removed')

  return { text: withoutTrailingProse.trim(), warnings: [...warnings] }
}

function firstSqlFence(text: string): string | undefined {
  for (const match of text.matchAll(FENCE)) {
    const language = (match[1] ?? '').toLowerCase()
    const body = (match[2] ?? '').trim()
    if (SQL_FENCE_LANGUAGES.has(language) && body !== '') return body
  }
  return undefined
}

function dropTrailingProse(text: string): string {
  const paragraphs = text.split(/\r?\n[ \t]*\r?\n/)
  const kept: string[] = []
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index > 0 && PROSE_OPENER.test(paragraph.trimStart())) break
    kept.push(paragraph)
  }
  return kept.join('\n\n')
}

// El prompt pide responder exactamente `-- CANNOT_ANSWER` cuando el esquema no basta; algunos modelos omiten los guiones.
// Solo cuenta si es toda la respuesta: una sentencia real que mencione la palabra (en una cadena) sigue siendo SQL.
const CANNOT_ANSWER_MARKER = /^[\s\-/*]*CANNOT_ANSWER[\s\-/*.]*$/i

function riskOf(statement: AnalyzedStatement): AiSqlRisk {
  if (statement.isDestructive) return 'destructive'
  if (statement.changesMode) return 'unknown'
  if (statement.type === 'query') return statement.isWrite ? 'write' : 'read'
  if (statement.type === 'dml' || statement.type === 'ddl') return 'write'
  return 'unknown'
}

/**
 * Exactamente una sentencia reconocible (ADR 0012): lo que sigue a la primera solo se tolera si no parece SQL (prosa cortada
 * por punto y coma), nunca se ejecuta ni se devuelve. Con dos sentencias reconocibles se rechaza todo el texto.
 */
export function classifySql(engine: Engine, extracted: ExtractedSql): ClassifiedSql {
  if (extracted.text.length > AI_SQL_MAX_LENGTH) {
    throw aiError('validation_failed', 'The generated SQL is too long', false)
  }
  if (CANNOT_ANSWER_MARKER.test(extracted.text)) {
    throw aiError('cannot_answer', 'The model could not answer with the available schema', false)
  }
  const [first, ...rest] = analyzeSql(engine, extracted.text)
  // `other` es lo que `analyzeSql` no reconoce como sentencia (prosa incluida): sin sentencia real no hay nada que abrir.
  // PRAGMA, SHOW, SET, EXPLAIN y el control de transacciones tienen su propio tipo y siguen pasando.
  if (!first || first.type === 'other') {
    throw aiError('validation_failed', 'The model did not produce a SQL statement', false)
  }
  if (!hasStatementForm(first.text)) {
    throw aiError('validation_failed', 'The model did not produce a SQL statement', false)
  }
  if (rest.some((statement) => statement.type !== 'other')) {
    throw aiError('validation_failed', 'The model produced more than one SQL statement', false)
  }

  const warnings = new Set(extracted.warnings)
  if (rest.length > 0) warnings.add('formatting_removed')

  return {
    sql: first.text,
    risk: riskOf(first),
    statementType: first.type,
    warnings: [...warnings],
  }
}
