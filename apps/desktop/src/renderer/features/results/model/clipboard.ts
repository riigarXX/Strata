/**
 * Copia con un `<textarea>` temporal y `document.execCommand('copy')`. Solo depende de que la copia salga de
 * un gesto del usuario en un documento con foco, sin permisos ni canales IPC extra hacia main.
 */
function copyWithTextarea(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.setAttribute('aria-hidden', 'true')
  area.tabIndex = -1
  // `white-space: pre` es imprescindible: con otro valor Chromium copia el texto «renderizado» y las
  // tabulaciones del TSV llegan al portapapeles convertidas en espacios. Estilos por CSSOM, que la CSP admite.
  Object.assign(area.style, {
    position: 'fixed',
    top: '0',
    left: '-9999px',
    width: '1px',
    height: '1px',
    opacity: '0',
    whiteSpace: 'pre',
  })
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand('copy')
  } finally {
    area.remove()
    previous?.focus({ preventScroll: true })
  }
}

export function writeClipboard(text: string): void {
  if (!copyWithTextarea(text)) throw new Error('No se pudo escribir en el portapapeles.')
}
