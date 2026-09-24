/**
 * Minimal line-level unified diff.
 *
 * Used for two things: the preview inside the permission dialog, and the
 * metadata the UI renders as a colored diff on the tool card. Both are display
 * concerns - nothing here is fed back to a patch program.
 *
 * This runs on Electron's main process before every edit's permission prompt,
 * so its cost must stay bounded whatever the file size: the common leading
 * lines are set aside first, the rest goes through Myers' O(ND) diff (linear for
 * a typical edit), and a change past the edit budget is shown as one replaced
 * block between the common head and tail instead of being aligned line by line.
 */

import type { FileDiff } from "@shared/protocol"

type Kind = "equal" | "delete" | "insert"

interface Op {
  kind: Kind
  line: string
}

/** Past this many changed lines, or this much search work, the middle is shown as one replaced block. */
export const DIFF_EDIT_LIMIT = 2000
const DIFF_WORK_LIMIT = 40_000_000

/**
 * Myers' greedy shortest edit script over line ids, in order. Undefined when
 * the script would pass the edit or work budget.
 */
function myers(a: Int32Array, b: Int32Array): Kind[] | undefined {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, DIFF_EDIT_LIMIT)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] is the frontier before round d, kept for k in [-d-1, d+1].
  const trace: Int32Array[] = []
  let work = 0
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      // Ties step right (a removal), so removals come out ahead of additions.
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      const from = x
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      work += x - from + 1
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (work > DIFF_WORK_LIMIT) return undefined
  }
  if (found < 0) return undefined

  const kinds: Kind[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d]
    const at = (k: number) => prev[k + d + 1]
    const k = x - y
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      kinds.push("equal")
      x--
      y--
    }
    kinds.push(down ? "insert" : "delete")
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    kinds.push("equal")
    x--
    y--
  }
  return kinds.reverse()
}

function diffLines(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++

  const ops: Op[] = []
  for (let i = 0; i < head; i++) ops.push({ kind: "equal", line: a[i] })

  // The common tail is left to the search, whose last snake walks it in linear time: trimming
  // it here would line repeated lines (a closing brace, a blank) up against the end rather
  // than the start, unlike the diffs this replaced. It is trimmed only for the replaced block.
  let oldMiddle = a.slice(head)
  let newMiddle = b.slice(head)
  // Lines become small integers so the search compares numbers, not strings.
  const ids = new Map<string, number>()
  const idOf = (line: string) => {
    let id = ids.get(line)
    if (id === undefined) ids.set(line, (id = ids.size))
    return id
  }
  const kinds = myers(Int32Array.from(oldMiddle, idOf), Int32Array.from(newMiddle, idOf))
  let tail = 0
  if (kinds) {
    // Within one changed run the removed lines come before the added ones.
    let i = 0
    let j = 0
    for (let at = 0; at < kinds.length; ) {
      if (kinds[at] === "equal") {
        ops.push({ kind: "equal", line: oldMiddle[i++] })
        j++
        at++
        continue
      }
      const inserts: Op[] = []
      for (; at < kinds.length && kinds[at] !== "equal"; at++) {
        if (kinds[at] === "delete") ops.push({ kind: "delete", line: oldMiddle[i++] })
        else inserts.push({ kind: "insert", line: newMiddle[j++] })
      }
      for (const op of inserts) ops.push(op)
    }
  } else {
    while (tail < oldMiddle.length && tail < newMiddle.length && oldMiddle[oldMiddle.length - 1 - tail] === newMiddle[newMiddle.length - 1 - tail]) tail++
    oldMiddle = oldMiddle.slice(0, oldMiddle.length - tail)
    newMiddle = newMiddle.slice(0, newMiddle.length - tail)
    for (const line of oldMiddle) ops.push({ kind: "delete", line })
    for (const line of newMiddle) ops.push({ kind: "insert", line })
  }

  for (let i = a.length - tail; i < a.length; i++) ops.push({ kind: "equal", line: a[i] })
  return ops
}

const CONTEXT = 3

/** Git's own line for "this side's last line has no terminator". */
const NO_EOL = "\\ No newline at end of file"

/**
 * Renders a unified diff with the usual @@ hunk headers. Returns an empty
 * string when the two sides are identical.
 */
