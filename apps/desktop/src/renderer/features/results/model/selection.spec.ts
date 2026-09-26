import { describe, expect, it } from 'vitest'
import {
  coversColumn,
  describeRange,
  extendSelection,
  initialSelection,
  isCellSelected,
  navigate,
  selectAll,
  selectCell,
  selectColumn,
  selectionRange,
  selectRow,
  type GridDims,
  type GridSelection,
  type NavigationInput,
} from './selection'

const dims: GridDims = { rows: 100, cols: 5 }
const press = (
  selection: GridSelection,
  key: string,
  modifiers: Partial<NavigationInput> = {},
): GridSelection => {
  const next = navigate(
    selection,
    { key, shift: false, mod: false, pageRows: 10, ...modifiers },
    dims,
  )
  if (!next) throw new Error(`${key} was not handled`)
  return next
}

describe('ranges', () => {
  it('a single cell is a 1x1 range', () => {
    expect(selectionRange(selectCell({ row: 3, col: 2 }), dims)).toEqual({
      rowStart: 3,
      rowEnd: 3,
      colStart: 2,
      colEnd: 2,
    })
  })

  it('normalises a range dragged backwards', () => {
    const selection = extendSelection(selectCell({ row: 8, col: 4 }), { row: 2, col: 1 })
    expect(selectionRange(selection, dims)).toEqual({
      rowStart: 2,
      rowEnd: 8,
      colStart: 1,
      colEnd: 4,
    })
  })

  it('selects a whole column, a whole row and everything', () => {
    expect(selectionRange(selectColumn(2), dims)).toEqual({
      rowStart: 0,
      rowEnd: 99,
      colStart: 2,
      colEnd: 2,
    })
    expect(selectionRange(selectRow(7), dims)).toEqual({
      rowStart: 7,
      rowEnd: 7,
      colStart: 0,
      colEnd: 4,
    })
    expect(selectionRange(selectAll(), dims)).toEqual({
      rowStart: 0,
      rowEnd: 99,
      colStart: 0,
      colEnd: 4,
    })
  })

  it('a column selection keeps covering rows that arrive later', () => {
    const selection = selectColumn(1)
    expect(selectionRange(selection, { rows: 10, cols: 5 })?.rowEnd).toBe(9)
    expect(selectionRange(selection, { rows: 500, cols: 5 })?.rowEnd).toBe(499)
  })

  it('has no range without cells', () => {
    expect(selectionRange(selectAll(), { rows: 0, cols: 5 })).toBeNull()
    expect(selectionRange(selectAll(), { rows: 5, cols: 0 })).toBeNull()
  })

  it('tests membership and whole-column coverage', () => {
    const range = selectionRange(
      extendSelection(selectCell({ row: 1, col: 1 }), { row: 3, col: 2 }),
      dims,
    )
    expect(isCellSelected(range, 2, 2)).toBe(true)
    expect(isCellSelected(range, 4, 2)).toBe(false)
    expect(isCellSelected(null, 0, 0)).toBe(false)
    expect(coversColumn(selectionRange(selectColumn(2), dims), 2, dims)).toBe(true)
    expect(coversColumn(range, 2, dims)).toBe(false)
  })

  it('describes a range', () => {
    expect(describeRange({ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 })).toBe(
      '1 celda seleccionada',
    )
    expect(describeRange({ rowStart: 0, rowEnd: 19_999, colStart: 0, colEnd: 2 })).toBe(
      '20.000 filas × 3 columnas seleccionadas',
    )
  })
})

