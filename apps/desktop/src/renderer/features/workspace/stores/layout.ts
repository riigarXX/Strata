import { defineStore } from 'pinia'
import { ref } from 'vue'

// Tamaños en píxeles CSS de los paneles redimensionables. Los límites viven junto al componente que
// los aplica, porque el máximo depende del espacio disponible en cada momento.
export const SIDEBAR_SIZE = { initial: 240, min: 180, max: 480 } as const
export const PANEL_SIZE = { initial: 360, min: 96, max: 720 } as const

export const useLayoutStore = defineStore('layout', () => {
  const sidebarSize = ref<number>(SIDEBAR_SIZE.initial)
  const panelSize = ref<number>(PANEL_SIZE.initial)
  return { sidebarSize, panelSize }
})
