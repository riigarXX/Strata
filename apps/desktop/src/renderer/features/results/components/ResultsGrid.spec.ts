import type { CellValue, ResultColumn } from '@strata/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ResultsGrid from './ResultsGrid.vue'

const columns: ResultColumn[] = [
  { name: 'id', dataType: 'integer', kind: 'number' },
  { name: 'name', dataType: 'text', kind: 'text' },
  { name: 'note', dataType: 'text', kind: 'text' },
]

const makeRows = (count: number, from = 0): CellValue[][] =>
  Array.from({ length: count }, (_, offset) => {
    const id = from + offset
    return [id, `name-${id}`, id % 5 === 0 ? null : `note ${id}`]
  })

let wrapper: VueWrapper | undefined
let execCommand: ReturnType<typeof vi.fn>
let copied: string[]

interface Options {
  rows?: CellValue[][]
  truncated?: [row: number, column: number, bytes: number][]
  busy?: boolean
  limited?: boolean
  cols?: ResultColumn[]
}

function mountGrid({
  rows = makeRows(50),
  truncated = [],
  busy = false,
  limited = false,
  cols = columns,
}: Options = {}) {
  const truncatedIndex = new Map(
    truncated.map(([row, col, bytes]) => [row * cols.length + col, bytes]),
  )
  wrapper = mount(ResultsGrid, {
    props: { columns: cols, rows, truncatedIndex, version: 1, busy, limited },
    attachTo: document.body,
  })
  return { rows, truncatedIndex, wrapper }
}

const grid = () => wrapper!.get('[role="grid"]')
const press = (key: string, init: KeyboardEventInit = {}) =>
  grid().trigger('keydown', { key, ...init })
const cell = (row: number, col: number) =>
  wrapper!.get(`[role="gridcell"][data-row="${row}"][data-col="${col}"]`)
const selected = () => wrapper!.findAll('[role="gridcell"][aria-selected="true"]')
const activeId = () => grid().attributes('aria-activedescendant')

beforeEach(() => {
  copied = []
  execCommand = vi.fn(() => {
    copied.push(document.querySelector('textarea')!.value)
    return true
  })
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'execCommand')
  vi.restoreAllMocks()
})

describe('structure and ARIA', () => {
  it('exposes a grid with real totals, a single tab stop and a description', () => {
    mountGrid({ rows: makeRows(50) })
    const element = grid()
    expect(element.attributes('aria-rowcount')).toBe('51')
    // Tres columnas de datos más la de número de fila.
    expect(element.attributes('aria-colcount')).toBe('4')
    expect(element.attributes('aria-multiselectable')).toBe('true')
    expect(element.attributes('aria-busy')).toBe('false')
    expect(element.attributes('tabindex')).toBe('0')
    expect(
      element.findAll('[tabindex]').filter((node) => node.attributes('tabindex') === '0'),
    ).toHaveLength(0)
    const detail = document.getElementById(element.attributes('aria-describedby')!)
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('integer')
  })

  it('numbers rows and columns from 1 counting the header row', () => {
    mountGrid()
    expect(wrapper!.get('[role="row"]').attributes('aria-rowindex')).toBe('1')
    expect(cell(0, 0).element.parentElement!.getAttribute('aria-rowindex')).toBe('2')
    expect(cell(0, 0).attributes('aria-colindex')).toBe('2')
    expect(cell(0, 2).attributes('aria-colindex')).toBe('4')
    expect(wrapper!.get('[role="rowheader"]').attributes('aria-colindex')).toBe('1')
  })

  it('marks the grid busy while chunks arrive', () => {
    mountGrid({ busy: true })
    expect(grid().attributes('aria-busy')).toBe('true')
  })

  it('shows typed headers with the type as text and aligns numbers to the right', () => {
    mountGrid()
    const header = wrapper!.get('[role="columnheader"][data-col="0"]')
    expect(header.text()).toContain('id')
    expect(header.get('[data-part="column-type"]').text()).toBe('integer')
    expect(header.classes()).toContain('results-grid__colhead--end')
    expect(cell(1, 0).classes()).toContain('results-grid__cell--end')
    expect(cell(1, 1).classes()).not.toContain('results-grid__cell--end')
  })

  it('shows NULL as text of its own with an explanatory title', () => {
    mountGrid()
    const nullCell = cell(0, 2)
    expect(nullCell.get('[data-part="null"]').text()).toBe('NULL')
    expect(nullCell.attributes('title')).toContain('nulo')
    expect(cell(1, 2).text()).toBe('note 1')
  })

  it('says so when the statement returned no rows', () => {
    mountGrid({ rows: [] })
    expect(wrapper!.get('[data-part="grid-empty"]').text()).toContain('no devolvió filas')
    expect(grid().attributes('aria-rowcount')).toBe('1')
    expect(wrapper!.find('[data-part="detail-empty"]').exists()).toBe(true)
  })
})

