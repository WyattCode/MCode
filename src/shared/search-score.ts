/**
 * How the search overlay ranks a match, by MiMo's rules (its search palette).
 *
 * Both halves of this app use it: the backend picks each conversation's best
 * message with it, and the window ranks titles, projects and files with it, so
 * a match found in a message and one found in a title are scored on one scale.
 *
 * - A match as typed scores 1000, plus up to 200 the nearer it is to the
 *   start, plus 80 when it stands as a whole word (a boundary on both sides)
 *   or 30 when only one side is a boundary. Only letters and digits count as
 *   word characters.
 * - Otherwise the query's characters are looked for in order, spaces included,
 *   the first place each can go. That scores 500, less 40 for each extra piece
 *   the characters are spread over, less how far the pieces spread beyond the
 *   query's own length (at most 200), less how far in the first one starts (at
 *   most 100). A score of 0 or less is no match.
 */

export interface ScoredMatch {
  score: number
  ranges: { start: number; end: number }[]
}

const WORD = /[a-z0-9]/i

function exactMatch(text: string, query: string): ScoredMatch | undefined {
  const at = text.indexOf(query)
  if (at < 0) return undefined
  const near = Math.max(0, 200 - at)
  const before = at === 0 || !WORD.test(text[at - 1] ?? "")
  const after = at + query.length >= text.length || !WORD.test(text[at + query.length] ?? "")
  const bonus = before && after ? 80 : before || after ? 30 : 0
  return { score: 1000 + near + bonus, ranges: [{ start: at, end: at + query.length }] }
}

function scatteredMatch(text: string, query: string): ScoredMatch | undefined {
  const hits: number[] = []
  let next = 0
  for (let at = 0; at < text.length && next < query.length; at++) {
    if (text[at] === query[next]) {
      hits.push(at)
      next++
    }
  }
  if (next < query.length) return undefined
  const ranges: ScoredMatch["ranges"] = []
  for (const at of hits) {
    const last = ranges[ranges.length - 1]
    if (last && last.end === at) last.end = at + 1
    else ranges.push({ start: at, end: at + 1 })
  }
  const span = hits[hits.length - 1]! - hits[0]! + 1
  const score = 500 - (ranges.length - 1) * 40 - Math.min(200, span - query.length) - Math.min(100, hits[0]!)
  return score > 0 ? { score, ranges } : undefined
}

/** The match of an already lower-cased query in some text, or undefined; an empty query matches with no score. */
export function scoreMatch(text: string, query: string): ScoredMatch | undefined {
  if (!query) return { score: 0, ranges: [] }
  const hay = text.toLowerCase()
  return exactMatch(hay, query) ?? scatteredMatch(hay, query)
}

/** How much of one message the search reads, as MiMo caps it. */
export const MESSAGE_SEARCH_CHARS = 20_000

/**
 * A single line around the first matched range, `room` characters either side,
 * with ellipses where it was cut and every range that falls inside moved to
 * match.
 */
export function snippetOf(text: string, ranges: ScoredMatch["ranges"], room = 40): { text: string; ranges: ScoredMatch["ranges"] } {
  const flat = text.replace(/\s/g, " ")
  if (!ranges.length) return { text: flat.slice(0, room * 2), ranges: [] }
  const first = ranges[0]!
  const start = Math.max(0, first.start - room)
  const end = Math.min(flat.length, first.end + room)
  const before = start > 0 ? "…" : ""
  const after = end < flat.length ? "…" : ""
  return {
    text: before + flat.slice(start, end) + after,
    ranges: ranges
      .filter((range) => range.start < end && range.end > start)
      .map((range) => ({ start: Math.max(start, range.start) - start + before.length, end: Math.min(end, range.end) - start + before.length })),
  }
}