describe('keyboard navigation', () => {
  const from = selectCell({ row: 10, col: 2 })

  it('moves one cell with the arrows and stops at the edges', () => {
    expect(press(from, 'ArrowDown').active).toEqual({ row: 11, col: 2 })
    expect(press(from, 'ArrowUp').active).toEqual({ row: 9, col: 2 })
    expect(press(from, 'ArrowLeft').active).toEqual({ row: 10, col: 1 })
    expect(press(from, 'ArrowRight').active).toEqual({ row: 10, col: 3 })
    expect(press(selectCell({ row: 0, col: 0 }), 'ArrowUp').active).toEqual({ row: 0, col: 0 })
    expect(press(selectCell({ row: 99, col: 4 }), 'ArrowRight').active).toEqual({ row: 99, col: 4 })
  })

  it('Home and End move within the row; with the modifier they jump to the corners', () => {
    expect(press(from, 'Home').active).toEqual({ row: 10, col: 0 })
    expect(press(from, 'End').active).toEqual({ row: 10, col: 4 })
    expect(press(from, 'Home', { mod: true }).active).toEqual({ row: 0, col: 0 })
    expect(press(from, 'End', { mod: true }).active).toEqual({ row: 99, col: 4 })
  })

  it('the modifier with an arrow jumps to that edge', () => {
    expect(press(from, 'ArrowUp', { mod: true }).active).toEqual({ row: 0, col: 2 })
    expect(press(from, 'ArrowDown', { mod: true }).active).toEqual({ row: 99, col: 2 })
    expect(press(from, 'ArrowLeft', { mod: true }).active).toEqual({ row: 10, col: 0 })
    expect(press(from, 'ArrowRight', { mod: true }).active).toEqual({ row: 10, col: 4 })
  })

  it('PageUp and PageDown move by the page size and clamp', () => {
    expect(press(from, 'PageDown').active).toEqual({ row: 20, col: 2 })
    expect(press(from, 'PageUp').active).toEqual({ row: 0, col: 2 })
    expect(press(selectCell({ row: 95, col: 0 }), 'PageDown').active).toEqual({ row: 99, col: 0 })
    expect(press(from, 'PageDown', { pageRows: 0 }).active).toEqual({ row: 11, col: 2 })
  })

  it('a plain move collapses the selection into the new cell', () => {
    const wide = extendSelection(from, { row: 14, col: 4 })
    const next = press(wide, 'ArrowDown')
    expect(next.anchor).toEqual(next.active)
    expect(next.extent).toEqual(next.active)
  })

  it('Shift extends the range from a fixed anchor, in every direction', () => {
    let selection = press(from, 'ArrowDown', { shift: true })
    selection = press(selection, 'ArrowDown', { shift: true })
    selection = press(selection, 'ArrowRight', { shift: true })
    expect(selection.anchor).toEqual({ row: 10, col: 2 })
    expect(selectionRange(selection, dims)).toEqual({
      rowStart: 10,
      rowEnd: 12,
      colStart: 2,
      colEnd: 3,
    })
    selection = press(selection, 'ArrowUp', { shift: true, mod: true })
    expect(selectionRange(selection, dims)).toEqual({
      rowStart: 0,
      rowEnd: 10,
      colStart: 2,
      colEnd: 3,
    })
    selection = press(selection, 'PageDown', { shift: true })
    expect(selection.extent.row).toBe(10)
  })

  it('Shift extending from a whole-column selection starts from its clamped end', () => {
    const next = press(selectColumn(1), 'ArrowUp', { shift: true })
    expect(next.extent).toEqual({ row: 98, col: 1 })
  })

  it('ignores other keys and empty grids', () => {
    expect(navigate(from, { key: 'a', shift: false, mod: false, pageRows: 10 }, dims)).toBeNull()
    expect(
      navigate(
        initialSelection(),
        { key: 'ArrowDown', shift: false, mod: false, pageRows: 10 },
        { rows: 0, cols: 3 },
      ),
    ).toBeNull()
  })

  it('keeps a stale position valid when the number of rows shrinks', () => {
    const stale = selectCell({ row: 500, col: 9 })
    const next = navigate(
      stale,
      { key: 'ArrowUp', shift: false, mod: false, pageRows: 10 },
      { rows: 20, cols: 3 },
    )
    expect(next?.active).toEqual({ row: 18, col: 2 })
  })
})
