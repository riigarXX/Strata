<script setup lang="ts">
import type { CellValue, ResultColumn } from '@strata/contracts'
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { useElementSize } from '../../workspace/composables/use-element-size'
import { truncatedBytes, type ResultSetView } from '../../execution/model/result-buffers'
import { useAnnouncer } from '../composables/use-announcer'
import { useResultFilter } from '../composables/use-result-filter'
import { displayText, fullText, truncationNotice } from '../model/cell-format'
import {
  clampWidth,
  initialColumnWidth,
  isRightAligned,
  KIND_LABELS,
  layoutColumns,
  rowNumberWidth,
  SAMPLE_ROWS,
  CHAR_WIDTH,
} from '../model/column-layout'
import { writeClipboard } from '../model/clipboard'
import { buildTsv, describeCopy } from '../model/copy-tsv'
import {
  clampPosition,
  coversColumn,
  describeRange,
  extendSelection,
  initialSelection,
  isCellSelected,
  navigate,
  rangeSize,
  selectAll,
  selectCell,
  selectColumn,
  selectRow,
  selectionRange,
  type CellPosition,
  type GridSelection,
} from '../model/selection'
import { columnWindow, rowWindow, scrollToReveal } from '../model/virtual-window'

const props = withDefaults(
  defineProps<{
    columns: readonly ResultColumn[]
    rows: ResultSetView['rows']
    truncatedIndex: ResultSetView['truncatedIndex']
    /** Cambia cuando el búfer añade filas: `rows` es el mismo array mutado, así que esto es lo que avisa. */
    version: number
    /** Siguen llegando chunks de este resultado. */
    busy?: boolean
    /** Resumen de la ejecución que se muestra en la barra del grid para no gastar otra línea. */
    caption?: string
    /** El resultado se recortó por el límite de filas: filtrar y copiar solo abarcan lo cargado. */
    limited?: boolean
    rowHeight?: number
  }>(),
  { busy: false, caption: '', limited: false, rowHeight: 28 },
)

const OVERSCAN_ROWS = 10
const OVERSCAN_COLUMNS_PX = 240
const FALLBACK_HEIGHT = 480
const FALLBACK_WIDTH = 960
const RESIZE_STEP = 16
const RESIZE_STEP_LARGE = 64

const uid = useId()
const detailId = `${uid}-detail`
const filterId = `${uid}-filter`
const cellDomId = (row: number, col: number): string => `${uid}-r${row}-c${col}`

const viewport = ref<HTMLElement | null>(null)
const { width: measuredWidth, height: measuredHeight } = useElementSize(viewport)
const scrollTop = shallowRef(0)
const scrollLeft = shallowRef(0)
const selection = shallowRef<GridSelection>(initialSelection())
const query = ref('')
const widthOverrides = shallowRef<ReadonlyMap<number, number>>(new Map())
const copyStatus = ref('')
const copying = ref(false)
const { message: liveMessage, announce, announceSoon } = useAnnouncer()

const loaded = computed(() => {
  // `rows` no es reactivo: la versión es lo que hace releer su longitud.
  void props.version
  return props.rows.length
})

const filter = useResultFilter({ rows: () => props.rows, loaded, query })
const dims = computed(() => ({ rows: filter.count.value, cols: props.columns.length }))
const range = computed(() => selectionRange(selection.value, dims.value))

const formatCount = (value: number): string => value.toLocaleString('es-ES')

// Anchos: la muestra solo crece hasta SAMPLE_ROWS filas, así que llegar a 100 000 no recalcula nada.
const sampleCount = computed(() => Math.min(loaded.value, SAMPLE_ROWS))
const autoWidths = computed(() => {
  void sampleCount.value
  return props.columns.map((column, index) => initialColumnWidth(column, index, props.rows))
})
const widths = computed(() =>
  autoWidths.value.map((width, index) => widthOverrides.value.get(index) ?? width),
)
const layout = computed(() => layoutColumns(widths.value))
const rowNumberSize = computed(() => rowNumberWidth(loaded.value))
const contentWidth = computed(() => rowNumberSize.value + layout.value.total)

