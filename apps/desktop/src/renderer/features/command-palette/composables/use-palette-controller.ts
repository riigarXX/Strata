import { parseInternalCommand } from '@strata/commands'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { commandIdOfInternal, resolveInternal } from '../model/internal-dispatch'
import { buildPaletteView, type PaletteItem, type PaletteView } from '../model/palette-items'
import { useCommandCenter } from '../stores/command-center'
import { usePaletteStore } from '../stores/palette'
import { currentPlatform } from './use-shortcut-hints'

// Pausa tras la última pulsación antes de anunciar el recuento: evita leer cada letra escrita.
const ANNOUNCE_DELAY_MS = 250

export function describeCount(count: number): string {
  if (count === 0) return 'Sin resultados'
  return `${count} ${count === 1 ? 'resultado' : 'resultados'}`
}

/**
 * Lógica de la paleta: qué se lista (`buildPaletteView`), qué elemento está activo y qué ocurre al
 * elegirlo. El componente solo pinta y traslada las teclas.
 */
export function usePaletteController() {
  const palette = usePaletteStore()
  const center = useCommandCenter()
  const platform = currentPlatform()

  const view = computed<PaletteView>(() =>
    buildPaletteView({
      registry: center.registry,
      context: center.context,
      platform,
      mode: palette.mode,
      query: palette.query,
      recents: palette.recents,
    }),
  )

  const activeIndex = ref(0)
  /** Último error de validación (comando desconocido, conexión inexistente…): la paleta sigue abierta. */
  const message = ref('')
  const resultsAnnouncement = ref('')

  const active = computed<PaletteItem | null>(() => view.value.items[activeIndex.value] ?? null)

  watch(
    () => [palette.isOpen, palette.mode, palette.query] as const,
    () => {
      activeIndex.value = 0
      message.value = ''
    },
  )

  let announceTimer: ReturnType<typeof setTimeout> | undefined
  watch(
    () => (palette.isOpen ? describeCount(view.value.items.length) : ''),
    (text) => {
      clearTimeout(announceTimer)
      if (text === '') {
        resultsAnnouncement.value = ''
        return
      }
      announceTimer = setTimeout(() => {
        resultsAnnouncement.value = text
      }, ANNOUNCE_DELAY_MS)
    },
    { immediate: true },
  )
  onBeforeUnmount(() => clearTimeout(announceTimer))

  function move(target: number): void {
    const count = view.value.items.length
    if (count === 0) return
    activeIndex.value = ((target % count) + count) % count
  }

  function fail(text: string): void {
    message.value = text
    void palette.announce(text)
  }

  /** Cierra devolviendo el foco y, ya con el foco en su sitio, ejecuta. */
  async function closeThen(run: () => void | Promise<void>): Promise<void> {
    await palette.close()
    await run()
  }

  async function runCommand(commandId: string, args?: Record<string, unknown>): Promise<void> {
    await palette.close()
    palette.recordUse(commandId)
    const outcome = await center.registry.execute(commandId, args)
    if (!outcome.ok) void palette.announce(outcome.message)
  }

  /** Analiza y ejecuta una entrada `\comando args`; los errores se muestran en la paleta, que sigue abierta. */
  async function submitInternal(input: string): Promise<void> {
    const parsed = parseInternalCommand(input)
    if (!parsed.ok) return fail(parsed.error.message)

    const commandId = commandIdOfInternal(parsed.invocation.command)
    const availability = center.registry.availability(commandId)
    if (!availability.enabled) return fail(availability.reason)

    const target = resolveInternal(center.context, parsed.invocation)
    if (!target.ok) return fail(target.message)
    await runCommand(target.value.commandId, { ...target.value.args })
  }

  async function activate(item: PaletteItem | null = active.value): Promise<void> {
    if (!item) return
    if (item.disabledReason !== null) return fail(`No disponible: ${item.disabledReason}`)

    const { action } = item
    switch (action.type) {
      case 'command':
        return runCommand(action.commandId)
      case 'internal-command':
        if (action.needsArguments) {
          palette.query = `\\${action.name} `
          return
        }
        return submitInternal(`\\${action.name}`)
      case 'internal':
        return submitInternal(action.input)
      case 'connect':
        return closeThen(() => center.context.actions.connect(action.profileId))
      case 'insert':
        return closeThen(() => center.context.actions.insertText(action.text))
    }
  }

  /** Enter sin elemento activo: en modo de comandos internos se interpreta lo escrito tal cual. */
  async function submit(): Promise<void> {
    if (active.value) return activate()
    if (palette.mode === 'commands' && palette.query.trimStart().startsWith('\\')) {
      return submitInternal(palette.query)
    }
  }

  /** Tab en modo de comandos internos: completa el campo con el elemento activo. */
  function complete(): void {
    const completion = active.value?.completion
    if (completion) palette.query = completion
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        void palette.close()
        return
      case 'ArrowDown':
        event.preventDefault()
        move(activeIndex.value + 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        move(activeIndex.value - 1)
        return
      case 'Home':
        if (!plain) return
        event.preventDefault()
        move(0)
        return
      case 'End':
        if (!plain) return
        event.preventDefault()
        move(view.value.items.length - 1)
        return
      case 'Enter':
        if (!plain) return
        event.preventDefault()
        void submit()
        return
      case 'Tab':
        // La paleta es un diálogo con un único campo: el foco no puede escaparse hacia la página.
        event.preventDefault()
        complete()
        return
    }
  }

  // Esc también cierra si el foco está fuera del diálogo (p. ej. tras un clic en su texto).
  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && palette.isOpen && !event.defaultPrevented) {
      event.preventDefault()
      void palette.close()
    }
  }
  onMounted(() => window.addEventListener('keydown', onWindowKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

  function hover(index: number): void {
    activeIndex.value = index
  }

  return {
    palette,
    view,
    activeIndex,
    active,
    message,
    resultsAnnouncement,
    onKeydown,
    activate,
    hover,
  }
}