export function unifiedDiff(filename: string, before: string, after: string): string {
  if (before === after) return ""

  /*
   * Splitting on the newline leaves an empty last element for text that ends
   * with one, and that element is not a line: git counts a three-line file
   * ending in a newline as three lines. Kept, it was written out as a blank
   * context or added line, and reversing such a patch over a file whose two
   * sides disagreed about the final newline put that blank line into the file.
   * Measured, with a real model: a turn that rewrote a three-line file without
   * a final newline came back from 撤销 with a fourth, empty line. The
   * terminator is carried as a flag instead, the way git carries it, and
   * written out as `\ No newline at end of file`.
   */
  const a = before === "" ? [] : before.split("\n")
  const b = after === "" ? [] : after.split("\n")
  if (before.endsWith("\n")) a.pop()
  if (after.endsWith("\n")) b.pop()
  const oldNoEOL = a.length > 0 && !before.endsWith("\n")
  const newNoEOL = b.length > 0 && !after.endsWith("\n")

  let ops = diffLines(a, b)
  /*
   * The final newline moved. Nothing in the lines themselves says so, so a
   * last line the two sides still share would be left as context - and the
   * change would not be in the diff at all: where it was the only change the
   * diff came out empty, and where something else changed too it was silently
   * dropped. Git writes it as that last line removed and added back, marked on
   * the side that has no terminator, and so does this.
   */
  if (oldNoEOL !== newNoEOL && ops.length > 0 && ops[ops.length - 1]!.kind === "equal") {
    const last = ops.length - 1
    ops = [...ops.slice(0, last), { kind: "delete", line: ops[last]!.line }, { kind: "insert", line: ops[last]!.line }]
  }

  // Indices of ops that are near a change and therefore belong in some hunk.
  const keep = new Set<number>()
  ops.forEach((op, index) => {
    if (op.kind === "equal") return
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k++) keep.add(k)
  })
  if (keep.size === 0) return ""

  const lines: string[] = [`--- a/${filename}`, `+++ b/${filename}`]

  let index = 0
  let oldLine = 1
  let newLine = 1
  while (index < ops.length) {
    if (!keep.has(index)) {
      if (ops[index].kind !== "insert") oldLine++
      if (ops[index].kind !== "delete") newLine++
      index++
      continue
    }

    const hunk: string[] = []
    const oldStart = oldLine
    const newStart = newLine
    let oldCount = 0
    let newCount = 0
    while (index < ops.length && keep.has(index)) {
      const op = ops[index]
      if (op.kind === "equal") {
        hunk.push(` ${op.line}`)
        oldCount++
        newCount++
        oldLine++
        newLine++
        // A line both sides share carries one marker, whichever side is missing its terminator.
        if ((oldNoEOL && oldLine - 1 === a.length) || (newNoEOL && newLine - 1 === b.length)) hunk.push(NO_EOL)
      } else if (op.kind === "delete") {
        hunk.push(`-${op.line}`)
        oldCount++
        oldLine++
        if (oldNoEOL && oldLine - 1 === a.length) hunk.push(NO_EOL)
      } else {
        hunk.push(`+${op.line}`)
        newCount++
        newLine++
        if (newNoEOL && newLine - 1 === b.length) hunk.push(NO_EOL)
      }
      index++
    }
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const line of hunk) lines.push(line)
  }

  return lines.join("\n")
}

/** A diff line that carries file text, rather than a header or a hunk marker. */
function isContentLine(line: string): boolean {
  return (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) && !line.startsWith("---") && !line.startsWith("+++")
}

/**
 * The same diff with the indentation every one of its lines shares taken off,
 * as MiMo's `trimDiff` does before a diff is shown.
 *
 * Code eight levels in produced a diff whose every line began with the same
 * thirty-two spaces, which pushed the changed text off the right edge of the
 * card and the approval dialog while the left third stayed blank. Only what
 * carries file text is shifted, and only by the smallest indentation among the
 * lines that have any text at all - a blank line inside the hunk does not hold
 * the whole block at zero.
 *
 * For showing only. A patch that has been shifted no longer matches the file,
 * so `git apply` would refuse it; the copy the undo uses is kept as it was.
 */
export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  let shared = Infinity
  for (const line of lines) {
    if (!isContentLine(line)) continue
    const content = line.slice(1)
    if (!content.trim()) continue
    shared = Math.min(shared, /^\s*/.exec(content)![0].length)
    if (shared === 0) return diff
  }
  if (!Number.isFinite(shared) || shared === 0) return diff
  return lines.map((line) => (isContentLine(line) ? line[0] + line.slice(1 + shared) : line)).join("\n")
}

/**
 * What an edit or write hands back about the file it changed: MiMo's
 * `filediff`.
 *
 * Two copies of the same change, because they are wanted for opposite reasons.
 * `diff` is what the card and the approval dialog show, so it has the
 * indentation every line shares taken off; `filediff.patch` is what the undo
 * hands to `git apply --reverse`, so it is left exactly as the file has it.
 * MiMo keeps only the shown one - its desktop does not reverse this patch to
 * undo a turn, and this app does.
 *
 * `additions` and `deletions` are MiMo's own two numbers beside the patch: how
 * many lines the call added and removed. The turn's card already counted a
 * whole turn's lines; a single step could not say what it had done.
 */
export function changed(file: string, patch: string): { diff: string; filediff: FileDiff } {
  const { added, removed } = diffStat(patch)
  return { diff: trimDiff(patch), filediff: { file, patch, additions: added, deletions: removed } }
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  return { added, removed }
}
