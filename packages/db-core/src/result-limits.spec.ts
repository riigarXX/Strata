import { describe, expect, it } from 'vitest'
import {
  boundRow,
  ChunkBuffer,
  estimateCellBytes,
  limitBytes,
  limitHexDigits,
  limitText,
  MAX_CELL_BYTES,
  MAX_CHUNK_BYTES,
  maxBinaryBytes,
  nextReadSize,
} from './result-limits'

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')

describe('limits', () => {
  it('keeps conservative, documented values', () => {
    expect(MAX_CELL_BYTES).toBe(256 * 1024)
    expect(MAX_CHUNK_BYTES).toBe(4 * 1024 * 1024)
    expect(MAX_CELL_BYTES).toBeLessThan(MAX_CHUNK_BYTES)
  })
})

describe('limitText', () => {
  it('returns the very same string when it fits', () => {
    const text = 'hello'
    expect(limitText(text, 10)).toEqual({ value: 'hello' })
    expect(limitText('', 10)).toEqual({ value: '' })
  })

  it('does not truncate a string of exactly the limit, and cuts one byte more', () => {
    expect(limitText('a'.repeat(100), 100)).toEqual({ value: 'a'.repeat(100) })
    expect(limitText('a'.repeat(101), 100)).toEqual({
      value: 'a'.repeat(100),
      originalBytes: 101,
    })
  })

  it('measures multibyte text in UTF-8 bytes, not in characters', () => {
    const exact = 'é'.repeat(50)
    expect(bytesOf(exact)).toBe(100)
    expect(limitText(exact, 100)).toEqual({ value: exact })
    expect(limitText(`${exact}é`, 100)).toEqual({ value: exact, originalBytes: 102 })
  })

  it('never cuts a multibyte character in half', () => {
    for (const unit of ['é', '€', '😀', '日']) {
      const text = unit.repeat(400)
      for (const limit of [1, 2, 3, 4, 5, 7, 10, 99, 100, 101, 102, 103]) {
        const { value, originalBytes } = limitText(text, limit)
        expect(originalBytes).toBe(bytesOf(text))
        expect(bytesOf(value)).toBeLessThanOrEqual(limit)
        expect(value).not.toContain('�')
        expect(text.startsWith(value)).toBe(true)
        // Nothing that would have fit was dropped: one more character would not fit.
        expect(bytesOf(value) + bytesOf(unit)).toBeGreaterThan(limit)
      }
    }
  })

  it('does not split a surrogate pair that straddles the head', () => {
    const text = `${'a'.repeat(9)}😀tail`
    const { value } = limitText(text, 10)
    expect(value).toBe('a'.repeat(9))
  })

  it('cuts to an empty string when not even the first character fits', () => {
    expect(limitText('😀😀', 3)).toEqual({ value: '', originalBytes: 8 })
  })

  it('caps a huge string without keeping it alive or changing its head', () => {
    const huge = 'ab'.repeat(5_000_000)
    const { value, originalBytes } = limitText(huge)
    expect(originalBytes).toBe(10_000_000)
    expect(bytesOf(value)).toBe(MAX_CELL_BYTES)
    expect(huge.startsWith(value)).toBe(true)
  })

  it('skips the byte count for strings that cannot exceed the limit', () => {
    const text = 'x'.repeat(MAX_CELL_BYTES / 3)
    expect(limitText(text)).toEqual({ value: text })
  })
})

describe('limitBytes', () => {
  it('measures the cap on the 0x<hex> form: two digits per byte plus the prefix', () => {
    expect(maxBinaryBytes(1000)).toBe(499)
    expect(maxBinaryBytes(2)).toBe(0)
    expect(maxBinaryBytes(0)).toBe(0)
    expect(2 + maxBinaryBytes(MAX_CELL_BYTES) * 2).toBeLessThanOrEqual(MAX_CELL_BYTES)
  })

  it('returns the same bytes when they fit, including an empty blob', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(limitBytes(bytes, 100).value).toBe(bytes)
    expect(limitBytes(new Uint8Array(0), 100)).toEqual({ value: new Uint8Array(0) })
  })

  it('keeps exactly the limit and truncates one byte more', () => {
    const exact = new Uint8Array(499).fill(7)
    expect(limitBytes(exact, 1000).originalBytes).toBeUndefined()

    const over = new Uint8Array(500).fill(7)
    const limited = limitBytes(over, 1000)
    expect(limited.originalBytes).toBe(500)
    expect(limited.value).toHaveLength(499)
  })

  it('keeps the first bytes in a detached copy', () => {
    const big = new Uint8Array(1000).map((_, index) => index % 256)
    const { value } = limitBytes(big, 100)
    expect([...value]).toEqual([...big.subarray(0, 49)])
    expect(value.buffer).not.toBe(big.buffer)
    expect(value.buffer.byteLength).toBe(49)
  })
})

