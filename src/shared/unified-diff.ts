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
