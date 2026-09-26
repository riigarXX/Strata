import { CATEGORIES, executionAction, type AppCommand } from './helpers'

const query = CATEGORIES.query
const transaction = CATEGORIES.transaction

export const QUERY_COMMANDS: readonly AppCommand[] = [
  {
    id: 'query.run',
    title: 'Ejecutar',
    description: 'Ejecuta la selección o, si no hay selección, todo el documento.',
    category: query,
    keywords: ['consulta', 'sql', 'lanzar', 'run'],
    shortcuts: ['Mod+Enter'],
    when: executionAction('run'),
    run: ({ actions }) => actions.run(),
  },
  {
    id: 'query.runAll',
    title: 'Ejecutar todo',
    description: 'Ejecuta el documento completo aunque haya una selección.',
    category: query,
    keywords: ['documento', 'script', 'sql', 'run'],
    shortcuts: ['Mod+Shift+Enter'],
    when: executionAction('run-all'),
    run: ({ actions }) => actions.runAll(),
  },
  {
    id: 'query.cancel',
    title: 'Cancelar ejecución',
    description: 'Cancela la consulta en curso.',
    category: query,
    keywords: ['detener', 'parar', 'abortar', 'cancel'],
    shortcuts: ['Escape'],
    keyboard: { passthrough: true },
    when: executionAction('cancel'),
    run: ({ actions }) => actions.cancel(),
  },
  {
    id: 'query.settings',
    title: 'Ajustes de ejecución',
    description:
      'Cambia el tiempo máximo, el máximo de filas y la confirmación de operaciones destructivas.',
    category: query,
    keywords: ['timeout', 'límite', 'filas', 'confirmación', 'preferencias'],
    run: ({ actions }) => actions.openSettings('execution'),
  },
  {
    id: 'transaction.begin',
    title: 'Iniciar transacción',
    description: 'Abre una transacción explícita en la conexión de la pestaña.',
    category: transaction,
    keywords: ['begin', 'transacción'],
    when: executionAction('begin'),
    run: ({ actions }) => actions.transaction('begin'),
  },
  {
    id: 'transaction.commit',
    title: 'Confirmar transacción',
    description: 'Confirma los cambios de la transacción activa.',
    category: transaction,
    keywords: ['commit', 'transacción', 'guardar'],
    when: executionAction('commit'),
    run: ({ actions }) => actions.transaction('commit'),
  },
  {
    id: 'transaction.rollback',
    title: 'Revertir transacción',
    description: 'Descarta los cambios de la transacción activa.',
    category: transaction,
    keywords: ['rollback', 'transacción', 'deshacer'],
    when: executionAction('rollback'),
    run: ({ actions }) => actions.transaction('rollback'),
  },
]
