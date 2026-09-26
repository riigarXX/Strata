// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createApprovedSqlitePaths } from './approved-sqlite-paths'
import { createSqliteFilePicker } from './sqlite-file-picker'

function setup(result: { canceled: boolean; filePaths: string[] }) {
  const approvedPaths = createApprovedSqlitePaths()
  const showOpenDialog = vi.fn(async () => result)
  return {
    approvedPaths,
    showOpenDialog,
    picker: createSqliteFilePicker({ showOpenDialog, approvedPaths }),
  }
}

describe('SqliteFilePicker', () => {
  it('abre un diálogo de solo archivo, devuelve la ruta y la aprueba', async () => {
    const { picker, approvedPaths, showOpenDialog } = setup({
      canceled: false,
      filePaths: ['/Users/me/data.db'],
    })

    expect(await picker.pick()).toBe('/Users/me/data.db')

    expect(approvedPaths.isApproved('/Users/me/data.db')).toBe(true)
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openFile'] }),
    )
  })

  it('devuelve null y no aprueba nada si el usuario cancela', async () => {
    const { picker, approvedPaths } = setup({ canceled: true, filePaths: ['/Users/me/data.db'] })

    expect(await picker.pick()).toBeNull()
    expect(approvedPaths.isApproved('/Users/me/data.db')).toBe(false)
  })

  it('devuelve null si el diálogo no entrega ninguna ruta', async () => {
    const { picker } = setup({ canceled: false, filePaths: [] })
    expect(await picker.pick()).toBeNull()
  })

  it('no aprueba una ruta no válida', async () => {
    const { picker, approvedPaths } = setup({ canceled: false, filePaths: ['relative.db'] })

    await expect(picker.pick()).rejects.toMatchObject({ normalized: { code: 'validation_failed' } })
    expect(approvedPaths.isApproved('relative.db')).toBe(false)
  })
})

describe('ApprovedSqlitePaths', () => {
  it('compara rutas normalizadas', () => {
    const approvedPaths = createApprovedSqlitePaths()
    approvedPaths.approve('/Users/me/data.db')

    expect(approvedPaths.isApproved('/Users/me/./x/../data.db')).toBe(true)
    expect(approvedPaths.isApproved('/Users/me/other.db')).toBe(false)
  })
})
