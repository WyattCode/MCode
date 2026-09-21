/**
 * Where a submenu goes beside the row that opened it.
 *
 * MiMo's submenus sit on the reading side of their row and move to the other
 * side when the window has no room there. Placed fixed rather than inside the
 * menu, so a list that scrolls does not clip the submenu of a row within it.
 */
export function besideRow(row: DOMRect, width: number, height: number, gap = 4, edge = 8) {
  const rtl = document.documentElement.dir === "rtl"
  const after = rtl ? row.left - gap - width : row.right + gap
  const before = rtl ? row.right + gap : row.left - gap - width
  const fits = (x: number) => x >= edge && x + width <= window.innerWidth - edge
  const left = fits(after) ? after : fits(before) ? before : Math.max(edge, Math.min(after, window.innerWidth - edge - width))
  // Level with the row's first line, nudged up by the submenu's own padding.
  const top = Math.max(topEdge(edge), Math.min(row.top - gap, window.innerHeight - edge - height))
  return { left: Math.round(left), top: Math.round(top) }
}

/*
 * MiMo never lets a submenu rise into the title bar: on Windows and Linux the
 * bar overlays the page, so the top edge is its 46px plus 8. macOS keeps the edge.
 */
function topEdge(edge: number): number {
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent)
  return mac ? edge : 46 + edge
}
