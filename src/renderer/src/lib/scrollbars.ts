/**
 * Marks whatever is being scrolled, so its scrollbar can appear while it is.
 *
 * MiMo's rule: the element under a scroll gets `data-scrollbar-active`, and
 * loses it 500ms after the last scroll event. A platform scrollbar cannot be
 * faded from CSS alone because nothing tells the stylesheet that scrolling is
 * happening; this is what does.
 *
 * One listener does it for the whole window. Scroll events do not bubble, but
 * they do capture, so a single listener on the document sees every surface.
 */

/** MiMo's linger after the last scroll. */
export const LINGER = 500
export const ACTIVE = "data-scrollbar-active"

const clearing = new WeakMap<Element, number>()

function mark(target: EventTarget | null): void {
  const element = target instanceof Element ? target : document.scrollingElement
  if (!element) return

  element.setAttribute(ACTIVE, "")

  const pending = clearing.get(element)
  if (pending !== undefined) window.clearTimeout(pending)
  clearing.set(
    element,
    window.setTimeout(() => {
      element.removeAttribute(ACTIVE)
      clearing.delete(element)
    }, LINGER),
  )
}

export function watchScrolling(): void {
  /*
   * Capture, because scroll does not bubble; passive, because this never wants
   * to hold up a scroll it is only observing.
   */
  document.addEventListener("scroll", (event) => mark(event.target), { capture: true, passive: true })
}
