import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeClipboard } from './clipboard'

afterEach(() => {
  Reflect.deleteProperty(document, 'execCommand')
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('writeClipboard', () => {
  it('copies through a temporary textarea that keeps tabs and newlines as they are', () => {
    let seen: { value: string; whiteSpace: string; selected: string } | null = null
    const execCommand = vi.fn(() => {
      const area = document.querySelector('textarea')!
      seen = {
        value: area.value,
        whiteSpace: area.style.whiteSpace,
        selected: area.value.slice(area.selectionStart, area.selectionEnd),
      }
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    writeClipboard('1\tname\n2\tother')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(seen).toEqual({
      value: '1\tname\n2\tother',
      whiteSpace: 'pre',
      selected: '1\tname\n2\tother',
    })
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('does not touch navigator.clipboard', () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => true })
    try {
      writeClipboard('x')
      expect(writeText).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('gives focus back to where it was and throws when the copy is refused', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    expect(() => writeClipboard('x')).toThrow('portapapeles')
    expect(document.activeElement).toBe(button)
  })
})
