import type { CellValue } from '@strata/contracts'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { useResultFilter, type ResultFilter } from './use-result-filter'

const makeRows = (count: number, from = 0): CellValue[][] =>
  Array.from({ length: count }, (_, offset) => [from + offset, `row ${from + offset}`])

let scope: EffectScope | undefined
afterEach(() => scope?.stop())

function setup(initial: number) {
  const rows = makeRows(initial)
  const loaded = ref(rows.length)
  const query = ref('')
  let yields = 0
  let filter!: ResultFilter
  scope = effectScope()
  scope.run(() => {
    filter = useResultFilter({
      rows: () => rows,
      loaded,
      query,
      budgetMs: 0,
      yieldToMain: () => {
        yields += 1
        return Promise.resolve()
      },
    })
  })
  const settle = async () => {
    for (let turn = 0; turn < 200 && filter.scanning.value; turn += 1) await nextTick()
  }
  return { rows, loaded, query, filter, settle, yields: () => yields }
}

describe('useResultFilter', () => {
  it('shows every loaded row without a query', () => {
    const { filter } = setup(1_000)
    expect(filter.active.value).toBe(false)
    expect(filter.count.value).toBe(1_000)
    expect(filter.sourceRow(42)).toBe(42)
  })

  it('processes in batches yielding the thread, and ends with the exact matches', async () => {
    const { filter, query, settle, yields } = setup(5_000)
    query.value = 'row 49'
    expect(filter.scanning.value).toBe(true)
    await settle()
    expect(yields()).toBeGreaterThan(5)
    expect(filter.scanning.value).toBe(false)
    expect(filter.count.value).toBe(111)
    expect(filter.sourceRow(0)).toBe(49)
    expect(filter.sourceRow(10)).toBe(499)
  })

  it('restarts when the query changes and drops the old scan', async () => {
    const { filter, query, settle } = setup(5_000)
    query.value = 'row 1'
    query.value = 'row 4999'
    await settle()
    expect(filter.count.value).toBe(1)
    expect(filter.sourceRow(0)).toBe(4_999)
  })

  it('goes back to all rows when the query is emptied', async () => {
    const { filter, query, settle } = setup(300)
    query.value = 'row 1'
    await settle()
    query.value = '  '
    expect(filter.active.value).toBe(false)
    expect(filter.count.value).toBe(300)
    expect(filter.scanning.value).toBe(false)
  })

  it('continues over the rows appended while the query is active', async () => {
    const { rows, loaded, filter, query, settle } = setup(1_000)
    query.value = '9'
    await settle()
    const before = filter.count.value
    rows.push(...makeRows(1_000, 1_000))
    loaded.value = rows.length
    await nextTick()
    await settle()
    expect(filter.count.value).toBeGreaterThan(before)
    expect(filter.count.value).toBe(
      rows.filter((row) => row.some((value) => String(value).includes('9'))).length,
    )
  })
})
