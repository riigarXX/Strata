import { QueryEventSchema, type QueryEvent, type Session } from '@strata/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_CELL_BYTES, MAX_CHUNK_BYTES } from '../result-limits'
import { liveBytes } from '../test-live-memory'
import { createSqliteAdapter } from './adapter'
import {
  collect,
  COUNT_TO,
  createTempDatabase,
  eventsOfType,
  queryRequest,
  removeTempDirs,
  sqliteProfile,
} from './test-support'

const adapter = createSqliteAdapter()
const sessions: Session[] = []

async function open() {
  const { filePath } = createTempDatabase()
  const session = await adapter.connect(sqliteProfile(filePath))
  sessions.push(session)
  return session
}

async function chunksOf(sql: string, extra: Parameters<typeof queryRequest>[2] = {}) {
  const session = await open()
  const events = await collect(adapter.execute(queryRequest(session.sessionId, sql, extra)))
  return { events, chunks: eventsOfType(events, 'chunk') }
}

const wireBytes = (event: QueryEvent): number =>
  Buffer.byteLength(JSON.stringify(event.type === 'chunk' ? event.rows : event))

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await adapter.disconnect(session.sessionId)
  }
  removeTempDirs()
})

describe('cell limit', () => {
  it('cuts a huge blob to the first bytes of its 0x<hex> form and flags it', async () => {
    const { events, chunks } = await chunksOf(
      `SELECT zeroblob(5000000) AS zeros, x'cafe' AS small, 42 AS n`,
    )
    const [chunk] = chunks
    expect(chunks).toHaveLength(1)
    const cell = chunk?.rows[0]?.[0]
    expect(typeof cell).toBe('string')
    expect(cell).toMatch(/^0x0+$/)
    expect(Buffer.byteLength(cell as string)).toBeLessThanOrEqual(MAX_CELL_BYTES)
    expect(Buffer.byteLength(cell as string)).toBeGreaterThan(MAX_CELL_BYTES - 2)
    expect(chunk?.rows[0]?.slice(1)).toEqual(['0xcafe', 42])
    expect(chunk?.truncated).toEqual([{ row: 0, column: 0, originalBytes: 5_000_000 }])
    for (const event of events) expect(QueryEventSchema.parse(event)).toEqual(event)
  })

  it('cuts huge text produced with hex() and keeps its head', async () => {
    const { chunks } = await chunksOf(`SELECT hex(zeroblob(2000000)) AS h`)
    const cell = chunks[0]?.rows[0]?.[0] as string
    expect(cell).toBe('0'.repeat(MAX_CELL_BYTES))
    expect(chunks[0]?.truncated).toEqual([{ row: 0, column: 0, originalBytes: 4_000_000 }])
  })

  it('never splits a multibyte character when cutting text built with printf/replace', async () => {
    const { chunks } = await chunksOf(`SELECT replace(printf('%400000c', 'x'), ' ', 'é') AS t`)
    const cell = chunks[0]?.rows[0]?.[0] as string
    expect(cell).not.toContain('�')
    expect(cell).toBe('é'.repeat(MAX_CELL_BYTES / 2))
    expect(Buffer.byteLength(cell)).toBe(MAX_CELL_BYTES)
    expect(chunks[0]?.truncated).toEqual([{ row: 0, column: 0, originalBytes: 399_999 * 2 + 1 }])
  })

  it('leaves values at or under the limit untouched and unflagged', async () => {
    const { chunks } = await chunksOf(
      `SELECT hex(zeroblob(${MAX_CELL_BYTES / 2})) AS exact, zeroblob(3) AS blob, '' AS empty, NULL AS missing, 1.5 AS ratio, 9007199254740993 AS big`,
    )
    expect(chunks[0]?.rows[0]).toEqual([
      '0'.repeat(MAX_CELL_BYTES),
      '0x000000',
      '',
      null,
      1.5,
      '9007199254740993',
    ])
    expect(chunks[0]).not.toHaveProperty('truncated')
  })

  it('cuts a blob that is one byte over the binary limit and keeps one that fits', async () => {
    const keep = (MAX_CELL_BYTES - 2) / 2
    const { chunks } = await chunksOf(
      `SELECT zeroblob(${keep}) AS fits, zeroblob(${keep + 1}) AS over`,
    )
    const [fits, over] = chunks[0]?.rows[0] ?? []
    expect(Buffer.byteLength(fits as string)).toBe(MAX_CELL_BYTES)
    expect(over).toBe(fits)
    expect(chunks[0]?.truncated).toEqual([{ row: 0, column: 1, originalBytes: keep + 1 }])
  })

  it('points each truncated cell at its row (relative to the chunk) and column', async () => {
    const { chunks } = await chunksOf(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10)
       SELECT x,
              CASE WHEN x % 3 = 0 THEN hex(zeroblob(200000)) ELSE 'small' END AS a,
              x * 2 AS b,
              CASE WHEN x = 4 OR x = 9 THEN zeroblob(300000) END AS c
       FROM c`,
      { chunkSize: 4 },
    )
    expect(chunks.map((chunk) => chunk.rows.length)).toEqual([4, 4, 2])
    expect(chunks.map((chunk) => chunk.truncated)).toEqual([
      [
        { row: 2, column: 1, originalBytes: 400_000 },
        { row: 3, column: 3, originalBytes: 300_000 },
      ],
      [{ row: 1, column: 1, originalBytes: 400_000 }],
      [
        { row: 0, column: 1, originalBytes: 400_000 },
        { row: 0, column: 3, originalBytes: 300_000 },
      ],
    ])
    expect(chunks[0]?.rows[2]?.[0]).toBe(3)
    expect(chunks[1]?.rows[1]?.[0]).toBe(6)
    expect(chunks[2]?.rows[0]?.[0]).toBe(9)
  })
})

describe('chunk budget', () => {
  it('splits a chunk before chunkSize when its rows would pass the byte budget', async () => {
    const { events, chunks } = await chunksOf(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100)
       SELECT x, hex(zeroblob(200000)) AS payload FROM c`,
      { chunkSize: 500 },
    )
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.reduce((total, chunk) => total + chunk.rows.length, 0)).toBe(100)
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index))
    for (const chunk of chunks) {
      expect(chunk.rows.length).toBeGreaterThanOrEqual(1)
      expect(chunk.rows.length).toBeLessThan(500)
      expect(wireBytes(chunk)).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
      expect(chunk.truncated).toHaveLength(chunk.rows.length)
      expect(chunk.truncated?.map((cell) => cell.row)).toEqual(chunk.rows.map((_, row) => row))
    }
    expect(chunks.flatMap((chunk) => chunk.rows.map((row) => row[0]))).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    )
    expect(eventsOfType(events, 'statement_done')[0]).toMatchObject({
      rowsReturned: 100,
      truncated: false,
    })
  })

  it('does not change chunking for ordinary rows', async () => {
    const { chunks } = await chunksOf(COUNT_TO(1250), { chunkSize: 500 })
    expect(chunks.map((chunk) => chunk.rows.length)).toEqual([500, 500, 250])
    for (const chunk of chunks) expect(chunk).not.toHaveProperty('truncated')
  })

  it('still emits a chunk of one row when that single row is over the budget', async () => {
    const columns = Array.from({ length: 30 }, () => 'zeroblob(400000)').join(', ')
    const { chunks } = await chunksOf(`SELECT ${columns}`)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.rows).toHaveLength(1)
    expect(chunks[0]?.truncated).toHaveLength(30)
  })
})

describe('memory', () => {
  it('does not keep the original values alive: live memory stays flat while hundreds of MB stream through', async () => {
    const session = await open()
    const baseline = await liveBytes()
    let peak = 0
    let processed = 0
    for await (const event of adapter.execute(
      queryRequest(
        session.sessionId,
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 30) SELECT zeroblob(20000000) FROM c`,
        { chunkSize: 500 },
      ),
    )) {
      if (event.type === 'chunk') {
        processed += event.rows.length * 20_000_000
        peak = Math.max(peak, (await liveBytes()) - baseline)
      }
    }
    expect(processed).toBe(600_000_000)
    expect(peak).toBeLessThan(40 * 1024 * 1024)
  })
})
