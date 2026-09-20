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
    (entry) => entry.offsetParent !== null || entry === document.activeElement,
  )
}

const cleanups = new WeakMap<HTMLElement, () => void>()

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
  ghost.style.pointerEvents = "none"
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
    el.setAttribute("role", "dialog")
    el.setAttribute("aria-modal", "true")
    // So the dialog can hold focus itself while it has nothing focusable yet.
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1")

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined

    // Deferred: a dialog that focuses its own field does it on mount too, and
    // whichever ran last would win. Anything already inside is left alone.
    const claim = requestAnimationFrame(() => {
      // Some of MiMo's dialogs open without taking focus; Tab still stays inside once it gets there.
      if (el.hasAttribute("data-modal-keep-focus")) return
      if (el.contains(document.activeElement)) return
      const stops = reachable(el)
      /*
       * A field wins over whatever happens to come first in the markup. Dialogs
       * here lead with a back or close button, so focusing position one left a
       * search or a key box waiting for a click before it could be typed in.
       */
      const field = stops.find(
        (entry) =>
          (entry instanceof HTMLInputElement && entry.type !== "hidden" && !entry.readOnly) ||
          entry instanceof HTMLTextAreaElement,
      )
      ;(field ?? stops[0] ?? el).focus()
    })

    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return
      const stops = reachable(el)
      if (!stops.length) {
        event.preventDefault()
        el.focus()
        return
      }
      const first = stops[0]
      const last = stops[stops.length - 1]
      const active = document.activeElement

      // Only the two ends need handling; everything between is the browser's.
      if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && (active === first || active === el)) {
        event.preventDefault()
        last.focus()
      } else if (!el.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    el.addEventListener("keydown", onKeydown)

    cleanups.set(el, () => {
      cancelAnimationFrame(claim)
      el.removeEventListener("keydown", onKeydown)
      // Back where it came from, so closing a dialog does not dump the user at
      // the top of the page.
      if (opener?.isConnected) opener.focus()
    })
  },

  // Still in the document here, so its scrim can be copied for the closing animation.
  beforeUnmount(el: HTMLElement) {
    playDialogExit(el)
  },

  unmounted(el: HTMLElement) {
    cleanups.get(el)?.()
    cleanups.delete(el)
  },
}

export function installModal(app: App): void {
  app.directive("modal", modal)
}
