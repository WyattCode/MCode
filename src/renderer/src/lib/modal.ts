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

  unmounted(el: HTMLElement) {
    cleanups.get(el)?.()
    cleanups.delete(el)
  },
}

export function installModal(app: App): void {
  app.directive("modal", modal)
}
