import type { TruncatedCell } from '@strata/contracts'

// Result-size limits shared by every adapter (ADR 0010, risk "Resultados muy grandes"). Nothing here touches a driver.
//
// What the caps do NOT remove is the cost of getting a value into the process at all, because the SQL is the user's own and cannot be
// rewritten to cut a column server-side (no left()/substr() on arbitrary queries):
//  - SQLite: one row is read at a time, so at most one raw row (the driver's copy of each of its cells) is alive, and only until it is capped.
//  - PostgreSQL: the server sends whole values and pg decodes them into strings, so a cell is fully in memory (a bytea twice: as hex text) while its
//    row is processed. The reads are sized to keep that bounded: one row first, then at most MAX_READ_BYTES of raw text per read (nextReadSize).
//    The residual is therefore one read (>= one row) and, for a single value near 512 MB, the driver's own string limit makes the query fail.
//  - A row with many columns can still exceed MAX_CHUNK_BYTES on its own (columns x MAX_CELL_BYTES): rows are never split.
// A consumer that needs a tighter bound lowers chunkSize; a SQL that selects left(col, N) avoids the transfer altogether.

// Every cell that leaves an adapter is at most this many bytes as it travels (UTF-8 of the string, `0x` + hex for binary).
// 256 KiB keeps any normal value intact (long text, JSON documents), while a cell that big is already useless in a grid and costly over IPC.
export const MAX_CELL_BYTES = 256 * 1024

// Approximate budget of a chunk: rows are added until the next one would pass it. A single row always fits, so a chunk is never empty.
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024

// Raw bytes an adapter may pull from the driver in one read before it starts asking for fewer rows (see nextReadSize).
export const MAX_READ_BYTES = 4 * MAX_CHUNK_BYTES

const HEX_PREFIX_LENGTH = 2

// `originalBytes` is only present when the value was cut: the size it had before, as UTF-8 for text and as raw bytes for binary.
export interface Bounded<T> {
  readonly value: T
  readonly originalBytes?: number
}

// Binary travels as `0x` followed by two hex digits per byte, so that is what the cap is measured on.
export function maxBinaryBytes(maxBytes: number): number {
  return Math.max(0, Math.floor((maxBytes - HEX_PREFIX_LENGTH) / 2))
}

// Only the first `maxBytes` UTF-16 units can matter (each takes at least one byte), so the head is small even when the text is huge.
function cutUtf8(text: string, maxBytes: number): string {
  let head = text.slice(0, maxBytes)
  const lastUnit = head.charCodeAt(head.length - 1)
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    head = head.slice(0, -1)
  }
  const bytes = Buffer.from(head, 'utf8')
  let end = Math.min(maxBytes, bytes.length)
  // A continuation byte at `end` means the cut falls inside a character: drop that character entirely.
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end--
  }
  // toString copies, so the result does not keep the (possibly huge) source string alive the way a slice would.
  return bytes.toString('utf8', 0, end)
}

export function limitText(text: string, maxBytes: number = MAX_CELL_BYTES): Bounded<string> {
  // UTF-8 takes at most 3 bytes per UTF-16 unit, so a short string is known to fit without being scanned.
  if (text.length * 3 <= maxBytes) return { value: text }
  const originalBytes = Buffer.byteLength(text, 'utf8')
  if (originalBytes <= maxBytes) return { value: text }
  return { value: cutUtf8(text, maxBytes), originalBytes }
}

export function limitBytes(
  bytes: Uint8Array,
  maxBytes: number = MAX_CELL_BYTES,
): Bounded<Uint8Array> {
  const keep = maxBinaryBytes(maxBytes)
  if (bytes.length <= keep) return { value: bytes }
  // The copy detaches the head from the full buffer, which can then be collected.
  return { value: new Uint8Array(bytes.subarray(0, keep)), originalBytes: bytes.length }
}