describe('truncated values', () => {
  it('flags a truncated cell with a glyph, hidden text and the original size', () => {
    mountGrid({ truncated: [[1, 2, 500_000]] })
    const flagged = cell(1, 2)
    expect(flagged.find('[data-part="truncated-flag"]').exists()).toBe(true)
    expect(flagged.text()).toContain('Valor truncado')
    expect(flagged.attributes('title')).toContain('488,3 KiB')
    expect(cell(2, 2).find('[data-part="truncated-flag"]').exists()).toBe(false)
  })

  it('warns in the detail line when the focused cell is truncated', async () => {
    mountGrid({ truncated: [[1, 2, 500_000]] })
    expect(wrapper!.find('[data-part="detail-truncated"]').exists()).toBe(false)
    await cell(1, 2).trigger('click')
    expect(wrapper!.get('[data-part="detail-truncated"]').text()).toContain('488,3 KiB')
  })
})

describe('virtualization', () => {
  it('keeps the DOM bounded with 100 000 rows and still reports the real total', () => {
    mountGrid({ rows: makeRows(100_000) })
    const rows = wrapper!.findAll('[role="row"]')
    expect(rows.length).toBeLessThan(60)
    expect(wrapper!.findAll('[role="gridcell"]').length).toBeLessThan(200)
    expect(grid().attributes('aria-rowcount')).toBe('100001')
    expect(wrapper!.get<HTMLElement>('[data-part="grid-body"]').element.style.height).toBe(
      `${100_000 * 28}px`,
    )
  })

  it('renders the rows that correspond to the scroll position', async () => {
    mountGrid({ rows: makeRows(100_000) })
    const element = grid().element as HTMLElement
    element.scrollTop = 28 * 5_000
    await grid().trigger('scroll')
    expect(cell(5_000, 1).text()).toBe('name-5000')
    expect(cell(5_000, 1).element.parentElement!.getAttribute('aria-rowindex')).toBe('5002')
    expect(wrapper!.find('[data-row="10"][data-col="1"]').exists()).toBe(false)
    expect(wrapper!.findAll('[role="row"]').length).toBeLessThan(60)
  })

  it('follows the growth of the buffer without changing what is already shown', async () => {
    const { rows } = mountGrid({ rows: makeRows(20) })
    expect(grid().attributes('aria-rowcount')).toBe('21')
    rows.push(...makeRows(80, 20))
    await wrapper!.setProps({ version: 2 })
    expect(grid().attributes('aria-rowcount')).toBe('101')
    expect(wrapper!.get('[data-part="filter-count"]').text()).toBe('100 filas')
    expect(cell(0, 1).text()).toBe('name-0')
  })

  it('shows the last row when scrolled to the end', async () => {
    mountGrid({ rows: makeRows(1_000) })
    await press('End', { ctrlKey: true })
    expect(cell(999, 1).text()).toBe('name-999')
    expect(activeId()).toBe(cell(999, 2).attributes('id'))
  })
})

