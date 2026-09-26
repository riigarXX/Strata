import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Estado de interfaz de la gestión de conexiones: permite abrirla desde la paleta y desde la barra lateral. */
export const useConnectionsPanelStore = defineStore('connectionsPanel', () => {
  const manageOpen = ref(false)

  function openManage(): void {
    manageOpen.value = true
  }

  function closeManage(): void {
    manageOpen.value = false
  }

  return { manageOpen, openManage, closeManage }
})
