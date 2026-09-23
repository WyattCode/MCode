/**
 * A zoom step is a resize, and the page is never told.
 *
 * Nineteen places in this window measure something - the work area's centre,
 * the window's width, a panel's room, a card's corner - and write the number
 * into a style, a ref or stored state. Every one of them re-measures on
 * `window`'s resize event, and that is the only signal any of them had.
 *
 * A zoom step changes what a CSS pixel is. The layout is unchanged in its own
 * units, so neither `resize` nor a ResizeObserver reliably fires, and every
 * number already written down now points somewhere else - off by the ratio
 * between the old zoom and the new. Measured on 2026-09-24 at 110%: the work
 * area's centre was 810 while the notice column still carried 878, and the
 * user saw the zoom notice itself - the one saying the zoom had changed -
 * sitting a tenth of the window right of centre.
 *
 * Rather than teach nineteen components about zoom, and every one written
 * after them, the step is announced here as what it is: a resize. Two sources,
 * because neither covers the other - the visual viewport reports a scale
 * change whatever caused it, including a pinch, while the backend's message is
 * the one certain to arrive for the keyboard and the menu. It is announced
 * twice, now and on the next frame, because the page has not always been laid
 * out again by the time the step reaches us.
 *
 * Call once, for the window's whole life.
 */
export function followZoom(): () => void {
  let again = 0
  /*
   * How the two sources are told apart from an ordinary resize, and from each
   * other. `devicePixelRatio` is the screen's ratio times the zoom factor, so
   * it moves on a zoom step and holds still while a window is dragged to a new
   * size - and the visual viewport reports both. Without this, every real
   * resize also raised a synthetic one and the whole window re-measured two or
   * three times per frame while the user dragged an edge (R25-C5); and a step
   * that reached both sources announced itself twice over.
   */
  let ratio = window.devicePixelRatio

  function announce() {
    if (window.devicePixelRatio === ratio) return
    ratio = window.devicePixelRatio
    window.dispatchEvent(new Event("resize"))
    cancelAnimationFrame(again)
    again = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")))
  }

  window.visualViewport?.addEventListener("resize", announce)
  const unzoom = window.mcode?.onZoomChanged?.(announce)

  return () => {
    window.visualViewport?.removeEventListener("resize", announce)
    unzoom?.()
    cancelAnimationFrame(again)
  }
}