describe('selection', () => {
  it('selects a cell by clicking and extends with Shift+click', async () => {
    mountGrid()
    await cell(2, 1).trigger('click')
    expect(selected()).toHaveLength(1)
    expect(cell(2, 1).attributes('aria-selected')).toBe('true')
    await cell(4, 2).trigger('click', { shiftKey: true })
    expect(selected()).toHaveLength(3 * 2)
    expect(activeId()).toBe(cell(4, 2).attributes('id'))
  })

  it('selects a whole column from its header and a whole row from its number', async () => {
    mountGrid({ rows: makeRows(10) })
    await wrapper!.get('[role="columnheader"][data-col="1"]').trigger('click')
    expect(selected()).toHaveLength(10)
    expect(wrapper!.get('[role="columnheader"][data-col="1"]').attributes('aria-selected')).toBe(
      'true',
    )
    await wrapper!.get('[role="rowheader"][data-row="3"]').trigger('click')
    expect(selected()).toHaveLength(3)
    expect(cell(3, 2).attributes('aria-selected')).toBe('true')
  })

  it('selects everything with Ctrl+A / Cmd+A and from the corner', async () => {
    mountGrid({ rows: makeRows(10) })
    await press('a', { metaKey: true })
    expect(selected()).toHaveLength(30)
    await cell(0, 0).trigger('click')
    expect(selected()).toHaveLength(1)
    await wrapper!.get('[role="columnheader"][aria-colindex="1"]').trigger('click')
    expect(selected()).toHaveLength(30)
  })

  it('selects the column or the row of the active cell from the keyboard', async () => {
    mountGrid({ rows: makeRows(10) })
    await cell(2, 1).trigger('click')
    await press(' ', { ctrlKey: true })
    expect(selected()).toHaveLength(10)
    await press(' ', { shiftKey: true })
    expect(selected()).toHaveLength(3)
  })

  it('makes the selection cover rows that arrive afterwards when a column is selected', async () => {
    const { rows } = mountGrid({ rows: makeRows(10) })
    await wrapper!.get('[role="columnheader"][data-col="1"]').trigger('click')
    rows.push(...makeRows(5, 10))
    await wrapper!.setProps({ version: 2 })
    expect(selected()).toHaveLength(15)
  })
})

describe('keyboard', () => {
  it('moves the active cell with the arrows, Home, End and paging', async () => {
    mountGrid({ rows: makeRows(200) })
    expect(activeId()).toBe(cell(0, 0).attributes('id'))
    await press('ArrowDown')
    await press('ArrowRight')
    expect(activeId()).toBe(cell(1, 1).attributes('id'))
    await press('End')
    expect(activeId()).toBe(cell(1, 2).attributes('id'))
    await press('Home')
    expect(activeId()).toBe(cell(1, 0).attributes('id'))
    await press('PageDown')
    const afterPage = Number(wrapper!.get('[aria-selected="true"]').attributes('data-row'))
    expect(afterPage).toBeGreaterThan(10)
    await press('Home', { ctrlKey: true })
    expect(activeId()).toBe(cell(0, 0).attributes('id'))
  })

  it('extends a range with Shift+arrows and announces it once', async () => {
    vi.useFakeTimers()
    try {
      mountGrid({ rows: makeRows(20) })
      await press('ArrowDown', { shiftKey: true })
      await press('ArrowDown', { shiftKey: true })
      await press('ArrowRight', { shiftKey: true })
      expect(selected()).toHaveLength(6)
      expect(wrapper!.get('[data-part="live"]').text()).toBe('')
      await vi.advanceTimersByTimeAsync(500)
      expect(wrapper!.get('[data-part="live"]').text()).toBe('3 filas × 2 columnas seleccionadas')
    } finally {
      vi.useRealTimers()
    }
  })

  it('prevents the default of handled keys only', async () => {
    mountGrid()
    const handled = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      cancelable: true,
      bubbles: true,
    })
    grid().element.dispatchEvent(handled)
    expect(handled.defaultPrevented).toBe(true)
    const ignored = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true, bubbles: true })
    grid().element.dispatchEvent(ignored)
    expect(ignored.defaultPrevented).toBe(false)
  })

  it('resizes the active column from the keyboard', async () => {
    mountGrid()
    const width = () =>
      Number.parseInt(
        wrapper!.get<HTMLElement>('[role="columnheader"][data-col="0"]').element.style.width,
      )
    const before = width()
    await press('ArrowRight', { altKey: true })
    expect(width()).toBe(before + 16)
    await press('ArrowLeft', { altKey: true, shiftKey: true })
    expect(width()).toBe(Math.max(64, before + 16 - 64))
  })

  it('updates the detail line with the full value of the active cell', async () => {
    mountGrid({ rows: [[1, 'x'.repeat(5_000), null]] })
    expect(wrapper!.get('[data-part="detail-value"]').text()).toBe('1')
    await press('ArrowRight')
    expect(wrapper!.get('[data-part="detail-value"]').text()).toHaveLength(5_000)
    expect(cell(0, 1).text().length).toBeLessThan(400)
    await press('ArrowRight')
    expect(wrapper!.get('[data-part="detail-value"]').text()).toBe('NULL')
  })
})

