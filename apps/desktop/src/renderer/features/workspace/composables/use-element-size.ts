import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/** Tamaño de contenido de un elemento en px; `0` mientras no se haya medido. */
export function useElementSize(target: Ref<HTMLElement | null>): {
  width: Ref<number>
  height: Ref<number>
} {
  const width = ref(0)
  const height = ref(0)
  let observer: ResizeObserver | undefined

  onMounted(() => {
    const element = target.value
    if (!element || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(([entry]) => {
      width.value = entry?.contentRect.width ?? 0
      height.value = entry?.contentRect.height ?? 0
    })
    observer.observe(element)
  })
  onBeforeUnmount(() => observer?.disconnect())

  return { width, height }
}
