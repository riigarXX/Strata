import { onScopeDispose, shallowRef, type Ref } from 'vue'

export interface Announcer {
  message: Ref<string>
  /** Anuncia ya (para resultados de una acción del usuario, como copiar). */
  announce: (text: string) => void
  /** Anuncia pasado `delayMs` sin nuevas llamadas: para cambios continuos como mover una selección con el teclado. */
  announceSoon: (text: string, delayMs?: number) => void
}

const DEFAULT_DELAY_MS = 400

/** Región `aria-live` con anuncios moderados: los cambios rápidos se agrupan en uno. */
export function useAnnouncer(): Announcer {
  const message = shallowRef('')
  let timer: ReturnType<typeof setTimeout> | undefined

  function clear(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function announce(text: string): void {
    clear()
    message.value = text
  }

  function announceSoon(text: string, delayMs = DEFAULT_DELAY_MS): void {
    clear()
    timer = setTimeout(() => {
      timer = undefined
      message.value = text
    }, delayMs)
  }

  onScopeDispose(clear)
  return { message, announce, announceSoon }
}
