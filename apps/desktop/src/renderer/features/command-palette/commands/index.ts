import { APP_SPECIFIC_COMMANDS } from './app-commands'
import { CONNECTION_COMMANDS } from './connection-commands'
import { EDITOR_COMMANDS } from './editor-commands'
import type { AppCommand } from './helpers'
import { QUERY_COMMANDS } from './query-commands'
import { SCHEMA_COMMANDS } from './schema-commands'
import { TAB_COMMANDS } from './tab-commands'

export { CATEGORY_ORDER } from './helpers'

/** Todos los comandos de la aplicación, en el orden en que se muestran las categorías. */
export const APP_COMMANDS: readonly AppCommand[] = [
  ...TAB_COMMANDS,
  ...QUERY_COMMANDS,
  ...EDITOR_COMMANDS,
  ...SCHEMA_COMMANDS,
  ...CONNECTION_COMMANDS,
  ...APP_SPECIFIC_COMMANDS,
]
