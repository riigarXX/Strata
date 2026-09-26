import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--editor-fg)',
    backgroundColor: 'var(--editor-bg)',
    fontFamily: 'var(--editor-font)',
    fontSize: 'var(--font-size-sm)',
  },
  // El anillo de foco lo dibuja `.tab-panel__editor:focus-within` por encima de las canaletas, que un
  // `outline` sobre `.cm-editor` deja tapado por la izquierda.
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: 'var(--font-line-height-base)',
    fontVariantLigatures: 'none',
  },
  '.cm-content': {
    caretColor: 'var(--editor-fg)',
    padding: 'var(--spacing-2) 0',
  },
  '.cm-line': { padding: '0 var(--spacing-3)' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--editor-fg)',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground': { backgroundColor: 'var(--editor-selection-bg-inactive)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection-bg)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line-bg)' },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-bg)',
    color: 'var(--text-muted)',
    border: 'none',
    borderRight: '1px solid var(--border-subtle)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 var(--spacing-3) 0 var(--spacing-2)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--editor-active-line-bg)',
    color: 'var(--editor-fg)',
  },
  // Un contorno acompaña al fondo: la pareja no se distingue solo por el matiz.
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--editor-bracket-match-bg)',
    outline: '1px solid var(--border-strong)',
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'var(--editor-bracket-mismatch-bg)',
    outline: '1px dashed var(--status-error)',
  },
  // Sin parpadeo del cursor si el sistema pide reducir el movimiento.
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-cursorLayer': { animation: 'none !important' },
  },
})

const highlightStyle = HighlightStyle.define([
  {
    tag: tags.keyword,
    color: 'var(--editor-syntax-keyword)',
    fontWeight: 'var(--font-weight-medium)',
  },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--editor-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--editor-syntax-number)' },
  {
    tag: [tags.typeName, tags.standard(tags.name)],
    color: 'var(--editor-fg)',
    fontWeight: 'var(--font-weight-semibold)',
  },
  { tag: [tags.operator, tags.punctuation], color: 'var(--editor-syntax-operator)' },
  {
    tag: [tags.lineComment, tags.blockComment],
    color: 'var(--editor-syntax-comment)',
    fontStyle: 'italic',
  },
])

/** Tema y resaltado del editor, íntegramente con los tokens `editor.*`: siguen el tema claro/oscuro sin recargar. */
export const strataTheme: Extension = [editorTheme, syntaxHighlighting(highlightStyle)]
