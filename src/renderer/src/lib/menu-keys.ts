import { isRovingKey, rovingStep, type RovingKey } from "./composer-menu"

/**
 * MiMo's one menu primitive, for menus drawn as focusable rows: Up and Down
 * walk the rows and wrap, Home and End jump to the ends, and Enter or Space on
 * a focused row is the row's own button doing what it does.
 */

/** Moves focus to the row `key` lands on. Answers whether there was a row to move to. */
export function focusRow(rows: readonly HTMLElement[], key: RovingKey): boolean {
  if (!rows.length) return false
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next = rovingStep(
    rows.map((_, index) => String(index)),
    at < 0 ? undefined : String(at),
    key,
  )
  if (next === undefined) return false
  rows[Number(next)].focus()
  return true
}

/** A keydown inside a menu: the roving keys move between its rows; everything else is left alone. */
export function onMenuRowKey(event: KeyboardEvent, rows: readonly HTMLElement[]): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || !isRovingKey(event.key)) return
  if (focusRow(rows, event.key)) event.preventDefault()
}
