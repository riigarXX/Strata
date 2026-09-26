/**
 * Elemento que tiene el foco de verdad: `document.activeElement` se queda en el anfitrión de un shadow
 * root (el editor CodeMirror), así que se desciende por los `shadowRoot` abiertos hasta el elemento final.
 * `null` si el foco está en el `body` (no hay nada al que volver).
 */
export function deepActiveElement(root: Document = document): HTMLElement | null {
  let active: Element | null = root.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active instanceof HTMLElement && active !== root.body ? active : null
}
