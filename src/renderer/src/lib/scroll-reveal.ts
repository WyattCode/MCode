/**
 * Where a list must scroll so one of its rows shows, with a little room on
 * either side - MiMo's rule for the settings nav's selected row.
 *
 * `top` is the row's offset in the list's own scrolled coordinates. Returns
 * undefined when the row, with its spare, already shows, so nothing moves.
 */
export function revealScrollTop(scrollTop: number, viewHeight: number, top: number, height: number, spare = 8): number | undefined {
  const start = top - spare
  const end = top + height + spare
  if (start < scrollTop) return Math.max(0, start)
  if (end > scrollTop + viewHeight) return Math.max(0, end - viewHeight)
  return undefined
}