describe('copy', () => {
  it('copies the selected cell, row, column or range as TSV', async () => {
    mountGrid({ rows: makeRows(6) })
    await cell(1, 1).trigger('click')
    await press('c', { metaKey: true })
    await flushPromises()
    expect(copied.at(-1)).toBe('name-1')

    await wrapper!.get('[role="rowheader"][data-row="5"]').trigger('click')
    await press('c', { ctrlKey: true })
    await flushPromises()
    expect(copied.at(-1)).toBe('5\tname-5\t')

    await cell(0, 1).trigger('click')
    await cell(1, 2).trigger('click', { shiftKey: true })
    await press('c', { metaKey: true })
    await flushPromises()
    expect(copied.at(-1)).toBe('name-0\t\nname-1\tnote 1')
  })

  it('adds the headers with Shift+Cmd/Ctrl+C and copies a column', async () => {
    mountGrid({ rows: makeRows(3) })
    await wrapper!.get('[role="columnheader"][data-col="0"]').trigger('click')
    await press('C', { metaKey: true, shiftKey: true })
    await flushPromises()
    expect(copied.at(-1)).toBe('id\n0\n1\n2')
  })

  it('escapes tabs, newlines and quotes so they paste into one cell', async () => {
    mountGrid({ rows: [[1, 'a\tb', 'say "hi"\nbye']] })
    await press('a', { metaKey: true })
    await press('c', { metaKey: true })
    await flushPromises()
    expect(copied.at(-1)).toBe('1\t"a\tb"\t"say ""hi""\nbye"')
  })

  it('reports the result in a live region and in the toolbar', async () => {
    mountGrid({ rows: makeRows(3) })
    await press('a', { metaKey: true })
    await press('c', { metaKey: true })
    await flushPromises()
    expect(wrapper!.get('[data-part="live"]').text()).toBe('Copiadas 3 filas × 3 columnas.')
    expect(wrapper!.get('[data-part="copy-status"]').text()).toContain('Copiadas 3 filas')
  })

  it('warns about truncated cells that were copied cut', async () => {
    mountGrid({ rows: makeRows(3), truncated: [[1, 1, 500_000]] })
    await press('a', { metaKey: true })
    await press('c', { metaKey: true })
    await flushPromises()
    expect(wrapper!.get('[data-part="live"]').text()).toContain('1 celda truncada se copió cortada')
  })

  it('copies through a temporary textarea that is removed afterwards', async () => {
    mountGrid({ rows: makeRows(2) })
    await cell(0, 1).trigger('click')
    await press('c', { metaKey: true })
    await flushPromises()
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
    expect(wrapper!.get('[data-part="live"]').text()).toContain('Copiadas')
  })

  it('reports when nothing could be copied', async () => {
    execCommand.mockReturnValue(false)
    mountGrid({ rows: makeRows(2) })
    await press('c', { metaKey: true })
    await flushPromises()
    expect(wrapper!.get('[data-part="live"]').text()).toContain('No se pudo copiar')
  })
})