describe('limitHexDigits', () => {
  it('returns the digits when they fit and cuts on whole bytes otherwise', () => {
    expect(limitHexDigits('deadbeef', 100)).toEqual({ value: 'deadbeef' })
    expect(limitHexDigits('', 100)).toEqual({ value: '' })

    const digits = 'ab'.repeat(500)
    expect(limitHexDigits(digits, 1000)).toEqual({
      value: 'ab'.repeat(499),
      originalBytes: 500,
    })
    expect(limitHexDigits('ab'.repeat(499), 1000).originalBytes).toBeUndefined()
  })

  it('agrees with limitBytes on how many bytes survive', () => {
    const bytes = new Uint8Array(3000).fill(0xab)
    const fromBytes = limitBytes(bytes, 1000)
    const fromHex = limitHexDigits(Buffer.from(bytes).toString('hex'), 1000)
    expect(fromHex.value).toBe(Buffer.from(fromBytes.value).toString('hex'))
    expect(fromHex.originalBytes).toBe(fromBytes.originalBytes)
  })
})

describe('estimateCellBytes', () => {
  it('weighs cells close to their serialized size', () => {
    expect(estimateCellBytes('abc')).toBe(6)
    expect(estimateCellBytes('日')).toBe(6)
    expect(estimateCellBytes(new Uint8Array(10))).toBe(25)
    expect(estimateCellBytes(null)).toBe(5)
    expect(estimateCellBytes(true)).toBe(5)
    expect(estimateCellBytes(12)).toBe(9)
    expect(estimateCellBytes(12n)).toBeGreaterThan(9)
  })
})

describe('boundRow', () => {
  it('bounds each cell, sums the weight and records the cut columns', () => {
    const row = boundRow(['short', 'x'.repeat(50), 'z'], (value) => limitText(value, 10))
    expect(row.cells).toEqual(['short', 'x'.repeat(10), 'z'])
    expect(row.truncations).toEqual([{ column: 1, originalBytes: 50 }])
    expect(row.bytes).toBe(8 + 13 + 4)
  })

  it('reports no cuts for a row that fits', () => {
    const row = boundRow(['a'], (value) => limitText(value, 10))
    expect(row.truncations).toEqual([])
  })
})

describe('ChunkBuffer', () => {
  const rowOf = (bytes: number, ...cut: { column: number; originalBytes: number }[]) => ({
    cells: [`r${bytes}`],
    bytes,
    truncations: cut,
  })

  it('fills up to chunkSize rows', () => {
    const buffer = new ChunkBuffer<string>(3, 1000)
    for (let index = 0; index < 2; index++) {
      expect(buffer.accepts(rowOf(10))).toBe(true)
      buffer.push(rowOf(10))
      expect(buffer.isFull).toBe(false)
    }
    buffer.push(rowOf(10))
    expect(buffer.isFull).toBe(true)
    expect(buffer.take().rows).toHaveLength(3)
    expect(buffer.length).toBe(0)
    expect(buffer.isFull).toBe(false)
  })

  it('refuses a row that would pass the byte budget, unless the chunk is empty', () => {
    const buffer = new ChunkBuffer<string>(100, 100)
    expect(buffer.accepts(rowOf(500))).toBe(true)
    buffer.push(rowOf(500))
    expect(buffer.isFull).toBe(true)
    expect(buffer.accepts(rowOf(1))).toBe(false)
    expect(buffer.take().rows).toHaveLength(1)
    expect(buffer.accepts(rowOf(500))).toBe(true)
  })

  it('takes rows up to the budget exactly', () => {
    const buffer = new ChunkBuffer<string>(100, 100)
    buffer.push(rowOf(60))
    expect(buffer.accepts(rowOf(40))).toBe(true)
    buffer.push(rowOf(40))
    expect(buffer.isFull).toBe(true)
    expect(buffer.accepts(rowOf(1))).toBe(false)
  })

  it('numbers truncated cells by their row within the chunk and restarts after take', () => {
    const buffer = new ChunkBuffer<string>(10, 1000)
    buffer.push(rowOf(1))
    buffer.push(rowOf(1, { column: 2, originalBytes: 900 }, { column: 4, originalBytes: 5 }))
    buffer.push(rowOf(1, { column: 0, originalBytes: 7 }))
    expect(buffer.take().truncated).toEqual([
      { row: 1, column: 2, originalBytes: 900 },
      { row: 1, column: 4, originalBytes: 5 },
      { row: 2, column: 0, originalBytes: 7 },
    ])

    buffer.push(rowOf(1, { column: 1, originalBytes: 3 }))
    expect(buffer.take().truncated).toEqual([{ row: 0, column: 1, originalBytes: 3 }])
  })

  it('omits truncated when nothing was cut', () => {
    const buffer = new ChunkBuffer<string>(10, 1000)
    buffer.push(rowOf(1))
    expect(buffer.take().truncated).toBeUndefined()
  })
})

describe('nextReadSize', () => {
  it('probes with one row before anything is known', () => {
    expect(nextReadSize(500, undefined)).toBe(1)
  })

  it('asks for what the chunk still needs when rows are small', () => {
    expect(nextReadSize(500, 100)).toBe(500)
    expect(nextReadSize(37, 0)).toBe(37)
  })

  it('shrinks the read so the largest row seen would still fit the raw budget', () => {
    expect(nextReadSize(500, 1024 * 1024, 16 * 1024 * 1024)).toBe(16)
    expect(nextReadSize(500, 64 * 1024 * 1024, 16 * 1024 * 1024)).toBe(1)
  })
})
