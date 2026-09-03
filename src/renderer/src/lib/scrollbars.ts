/**
 * Marks whatever is being scrolled, so its scrollbar can appear while it is.
 *
 * opencode draws its own scrollbars: a thumb it positions itself, held at
 * opacity 0 and faded in for as long as the surface is being scrolled. MCode
 * uses the platform's, which cannot be faded from CSS alone because nothing
 * tells the stylesheet that scrolling is happening.
 *
 * One listener does it for the whole window. Scroll events do not bubble, but
 * they do capture, so a single listener on the document sees every surface -
 * which is what makes this affordable enough to leave on permanently rather
 * than wiring a wrapper component around each scrolling area.
 */

/** Long enough to still be visible when the pointer stops between flicks. */
const LINGER = 900

const clearing = new WeakMap<Element, number>()

function mark(target: EventTarget | null): void {
  const element = target instanceof Element ? target : document.scrollingElement
  if (!element) return

  element.setAttribute("data-scrolling", "true")

  const pending = clearing.get(element)
  if (pending !== undefined) window.clearTimeout(pending)
  clearing.set(
    element,
    window.setTimeout(() => {
      element.removeAttribute("data-scrolling")
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