const viewportHeight = computed(() => measuredHeight.value || FALLBACK_HEIGHT)
const viewportWidth = computed(() => measuredWidth.value || FALLBACK_WIDTH)
// La cabecera fija ocupa la primera fila del viewport y la columna de número de fila el ancho inicial.
const bodyViewportHeight = computed(() =>
  Math.max(props.rowHeight, viewportHeight.value - props.rowHeight),
)
const dataViewportWidth = computed(() => Math.max(1, viewportWidth.value - rowNumberSize.value))
const pageRows = computed(() =>
  Math.max(1, Math.floor(bodyViewportHeight.value / props.rowHeight) - 1),
)

const rowRange = (): { start: number; end: number } =>
  rowWindow({
    scrollTop: scrollTop.value,
    viewportHeight: bodyViewportHeight.value,
    rowHeight: props.rowHeight,
    rowCount: dims.value.rows,
    overscan: OVERSCAN_ROWS,
  })
// Dos `computed` de números en lugar de uno de objeto: solo re-renderiza cuando cambia un límite de verdad.
const rowStart = computed(() => rowRange().start)
const rowEnd = computed(() => rowRange().end)
const columnRange = (): { start: number; end: number } =>
  columnWindow(
    layout.value.starts,
    layout.value.total,
    scrollLeft.value,
    dataViewportWidth.value,
    OVERSCAN_COLUMNS_PX,
  )
const columnStart = computed(() => columnRange().start)
const columnEnd = computed(() => columnRange().end)

interface VisibleRow {
  display: number
  source: number
}

const visibleRows = computed<VisibleRow[]>(() => {
  void filter.version.value
  const rows: VisibleRow[] = []
  for (let display = rowStart.value; display < rowEnd.value; display += 1) {
    rows.push({ display, source: filter.sourceRow(display) })
  }
  return rows
})

const visibleColumns = computed<number[]>(() => {
  const columns: number[] = []
  for (let col = columnStart.value; col < columnEnd.value; col += 1) columns.push(col)
  return columns
})

const activeCell = computed(() => {
  void filter.version.value
  if (dims.value.rows <= 0 || dims.value.cols <= 0) return null
  const position = clampPosition(selection.value.active, dims.value)
  const source = filter.sourceRow(position.row)
  const value: CellValue = props.rows[source]?.[position.col] ?? null
  return {
    position,
    source,
    value,
    column: props.columns[position.col]!,
    truncatedBytes: truncatedBytes(
      { columns: props.columns, truncatedIndex: props.truncatedIndex },
      source,
      position.col,
    ),
  }
})

const activeDescendant = computed(() => {
  const cell = activeCell.value
  if (!cell) return undefined
  const { row, col } = cell.position
  const visible =
    row >= rowStart.value && row < rowEnd.value && col >= columnStart.value && col < columnEnd.value
  return visible ? cellDomId(row, col) : undefined
})

const countText = computed(() => {
  if (!filter.active.value) {
    return `${formatCount(loaded.value)} ${loaded.value === 1 ? 'fila' : 'filas'}`
  }
  const scanning = filter.scanning.value ? ' (filtrando…)' : ''
  return `${formatCount(filter.count.value)} de ${formatCount(loaded.value)} filas${scanning}`
})

const emptyText = computed(() => {
  if (dims.value.rows > 0) return null
  if (filter.active.value)
    return filter.scanning.value ? 'Filtrando…' : 'Ninguna fila cargada coincide con el filtro.'
  return props.busy ? 'Esperando filas…' : 'La sentencia no devolvió filas.'
})

function valueAt(source: number, col: number): CellValue {
  return props.rows[source]?.[col] ?? null
}

