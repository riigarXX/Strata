import { disabled, ENABLED } from '@strata/commands'
import { CATEGORIES, NO_TABS, type AppCommand } from './helpers'

const editorReady = ({ editorReady: ready }: { editorReady: boolean }) =>
  ready ? ENABLED : disabled(NO_TABS)

export const EDITOR_COMMANDS: readonly AppCommand[] = [
  {
    id: 'editor.focus',
    title: 'Enfocar editor',
    description: 'Lleva el foco al editor SQL de la pestaña activa.',
    category: CATEGORIES.editor,
    keywords: ['consola', 'escribir', 'foco'],
    shortcuts: ['Mod+L'],
    when: editorReady,
    run: ({ actions }) => {
      actions.focusEditor()
    },
  },
  {
    id: 'editor.format',
    title: 'Formatear SQL',
    description: 'Da formato al documento con el dialecto de la conexión.',
    category: CATEGORIES.editor,
    keywords: ['formato', 'ordenar', 'indentar', 'format'],
    shortcuts: ['Alt+Shift+F'],
    when: editorReady,
    run: async ({ actions }) => {
      await actions.formatDocument()
    },
  },
]