describe('local filter', () => {
  const type = async (text: string) => {
    await wrapper!.get('[data-part="filter-input"]').setValue(text)
    await vi.waitFor(
      () => expect(wrapper!.get('[data-part="filter-count"]').text()).not.toContain('filtrando'),
      { timeout: 15_000 },
    )
  }

  it('filters loaded rows by substring, ignoring case, and shows N of M', async () => {
    mountGrid({ rows: makeRows(100) })
    await type('NAME-4')
    expect(wrapper!.get('[data-part="filter-count"]').text()).toBe('11 de 100 filas')
    expect(grid().attributes('aria-rowcount')).toBe('12')
    expect(cell(0, 1).text()).toBe('name-4')
    expect(wrapper!.get('[role="rowheader"][data-row="0"]').text()).toBe('5')
  })

  it('shows all rows again when the filter is cleared', async () => {
    mountGrid({ rows: makeRows(100) })
    await type('name-4')
    await type('')
    expect(wrapper!.get('[data-part="filter-count"]').text()).toBe('100 filas')
  })

  it('says when nothing matches', async () => {
    mountGrid({ rows: makeRows(100) })
    await type('zzz')
    expect(wrapper!.get('[data-part="filter-count"]').text()).toBe('0 de 100 filas')
    expect(wrapper!.get('[data-part="grid-empty"]').text()).toContain('Ninguna fila')
  })

  it('states that it filters only what is loaded and whether the result was cut by the limit', () => {
    mountGrid()
    expect(wrapper!.get('[data-part="filter-scope"]').text()).toContain('cargadas')
    wrapper!.unmount()
    mountGrid({ limited: true })
    expect(wrapper!.get('[data-part="limit-note"]').text()).toContain('límite de filas')
  })

  it('keeps filtering as new rows arrive', async () => {
    const { rows } = mountGrid({ rows: makeRows(50) })
    await type('name-1')
    expect(wrapper!.get('[data-part="filter-count"]').text()).toBe('11 de 50 filas')
    rows.push(...makeRows(100, 50))
    await wrapper!.setProps({ version: 2 })
    await vi.waitFor(
      () => expect(wrapper!.get('[data-part="filter-count"]').text()).toBe('61 de 150 filas'),
      { timeout: 15_000 },
    )
  })

  it('clears the filter with Escape from the field', async () => {
    mountGrid({ rows: makeRows(100) })
    await type('name-4')
    await wrapper!.get('[data-part="filter-input"]').trigger('keydown', { key: 'Escape' })
    expect((wrapper!.get('[data-part="filter-input"]').element as HTMLInputElement).value).toBe('')
  })

  it('handles 100 000 rows without blocking: it works in batches and reaches the right answer', async () => {
    mountGrid({ rows: makeRows(100_000) })
    const started = performance.now()
    await type('name-99999')
    expect(wrapper!.get('[data-part="filter-count"]').text()).toBe('1 de 100.000 filas')
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('announces the outcome once the scan finishes, not per batch', async () => {
    vi.useFakeTimers()
    try {
      mountGrid({ rows: makeRows(100) })
      await wrapper!.get('[data-part="filter-input"]').setValue('name-4')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(wrapper!.get('[data-part="live"]').text()).toBe(
        '11 de 100 filas coinciden con el filtro.',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('announcements while loading', () => {
  it('announces completion once when the run ends', async () => {
    mountGrid({ rows: makeRows(30), busy: true })
    expect(wrapper!.get('[data-part="live"]').text()).toBe('')
    await wrapper!.setProps({ busy: false })
    expect(wrapper!.get('[data-part="live"]').text()).toBe('Resultado completo: 30 filas cargadas.')
  })
})
