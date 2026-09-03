/**
 * How a keystroke is written down, so a stored binding and a live event can be
 * compared as strings.
 *
 * The order is fixed rather than following the order the modifiers were
 * pressed, and the key is normalised to its printed form - "Ctrl+Shift+K"
 * whichever way the user got there.
 */
export function chordOf(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl")
  if (event.altKey) parts.push("Alt")
  if (event.shiftKey) parts.push("Shift")

  let key = event.key
  if (key === " ") key = "Space"
  else if (key === "ArrowUp") key = "\u2191"
  else if (key === "ArrowDown") key = "\u2193"
  else if (key === "ArrowLeft") key = "\u2190"
  else if (key === "ArrowRight") key = "\u2192"
  else if (key.length === 1) key = key.toUpperCase()

  // A bare modifier is not a chord, and capturing one would bind nothing.
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return ""
  parts.push(key)
  return parts.join("+")
}

/** Whether a chord is worth storing: bare letters would swallow typing. */
export function isBindable(chord: string): boolean {
  if (!chord) return false
  return chord.includes("Ctrl+") || chord.includes("Alt+") || /^F\d+$/.test(chord)
}
