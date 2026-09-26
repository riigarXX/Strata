import { defineStore } from 'pinia'
import { nextTick, ref } from 'vue'
import { deepActiveElement } from '../../../components/focus'
import { useQueryEditor } from '../../query-editor'
import type { PaletteMode } from '../model/context'

const MAX_RECENTS = 20

/** Devuelve el foco a `target`; el editor CodeMirror lo recupera con `focus()` de su vista para conservar la selección. */
function focusBack(target: HTMLElement | null): void {
  const editor = useQueryEditor()
  if (target?.isConnected) {
    if (target.closest('.cm-editor') && editor.focusEditor()) return
    target.focus()
    return
  }
  // El elemento ya no existe (p. ej. su pestaña se cerró): lo más útil es el editor.
  editor.focusEditor()
}

/**
 * Estado de la paleta. Solo guarda si está abierta, en qué modo, lo escrito y los comandos usados
 * (ids, sin argumentos); el elemento que tenía el foco se guarda fuera del estado reactivo.
 */
export const usePaletteStore = defineStore('commandPalette', () => {
  const isOpen = ref(false)
  const mode = ref<PaletteMode>('commands')
  const query = ref('')
  const recents = ref<string[]>([])
  const announcement = ref('')
  let opener: HTMLElement | null = null

  /** Abre la paleta o, si ya está abierta, cambia de modo y de texto sin perder el elemento al que devolver el foco. */
  function open(nextMode: PaletteMode = 'commands', initialQuery = ''): void {
    if (!isOpen.value) opener = deepActiveElement()
    mode.value = nextMode
    query.value = initialQuery
    isOpen.value = true
  }

  /** Cierra y, cuando el DOM ya no contiene la paleta, devuelve el foco exactamente a donde estaba. */
  async function close(): Promise<void> {
    if (!isOpen.value) return
    isOpen.value = false
    const target = opener
    opener = null
    await nextTick()
    focusBack(target)
  }

  function toggle(): void {
    if (isOpen.value) void close()
    else open('commands')
  }

  function recordUse(commandId: string): void {
    recents.value = [commandId, ...recents.value.filter((id) => id !== commandId)].slice(
      0,
      MAX_RECENTS,
    )
  }

  /** Anuncia un mensaje a las tecnologías de apoyo; el mismo texto seguido se vuelve a leer. */
  async function announce(message: string): Promise<void> {
    announcement.value = ''
    await nextTick()
    announcement.value = message
  }

  return { isOpen, mode, query, recents, announcement, open, close, toggle, recordUse, announce }
})
