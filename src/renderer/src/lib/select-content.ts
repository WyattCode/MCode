/**
 * MiMo's Select All inside the right panel: Ctrl+A (Cmd+A on a Mac), with focus
 * outside any field, selects only the nearest `[data-selectable="content"]`
 * block in the panel - a document, a diff, a file - instead of the whole window.
 * The block is found from the selection's anchor, else from what was last
 * pressed, else from the focused element, in that order.
 */
let lastPressed: Node | null = null

/** The content block in the right panel that holds `node`, if any. */
export function contentBlock(node: Node | null | undefined): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  const block = element?.closest<HTMLElement>('[data-selectable="content"]') ?? null
  return block?.closest("[data-right-panel]") ? block : null
}

function typingIn(node: Element | null): boolean {
  if (!(node instanceof HTMLElement)) return false
  return node.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.code !== "KeyA" || event.shiftKey || event.altKey) return
  const mac = navigator.platform.toLowerCase().includes("mac")
  if (!(mac ? event.metaKey : event.ctrlKey)) return
  if (typingIn(document.activeElement)) return
  const block =
    contentBlock(window.getSelection()?.anchorNode) ?? contentBlock(lastPressed) ?? contentBlock(document.activeElement)
  if (!block) return
  event.preventDefault()
  event.stopPropagation()
  const range = document.createRange()
  range.selectNodeContents(block)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/* On the capture pass, as MiMo's is, so nothing underneath treats the chord as its own first. */
export function installSelectContent(): void {
  window.addEventListener("pointerdown", (event) => (lastPressed = event.target instanceof Node ? event.target : null), true)
  window.addEventListener("keydown", onKeydown, true)
}
