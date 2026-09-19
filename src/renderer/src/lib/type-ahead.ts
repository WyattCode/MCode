/**
 * Type-ahead over a list of labels, as MiMo's settings dropdown (a Radix
 * Select) does it: characters typed within a second of each other build one
 * search, the next label that starts with it wins, the search wraps round from
 * the row after the current one, and pressing the same letter again steps on
 * through the labels that start with it. Kept pure so smoke can hold it.
 */
export const TYPE_AHEAD_MS = 1000

/** The index the search lands on, or -1 when nothing else matches. */
export function typeAheadMatch(labels: readonly string[], current: number, search: string): number {
  if (!labels.length || !search) return -1
  const repeated = search.length > 1 && [...search].every((char) => char === search[0])
  const needle = (repeated ? search[0] : search).toLocaleLowerCase()
  const start = Math.max(current, 0)
  const order = labels.map((_, index) => (start + index) % labels.length)
  // One letter moves on from where it stands; a longer search may keep the row it already matches.
  const candidates = needle.length === 1 ? order.filter((index) => index !== current) : order
  const hit = candidates.find((index) => labels[index].toLocaleLowerCase().startsWith(needle))
  return hit === undefined || hit === current ? -1 : hit
}

/**
 * A search that forgets itself a second after the last key. While one is
 * under way a space is part of it, as in Radix, rather than a key of its own.
 */
export function typeAheadBuffer(): { push: (char: string) => string; searching: () => boolean } {
  let search = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    push(char) {
      search += char
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => (search = ""), TYPE_AHEAD_MS)
      return search
    },
    searching: () => search.length > 0,
  }
}
