import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Estado de interfaz del panel de historial: permite abrirlo desde la barra, la paleta y el teclado. */
export const useHistoryPanelStore = defineStore('historyPanel', () => {
  const isOpen = ref(false)

  function open(): void {
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
  }

  function toggle(): void {
    isOpen.value = !isOpen.value
  }

  return { isOpen, open, close, toggle }
})
