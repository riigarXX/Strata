/** Ventana para seguir componiendo la misma búsqueda por escritura. */
export const TYPEAHEAD_TIMEOUT_MS = 700

/**
 * Búsqueda por escritura de un árbol (WAI-ARIA APG): las letras se acumulan mientras se teclea sin
 * pausa; una misma letra repetida recorre los nodos que empiezan por ella.
 */
export class Typeahead {
  private buffer = ''
  private lastAt = Number.NEGATIVE_INFINITY

  /** Un espacio solo forma parte de la búsqueda si ya hay algo escrito; si no, es una acción de teclado. */
  get active(): boolean {
    return this.buffer !== ''
  }

  /**
   * Índice del nodo al que saltar, o `null` si nada coincide. `labels` son los nodos visibles en orden
   * y `current` el índice del nodo con foco.
   */
  push(char: string, labels: readonly string[], current: number, now: number): number | null {
    if (now - this.lastAt > TYPEAHEAD_TIMEOUT_MS) this.buffer = ''
    this.lastAt = now
    this.buffer += char.toLocaleLowerCase()

    const repeated = [...this.buffer].every((entry) => entry === this.buffer[0])
    const needle = repeated ? this.buffer[0]! : this.buffer
    // Con una letra repetida se empieza tras el nodo actual; con una palabra, desde él mismo.
    const start = repeated ? current + 1 : Math.max(current, 0)
    for (let step = 0; step < labels.length; step += 1) {
      const index = (start + step) % labels.length
      if (labels[index]!.toLocaleLowerCase().startsWith(needle)) return index
    }
    return null
  }
}
