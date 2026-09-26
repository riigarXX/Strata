import { PickSqliteFileResultSchema } from '@strata/contracts'
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import type { ApprovedSqlitePaths } from './approved-sqlite-paths'
import { managerError } from './errors'

export interface SqliteFilePickerDependencies {
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
  approvedPaths: ApprovedSqlitePaths
}

export interface SqliteFilePicker {
  /** Ruta elegida y aprobada, o `null` si el usuario canceló. */
  pick(): Promise<string | null>
}

export function createSqliteFilePicker({
  showOpenDialog,
  approvedPaths,
}: SqliteFilePickerDependencies): SqliteFilePicker {
  return {
    async pick() {
      const result = await showOpenDialog({
        title: 'Select a SQLite database',
        properties: ['openFile'],
        filters: [
          { name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
          { name: 'All files', extensions: ['*'] },
        ],
      })
      const [filePath] = result.filePaths
      if (result.canceled || filePath === undefined) return null

      const parsed = PickSqliteFileResultSchema.safeParse({ filePath })
      if (!parsed.success || parsed.data.filePath === null) {
        throw managerError('validation_failed', 'The selected file path is not valid')
      }
      approvedPaths.approve(parsed.data.filePath)
      return parsed.data.filePath
    },
  }
}
