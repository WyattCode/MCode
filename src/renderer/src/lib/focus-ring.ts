/**
 * How focus last moved, for the keyboard ring on text fields.
 *
 * `:focus-visible` already tells a Tab from a click on buttons, but a text
 * field matches it however it was focused, so ringing fields by it would draw
 * a ring under the mouse too, which MiMo never does. The root carries
 * `data-focus-key` from a Tab press until the next pointer press;
 * base.css rings a focused field only while it is there.
 */
export function installFocusRing(root: HTMLElement = document.documentElement): void {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab") root.dataset.focusKey = ""
    },
    true,
  )
  window.addEventListener("pointerdown", () => delete root.dataset.focusKey, true)
}
