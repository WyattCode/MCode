import type { App, DirectiveBinding } from "vue"

/**
 * Runs a handler on Enter, except while an input method is composing.
 *
 * `@keydown.enter` fires on the Enter that confirms an IME candidate, which is
 * not a press meant for the app: typing a Chinese session name and pressing
 * Enter to choose the characters submitted the dialog with the pinyin still in
 * the field. The composer already carried this guard by hand; every other Enter
 * binding in the app was missing it, so it lives in one place instead of eight
 * near-copies. Chromium reports keyCode 229 for the same state on some layouts.
 */
const listeners = new WeakMap<HTMLElement, (event: KeyboardEvent) => void>()

function attach(el: HTMLElement, binding: DirectiveBinding<() => void>): void {
  const listener = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return
    if (event.isComposing || event.keyCode === 229) return
    binding.value()
  }
  el.addEventListener("keydown", listener)
  listeners.set(el, listener)
}

function detach(el: HTMLElement): void {
  const listener = listeners.get(el)
  if (!listener) return
  el.removeEventListener("keydown", listener)
  listeners.delete(el)
}

export function installEnter(app: App): void {
  app.directive("enter", {
    mounted: attach,
    // Rebound rather than left in place: the handler is captured in the
    // closure, so a changed binding would otherwise keep calling the old one.
    updated(el: HTMLElement, binding: DirectiveBinding<() => void>) {
      detach(el)
      attach(el, binding)
    },
    unmounted: detach,
  })
}
