import { onBeforeUnmount, onMounted } from 'vue'
import { currentExecutionPort } from '../../execution/composables/execution-port'
import { describeBlocked } from '../model/feedback'
import { isNativeDialogOpen, isOverlayOpen } from '../model/overlays'
import { useCommandCenter } from '../stores/command-center'
import { usePaletteStore } from '../stores/palette'
import { currentPlatform } from './use-shortcut-hints'

/**
 * Atajos globales, todos resueltos por el registro de comandos (única fuente de verdad). Se escucha en
 * `window`: los eventos del editor CodeMirror, dentro de su shadow root, llegan aquí con el foco en él.
 *
 * Precedencia: 1) un diálogo u overlay abierto se lo queda todo, salvo los comandos de la propia paleta
 * (`whileModal`); 2) un evento que ya consumió otro (`defaultPrevented`: p. ej. Esc colapsando una selección
 * múltiple en CodeMirror) no se ejecuta; 3) los atajos `passthrough` (Esc) solo actúan si el comando está
 * habilitado y no consumen el evento, así que «Esc y luego Tab» sigue sacando el foco del editor.
 */
export function useGlobalShortcuts(): void {
  const center = useCommandCenter()
  const palette = usePaletteStore()
  const platform = currentPlatform()

  function reportBlocked(id: string, title: string, reason: string): void {
    const message = describeBlocked(title, reason)
    void palette.announce(message)
    if (id.startsWith('query.') || id.startsWith('transaction.')) {
      currentExecutionPort()?.showHint(message)
    }
  }

  async function run(id: string): Promise<void> {
    const outcome = await center.registry.execute(id)
    if (!outcome.ok && outcome.reason === 'failed') void palette.announce(outcome.message)
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return
    const command = center.registry.findByKey(event, platform)
    if (!command) return

    const { passthrough = false, repeat = false, whileModal = false } = command.keyboard
    // Se mira el estado de la paleta y no solo el DOM: entre abrirla y pintarla pasa un ciclo de Vue.
    const blocked = palette.isOpen ? !whileModal || isNativeDialogOpen() : isOverlayOpen()
    if (blocked) return

    const availability = center.registry.availability(command.id)
    if (passthrough) {
      if (event.defaultPrevented || event.repeat || !availability.enabled) return
      void run(command.id)
      return
    }

    if (event.defaultPrevented) return
    event.preventDefault()
    if (event.repeat && !repeat) return
    if (availability.enabled) void run(command.id)
    else if (!event.repeat) reportBlocked(command.id, command.title, availability.reason)
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
