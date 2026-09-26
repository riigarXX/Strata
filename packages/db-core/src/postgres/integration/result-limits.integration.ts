import { QueryEventSchema, type QueryEvent, type Session } from '@strata/contracts'
import { afterEach, expect, it } from 'vitest'
import { MAX_CELL_BYTES, MAX_CHUNK_BYTES } from '../../result-limits'
import { liveBytes } from '../../test-live-memory'
import { createPostgresAdapter } from '../adapter'
import {
  describeEachTarget,
  eventsOfType,
  last,
  profileFor,
  queryRequest,
  run,
  type PgTarget,
} from './support'

const adapter = createPostgresAdapter()
const sessions: Session[] = []

async function open(target: PgTarget) {
  const session = await adapter.connect(profileFor(target))
  sessions.push(session)
  return session
}

// What crosses IPC must survive structured clone and the contracts' own schema.
function expectIpcSafe(events: readonly QueryEvent[]): void {
  for (const event of events) {
    expect(QueryEventSchema.parse(event)).toEqual(event)
    expect(structuredClone(event)).toEqual(event)
  }
}

const wireBytes = (rows: unknown): number => Buffer.byteLength(JSON.stringify(rows))

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await adapter.disconnect(session.sessionId)
  }
})

describeEachTarget('PostgreSQL result limits', (target) => {
  async function chunksOf(sql: string, extra: Parameters<typeof queryRequest>[2] = {}) {
    const session = await open(target)
    const events = await run(adapter, session, sql, extra)
    expect(last(events).type).toBe('done')
    expectIpcSafe(events)
    return { session, events, chunks: eventsOfType(events, 'chunk') }
  }

  it('cuts a 5 MB text and flags its row and column', async () => {
    const { chunks } = await chunksOf(`SELECT 7 AS id, repeat('x', 5000000) AS body`)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.rows).toEqual([[7, 'x'.repeat(MAX_CELL_BYTES)]])
    expect(chunks[0]?.truncated).toEqual([{ row: 0, column: 1, originalBytes: 5_000_000 }])
  })

  it('cuts multibyte text on a character boundary', async () => {
    const { chunks } = await chunksOf(`SELECT repeat('日', 300000) AS t`)
    const cell = chunks[0]?.rows[0]?.[0] as string
    expect(cell).toBe('日'.repeat(Math.floor(MAX_CELL_BYTES / 3)))
    expect(Buffer.byteLength(cell)).toBeLessThanOrEqual(MAX_CELL_BYTES)
    expect(chunks[0]?.truncated).toEqual([{ row: 0, column: 0, originalBytes: 900_000 }])
  })

  it('cuts a large bytea to the first bytes of its 0x<hex> form', async () => {
    const { chunks } = await chunksOf(
      `SELECT decode(repeat('ab', 3000000), 'hex') AS big, '\\xdeadbeef'::bytea AS small`,
    )
    const [big, small] = chunks[0]?.rows[0] ?? []
    expect(big).toBe(`0x${'ab'.repeat((MAX_CELL_BYTES - 2) / 2)}`)
    expect(Buffer.byteLength(big as string)).toBe(MAX_CELL_BYTES)
    expect(small).toBe('0xdeadbeef')
    expect(chunks[0]?.truncated).toEqual([{ row: 0, column: 0, originalBytes: 3_000_000 }])
  })

  it('cuts a large jsonb, json and array as text', async () => {
    const { chunks } = await chunksOf(
      `SELECT jsonb_build_object('k', repeat('y', 4000000)) AS j,
              json_build_array(repeat('z', 500000)) AS js,
              ARRAY[repeat('a', 400000), 'b'] AS arr`,
    )
    expect(chunks[0]?.columns.map((column) => column.kind)).toEqual(['json', 'json', 'array'])
    const [jsonb, json, array] = chunks[0]?.rows[0] as string[]
    expect(jsonb?.startsWith('{"k": "yyy')).toBe(true)
    expect(Buffer.byteLength(jsonb as string)).toBe(MAX_CELL_BYTES)
    expect(json?.startsWith('["zzz')).toBe(true)
    expect(array?.startsWith('{aaa')).toBe(true)
    expect(chunks[0]?.truncated).toEqual([
      { row: 0, column: 0, originalBytes: 4_000_009 },
      { row: 0, column: 1, originalBytes: 500_004 },
      { row: 0, column: 2, originalBytes: 400_004 },
    ])
  })

  it('leaves ordinary cells, values at the limit and empty values untouched', async () => {
    const { chunks } = await chunksOf(
      `SELECT 1 AS n, true AS b, 9223372036854775807::bigint AS big, '2024-01-15 10:30:00+00'::timestamptz AS ts,
              NULL::text AS missing, '' AS empty, repeat('e', ${MAX_CELL_BYTES}) AS exact,
              decode(repeat('00', ${(MAX_CELL_BYTES - 2) / 2}), 'hex') AS exact_bytes`,
    )
    expect(chunks[0]?.rows[0]).toEqual([
      1,
      true,
      '9223372036854775807',
      '2024-01-15T10:30:00+00:00',
      null,
      '',
      'e'.repeat(MAX_CELL_BYTES),
      `0x${'00'.repeat((MAX_CELL_BYTES - 2) / 2)}`,
    ])
    expect(chunks[0]).not.toHaveProperty('truncated')
  })

  it('cuts a value one byte over the limit', async () => {
    const { chunks } = await chunksOf(`SELECT repeat('e', ${MAX_CELL_BYTES + 1}) AS over`)
    expect(chunks[0]?.rows[0]?.[0]).toBe('e'.repeat(MAX_CELL_BYTES))
    expect(chunks[0]?.truncated).toEqual([{ row: 0, column: 0, originalBytes: MAX_CELL_BYTES + 1 }])
  })

  it('points each truncated cell at its row (relative to the chunk) and column', async () => {
    const { chunks } = await chunksOf(
      `SELECT g AS n,
              CASE WHEN g % 3 = 0 THEN repeat('z', 400000) ELSE 'small' END AS a,
              g * 2 AS b,
              CASE WHEN g = 4 OR g = 9 THEN decode(repeat('ff', 300000), 'hex') END AS c
       FROM generate_series(1, 10) g`,
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

  it('splits chunks by byte budget before chunkSize and never emits an empty one', async () => {
    const { events, chunks } = await chunksOf(
      `SELECT g AS n, repeat('q', 300000) AS payload FROM generate_series(1, 100) g`,
      { chunkSize: 500 },
    )
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index))
    for (const chunk of chunks) {
      expect(chunk.rows.length).toBeGreaterThanOrEqual(1)
      expect(chunk.rows.length).toBeLessThan(500)
      expect(wireBytes(chunk.rows)).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
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

  it('emits a one-row chunk when a single row is over the budget', async () => {
    const columns = Array.from({ length: 30 }, () => `repeat('w', 400000)`).join(', ')
    const { chunks } = await chunksOf(`SELECT ${columns}`)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.rows).toHaveLength(1)
    expect(chunks[0]?.truncated).toHaveLength(30)
  })

  it('keeps ordinary chunking, including chunkSize 1 and an empty result', async () => {
    const small = await chunksOf('SELECT g FROM generate_series(1, 1250) g', { chunkSize: 500 })
    expect(small.chunks.map((chunk) => chunk.rows.length)).toEqual([500, 500, 250])
    for (const chunk of small.chunks) expect(chunk).not.toHaveProperty('truncated')

    const single = await chunksOf('SELECT g FROM generate_series(1, 4) g', { chunkSize: 1 })
    expect(single.chunks.map((chunk) => chunk.rows.length)).toEqual([1, 1, 1, 1])

    const empty = await chunksOf(`SELECT repeat('x', 10) AS a WHERE false`)
    expect(empty.chunks).toMatchObject([{ rows: [], columns: [{ name: 'a' }] }])
  })

  it('honors maxRows with big rows and leaves the session usable', async () => {
    const { session, events, chunks } = await chunksOf(
      `SELECT g, repeat('m', 1000000) AS body FROM generate_series(1, 50) g`,
      { maxRows: 10, chunkSize: 500 },
    )
    expect(chunks.reduce((total, chunk) => total + chunk.rows.length, 0)).toBe(10)
    expect(eventsOfType(events, 'statement_done')[0]).toMatchObject({
      rowsReturned: 10,
      truncated: true,
    })
    expect(eventsOfType(events, 'notice')).toHaveLength(1)
    expect(last(await run(adapter, session, 'SELECT 1')).type).toBe('done')
  })

  it('keeps live memory flat while hundreds of MB of cells stream through', async () => {
    const session = await open(target)
    const baseline = await liveBytes()
    let peak = 0
    let processedRows = 0
    for await (const event of adapter.execute(
      queryRequest(
        session.sessionId,
        `SELECT g, repeat('m', 3000000) AS body FROM generate_series(1, 100) g`,
        { chunkSize: 500 },
      ),
    )) {
      if (event.type === 'chunk') {
        processedRows += event.rows.length
        peak = Math.max(peak, (await liveBytes()) - baseline)
      }
    }
    expect(processedRows).toBe(100)
    // 300 MB of text went through; what was alive at once is a raw read of MAX_READ_BYTES plus the pending chunk.
    expect(peak).toBeLessThan(40 * 1024 * 1024)
  })
})
