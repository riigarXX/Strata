export interface CellPosition {
  row: number
  col: number
}

/**
 * Selección de un grid: `active` es la celda con el foco lógico y `anchor`/`extent` los extremos del
 * rectángulo seleccionado. Una columna o fila entera se guarda con `Infinity` en el extremo abierto, de modo
 * que sigue cubriendo las filas que lleguen después de seleccionar.
 */
export interface GridSelection {
  active: CellPosition
  anchor: CellPosition
  extent: CellPosition
}

export interface GridDims {
  rows: number
  cols: number
}

/** Rectángulo inclusivo ya recortado a las dimensiones reales. */
export interface CellRange {
  rowStart: number
  rowEnd: number
  colStart: number
  colEnd: number
}

const ORIGIN: CellPosition = { row: 0, col: 0 }

export function initialSelection(): GridSelection {
  return { active: ORIGIN, anchor: ORIGIN, extent: ORIGIN }
}

export function selectCell(position: CellPosition): GridSelection {
  return { active: position, anchor: position, extent: position }
}

export function selectColumn(col: number): GridSelection {
  return {
    active: { row: 0, col },
    anchor: { row: 0, col },
    extent: { row: Number.POSITIVE_INFINITY, col },
  }
}

export function selectRow(row: number): GridSelection {
  return {
    active: { row, col: 0 },
    anchor: { row, col: 0 },
    extent: { row, col: Number.POSITIVE_INFINITY },
  }
}

export function selectAll(): GridSelection {
  return {
    active: ORIGIN,
    anchor: ORIGIN,
    extent: { row: Number.POSITIVE_INFINITY, col: Number.POSITIVE_INFINITY },
  }
}

/** Extiende el rectángulo desde `anchor` hasta `position`, que pasa a ser la celda activa. */
export function extendSelection(selection: GridSelection, position: CellPosition): GridSelection {
  return { active: position, anchor: selection.anchor, extent: position }
}

const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max)

export function clampPosition(position: CellPosition, dims: GridDims): CellPosition {
  return { row: clamp(position.row, dims.rows - 1), col: clamp(position.col, dims.cols - 1) }
}

/** Rectángulo seleccionado dentro de `dims`; `null` si no hay celdas. */
export function selectionRange(selection: GridSelection, dims: GridDims): CellRange | null {
  if (dims.rows <= 0 || dims.cols <= 0) return null
  const a = clampPosition(selection.anchor, dims)
  const b = clampPosition(selection.extent, dims)
  return {
    rowStart: Math.min(a.row, b.row),
    rowEnd: Math.max(a.row, b.row),
    colStart: Math.min(a.col, b.col),
    colEnd: Math.max(a.col, b.col),
  }
}

export function isCellSelected(range: CellRange | null, row: number, col: number): boolean {
  return (
    range !== null &&
    row >= range.rowStart &&
    row <= range.rowEnd &&
    col >= range.colStart &&
    col <= range.colEnd
  )
}

export function rangeSize(range: CellRange): { rows: number; cols: number } {
  return { rows: range.rowEnd - range.rowStart + 1, cols: range.colEnd - range.colStart + 1 }
}

export function coversColumn(range: CellRange | null, col: number, dims: GridDims): boolean {
  return (
    range !== null &&
    dims.rows > 0 &&
    range.rowStart === 0 &&
    range.rowEnd === dims.rows - 1 &&
    col >= range.colStart &&
    col <= range.colEnd
  )
}

export interface NavigationInput {
  key: string
  shift: boolean
  /** Cmd en macOS o Ctrl en el resto. */
  mod: boolean
  /** Filas que avanzan AvPág/RePág, normalmente las que caben en la ventana. */
  pageRows: number
}

const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

export function isNavigationKey(key: string): boolean {
  return NAVIGATION_KEYS.has(key)
}

function destination(active: CellPosition, input: NavigationInput, dims: GridDims): CellPosition {
  const lastRow = dims.rows - 1
  const lastCol = dims.cols - 1
  switch (input.key) {
    case 'ArrowUp':
      return { row: input.mod ? 0 : active.row - 1, col: active.col }
    case 'ArrowDown':
      return { row: input.mod ? lastRow : active.row + 1, col: active.col }
    case 'ArrowLeft':
      return { row: active.row, col: input.mod ? 0 : active.col - 1 }
    case 'ArrowRight':
      return { row: active.row, col: input.mod ? lastCol : active.col + 1 }
    case 'Home':
      return { row: input.mod ? 0 : active.row, col: 0 }
    case 'End':
      return { row: input.mod ? lastRow : active.row, col: lastCol }
    case 'PageUp':
      return { row: active.row - Math.max(1, input.pageRows), col: active.col }
    default:
      return { row: active.row + Math.max(1, input.pageRows), col: active.col }
  }
}

/**
 * Selección tras una tecla de navegación, o `null` si no la gestiona o no hay celdas. Sin Shift la celda
 * activa se mueve y el rectángulo se colapsa en ella; con Shift se mueve el extremo del rectángulo.
 */
export function navigate(
  selection: GridSelection,
  input: NavigationInput,
  dims: GridDims,
): GridSelection | null {
  if (!isNavigationKey(input.key) || dims.rows <= 0 || dims.cols <= 0) return null
  const from = clampPosition(input.shift ? selection.extent : selection.active, dims)
  const target = clampPosition(destination(from, input, dims), dims)
  return input.shift ? extendSelection(selection, target) : selectCell(target)
}

export function describeRange(range: CellRange): string {
  const { rows, cols } = rangeSize(range)
  if (rows === 1 && cols === 1) return '1 celda seleccionada'
  const rowsText = `${rows.toLocaleString('es-ES')} ${rows === 1 ? 'fila' : 'filas'}`
  const colsText = `${cols.toLocaleString('es-ES')} ${cols === 1 ? 'columna' : 'columnas'}`
  return `${rowsText} × ${colsText} seleccionadas`
}