function truncatedAt(source: number, col: number): number | null {
  return props.truncatedIndex.get(source * props.columns.length + col) ?? null
}

function cellTitle(source: number, col: number): string | undefined {
  const value = valueAt(source, col)
  if (value === null) return 'NULL (valor nulo)'
  const original = truncatedAt(source, col)
  if (original !== null) return truncationNotice(original)
  const text = typeof value === 'string' ? value : String(value)
  return text.length * CHAR_WIDTH > (widths.value[col] ?? 0) - CHAR_WIDTH * 2
    ? text.slice(0, 500)
    : undefined
}

function columnTitle(col: number): string {
  const column = props.columns[col]!
  return `${column.name} · ${column.dataType} (${KIND_LABELS[column.kind]})`
}

const isSelected = (row: number, col: number): boolean => isCellSelected(range.value, row, col)
const isActive = (row: number, col: number): boolean => {
  const active = activeCell.value?.position
  return active !== undefined && active.row === row && active.col === col
}

function commit(next: GridSelection, reveal = true): void {
  selection.value = next
  if (reveal) revealPosition(clampPosition(next.active, dims.value))
  const current = selectionRange(next, dims.value)
  if (current) {
    const { rows, cols } = rangeSize(current)
    if (rows > 1 || cols > 1) announceSoon(describeRange(current))
  }
}

function revealPosition(position: CellPosition): void {
  const element = viewport.value
  if (!element || dims.value.rows <= 0) return
  const top = scrollToReveal({
    current: element.scrollTop,
    viewport: bodyViewportHeight.value,
    itemStart: position.row * props.rowHeight,
    itemEnd: (position.row + 1) * props.rowHeight,
    leadingInset: 0,
  })
  const start = layout.value.starts[position.col] ?? 0
  const left = scrollToReveal({
    current: element.scrollLeft,
    viewport: dataViewportWidth.value,
    itemStart: start,
    itemEnd: start + (widths.value[position.col] ?? 0),
    leadingInset: 0,
  })
  if (top !== element.scrollTop) element.scrollTop = top
  if (left !== element.scrollLeft) element.scrollLeft = left
  scrollTop.value = element.scrollTop
  scrollLeft.value = element.scrollLeft
}

function onScroll(): void {
  const element = viewport.value
  if (!element) return
  scrollTop.value = element.scrollTop
  scrollLeft.value = element.scrollLeft
}

function setWidth(col: number, width: number): void {
  const next = new Map(widthOverrides.value)
  next.set(col, clampWidth(width))
  widthOverrides.value = next
}

function resetWidth(col: number): void {
  const next = new Map(widthOverrides.value)
  next.delete(col)
  widthOverrides.value = next
}

function resizeActiveColumn(direction: -1 | 1, large: boolean): void {
  const col = activeCell.value?.position.col
  if (col === undefined) return
  const step = large ? RESIZE_STEP_LARGE : RESIZE_STEP
  setWidth(col, (widths.value[col] ?? 0) + direction * step)
  announceSoon(`Columna ${props.columns[col]!.name}: ${widths.value[col]} píxeles de ancho.`, 250)
}

let resize: { col: number; startX: number; startWidth: number } | null = null

