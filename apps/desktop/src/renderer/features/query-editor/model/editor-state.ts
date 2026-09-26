import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { sql } from '@codemirror/lang-sql'
import { bracketMatching } from '@codemirror/language'
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Facet,
  type Extension,
} from '@codemirror/state'
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { highlightDialect, type SqlEngine } from './dialects'
import { strataTheme } from './editor-theme'
import { isFormatShortcut } from './format-shortcut'

/** Motor cuyo dialecto tiene configurado el estado; permite detectar estados guardados desfasados. */
export const engineFacet = Facet.define<SqlEngine | null, SqlEngine | null>({
  combine: (values) => values[0] ?? null,
})

/** Marca los cambios que vienen del store (no del usuario) para no reescribirlos de vuelta. */
export const externalSync = Annotation.define<boolean>()

export const languageCompartment = new Compartment()

export function languageExtension(engine: SqlEngine | null): Extension {
  return [sql({ dialect: highlightDialect(engine) }), engineFacet.of(engine)]
}

// Mod-Enter y Mod-l quedan libres para los atajos globales de ejecutar y de enfocar el editor.
const RESERVED_KEYS = new Set(['Mod-Enter', 'Mod-l'])
const baseKeymap = defaultKeymap.filter((binding) => !RESERVED_KEYS.has(binding.key ?? ''))

/** Rango del documento que cubre la selección del DOM, o `null` si no hay o cae fuera del editor. */
function domSelectionRange(view: EditorView): { from: number; to: number } | null {
  const { root, contentDOM } = view
  // Dentro de un shadow root la selección se lee del propio root (Chromium); en un documento, del documento.
  const selection = (root as Document).getSelection()
  const { anchorNode, focusNode } = selection ?? {}
  if (!selection || !anchorNode || !focusNode) return null
  if (!contentDOM.contains(anchorNode) || !contentDOM.contains(focusNode)) return null
  const anchor = view.posAtDOM(anchorNode, selection.anchorOffset)
  const focus = view.posAtDOM(focusNode, selection.focusOffset)
  return { from: Math.min(anchor, focus), to: Math.max(anchor, focus) }
}

/**
 * Teclear sobre una selección resaltada (Mod+A y escribir, o un `fill`) hace que Chromium arrastre el color
 * y el peso del token al texto nuevo como `style=""` en línea, y `style-src 'self'` lo rechaza con un
 * `console.error`. Sin composición ni varios cursores el reemplazo se resuelve en CodeMirror, que después
 * vuelve a pintar el documento igualmente: el DOM nunca llega a editarse. Se lee la selección del DOM y no
 * la del estado, que CodeMirror sincroniza de forma asíncrona y puede ir por detrás de una selección reciente.
 */
export const typeOverSelection: Extension = EditorView.domEventHandlers({
  beforeinput(event, view) {
    if (event.inputType !== 'insertText' || event.isComposing || !event.data) return false
    const { state } = view
    if (state.selection.ranges.length !== 1) return false
    const range = domSelectionRange(view)
    if (!range || range.from === range.to) return false

    const text = event.data
    const insert = () =>
      state.update({
        changes: { from: range.from, to: range.to, insert: text },
        selection: EditorSelection.cursor(range.from + text.length),
        scrollIntoView: true,
        userEvent: 'input.type',
      })
    const handled = state.facet(EditorView.inputHandler).some((handle) => {
      return handle(view, range.from, range.to, text, insert)
    })
    if (!handled) view.dispatch(insert())
    return true
  },
})

export interface EditorExtensionsOptions {
  /** Nombre accesible del cuadro de texto; se lee en cada actualización. */
  label: () => string
  /** Atajo local `Shift+Alt+F`. */
  onFormat: () => void
  /** Se llama tras cada actualización con cambios de documento que no son externos. */
  onEdit: (state: EditorState) => void
}

/**
 * Extensiones comunes a todas las pestañas. Tab indenta; Esc y luego Tab saca el foco del editor
 * (modo «tab-focus» integrado de CodeMirror), así que no es una trampa de teclado.
 */
export function createEditorExtensions(options: EditorExtensionsOptions): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    bracketMatching(),
    keymap.of([indentWithTab, ...baseKeymap, ...historyKeymap]),
    EditorView.domEventHandlers({
      keydown(event) {
        if (!isFormatShortcut(event)) return false
        event.preventDefault()
        options.onFormat()
        return true
      },
    }),
    typeOverSelection,
    EditorView.contentAttributes.of(() => ({
      'aria-label': options.label(),
      'aria-description': 'Pulsa Esc y después Tab para salir del editor',
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
    })),
    EditorView.updateListener.of((update) => {
      const external = update.transactions.some((tr) => tr.annotation(externalSync))
      if (update.docChanged && !external) options.onEdit(update.state)
    }),
    strataTheme,
  ]
}

export function createEditorState(
  doc: string,
  engine: SqlEngine | null,
  extensions: Extension[],
): EditorState {
  return EditorState.create({
    doc,
    extensions: [languageCompartment.of(languageExtension(engine)), ...extensions],
  })
}
