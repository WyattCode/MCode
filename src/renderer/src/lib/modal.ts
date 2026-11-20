import type { App } from "vue"

/**
 * Makes an element behave as a modal dialog.
 *
 * The dialogs here were only visually modal: a scrim covered the page, but Tab
 * walked straight past the dialog into the workspace behind it, focus never
 * moved into the dialog when it opened, and nothing told a screen reader that
 * the rest of the page had stopped being available. This adds the three parts
 * that were missing - the role, the focus, and the boundary - in one place, so
 * every dialog gets the same behaviour instead of four near-copies.
 *
 * It also plays MiMo's closing animation for every dialog at once: the card
 * fades out while shrinking to .95 over .2s and the scrim fades over .15s. A
 * dialog is removed by `v-if` the moment it closes, so the animation runs on a
 * copy left in its place for those 200ms, which takes no input.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

/** Rendered and reachable, rather than merely present in the markup. */
function reachable(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (entry) => (entry.offsetParent !== null || entry === document.activeElement) && entry.tabIndex >= 0,
  )
}

type Layer = { element: HTMLElement; opener?: HTMLElement; claim: number }
const layers: Layer[] = []
const inerted = new Set<Element>()

function topLayer() {
  return layers.at(-1)
}

/** Keep the top dialog and the path to it interactive, including its own scrim. */
function updateInert() {
  for (const element of inerted) element.removeAttribute("inert")
  inerted.clear()
  const dialog = topLayer()?.element
  if (!dialog) return
  const scrim = dialog.parentElement?.closest(".scrim, .overlay, .vs-scrim")
  const boundary = scrim && !layers.some(({ element }) => element !== dialog && scrim.contains(element))
    ? scrim
    : dialog
  for (let node: Element | null = boundary; node?.parentElement && node !== document.body; node = node.parentElement) {
    for (let sibling: Element | null = node.parentElement.firstElementChild; sibling; sibling = sibling.nextElementSibling) {
      if (sibling === node || sibling.hasAttribute("inert")) continue
      sibling.setAttribute("inert", "")
      inerted.add(sibling)
    }
  }
}

function focusDialog(el: HTMLElement) {
  if (el.contains(document.activeElement)) return
  if (el.hasAttribute("data-modal-keep-focus")) {
    el.focus()
    return
  }
  const stops = reachable(el)
  const field = stops.find((entry) =>
    (entry instanceof HTMLInputElement && entry.type !== "hidden" && !entry.readOnly) ||
    entry instanceof HTMLTextAreaElement,
  )
  ;(field ?? stops[0] ?? el).focus()
}

function onKeydown(event: KeyboardEvent) {
  const el = topLayer()?.element
  if (!el || event.defaultPrevented) return
  const target = event.target
  if (target instanceof Element && target.closest("[inert]")) {
    event.preventDefault()
    event.stopPropagation()
    focusDialog(el)
    return
  }
  if (event.key !== "Tab" || !el.contains(target as Node)) return
  const stops = reachable(el)
  const first = stops[0]
  const last = stops.at(-1)
  const active = document.activeElement
  if (!first || active === el || active === (event.shiftKey ? first : last)) {
    event.preventDefault()
    ;((event.shiftKey ? last : first) ?? el).focus()
  }
}

function onFocusIn(event: FocusEvent) {
  const el = topLayer()?.element
  if (el && event.target instanceof Element && event.target.closest("[inert]")) focusDialog(el)
}

/* MiMo's motion-slow and its overlay fade. */
export const DIALOG_EXIT_MS = 200
const SCRIM_EXIT_MS = 150