function onResizeDown(event: PointerEvent, col: number): void {
  event.preventDefault()
  event.stopPropagation()
  resize = { col, startX: event.clientX, startWidth: widths.value[col] ?? 0 }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onResizeMove(event: PointerEvent): void {
  if (resize) setWidth(resize.col, resize.startWidth + event.clientX - resize.startX)
}

function onResizeEnd(): void {
  resize = null
}

async function copySelection(withHeaders: boolean): Promise<void> {
  const current = range.value
  if (!current || copying.value) return
  copying.value = true
  copyStatus.value = 'Copiando…'
  const requested = current.rowEnd - current.rowStart + 1
  let message: string
  try {
    const result = await buildTsv(
      {
        columns: props.columns,
        rows: props.rows,
        truncatedIndex: props.truncatedIndex,
        sourceRow: filter.sourceRow,
      },
      current,
      { headers: withHeaders },
    )
    writeClipboard(result.text)
    message = describeCopy(result, requested, withHeaders)
  } catch {
    message = 'No se pudo copiar la selección al portapapeles.'
  } finally {
    copying.value = false
  }
  copyStatus.value = message
  announce(message)
}

function onKeydown(event: KeyboardEvent): void {
  const mod = event.metaKey || event.ctrlKey
  const key = event.key
  let handled = true

  if (event.altKey && !mod && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    resizeActiveColumn(key === 'ArrowLeft' ? -1 : 1, event.shiftKey)
  } else if (event.altKey) {
    handled = false
  } else if (mod && key.toLowerCase() === 'a') {
    commit(selectAll(), false)
  } else if (mod && key.toLowerCase() === 'c') {
    void copySelection(event.shiftKey)
  } else if (event.ctrlKey && key === ' ') {
    const cell = activeCell.value
    if (cell) commit(selectColumn(cell.position.col), false)
  } else if (event.shiftKey && key === ' ') {
    const cell = activeCell.value
    if (cell) commit(selectRow(cell.position.row), false)
  } else {
    const next = navigate(
      selection.value,
      { key, shift: event.shiftKey, mod, pageRows: pageRows.value },
      dims.value,
    )
    if (next) commit(next)
    else handled = false
  }

  if (handled) {
    event.preventDefault()
    event.stopPropagation()
  }
}

function onClick(event: MouseEvent): void {
  const target = event.target
  if (!(target instanceof Element) || target.closest('[data-resize]')) return
  const part = target.closest<HTMLElement>('[data-grid-part]')
  if (!part) return
  const row = Number(part.dataset.row)
  const col = Number(part.dataset.col)
  switch (part.dataset.gridPart) {
    case 'cell':
      commit(
        event.shiftKey ? extendSelection(selection.value, { row, col }) : selectCell({ row, col }),
        false,
      )
      break
    case 'row-header':
      commit(selectRow(row), false)
      break
    case 'column-header':
      commit(selectColumn(col), false)
      break
    case 'corner':
      commit(selectAll(), false)
      break
    default:
      return
  }
  viewport.value?.focus({ preventScroll: true })
}

function onFilterEscape(event: KeyboardEvent): void {
  if (query.value === '') return
  query.value = ''
  event.stopPropagation()
}

watch(query, () => {
  selection.value = initialSelection()
  const element = viewport.value
  if (element) element.scrollTop = 0
  scrollTop.value = 0
})

watch(
  () => props.busy,
  (busy, wasBusy) => {
    if (wasBusy && !busy) {
      announce(`Resultado completo: ${formatCount(loaded.value)} filas cargadas.`)
    }
  },
)

watch(
  [filter.scanning, filter.count, filter.active],
  ([scanning, count, active], [, , wasActive]) => {
    if (scanning || props.busy) return
    if (active) {
      announceSoon(
        `${formatCount(count)} de ${formatCount(loaded.value)} filas coinciden con el filtro.`,
      )
    } else if (wasActive) {
      announceSoon(`Filtro quitado: ${formatCount(loaded.value)} filas.`)
    }
  },
)

onBeforeUnmount(() => {
  resize = null
})
</script>

<template>
  <div
    class="results-grid"
    data-part="results-grid"
    :style="{ '--results-row-height': `${rowHeight}px` }"
  >
    <div class="results-grid__toolbar" data-part="grid-toolbar">
      <label class="visually-hidden" :for="filterId">Filtrar las filas cargadas</label>
      <input
        :id="filterId"
        v-model="query"
        type="search"
        class="results-grid__filter"
        placeholder="Filtrar filas cargadas…"
        autocomplete="off"
        spellcheck="false"
        data-part="filter-input"
        @keydown.esc="onFilterEscape"
      />
      <span class="results-grid__count" data-part="filter-count">{{ countText }}</span>
      <span v-if="caption" class="results-grid__note" data-part="grid-caption">{{ caption }}</span>
      <span v-if="limited" class="results-grid__note" data-part="limit-note">
        Recortado por el límite de filas: el filtro y la copia solo abarcan las filas cargadas.
      </span>
      <span v-else class="results-grid__note" data-part="filter-scope">
        El filtro solo abarca las filas cargadas.
      </span>
      <span
        v-if="copyStatus"
        class="results-grid__note"
        aria-hidden="true"
        data-part="copy-status"
        >{{ copyStatus }}</span
      >
    </div>

    <div
      ref="viewport"
      class="results-grid__viewport"
      role="grid"
      tabindex="0"
      aria-label="Resultados de la consulta"
      aria-multiselectable="true"
      :aria-rowcount="dims.rows + 1"
      :aria-colcount="dims.cols + 1"
      :aria-busy="busy"
      :aria-describedby="detailId"
      :aria-activedescendant="activeDescendant"
      data-part="grid"
      @scroll.passive="onScroll"
      @keydown="onKeydown"
      @click="onClick"
    >
      <div
        class="results-grid__header"
        role="rowgroup"
        :style="{ width: `${contentWidth}px` }"
        data-part="grid-header"
      >
        <div class="results-grid__row results-grid__row--header" role="row" aria-rowindex="1">
          <div
            role="columnheader"
            aria-colindex="1"
            aria-label="Número de fila"
            class="results-grid__corner"
            data-grid-part="corner"
            :style="{ width: `${rowNumberSize}px` }"
          >
            #
          </div>
          <div
            v-for="col in visibleColumns"
            :key="col"
            role="columnheader"
            class="results-grid__colhead"
            :class="{ 'results-grid__colhead--end': isRightAligned(columns[col]!.kind) }"
            :aria-colindex="col + 2"
            :aria-selected="coversColumn(range, col, dims)"
            :title="columnTitle(col)"
            :data-col="col"
            :data-kind="columns[col]!.kind"
            data-grid-part="column-header"
            :style="{
              left: `${rowNumberSize + layout.starts[col]!}px`,
              width: `${widths[col]}px`,
            }"
          >
            <span class="results-grid__colname">{{ columns[col]!.name }}</span>
            <span class="results-grid__coltype mono" data-part="column-type">{{
              columns[col]!.dataType
            }}</span>
            <span
              class="results-grid__resize"
              aria-hidden="true"
              data-resize
              @pointerdown="onResizeDown($event, col)"
              @pointermove="onResizeMove"
              @pointerup="onResizeEnd"
              @pointercancel="onResizeEnd"
              @dblclick.stop="resetWidth(col)"
            ></span>
          </div>
        </div>
      </div>

      <div
        class="results-grid__body"
        role="rowgroup"
        :style="{ width: `${contentWidth}px`, height: `${dims.rows * rowHeight}px` }"
        data-part="grid-body"
      >
        <div
          v-for="row in visibleRows"
          :key="row.display"
          class="results-grid__row"
          :class="{ 'results-grid__row--alt': row.display % 2 === 1 }"
          role="row"
          :aria-rowindex="row.display + 2"
          :style="{ top: `${row.display * rowHeight}px`, width: `${contentWidth}px` }"
        >
          <div
            role="rowheader"
            aria-colindex="1"
            class="results-grid__rownum mono"
            data-grid-part="row-header"
            :data-row="row.display"
            :style="{ width: `${rowNumberSize}px` }"
          >
            {{ formatCount(row.source + 1) }}
          </div>
          <div
            v-for="col in visibleColumns"
            :id="cellDomId(row.display, col)"
            :key="col"
            role="gridcell"
            class="results-grid__cell mono"
            :class="{
              'results-grid__cell--end': isRightAligned(columns[col]!.kind),
              'results-grid__cell--active': isActive(row.display, col),
              'results-grid__cell--truncated': truncatedAt(row.source, col) !== null,
            }"
            :aria-colindex="col + 2"
            :aria-selected="isSelected(row.display, col)"
            :title="cellTitle(row.source, col)"
            :data-row="row.display"
            :data-col="col"
            data-grid-part="cell"
            :style="{
              left: `${rowNumberSize + layout.starts[col]!}px`,
              width: `${widths[col]}px`,
            }"
          >
            <span
              v-if="valueAt(row.source, col) === null"
              class="results-grid__null"
              data-part="null"
              >NULL</span
            >
            <template v-else>
              <template v-if="truncatedAt(row.source, col) !== null">
                <span
                  class="results-grid__flag"
                  aria-hidden="true"
                  data-part="truncated-flag"
                ></span>
                <span class="visually-hidden">Valor truncado. </span>
              </template>
              {{ displayText(valueAt(row.source, col)) }}
            </template>
          </div>
        </div>
      </div>
    </div>

    <p v-if="emptyText" class="placeholder" data-part="grid-empty">{{ emptyText }}</p>

    <div
      :id="detailId"
      class="results-grid__detail"
      tabindex="0"
      role="group"
      aria-label="Valor de la celda enfocada"
      data-part="cell-detail"
    >
      <template v-if="activeCell">
        <span class="results-grid__detail-meta" data-part="detail-meta">
          Fila {{ formatCount(activeCell.source + 1) }} · {{ activeCell.column.name }} ·
          {{ activeCell.column.dataType }}
        </span>
        <span
          v-if="activeCell.truncatedBytes !== null"
          class="results-grid__detail-warning"
          data-part="detail-truncated"
        >
          <span class="results-grid__flag" aria-hidden="true"></span>
          {{ truncationNotice(activeCell.truncatedBytes) }}
        </span>
        <pre
          class="results-grid__detail-value mono"
          :class="{ 'results-grid__detail-value--null': activeCell.value === null }"
          data-part="detail-value"
          >{{ fullText(activeCell.value) }}</pre>
      </template>
      <span v-else class="placeholder" data-part="detail-empty"
        >Selecciona una celda para ver su valor completo.</span
      >
    </div>

    <div class="visually-hidden" role="status" aria-live="polite" data-part="live">
      {{ liveMessage }}
    </div>
  </div>
