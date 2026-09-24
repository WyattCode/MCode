/**
 * Reading the unified diffs the file tools record.
 *
 * Shared because both sides need the same answer: the window counts what a turn
 * changed file by file, and the server takes a turn's changes back out of the
 * files. A diff may carry more than one file's changes - a turn's are read
 * together - so the first job is always to split it where each file's header
 * begins.
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
  /**
   * The hunk reaches the end of the file and that side has no final newline -
   * git's `\ No newline at end of file`. Carried so a patch written back out
   * says it too: without it a reversed patch hands git a line where the file
   * ends, and the file comes back one blank line longer.
   */
  oldNoEOL?: boolean
  newNoEOL?: boolean
}

export interface DiffSection {
  /** The path as the diff names it, without git's `b/` prefix. */
  file: string
  /** The old side's path, without the `a/` prefix: `/dev/null` for a patch that creates the file. */
  oldFile: string
  hunks: DiffHunk[]
}

/**
 * Whether this section's change brought the file into being, read from the
 * patch rather than from what the call recorded beside it.
 *
 * MiMo asks the same of every patch it is about to reverse, because a file its
 * `created` flag has lost would otherwise have a create-patch applied backwards
 * and be left empty instead of being deleted. Git writes `--- /dev/null` there;
 * this app's own differ names the file on both sides and says the same thing by
 * counting from nothing - one hunk that starts at the top and removes no lines.
 *
 * `createdFile` is the question both callers actually ask: what the call
 * recorded, and only where it recorded nothing, what the patch says. A call
 * that recorded `created: false` had a file on disk to read, empty or not, so
 * its word beats the patch's shape.
 */
export function createdFile(recorded: unknown, section: DiffSection): boolean {
  if (typeof recorded === "boolean") return recorded
  return sectionCreates(section)
}

export function sectionCreates(section: DiffSection): boolean {
  if (section.oldFile === "/dev/null") return true
  if (section.hunks.length !== 1) return false
  const hunk = section.hunks[0]!
  return hunk.oldLines.length === 0 && hunk.oldStart <= 1
}

/** Git's own line for "this side's last line has no terminator". */
const NO_EOL = "\\ No newline at end of file"

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnifiedDiff(diff: string): DiffSection[] {
  const lines = diff.split("\n")
  const sections: DiffSection[] = []
  let current: DiffSection | undefined
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      current = {
        file: lines[index + 1]!.slice(4).replace(/^b\//, "").trim(),
        oldFile: line.slice(4).replace(/^a\//, "").trim(),
        hunks: [],
      }
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
    /* Which side the marker belongs to is told by the line it follows. */
    let previous = ""
    while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const body = lines[index]!
      const text = body.slice(1)
      if (body.startsWith(" ")) {
        hunk.oldLines.push(text)
        hunk.newLines.push(text)
        oldLeft--
        newLeft--
        previous = " "
      } else if (body.startsWith("-")) {
        hunk.oldLines.push(text)
        hunk.removed++
        oldLeft--
        previous = "-"
      } else if (body.startsWith("+")) {
        hunk.newLines.push(text)
        hunk.added++
        newLeft--
        previous = "+"
      } else if (body.startsWith("\\")) {
        if (previous === " " || previous === "-") hunk.oldNoEOL = true
        if (previous === " " || previous === "+") hunk.newNoEOL = true
      } else {
        break
      }
      index++
    }
    /*
     * The marker sits after the hunk's last line, by which point the counts are
     * spent and the loop above has already stopped - so it is read here, and it
     * speaks for whichever side that last line belonged to.
     */
    if (lines[index]?.startsWith("\\")) {
      if (previous === " " || previous === "-") hunk.oldNoEOL = true
      if (previous === " " || previous === "+") hunk.newNoEOL = true
      index++
    }
    current.hunks.push(hunk)
  }
  return sections
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
    /* Where each side's last line landed, so the marker can follow it. */
    let lastOld = -1
    let lastNew = -1
    const wrote = (usedOld: boolean, usedNew: boolean) => {
      if (usedOld && old === hunk.oldLines.length) lastOld = out.length - 1
      if (usedNew && fresh === hunk.newLines.length) lastNew = out.length - 1
    }
    while (old < hunk.oldLines.length || fresh < hunk.newLines.length) {
      const before = hunk.oldLines[old]
      const after = hunk.newLines[fresh]
      if (old < hunk.oldLines.length && fresh < hunk.newLines.length && before === after) {
        /*
         * Same text on both sides is context - except at the end of a file
         * where only the terminator moved, which is a change git writes as the
         * last line removed and added back, marked on the side that lost it.
         * Written as context the patch would reverse to nothing.
         */
        const ends = old === hunk.oldLines.length - 1 && fresh === hunk.newLines.length - 1
        if (ends && Boolean(hunk.oldNoEOL) !== Boolean(hunk.newNoEOL)) {
          out.push(`-${before}`)
          old++
          wrote(true, false)
          out.push(`+${after}`)
          fresh++
          wrote(false, true)
          continue
        }
        out.push(` ${before}`)
        old++
        fresh++
        wrote(true, true)
        continue
      }
      if (old < hunk.oldLines.length && (fresh >= hunk.newLines.length || !hunk.newLines.includes(before!))) {
        out.push(`-${before}`)
        old++
        wrote(true, false)
        continue
      }
      if (fresh < hunk.newLines.length) {
        out.push(`+${after}`)
        fresh++
        wrote(false, true)
        continue
      }
      out.push(`-${before}`)
      old++
      wrote(true, false)
    }
    /*
     * Written from the back so the earlier index is still where it was, and at
     * most once for a line both sides end on.
     */
    const marks = new Set<number>()
    if (hunk.oldNoEOL && lastOld >= 0) marks.add(lastOld)
    if (hunk.newNoEOL && lastNew >= 0) marks.add(lastNew)
    for (const at of [...marks].sort((x, y) => y - x)) out.splice(at + 1, 0, NO_EOL)
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
  return { file: section.file, oldFile: section.oldFile, hunks }
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
