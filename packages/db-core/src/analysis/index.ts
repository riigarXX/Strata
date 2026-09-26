import type { Engine } from '@strata/contracts'
import { splitPostgresStatements } from '../postgres/statement-splitter'
import { splitSqliteStatements } from '../sqlite/statement-splitter'
import type { Classification, Classifier, SqlStatementType } from './common'
import { classifyPostgres } from './postgres'
import { classifySqlite } from './sqlite'
import { tokenizePostgres, tokenizeSqlite } from './tokens'

export type { SqlStatementType }

export interface AnalyzedStatement {
  readonly text: string
  // First keyword, upper-cased, as reported by the dialect's statement splitter.
  readonly command: string
  readonly type: SqlStatementType
  readonly isWrite: boolean
  // DROP, TRUNCATE, ALTER ... DROP, and DELETE/UPDATE without WHERE. A UX heuristic (ADR 0004), not a security barrier.
  readonly isDestructive: boolean
  readonly changesMode: boolean
  // Allow-list verdict for read-only profiles: only recognized reads and plain transaction control pass; anything unclear does not.
  readonly allowedInReadOnly: boolean
}

interface Dialect {
  readonly split: (sql: string) => { text: string; command: string }[]
  readonly tokenize: typeof tokenizePostgres
  readonly classify: Classifier
}

const DIALECTS: Readonly<Record<Engine, Dialect>> = {
  postgres: {
    split: splitPostgresStatements,
    tokenize: tokenizePostgres,
    classify: classifyPostgres,
  },
  sqlite: { split: splitSqliteStatements, tokenize: tokenizeSqlite, classify: classifySqlite },
}

function isAllowedInReadOnly({ type, isWrite, changesMode }: Classification): boolean {
  return !isWrite && !changesMode && (type === 'query' || type === 'transaction')
}

/**
 * Pure and driver-free: splits the document with the dialect's own splitter (the same one the adapter
 * executes with, so what is analyzed is what runs) and classifies each statement from its tokens, where
 * comments and literals are already gone.
 */
export function analyzeSql(engine: Engine, sql: string): AnalyzedStatement[] {
  const dialect = DIALECTS[engine]
  return dialect.split(sql).map(({ text, command }) => {
    const classification = dialect.classify(dialect.tokenize(text))
    return {
      text,
      command,
      type: classification.type,
      isWrite: classification.isWrite,
      isDestructive: classification.isDestructive,
      changesMode: classification.changesMode,
      allowedInReadOnly: isAllowedInReadOnly(classification),
    }
  })
}

export function findReadOnlyViolation(engine: Engine, sql: string): AnalyzedStatement | undefined {
  return analyzeSql(engine, sql).find((statement) => !statement.allowedInReadOnly)
}
