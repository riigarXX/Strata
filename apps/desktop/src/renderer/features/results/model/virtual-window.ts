export interface RowWindowInput {
  scrollTop: number
  viewportHeight: number
  rowHeight: number
  rowCount: number
  overscan: number
}

/** Filas `[start, end)` que hay que tener en el DOM: las visibles más `overscan` por arriba y por abajo. */
export interface IndexWindow {
  start: number
  end: number
}

const EMPTY_WINDOW: IndexWindow = { start: 0, end: 0 }

export function rowWindow({
  scrollTop,
  viewportHeight,
  rowHeight,
  rowCount,
  overscan,
}: RowWindowInput): IndexWindow {
  if (rowCount <= 0 || rowHeight <= 0) return EMPTY_WINDOW
  const top = Math.max(0, scrollTop)
  const first = Math.floor(top / rowHeight)
  const last = Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight)
  const start = Math.min(Math.max(0, first - overscan), rowCount)
  const end = Math.min(rowCount, Math.max(start, last + overscan))
  return { start, end }
}

/** Índice de la última columna cuyo inicio es `<= position` (búsqueda binaria sobre los inicios acumulados). */
function columnAt(starts: readonly number[], position: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= position) low = middle
    else high = middle - 1
  }
  return low
}

/**
 * Columnas `[start, end)` que caen en `[scrollLeft, scrollLeft + viewportWidth)` más `overscanPx` a cada lado.
 * `starts[i]` es el desplazamiento izquierdo de la columna `i`; `total` el ancho de todas juntas.
 */
export function columnWindow(
  starts: readonly number[],
  total: number,
  scrollLeft: number,
  viewportWidth: number,
  overscanPx: number,
): IndexWindow {
  if (starts.length === 0) return EMPTY_WINDOW
  const left = Math.max(0, scrollLeft - overscanPx)
  const right = Math.min(total, scrollLeft + Math.max(0, viewportWidth) + overscanPx)
  const start = columnAt(starts, left)
  let end = columnAt(starts, Math.max(left, right - 1)) + 1
  end = Math.min(starts.length, Math.max(end, start + 1))
  return { start, end }
}

export interface RevealInput {
  current: number
  viewport: number
  /** Inicio y fin (exclusivo) del elemento en coordenadas del contenido. */
  itemStart: number
  itemEnd: number
  /** Espacio del borde inicial tapado por elementos fijos (cabecera o columna de número de fila). */
  leadingInset: number
}

/** Nuevo `scrollTop`/`scrollLeft` mínimo para que el elemento quede entero a la vista, sin moverse si ya lo está. */
export function scrollToReveal({
  current,
  viewport,
  itemStart,
  itemEnd,
  leadingInset,
}: RevealInput): number {
  if (itemStart - leadingInset < current) return Math.max(0, itemStart - leadingInset)
  if (itemEnd > current + viewport) return Math.max(0, itemEnd - viewport)
  return current
}
