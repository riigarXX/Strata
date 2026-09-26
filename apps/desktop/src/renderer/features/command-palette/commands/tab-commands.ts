import { disabled, ENABLED } from '@strata/commands'
import { CATEGORIES, needsTab, NO_TABS, type AppCommand } from './helpers'

const category = CATEGORIES.tabs

const selectable = (position: number): AppCommand => ({
  id: `tab.select.${position}`,
  title: `Ir a la pestaña ${position}`,
  description: `Activa la pestaña en la posición ${position}.`,
  category,
  shortcuts: [`Mod+${position}`],
  hidden: true,
  when: ({ tabs }) =>
    tabs.count === 0
      ? disabled(NO_TABS)
      : tabs.count >= position
        ? ENABLED
        : disabled(`No existe la pestaña ${position}`),
  run: ({ actions }) => actions.selectTabAt(position - 1),
})

export const TAB_COMMANDS: readonly AppCommand[] = [
  {
    id: 'tab.new',
    title: 'Nueva pestaña SQL',
    description: 'Abre una pestaña de consulta vacía con la conexión activa y enfoca su editor.',
    category,
    keywords: ['abrir', 'crear', 'consulta', 'tab'],
    shortcuts: ['Mod+T'],
    run: ({ actions }) => actions.newTab(),
  },
  {
    id: 'tab.close',
    title: 'Cerrar pestaña',
    description: 'Cierra la pestaña activa sin pedir confirmación.',
    category,
    keywords: ['quitar', 'tab'],
    shortcuts: ['Mod+W'],
    when: needsTab,
    run: ({ actions }) => actions.closeActiveTab(),
  },
  {
    id: 'tab.next',
    title: 'Pestaña siguiente',
    description: 'Activa la pestaña de la derecha; tras la última vuelve a la primera.',
    category,
    keywords: ['derecha', 'tab'],
    shortcuts: ['Ctrl+Tab'],
    keyboard: { repeat: true },
    when: ({ tabs }) =>
      tabs.count > 1
        ? ENABLED
        : disabled(tabs.count === 0 ? NO_TABS : 'Solo hay una pestaña abierta'),
    run: ({ actions }) => actions.selectRelativeTab(1),
  },
  {
    id: 'tab.previous',
    title: 'Pestaña anterior',
    description: 'Activa la pestaña de la izquierda; antes de la primera pasa a la última.',
    category,
    keywords: ['izquierda', 'tab'],
    shortcuts: ['Ctrl+Shift+Tab'],
    keyboard: { repeat: true },
    when: ({ tabs }) =>
      tabs.count > 1
        ? ENABLED
        : disabled(tabs.count === 0 ? NO_TABS : 'Solo hay una pestaña abierta'),
    run: ({ actions }) => actions.selectRelativeTab(-1),
  },
  ...Array.from({ length: 8 }, (_, index) => selectable(index + 1)),
  {
    id: 'tab.select.last',
    title: 'Ir a la última pestaña',
    description: 'Activa la última pestaña, sea cual sea su posición.',
    category,
    shortcuts: ['Mod+9'],
    hidden: true,
    when: needsTab,
    run: ({ actions }) => actions.selectLastTab(),
  },
]
