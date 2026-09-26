import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueryEvent, QueryRequest } from '@strata/contracts'
import Database from 'better-sqlite3'
import type { ResolvedSqliteProfile } from '../adapter'

const tempDirs: string[] = []

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Real SQLite files in a throwaway directory: nothing in these tests is mocked.
export function createTempDatabase(setupSql = ''): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'strata-sqlite-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'fixture.sqlite')
  const db = new Database(filePath)
  if (setupSql) {
    db.exec(setupSql)
  }
  db.close()
  return { dir, filePath }
}

export function sqliteProfile(filePath: string, readOnly = false): ResolvedSqliteProfile {
  return { id: 'profile-1', name: 'fixture', engine: 'sqlite', filePath, readOnly }
}

export function queryRequest(
  sessionId: string,
  sql: string,
  extra: Partial<QueryRequest> = {},
): QueryRequest {
  return { requestId: `req-${Math.random().toString(36).slice(2)}`, sessionId, sql, ...extra }
}

export async function collect(events: AsyncIterable<QueryEvent>): Promise<QueryEvent[]> {
  const collected: QueryEvent[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

export function eventsOfType<T extends QueryEvent['type']>(
  events: readonly QueryEvent[],
  type: T,
): Extract<QueryEvent, { type: T }>[] {
  return events.filter((event): event is Extract<QueryEvent, { type: T }> => event.type === type)
}

export const COUNT_TO = (limit: number): string =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${limit}) SELECT x FROM c`