// For drivers that hand binary over already as hex digits (PostgreSQL's bytea text format, without its `\x` prefix).
export function limitHexDigits(digits: string, maxBytes: number = MAX_CELL_BYTES): Bounded<string> {
  const keepDigits = maxBinaryBytes(maxBytes) * 2
  if (digits.length <= keepDigits) return { value: digits }
  return {
    value: Buffer.from(digits.slice(0, keepDigits), 'latin1').toString('latin1'),
    originalBytes: Math.floor(digits.length / 2),
  }
}

// What a cell weighs in a chunk: close to its JSON size, and cheap because oversized cells were already cut.
export function estimateCellBytes(cell: unknown): number {
  if (typeof cell === 'string') return Buffer.byteLength(cell, 'utf8') + 3
  if (cell instanceof Uint8Array) return cell.length * 2 + 5
  if (cell === null || cell === undefined || typeof cell === 'boolean') return 5
  if (typeof cell === 'bigint') return 24
  return 9
}

export interface BoundedRow<Cell> {
  readonly cells: Cell[]
  readonly bytes: number
  readonly truncations: readonly { readonly column: number; readonly originalBytes: number }[]
}

export function boundRow<Raw, Cell>(
  raw: readonly Raw[],
  bound: (value: Raw, column: number) => Bounded<Cell>,
): BoundedRow<Cell> {
  const cells: Cell[] = []
  const truncations: { column: number; originalBytes: number }[] = []
  let bytes = 0
  raw.forEach((value, column) => {
    const limited = bound(value, column)
    cells.push(limited.value)
    bytes += estimateCellBytes(limited.value)
    if (limited.originalBytes !== undefined) {
      truncations.push({ column, originalBytes: limited.originalBytes })
    }
  })
  return { cells, bytes, truncations }
}

export interface TakenChunk<Cell> {
  readonly rows: Cell[][]
  // Absent when nothing was cut.
  readonly truncated: TruncatedCell[] | undefined
}

// Accumulates rows for one chunk, bounded by row count and by bytes. `accepts` is asked before `push` and `isFull` after it.
export class ChunkBuffer<Cell> {
  private rows: Cell[][] = []
  private truncated: TruncatedCell[] = []
  private bytes = 0
  private readonly chunkSize: number
  private readonly maxBytes: number

  constructor(chunkSize: number, maxBytes: number = MAX_CHUNK_BYTES) {
    this.chunkSize = chunkSize
    this.maxBytes = maxBytes
  }

  get length(): number {
    return this.rows.length
  }

  // An empty chunk takes any row, however big: rows are never split.
  accepts(row: BoundedRow<Cell>): boolean {
    return this.rows.length === 0 || this.bytes + row.bytes <= this.maxBytes
  }

  push(row: BoundedRow<Cell>): void {
    for (const { column, originalBytes } of row.truncations) {
      this.truncated.push({ row: this.rows.length, column, originalBytes })
    }
    this.rows.push(row.cells)
    this.bytes += row.bytes
  }

  get isFull(): boolean {
    return this.rows.length >= this.chunkSize || this.bytes >= this.maxBytes
  }

  take(): TakenChunk<Cell> {
    const taken = {
      rows: this.rows,
      truncated: this.truncated.length > 0 ? this.truncated : undefined,
    }
    this.rows = []
    this.truncated = []
    this.bytes = 0
    return taken
  }
}

// Rows for the next cursor read. The first read is a single row to learn how heavy rows are; after that the read shrinks so the
// largest row seen last time would still fit MAX_READ_BYTES, and never asks for more than the chunk still needs.
export function nextReadSize(
  room: number,
  largestRawRowBytes: number | undefined,
  maxReadBytes: number = MAX_READ_BYTES,
): number {
  if (largestRawRowBytes === undefined) return 1
  return Math.max(1, Math.min(room, Math.floor(maxReadBytes / Math.max(largestRawRowBytes, 1))))
}
