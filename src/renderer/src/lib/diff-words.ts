/*
 * The marks inside a changed line, so a renamed identifier lights up that word
 * and not the whole line.
 *
 * MiMo runs diff2html at its default `diffStyle: "word"`: a removed line and
 * the added line paired with it are cut into tokens, the tokens are diffed, and
 * the ones only one side has are the ones it paints. This is that reading -
 * MiMo's tokens, MiMo's token diff, and the length past which it leaves a line
 * alone - written out here rather than taken from the library, which this app
 * does not carry.
 *
 * No window is needed for any of it, so the smoke test covers it.
 */

/** Past this many characters diff2html leaves a line plain, and so does this. */
export const WORD_MARK_MAX = 10_000

/*
 * How far the token diff is followed before a line is left plain.
 *
 * The token diff is the classic O(ND) walk: cheap for the ordinary change of a
 * word or two, and quadratic for two long lines with nothing in common. Past a
 * thousand edits a line has been rewritten rather than changed, and every token
 * would be painted anyway - which is the plain line - so the walk stops there
 * instead of taking seconds over a minified file.
 */
const MAX_EDITS = 1000

/* diff2html's word characters: letters, digits, `_`, and the Latin ranges of the tokenizer it ships. */
const WORD = "a-zA-Z0-9_\\u00AD\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02C6\\u02C8-\\u02D7\\u02DE-\\u02FF\\u1E00-\\u1EFF"
const TOKEN = new RegExp(`(\\r?\\n)|[${WORD}]+|[^\\S\\n\\r]+|[^${WORD}]`, "gu")

/** A line cut the way diff2html cuts it: a run of word characters, a run of blanks, or one other character. */
export function wordTokens(text: string): string[] {
  return (text.match(TOKEN) ?? []).filter(Boolean)
}

/** A piece of a line, and whether the other side of the pair has it. */
export interface LineMark {
  text: string
  changed: boolean
}

interface Piece {
  count: number
  added: boolean
  removed: boolean
  previous?: Piece
  value?: string
}

interface Trail {
  oldPos: number
  last?: Piece
}

function extend(trail: Trail, added: boolean, removed: boolean, step: number): Trail {
  const last = trail.last
  if (last && last.added === added && last.removed === removed) {
    return { oldPos: trail.oldPos + step, last: { count: last.count + 1, added, removed, previous: last.previous } }
  }
  return { oldPos: trail.oldPos + step, last: { count: 1, added, removed, previous: last } }
}

/** Follows the diagonal as far as the two sides agree, and says where the new side stands. */
function common(trail: Trail, next: readonly string[], old: readonly string[], diagonal: number): number {
  let oldPos = trail.oldPos
  let newPos = oldPos - diagonal
  let run = 0
  while (newPos + 1 < next.length && oldPos + 1 < old.length && old[oldPos + 1] === next[newPos + 1]) {
    newPos++
    oldPos++
    run++
  }
  if (run) trail.last = { count: run, added: false, removed: false, previous: trail.last }
  trail.oldPos = oldPos
  return newPos
}

/** The pieces a trail stands for, each carrying the text it covers. */
function pieces(last: Piece | undefined, next: readonly string[], old: readonly string[]): Piece[] {
  const out: Piece[] = []
  for (let piece = last; piece; piece = piece.previous) out.push(piece)
  out.reverse()
  let newPos = 0
  let oldPos = 0
  for (const piece of out) {
    if (piece.removed) {
      piece.value = old.slice(oldPos, oldPos + piece.count).join("")
      oldPos += piece.count
    } else {
      piece.value = next.slice(newPos, newPos + piece.count).join("")
      newPos += piece.count
      if (!piece.added) oldPos += piece.count
    }
  }
  return out
}

/** The token diff itself, or nothing when the two sides are too far apart to be worth marking. */
function tokenDiff(old: readonly string[], next: readonly string[]): Piece[] | undefined {
  const oldLen = old.length
  const newLen = next.length
  const first: Trail = { oldPos: -1 }
  let newPos = common(first, next, old, 0)
  if (first.oldPos + 1 >= oldLen && newPos + 1 >= newLen) return pieces(first.last, next, old)
  const trails = new Map<number, Trail | undefined>([[0, first]])
  let lowest = -Infinity
  let highest = Infinity
  const edits = Math.min(oldLen + newLen, MAX_EDITS)
  for (let length = 1; length <= edits; length++) {
    for (let diagonal = Math.max(lowest, -length); diagonal <= Math.min(highest, length); diagonal += 2) {
      const removeTrail = trails.get(diagonal - 1)
      const addTrail = trails.get(diagonal + 1)
      if (removeTrail) trails.set(diagonal - 1, undefined)
      const addAt = addTrail ? addTrail.oldPos - diagonal : -1
      const canAdd = Boolean(addTrail) && addAt >= 0 && addAt < newLen
      const canRemove = Boolean(removeTrail) && removeTrail!.oldPos + 1 < oldLen
      if (!canAdd && !canRemove) {
        trails.set(diagonal, undefined)
        continue
      }
      const trail =
        !canRemove || (canAdd && removeTrail!.oldPos < addTrail!.oldPos)
          ? extend(addTrail!, true, false, 0)
          : extend(removeTrail!, false, true, 1)
      newPos = common(trail, next, old, diagonal)
      if (trail.oldPos + 1 >= oldLen && newPos + 1 >= newLen) return pieces(trail.last, next, old)
      trails.set(diagonal, trail)
      if (trail.oldPos + 1 >= oldLen) highest = Math.min(highest, diagonal - 1)
      if (newPos + 1 >= newLen) lowest = Math.max(lowest, diagonal + 1)
    }
  }
  return undefined
}

function append(marks: LineMark[], text: string, changed: boolean): void {
  const last = marks[marks.length - 1]
  if (last && last.changed === changed) last.text += text
  else marks.push({ text, changed })
}

/**
 * A removed line and the added line paired with it, cut into what they share
 * and what only one of them has. Nothing comes back for a pair too long to
 * mark, and the pair is then drawn plain.
 */
export function markPair(old: string, next: string): { old: LineMark[]; next: LineMark[] } | undefined {
  if (old.length > WORD_MARK_MAX || next.length > WORD_MARK_MAX) return undefined
  const parts = tokenDiff(wordTokens(old), wordTokens(next))
  if (!parts) return undefined
  const oldMarks: LineMark[] = []
  const nextMarks: LineMark[] = []
  for (const part of parts) {
    const value = part.value ?? ""
    if (!value) continue
    if (part.removed) append(oldMarks, value, true)
    else if (part.added) append(nextMarks, value, true)
    else {
      append(oldMarks, value, false)
      append(nextMarks, value, false)
    }
  }
  return { old: oldMarks, next: nextMarks }
}