/** Whether motion is turned down: the appearance setting first; left to the system, the system's preference. */
export function reducedMotion(): boolean {
  const motion = document.documentElement.getAttribute("data-motion")
  if (motion === "on") return true
  if (motion === "off") return false
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/*
 * Leaves a copy of the closing dialog's scrim where it was and animates that
 * out. Only a dialog inside a fixed scrim gets one: a copy of anything in the
 * normal flow would push the page about while it faded. A layer that plays its
 * own closing (the settings overlay) opts out with data-modal-no-exit.
 */
export function playDialogExit(el: HTMLElement): void {
  if (reducedMotion() || typeof el.animate !== "function") return
  const root = el.closest<HTMLElement>(".scrim, .overlay, .vs-scrim")
  if (!root?.parentNode || root.hasAttribute("data-modal-no-exit") || el.hasAttribute("data-modal-no-exit")) return
  const ghost = root.cloneNode(true) as HTMLElement
  ghost.setAttribute("aria-hidden", "true")
  ghost.setAttribute("data-modal-exit", "")
  ghost.removeAttribute("id")
  for (const node of ghost.querySelectorAll("[id]")) node.removeAttribute("id")
  /*
   * The copy is a picture, not a dialog: inert takes its buttons out of the
   * tab order as well as out of hit-testing, so a Tab right after Escape goes
   * on to the next real control instead of into a dead copy that is then
   * removed under the focus, leaving the reader on <body>.
   */
  ghost.setAttribute("inert", "")
  // No entry animation on the copy: it starts where the real one stood.
  ghost.style.animation = "none"
  root.parentNode.insertBefore(ghost, root.nextSibling)
  const path: number[] = []
  for (let node: Node | null = el; node && node !== root; node = node.parentNode) {
    const parent: Node | null = node.parentNode
    if (!parent) break
    path.unshift([...parent.childNodes].indexOf(node as ChildNode))
  }
  const card = path.reduce<Node | undefined>((node, at) => node?.childNodes[at], ghost) as HTMLElement | undefined
  if (card && card !== ghost) {
    card.style.animation = "none"
    card.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(0.95)" },
      ],
      { duration: DIALOG_EXIT_MS, easing: "ease", fill: "forwards" },
    )
  }
  ghost
    .animate([{ opacity: 1 }, { opacity: 0 }], { duration: SCRIM_EXIT_MS, delay: DIALOG_EXIT_MS - SCRIM_EXIT_MS, easing: "ease", fill: "forwards" })
    .finished.catch(() => undefined)
    .finally(() => ghost.remove())
}

export const modal = {
  mounted(el: HTMLElement) {
    if (!el.hasAttribute("role")) el.setAttribute("role", "dialog")
    el.setAttribute("aria-modal", "true")
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1")

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (!layers.length) {
      document.addEventListener("keydown", onKeydown, true)
      document.addEventListener("focusin", onFocusIn, true)
    }
    const layer: Layer = {
      element: el,
      opener,
      // Let a dialog's mounted hook choose its own field first.
      claim: requestAnimationFrame(() => {
        if (topLayer() === layer) focusDialog(el)
      }),
    }
    const above = layers.findIndex(({ element }) => el.contains(element))
    if (above === -1) layers.push(layer)
    else layers.splice(above, 0, layer)
    updateInert()
  },

  // Still in the document here, so its scrim can be copied for the closing animation.
  beforeUnmount(el: HTMLElement) {
    playDialogExit(el)
  },

  unmounted(el: HTMLElement) {
    const index = layers.findIndex(({ element }) => element === el)
    if (index < 0) return
    const wasTop = index === layers.length - 1
    const [layer] = layers.splice(index, 1)
    cancelAnimationFrame(layer.claim)
    for (const remaining of layers) {
      if (remaining.opener && el.contains(remaining.opener)) remaining.opener = layer.opener
    }
    updateInert()
    if (!layers.length) {
      document.removeEventListener("keydown", onKeydown, true)
      document.removeEventListener("focusin", onFocusIn, true)
    }
    if (!wasTop) return
    const next = topLayer()?.element
    if (layer.opener?.isConnected && (!next || next.contains(layer.opener))) layer.opener.focus()
    else if (next) focusDialog(next)
  },
}

export function installModal(app: App): void {
  app.directive("modal", modal)
}
