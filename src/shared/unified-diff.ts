/**
 * Reading the unified diffs the file tools record.
 *
 * Shared because both sides need the same answer: the window counts what a turn
 * changed file by file, and the server takes a turn's changes back out of the
 * files. A tool's diff may cover several files - apply_patch joins one per file
 * - so the first job is always to split it where each file's header begins.
 *
 * Hunks are read by their counts rather than by their prefixes. A removed line
 * that happens to read "-- x" is written "--- x", and followed by an added line
 * reading "++ y" it looks exactly like the header of the next file; only the
 * hunk's own line counts say it is still inside the hunk.
 */

export interface DiffHunk {
  /** 1-based line the hunk starts on, before and after. */
  oldStart: number
  newStart: number
  /** The hunk as it read before the change: context and removed lines. */
  oldLines: string[]
  /** The hunk as it reads after: context and added lines. */
  newLines: string[]
  added: number
  removed: number
}

export interface DiffSection {
  /** The path as the diff names it, without git's `b/` prefix. */
  file: string
  hunks: DiffHunk[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnifiedDiff(diff: string): DiffSection[] {
  const lines = diff.split("\n")
  const sections: DiffSection[] = []
  let current: DiffSection | undefined
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      current = { file: lines[index + 1]!.slice(4).replace(/^b\//, "").trim(), hunks: [] }
      sections.push(current)
      index += 2
      continue
    }
    const match = HUNK.exec(line)
    if (!match || !current) {
      index++
      continue
    }
    let oldLeft = match[2] === undefined ? 1 : Number(match[2])
    let newLeft = match[4] === undefined ? 1 : Number(match[4])
    const hunk: DiffHunk = {
      oldStart: Number(match[1]),
      newStart: Number(match[3]),
      oldLines: [],
      newLines: [],
      added: 0,
      removed: 0,
    }
    index++
    while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const body = lines[index]!
      const text = body.slice(1)
      if (body.startsWith(" ")) {
        hunk.oldLines.push(text)
        hunk.newLines.push(text)
        oldLeft--
        newLeft--
      } else if (body.startsWith("-")) {
        hunk.oldLines.push(text)
        hunk.removed++
        oldLeft--
      } else if (body.startsWith("+")) {
        hunk.newLines.push(text)
        hunk.added++
        newLeft--
      } else if (!body.startsWith("\\")) {
        break
      }
      index++
    }
    current.hunks.push(hunk)
  }
  return sections
}

/** A section that brought its file into being: nothing stood there before it. */
export function createsFile(section: DiffSection): boolean {
  return section.hunks.length > 0 && section.hunks.every((hunk) => hunk.oldLines.length === 0)
}

/**
 * Takes one file's changes back out of its current contents.
 *
 * Each hunk is looked for where it was written, and failing that at the
 * nearest place its lines still stand, so later edits elsewhere in the file do
 * not stop it; a hunk whose lines are no longer there at all leaves the whole
 * file alone and the answer is undefined.
 */
export function reverseSection(content: string, section: DiffSection): string | undefined {
  let lines = content === "" ? [] : content.split("\n")
  for (const hunk of [...section.hunks].reverse()) {
    const at = locate(lines, hunk.newLines, hunk.newStart - 1)
    if (at < 0) return undefined
    lines = [...lines.slice(0, at), ...hunk.oldLines, ...lines.slice(at + hunk.newLines.length)]
  }
  return lines.join("\n")
}

/** One section written back out as a patch git can be handed, `a/`-`b/` headers and all. */
export function sectionPatch(section: DiffSection): string {
  const out = [`--- a/${section.file}`, `+++ b/${section.file}`]
  for (const raw of section.hunks) {
    /*
     * Splitting a file that ends in a newline leaves an empty last element, so
     * a hunk reaching the end of the file carries an empty context line on both
     * sides. Written out, that line asks git to match one line past the end of
     * the file and `git apply` refuses the whole hunk - measured: the same
     * patch without it applies cleanly. The empty line is still wanted for
     * locating the hunk, so it is dropped here rather than when parsing.
     */
    const tail = raw.oldLines.length > 0 && raw.newLines.length > 0 && raw.oldLines.at(-1) === "" && raw.newLines.at(-1) === ""
    const hunk = tail ? { ...raw, oldLines: raw.oldLines.slice(0, -1), newLines: raw.newLines.slice(0, -1) } : raw
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines.length} +${hunk.newStart},${hunk.newLines.length} @@`)
    /*
     * The bodies are rebuilt from the two sides rather than kept verbatim:
     * a line in both is context, a line only on the old side was removed, and
     * one only on the new side was added - which is exactly how they parsed.
     */
    let old = 0
    let fresh = 0
    while (old < hunk.oldLines.length || fresh < hunk.newLines.length) {
      const before = hunk.oldLines[old]
      const after = hunk.newLines[fresh]
      if (old < hunk.oldLines.length && fresh < hunk.newLines.length && before === after) {
        out.push(` ${before}`)
        old++
        fresh++
        continue
      }
      if (old < hunk.oldLines.length && (fresh >= hunk.newLines.length || !hunk.newLines.includes(before!))) {
        out.push(`-${before}`)
        old++
        continue
      }
      if (fresh < hunk.newLines.length) {
        out.push(`+${after}`)
        fresh++
        continue
      }
      out.push(`-${before}`)
      old++
    }
  }
  return `${out.join("\n")}\n`
}

/**
 * The same section, with each hunk moved to where its lines actually stand now.
 *
 * MiMo recomputes a patch against the file on disk and tries `git apply` a
 * second time with it, which is what rescues a hunk that later edits have
 * pushed up or down the file. A hunk whose lines are gone altogether answers
 * undefined, and the caller falls back the way MiMo does.
 */
export function recountedSection(content: string, section: DiffSection): DiffSection | undefined {
  const lines = content === "" ? [] : content.split("\n")
  const hunks: DiffHunk[] = []
  /* How far the old side has drifted from the new one, so `oldStart` stays consistent across hunks. */
  let drift = 0
  for (const hunk of section.hunks) {
    const at = locate(lines, hunk.newLines, hunk.newStart - 1)
    if (at < 0) return undefined
    hunks.push({ ...hunk, newStart: at + 1, oldStart: at + 1 + drift })
    drift += hunk.oldLines.length - hunk.newLines.length
  }
  return { file: section.file, hunks }
}

function locate(lines: string[], block: string[], expected: number): number {
  if (block.length === 0) return Math.min(Math.max(expected, 0), lines.length)
  const fits = (start: number) => block.every((line, offset) => lines[start + offset] === line)
  for (let distance = 0; distance <= lines.length; distance++) {
    for (const start of distance === 0 ? [expected] : [expected - distance, expected + distance]) {
      if (start >= 0 && start + block.length <= lines.length && fits(start)) return start
    }
  }
  return -1
}
