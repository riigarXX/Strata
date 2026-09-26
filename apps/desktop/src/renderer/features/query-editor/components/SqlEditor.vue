<script setup lang="ts">
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWorkspaceStore, type SqlTab } from '../../workspace/stores/workspace'
import { registerEditor } from '../composables/use-query-editor'
import type { SqlEngine } from '../model/dialects'
import {
  createEditorExtensions,
  createEditorState,
  engineFacet,
  externalSync,
  languageCompartment,
  languageExtension,
} from '../model/editor-state'
import { selectionOrDocument, wholeDocument } from '../model/execution-text'
import { formatSql } from '../model/format-sql'
import { TabEditorStates, type SavedEditor } from '../model/tab-editor-states'

const props = defineProps<{ tab: SqlTab; engine: SqlEngine | null }>()

const workspace = useWorkspaceStore()
const host = ref<HTMLElement | null>(null)
const status = ref('')

const states = new TabEditorStates()
let view: EditorView | null = null
let currentTabId = props.tab.id
// Último texto que el editor y el store comparten: evita reescribir en bucle y comparar documentos enteros.
let syncedContent = props.tab.content
let unregister: (() => void) | null = null

const extensions = createEditorExtensions({
  label: () => `Editor SQL de ${props.tab.title}`,
  onFormat: () => void formatDocument(),
  onEdit: (state) => {
    syncedContent = state.doc.toString()
    workspace.setContent(currentTabId, syncedContent)
  },
})

/** Estado guardado de la pestaña (o uno nuevo), puesto al día con su texto y su motor actuales. */
function stateFor(tab: SqlTab): { state: EditorState; saved: SavedEditor | undefined } {
  const saved = states.get(tab.id)
  let state = saved?.state ?? createEditorState(tab.content, props.engine, extensions)
  const stale = state.facet(engineFacet) !== props.engine
  const diverged = state.doc.toString() !== tab.content
  if (stale || diverged) {
    state = state.update({
      changes: diverged ? { from: 0, to: state.doc.length, insert: tab.content } : undefined,
      effects: stale ? [languageCompartment.reconfigure(languageExtension(props.engine))] : [],
      annotations: externalSync.of(true),
    }).state
  }
  syncedContent = tab.content
  return { state, saved }
}

function switchTab(previousId: string): void {
  if (!view) return
  if (workspace.tabs.some((tab) => tab.id === previousId)) states.save(previousId, view)
  currentTabId = props.tab.id
  const { state, saved } = stateFor(props.tab)
  view.setState(state)
  if (saved) view.dispatch({ effects: saved.scroll })
}

watch(
  () => props.tab.id,
  (_id, previousId) => switchTab(previousId),
)

// El store es la fuente de verdad: si su texto cambia por fuera del editor, el documento lo sigue.
watch(
  () => props.tab.content,
  (content) => {
    if (!view || content === syncedContent) return
    syncedContent = content
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: externalSync.of(true),
    })
  },
)

watch(
  () => props.engine,
  (engine) => {
    if (!view || view.state.facet(engineFacet) === engine) return
    view.dispatch({ effects: languageCompartment.reconfigure(languageExtension(engine)) })
  },
)

watch(
  () => workspace.tabs.map((tab) => tab.id),
  (ids) => states.prune(new Set(ids)),
)

/** Inserta en el cursor (sustituyendo la selección) los textos que el store tiene en cola para esta pestaña. */
function drainInserts(): void {
  if (!view) return
  const texts = workspace.takeInserts(currentTabId)
  if (texts.length === 0) return
  for (const text of texts) {
    view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input' })
  }
  view.focus()
}

watch(() => workspace.insertQueues[props.tab.id]?.length ?? 0, drainInserts)

async function announce(message: string): Promise<void> {
  status.value = ''
  await nextTick()
  status.value = message
}

async function formatDocument(): Promise<boolean> {
  const target = view
  if (!target) return false
  const { doc } = target.state
  if (doc.length === 0) return false
  try {
    const original = doc.toString()
    const formatted = await formatSql(original, props.engine)
    // Si el usuario escribió o cambió de pestaña mientras se cargaba el formateador, se descarta.
    if (target.state.doc !== doc) return false
    if (formatted !== original) {
      target.dispatch({
        changes: { from: 0, to: doc.length, insert: formatted },
        selection: EditorSelection.cursor(
          Math.min(target.state.selection.main.head, formatted.length),
        ),
        userEvent: 'input',
      })
    }
    await announce('Documento formateado')
    return true
  } catch {
    await announce('No se pudo formatear: el SQL no es válido')
    return false
  }
}

onMounted(() => {
  const element = host.value
  if (!element) return
  // CodeMirror inyecta sus estilos con una etiqueta <style>, que `style-src 'self'` bloquea. Dentro de un
  // shadow root usa `adoptedStyleSheets`, que la CSP no restringe, así que no hace falta nonce ni 'unsafe-inline'.
  const shadow = element.attachShadow({ mode: 'open' })
  const editor = new EditorView({ state: stateFor(props.tab).state, parent: shadow })
  view = editor
  unregister = registerEditor({
    executionText: () => selectionOrDocument(editor.state),
    documentText: () => wholeDocument(editor.state),
    focus: () => editor.focus(),
    format: formatDocument,
  })
  drainInserts()
})

onBeforeUnmount(() => {
  unregister?.()
  view?.destroy()
  view = null
})
</script>

<template>
  <div class="sql-editor">
    <div ref="host" class="sql-editor__host"></div>
    <p class="visually-hidden" role="status" aria-live="polite">{{ status }}</p>
  </div>
</template>

<style scoped>
.sql-editor {
  position: relative;
  height: 100%;
  min-height: 0;
}

.sql-editor__host {
  height: 100%;
}
</style>
