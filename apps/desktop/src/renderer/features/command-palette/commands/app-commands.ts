import { buildInternalInput, disabled, ENABLED, THEME_CHOICES } from '@strata/commands'
import { CATEGORIES, needsTab, stringArg, type AppCommand } from './helpers'

const category = CATEGORIES.app

const THEME_LABELS = { dark: 'oscuro', light: 'claro', system: 'el del sistema' } as const

export const APP_SPECIFIC_COMMANDS: readonly AppCommand[] = [
  {
    id: 'palette.open',
    title: 'Abrir paleta de comandos',
    description: 'Busca y ejecuta cualquier comando; escribe \\ para los comandos internos.',
    category,
    shortcuts: ['Mod+K'],
    keyboard: { whileModal: true },
    hidden: true,
    run: ({ actions }) => actions.togglePalette(),
  },
  {
    id: 'palette.goto',
    title: 'Buscar tabla, vista o conexión',
    description: 'Ir a una conexión (la conecta) o a una tabla de la caché (inserta su nombre).',
    category,
    keywords: ['ir a', 'buscar', 'tabla', 'vista', 'conexión', 'goto'],
    shortcuts: ['Mod+P'],
    keyboard: { whileModal: true },
    run: ({ actions }) => actions.openPalette('goto'),
  },
  {
    id: 'settings.open',
    title: 'Abrir ajustes',
    description: 'Apariencia, ejecución, historial e IA local: se guardan al momento.',
    category,
    keywords: ['preferencias', 'configuración', 'opciones', 'ajustes', 'settings', 'preferences'],
    shortcuts: ['Mod+,'],
    run: ({ actions }) => actions.openSettings(),
  },
  {
    id: 'settings.ai',
    title: 'Abrir ajustes de IA',
    description:
      'Activa el asistente de IA local, elige el servidor y el modelo, y descarga el recomendado.',
    category,
    keywords: [
      'ia',
      'ai',
      'inteligencia artificial',
      'asistente',
      'modelo',
      'ollama',
      'lm studio',
      'llm',
      'local',
    ],
    run: ({ actions }) => actions.openSettings('ai'),
  },
  {
    id: 'history.open',
    title: 'Abrir historial',
    description: 'Busca, reabre en una pestaña nueva o borra consultas anteriores.',
    category,
    keywords: ['historial', 'anteriores', 'history'],
    shortcuts: ['Mod+Shift+H'],
    internal: 'history',
    run: ({ actions }) => actions.openHistory(),
  },
  {
    id: 'ask.open',
    title: 'Preguntar a la base…',
    description:
      'Pregunta en lenguaje natural a la IA local: abre la consulta en una pestaña nueva y, si solo lee datos, la ejecuta.',
    category,
    keywords: [
      'ia',
      'ai',
      'preguntar',
      'pregunta',
      'lenguaje natural',
      'asistente',
      'sql',
      'consulta',
      'ollama',
      'ask',
    ],
    shortcuts: ['Mod+Shift+A'],
    internal: 'ask',
    run: ({ actions }) => actions.openAsk(),
  },
  {
    id: 'history.exclude',
    title: 'Quitar del historial la última consulta',
    description:
      'Borra del historial la entrada que dejó la última ejecución de esta pestaña, si aún existe.',
    category,
    keywords: ['historial', 'excluir', 'no guardar', 'borrar', 'privacidad', 'history'],
    when: (context) => {
      const tab = needsTab(context)
      if (!tab.enabled) return tab
      return context.execution?.canExcludeFromHistory
        ? ENABLED
        : disabled('La última ejecución de esta pestaña no dejó una entrada que quitar')
    },
    run: ({ actions }) => actions.excludeFromHistory(),
  },
  {
    id: 'preferences.timing',
    title: 'Mostrar u ocultar la duración',
    description: 'Alterna la duración de las sentencias en el panel de Mensajes.',
    category,
    keywords: ['timing', 'tiempo', 'duración', 'ms'],
    internal: 'timing',
    run: ({ actions }, args) => {
      const mode = stringArg(args, 'mode')
      const shown = actions.setTiming(mode === undefined ? 'toggle' : mode === 'on')
      actions.announce(`Duración en Mensajes: ${shown ? 'visible' : 'oculta'}`)
    },
  },
  {
    id: 'results.clear',
    title: 'Limpiar mensajes y resultados',
    description: 'Vacía los mensajes y los resultados de la pestaña activa.',
    category,
    keywords: ['borrar', 'vaciar', 'clear'],
    internal: 'clear',
    when: (context) => {
      const tab = needsTab(context)
      if (!tab.enabled) return tab
      return context.execution?.idle === false ? disabled('Hay una ejecución en curso') : ENABLED
    },
    run: ({ actions }) => {
      if (actions.clearActiveTab()) actions.announce('Mensajes y resultados limpiados')
    },
  },
  {
    id: 'theme.set',
    title: 'Cambiar tema…',
    description: 'Elige el tema oscuro, el claro o el del sistema.',
    category,
    keywords: ['oscuro', 'claro', 'apariencia', 'dark', 'light', 'theme'],
    internal: 'theme',
    run: async ({ actions }, args) => {
      const mode = stringArg(args, 'mode')
      if (mode === undefined) {
        actions.openPalette('commands', `${buildInternalInput('theme')} `)
        return
      }
      const chosen = THEME_CHOICES.find((theme) => theme === mode)
      if (!chosen) throw new Error(`Tema desconocido «${mode}».`)
      if (!(await actions.setTheme(chosen))) throw new Error('No se pudo guardar el tema.')
      actions.announce(`Tema: ${THEME_LABELS[chosen]}`)
    },
  },
]
