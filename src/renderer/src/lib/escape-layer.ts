import { onBeforeUnmount, onMounted } from "vue"

/**
 * Escape for the layers that sit on top of the page: menus, confirmations and
 * the older dialogs.
 *
 * Each of these used to listen for Escape on its own, in the bubble phase and
 * without marking the key as taken. Whatever had registered earlier saw the key
 * first, so one press closed a confirmation and the settings window under it,
 * or closed a menu and also cleared the annotation boxes of the document
 * showing behind it. MiMo's layers handle Escape on the capture phase and mark
 * it `defaultPrevented`, and everything underneath skips a prevented Escape, so
 * one press closes one layer. This is that, for every layer that uses it.
 *
 * One listener on the document's capture phase serves every layer, and only
 * the layer opened last answers: a confirmation raised from a menu closes
 * before the menu does. The document rather than the window, so a list that
 * takes Escape on the window's capture phase (SelectMenu, LanguageMenu) inside
 * one of these layers still closes first and alone. A press that is finishing
 * an IME composition belongs to the candidate window, not to the layer.
 */
type Layer = (event: KeyboardEvent) => void

const layers: Layer[] = []

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  const top = layers[layers.length - 1]
  if (!top) return
  event.preventDefault()
  top(event)
}

/** Registers a layer's close; the returned function takes it off again. */
export function escapeLayer(close: Layer): () => void {
  if (!layers.length) document.addEventListener("keydown", onKeydown, true)
  layers.push(close)
  return () => {
    const at = layers.lastIndexOf(close)
    if (at >= 0) layers.splice(at, 1)
    if (!layers.length) document.removeEventListener("keydown", onKeydown, true)
  }
}

/** `escapeLayer` for as long as the component is mounted. */
export function useEscapeLayer(close: Layer): void {
  let release: (() => void) | undefined
  onMounted(() => (release = escapeLayer(close)))
  onBeforeUnmount(() => release?.())
}

const DIALOGS = '[aria-modal="true"]'
/* What MiMo's own test counts as a layer being up: a dialog, or an open menu or list. */
const LAYERS = `${DIALOGS}, [role="menu"], [role="listbox"]`

function anyOpen(selector: string, except?: Element | null): boolean {
  for (const node of document.querySelectorAll(selector)) {
    // The copies left behind by a closing animation do not count.
    if (node !== except && !node.closest("[data-modal-exit]")) return true
  }
  return false
}

/**
 * Whether a dialog, menu or list other than `except` is open. Read from the
 * page itself, so no hand-kept list of nested layers can fall out of step.
 */
export function layerOpen(except?: Element | null): boolean {
  return anyOpen(LAYERS, except)
}

/** Whether a modal dialog other than `except` is open. */
export function dialogOpen(except?: Element | null): boolean {
  return anyOpen(DIALOGS, except)
}
