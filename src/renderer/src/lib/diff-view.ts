/*
 * The diff tab's reading of a patch, MCode's own: split per file with each
 * file's +/- counts, lines numbered on both sides, and the pairing a
 * side-by-side view needs. No window is needed, so the smoke test covers it.
 */

import { markPair, type LineMark } from "./diff-words"

/* MiMo's cap: past this many lines only the start of a patch is drawn. */
export const DIFF_LINE_CAP = 1200

export function capDiff(text: string, cap = DIFF_LINE_CAP): { text: string; truncated: boolean; omitted: number } {
  if (!text) return { text, truncated: false, omitted: 0 }
  const lines = text.split("\n")
  if (lines.length <= cap) return { text, truncated: false, omitted: 0 }
  return { text: lines.slice(0, cap).join("\n"), truncated: true, omitted: lines.length - cap }
}

export type DiffLayout = "unified" | "split"
export const DIFF_LAYOUT_KEY = "mcode.ui.diffLayout"

export function normalizeLayout(value: string | null | undefined): DiffLayout {
  return value === "split" ? "split" : "unified"
}

export interface DiffLine {
  kind: "add" | "del" | "ctx"
  old?: number
  new?: number
  text: string
  /** What the line shares with the one it is paired with, and what only it has. */
  marks?: readonly LineMark[]
}

export interface DiffHunkView {
  header: string
  lines: DiffLine[]
}

export interface DiffFileView {
  name: string
  oldName?: string
  status: "changed" | "added" | "deleted" | "renamed"
  added: number
  deleted: number
  hunks: DiffHunkView[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function stripPath(raw: string): string {
  const trimmed = raw.replace(/\t.*$/, "").trim().replace(/^"(.*)"$/, "$1")
  return trimmed.replace(/^[ab]\//, "")
}

/*
 * Files by their headers - `diff --git`, or a bare `---`/`+++` pair as the
 * edit tools write - and hunks read by their counts, so a removed line that
 * reads "-- x" is not taken for the next file's header.
 */
export function parseDiffFiles(diff: string): DiffFileView[] {
  const files: DiffFileView[] = []
  const lines = diff.split("\n")
  let file: DiffFileView | undefined
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0
  const start = (name = ""): DiffFileView => {
    const next: DiffFileView = { name, status: "changed", added: 0, deleted: 0, hunks: [] }
    files.push(next)
    return next
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const hunk = oldLeft > 0 || newLeft > 0 ? file?.hunks[file.hunks.length - 1] : undefined
    if (hunk && file) {
      if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", new: newLine++, text: line.slice(1) })
        file.added++
        newLeft--
        continue
      }
      if (line.startsWith("-")) {
        hunk.lines.push({ kind: "del", old: oldLine++, text: line.slice(1) })
        file.deleted++
        oldLeft--
        continue
      }
      if (line.startsWith(" ") || line === "") {
        hunk.lines.push({ kind: "ctx", old: oldLine++, new: newLine++, text: line.slice(1) })
        oldLeft--
        newLeft--
        continue
      }
      if (line.startsWith("\\")) continue
      oldLeft = 0
      newLeft = 0
    }
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line)
      file = start(match ? match[2] : "")
      if (match && match[1] !== match[2]) file.oldName = match[1]
      continue
    }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      const before = line.slice(4).trim()
      const after = lines[index + 1]!.slice(4).trim()
      if (!file || file.hunks.length) file = start()
      if (after === "/dev/null") {
        file.status = "deleted"
        file.name = stripPath(before)
      } else {
        file.name = stripPath(after)
        if (before === "/dev/null") file.status = "added"
      }
      index++
      continue
    }
    if (file && !file.hunks.length) {
      if (line.startsWith("new file mode")) file.status = "added"
      else if (line.startsWith("deleted file mode")) file.status = "deleted"
      else if (line.startsWith("rename from ")) {
        file.status = "renamed"
        file.oldName = line.slice("rename from ".length)
      } else if (line.startsWith("rename to ")) {
        file.status = "renamed"
        file.name = line.slice("rename to ".length)
      }
    }
    const match = HUNK.exec(line)
    if (!match) continue
    if (!file) file = start()
    oldLine = Number(match[1])
    newLine = Number(match[3])
    oldLeft = match[2] === undefined ? 1 : Number(match[2])
    newLeft = match[4] === undefined ? 1 : Number(match[4])
    file.hunks.push({ header: line, lines: [] })
  }
  return files
}

