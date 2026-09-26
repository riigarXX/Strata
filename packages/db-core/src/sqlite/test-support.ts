import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { QueryEvent, QueryRequest } from '@strata/contracts'
import Database from 'better-sqlite3'
import { buildSync } from 'esbuild'
import type { DatabaseAdapter, ResolvedSqliteProfile } from '../adapter'
import { createSqliteAdapter, type SqliteAdapterOptions } from './adapter'

let workerPath: string | undefined

// The worker runs as plain JavaScript in a real thread, so tests bundle it once. The output lives next to the package so `better-sqlite3` (left external, as in the desktop build) resolves from its node_modules.
export function sqliteWorkerPath(): string {
  if (!workerPath) {
    const outfile = fileURLToPath(
      new URL('../../node_modules/.cache/sqlite-worker/worker.cjs', import.meta.url),
    )
    buildSync({
      entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['better-sqlite3'],
      logLevel: 'silent',
    })
    workerPath = outfile
  }
  return workerPath
}

export function createTestAdapter(options: Partial<SqliteAdapterOptions> = {}): DatabaseAdapter {
  return createSqliteAdapter({ workerPath: sqliteWorkerPath(), ...options })
}

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
