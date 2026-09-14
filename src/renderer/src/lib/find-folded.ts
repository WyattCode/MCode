/*
 * Find matches in the conversation that are folded away.
 *
 * The transcript knows which steps are folded; the find bar is mounted by the
 * app shell, far above it. The transcript registers a counter here and the bar
 * asks it, so MiMo's "cur/total(未展开 N)" can count what is not on screen.
 */

type Counter = (needle: string) => number

let counter: Counter | undefined

/** Registers the counter; the returned function takes it back. */
export function registerFoldedCounter(next: Counter): () => void {
  counter = next
  return () => {
    if (counter === next) counter = undefined
  }
}

export function foldedMatches(needle: string): number {
  return counter?.(needle) ?? 0
}

/** How many times the needle occurs in a text, without overlaps, ignoring case. */
export function occurrences(text: string, needle: string): number {
  if (!needle) return 0
  const hay = text.toLowerCase()
  let found = 0
  let at = hay.indexOf(needle)
  while (at !== -1) {
    found++
    at = hay.indexOf(needle, at + needle.length)
  }
  return found
}