export interface ReviewRow {
  kind: "add" | "del" | "ctx" | "hunk"
  old?: number
  new?: number
  sign: string
  text: string
}

/*
 * The review box's rows: each hunk's header, then its lines, file after file.
 * Read through parseDiffFiles, so a later file's `diff --git`, `---` and `+++`
 * lines are headers, not a removed and an added row.
 */
export function reviewRows(diff: string): ReviewRow[] {
  return parseDiffFiles(diff).flatMap((file) =>
    file.hunks.flatMap((hunk): ReviewRow[] => [
      { kind: "hunk", sign: "", text: hunk.header },
      ...hunk.lines.map((line) => ({
        kind: line.kind,
        old: line.old,
        new: line.new,
        sign: line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ",
        text: line.text,
      })),
    ]),
  )
}

/*
 * A hunk's lines with the word marks filled in.
 *
 * MiMo pairs a run of removals with the run of additions after it, row for row,
 * and marks a pair that has both sides; a removal with no addition against it,
 * and an addition that follows no removal, stay plain. The pairing is the one
 * `splitRows` draws with, so the same words light up in either layout.
 */
export function markWords(lines: readonly DiffLine[]): DiffLine[] {
  const marked = lines.map((line) => ({ ...line }))
  let index = 0
  while (index < marked.length) {
    if (marked[index]!.kind === "ctx") {
      index++
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (index < marked.length && marked[index]!.kind === "del") removed.push(marked[index++]!)
    while (index < marked.length && marked[index]!.kind === "add") added.push(marked[index++]!)
    for (let row = 0; row < Math.min(removed.length, added.length); row++) {
      const pair = markPair(removed[row]!.text, added[row]!.text)
      if (!pair) continue
      removed[row]!.marks = pair.old
      added[row]!.marks = pair.next
    }
  }
  return marked
}

/**
 * A renamed file's two names in one, MiMo's braced form: the parts of the path
 * they share stay put and only the part that moved is written `{old → new}`.
 * Anything else - a file that was not renamed, or one side being /dev/null -
 * is its own name.
 */
export function displayName(file: Pick<DiffFileView, "name" | "oldName">): string {
  const before = file.oldName
  if (!before || before === file.name || before.includes("dev/null") || file.name.includes("dev/null")) return file.name
  const from = before.split("/")
  const to = file.name.split("/")
  const head: string[] = []
  const tail: string[] = []
  let start = 0
  let endFrom = from.length - 1
  let endTo = to.length - 1
  while (start < endFrom && start < endTo && from[start] === to[start]) head.push(to[start++]!)
  while (endFrom > start && endTo > start && from[endFrom] === to[endTo]) {
    tail.unshift(to[endTo]!)
    endFrom--
    endTo--
  }
  const moved = `{${from.slice(start, endFrom + 1).join("/")} → ${to.slice(start, endTo + 1).join("/")}}`
  const above = head.join("/")
  const below = tail.join("/")
  if (above && below) return `${above}/${moved}/${below}`
  if (above) return `${above}/${moved}`
  if (below) return `${moved}/${below}`
  return `${before} → ${file.name}`
}

export interface SplitRow {
  left?: DiffLine
  right?: DiffLine
}

/* Side by side: context on both sides, a run of removals paired row for row with the additions after it. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.kind === "ctx") {
      rows.push({ left: line, right: line })
      index++
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (index < lines.length && lines[index]!.kind === "del") removed.push(lines[index++]!)
    while (index < lines.length && lines[index]!.kind === "add") added.push(lines[index++]!)
    for (let row = 0; row < Math.max(removed.length, added.length); row++) rows.push({ left: removed[row], right: added[row] })
  }
  return rows
}

/* A file's name as its folder part and its own name, MiMo's dim directory before the base. */
export function splitPath(name: string): { dir: string; base: string } {
  const cut = name.lastIndexOf("/")
  return cut >= 0 ? { dir: name.slice(0, cut + 1), base: name.slice(cut + 1) } : { dir: "", base: name }
}
