/** Diálogo modal o cualquier overlay marcado como modal: mientras exista, Esc y los atajos son suyos. */
export function isOverlayOpen(root: ParentNode = document): boolean {
  return root.querySelector("dialog[open], [aria-modal='true']") !== null
}

/** ¿Hay un `<dialog>` modal nativo abierto (distinto de la paleta, que no lo es)? */
export function isNativeDialogOpen(root: ParentNode = document): boolean {
  return root.querySelector('dialog[open]') !== null
}
