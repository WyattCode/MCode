import { readonly, ref } from "vue"

/**
 * Whether assistive technology is reading this window, as Chromium reports it.
 *
 * xterm draws its text on a canvas, which a screen reader cannot read; its
 * screen reader mode adds a transparent row-per-line copy of the screen and a
 * live region that speaks new output. That copy is rebuilt on every frame the
 * terminal draws, so it is built only while something is there to read it -
 * the same rule VS Code's terminal follows.
 */
const active = ref(false)
let started = false

export function screenReaderActive() {
  if (!started) {
    started = true
    // The window lives as long as the app does; the listener is never taken down.
    window.mcode.onScreenReader((enabled) => (active.value = enabled))
    window.mcode
      .screenReader()
      .then((enabled) => (active.value = enabled))
      .catch(() => {
        // Unknown is read as absent: the terminal simply stays as it is drawn.
      })
  }
  return readonly(active)
}