</template>

<style scoped>
.results-grid {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  height: 100%;
  /* Con el panel al mínimo el grid no se aplasta: el panel pasa a desplazarse. */
  min-height: 12rem;
}

.results-grid__toolbar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-1) var(--spacing-3);
}

.results-grid__filter {
  width: 16rem;
  max-width: 100%;
  min-height: 28px;
  padding: 0 var(--spacing-2);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  background-color: var(--input-bg);
  color: var(--input-fg);
  font-size: var(--font-size-sm);
  transition: border-color var(--motion-duration-fast) var(--motion-easing-out);
}

.results-grid__filter:focus-visible {
  border-color: var(--input-border-focus);
  outline-offset: 0;
}

.results-grid__count {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.results-grid__note {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

/* El recorte cambia lo que el filtro y la copia abarcan: se marca con glifo, no solo con texto. */
.results-grid__note[data-part='limit-note'] {
  color: var(--text-primary);
}

.results-grid__note[data-part='limit-note']::before {
  content: var(--status-glyph-warning);
  margin-inline-end: var(--spacing-1);
  color: var(--status-warning);
}

.results-grid__viewport {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--grid-border);
  border-radius: var(--radius-sm);
  outline-offset: -2px;
  user-select: none;
}

.results-grid__header {
  position: sticky;
  top: 0;
  z-index: 2;
  min-width: 100%;
  height: var(--results-row-height);
  background: var(--grid-header-bg);
  color: var(--grid-header-fg);
}

.results-grid__body {
  position: relative;
  min-width: 100%;
}

.results-grid__row {
  position: absolute;
  left: 0;
  height: var(--results-row-height);
  line-height: var(--results-row-height);
}

.results-grid__row--header {
  position: relative;
  border-bottom: 1px solid var(--border-strong);
}

.results-grid__body .results-grid__row {
  border-bottom: 1px solid var(--grid-border);
}

.results-grid__body .results-grid__row--alt {
  background: var(--grid-row-alt-bg);
}

.results-grid__body .results-grid__row:hover {
  background: var(--grid-row-hover-bg);
}

.results-grid__corner,
.results-grid__rownum {
  position: sticky;
  left: 0;
  z-index: 3;
  height: 100%;
  padding: 0 var(--spacing-2);
  overflow: hidden;
  border-inline-end: 1px solid var(--grid-border);
  background: var(--grid-gutter-bg);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  text-align: right;
  white-space: nowrap;
  cursor: pointer;
}

.results-grid__corner {
  border-inline-end-color: var(--border-strong);
  background: var(--grid-header-bg);
  color: var(--grid-header-fg);
  font-weight: var(--font-weight-semibold);
}

.results-grid__rownum {
  z-index: 1;
}

.results-grid__rownum:hover {
  color: var(--text-primary);
}

.results-grid__colhead,
.results-grid__cell {
  position: absolute;
  top: 0;
  height: 100%;
  padding: 0 var(--spacing-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.results-grid__colhead {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-2);
  border-inline-end: 1px solid var(--border-strong);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.results-grid__colhead:hover {
  box-shadow: inset 0 -2px 0 var(--border-strong);
}

.results-grid__colhead[aria-selected='true'] {
  box-shadow: inset 0 -2px 0 var(--action-primary);
}

.results-grid__colhead--end {
  justify-content: flex-end;
}

.results-grid__colname {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* La jerarquía cabecera/tipo va en peso y opacidad, no en text.muted: no llega a AA sobre grid.header-bg. */
.results-grid__coltype {
  flex: none;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-regular);
  opacity: 0.75;
}

.results-grid__resize {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  touch-action: none;
}

.results-grid__resize:hover {
  background: var(--border-strong);
}

.results-grid__cell {
  border-inline-end: 1px solid var(--grid-border);
  cursor: cell;
}

.results-grid__cell--end {
  text-align: right;
}

.results-grid__cell--truncated {
  box-shadow: inset 2px 0 0 var(--status-warning);
}

.results-grid__cell[aria-selected='true'] {
  background: var(--grid-selection-bg);
}

.results-grid__cell--active {
  outline: 1px solid var(--border-strong);
  outline-offset: -1px;
}

.results-grid__viewport:focus-visible .results-grid__cell--active {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}

.results-grid__null {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-style: italic;
  letter-spacing: 0.04em;
}

.results-grid__flag::before {
  content: var(--status-glyph-warning);
  color: var(--status-warning);
  margin-inline-end: var(--spacing-1);
}

.results-grid__detail {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--spacing-1) var(--spacing-3);
  max-height: 6rem;
  padding: var(--spacing-2) var(--spacing-3);
  overflow: auto;
  border: 1px solid var(--grid-border);
  border-radius: var(--radius-sm);
  background: var(--surface-card);
  user-select: text;
}

.results-grid__detail:focus-visible {
  outline-offset: -2px;
}

.results-grid__detail-meta {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  line-height: var(--font-line-height-xs);
}

.results-grid__detail-warning {
  color: var(--status-warning);
  font-size: var(--font-size-xs);
  line-height: var(--font-line-height-xs);
}

.results-grid__detail-value {
  flex: 1 1 12rem;
  min-width: 0;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.results-grid__detail-value--null {
  color: var(--text-muted);
  font-style: italic;
}
</style>
