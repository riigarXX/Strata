import { defineStore } from 'pinia'
import { ref } from 'vue'

export const SETTINGS_SECTIONS = ['appearance', 'execution', 'history', 'ai'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/** Estado de interfaz de la pantalla de ajustes: permite abrirla desde la barra, la paleta y el teclado. */
export const useSettingsStore = defineStore('settings', () => {
  const isOpen = ref(false)
  /** Sección a la que se lleva el foco al abrir; `null` abre desde el principio. */
  const section = ref<SettingsSection | null>(null)

  function open(target: SettingsSection | null = null): void {
    section.value = target
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
  }

  return { isOpen, section, open, close }
})
