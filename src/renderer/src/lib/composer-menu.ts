/**
 * The keyboard in MiMo's composer menus and the home project picker.
 *
 * Its list primitive walks rows with ArrowUp and ArrowDown, wrapping at either
 * end, and jumps to the ends with Home and End. Kept pure so smoke can hold it.
 */
export type RovingKey = "ArrowDown" | "ArrowUp" | "Home" | "End"

export function isRovingKey(key: string): key is RovingKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End"
}

/** The row the keyboard lands on; with nothing highlighted yet, Down starts at the top and Up at the bottom. */
export function rovingStep<T extends string>(keys: readonly T[], current: T | undefined, key: RovingKey): T | undefined {
  if (!keys.length) return undefined
  if (key === "Home") return keys[0]
  if (key === "End") return keys[keys.length - 1]
  const by = key === "ArrowDown" ? 1 : -1
  const at = current === undefined ? -1 : keys.indexOf(current)
  if (at === -1) return by > 0 ? keys[0] : keys[keys.length - 1]
  return keys[(at + by + keys.length) % keys.length]
}
