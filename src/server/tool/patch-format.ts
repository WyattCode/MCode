/**
 * The patch language the `patch` tool takes: OpenCode v2's
 * (packages/util/src/patch.ts, MIT - Copyright (c) 2025 opencode), ported
 * without its Effect wrappers. It is the envelope OpenAI's GPT models are
 * trained to write:
 *
 *     *** Begin Patch
 *     *** Add File: path          every following line starts with +
 *     *** Delete File: path       nothing follows
 *     *** Update File: path       @@ context, then ' ', '-' and '+' lines
 *     *** Move to: path           optional, right after Update File
 *     *** End Patch
 *
 * Lines are found by content, not by number, trying an exact match first and
 * then progressively looser ones (trailing space, surrounding space, then
 * typographic quotes and dashes), which is what makes a model's patch apply to
 * a file it last read a few edits ago.
 */

export type Hunk =
  | { readonly type: "add"; readonly path: string; readonly contents: string }
  | { readonly type: "delete"; readonly path: string }
  | { readonly type: "update"; readonly path: string; readonly movePath?: string; readonly chunks: readonly UpdateFileChunk[] }

export interface UpdateFileChunk {
  readonly oldLines: readonly string[]
  readonly newLines: readonly string[]
  readonly changeContext?: string
  readonly endOfFile?: boolean
}

export type Parsed = { ok: true; hunks: Hunk[] } | { ok: false; error: string }

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"

function invalidHeader(line: string, lineNumber: number, reason?: string): string {
  if (reason) return `Invalid hunk at line ${lineNumber}: ${reason}`
  return `Invalid hunk at line ${lineNumber}: '${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`
}

export function parsePatch(patchText: string): Parsed {
  const lines = stripHeredoc(patchText.trim())
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
  const begin = lines[0]?.trim() === BEGIN ? 0 : -1
  const end = lines.at(-1)?.trim() === END ? lines.length - 1 : -1
  if (begin === -1) return { ok: false, error: `The first line of the patch must be '${BEGIN}'` }
  if (end === -1 || begin >= end) return { ok: false, error: `The last line of the patch must be '${END}'` }

  const hunks: Hunk[] = []
  let index = begin + 1
  while (index < end) {
    const line = lines[index]!
    const header = line.trim()
    if (index === begin + 1 && header.startsWith("*** Environment ID:") && header.slice("*** Environment ID:".length).trim()) {
      index++
      continue
    }
    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length).trim()
      const parsed = parseAdd(lines, index + 1, end, path)
      if ("error" in parsed) return { ok: false, error: parsed.error }
      hunks.push({ type: "add", path, contents: parsed.content })
      index = parsed.next
      continue
    }
    if (header.startsWith("*** Delete File: ")) {
      const path = header.slice("*** Delete File: ".length).trim()
      const next = lines[index + 1]?.trim()
      if (index + 1 < end && next !== undefined && !isBoundary(next)) {
        if (next.startsWith("*** ")) return { ok: false, error: invalidHeader(next, index + 2) }
        return { ok: false, error: invalidHeader(next, index + 2, `Unexpected line after Delete File '${path}': '${next}'. Delete hunks do not contain body lines`) }
      }
      hunks.push({ type: "delete", path })
      index++
      continue
    }
    if (header.startsWith("*** Update File: ")) {
      const path = header.slice("*** Update File: ".length).trim()
      let next = index + 1
      let movePath: string | undefined
      while (lines[next]?.trimEnd() === "*** End of File") next++
      const move = lines[next]?.trimEnd()
      if (move === "*** Move to:" || move?.startsWith("*** Move to: ")) {
        movePath = move.slice("*** Move to: ".length).trim()
        if (!movePath) return { ok: false, error: invalidHeader(lines[next]!.trim(), next + 1, `Move destination for '${path}' must not be empty`) }
        next++
      }
      const parsed = parseUpdate(lines, next, end, path, index)
      if ("error" in parsed) return { ok: false, error: parsed.error }
      hunks.push({ type: "update", path, ...(movePath ? { movePath } : {}), chunks: parsed.chunks })
      index = parsed.next
      continue
    }
    return { ok: false, error: invalidHeader(header, index + 1) }
  }
  return { ok: true, hunks }
}

/**
 * A file's text with an update's chunks applied (v2's `derive`). The text
 * comes in with its line endings already made `\n`; the caller puts the
 * file's own back. Throws, with the lines it could not find, when a chunk
 * does not match.
 */
export function applyChunks(path: string, chunks: readonly UpdateFileChunk[], original: string): string {
  const lines = original.split("\n")
  if (lines.at(-1) === "") lines.pop()
  const replacements = computeReplacements(lines, path, chunks)
  for (const [start, remove, insert] of replacements.reverse()) lines.splice(start, remove, ...insert)
  if (lines.at(-1) !== "") lines.push("")
  return lines.join("\n")
}

function parseAdd(lines: readonly string[], start: number, end: number, path: string): { content: string; next: number } | { error: string } {
  const content: string[] = []
  let index = start
  while (index < end && !isBoundary(lines[index]!.trim())) {
    if (!lines[index]!.startsWith("+")) {
      const line = lines[index]!.trim()
      return { error: invalidHeader(line, index + 1, `Invalid Add File line for '${path}': expected a line starting with '+', got '${line}'`) }
    }
    content.push(lines[index]!.slice(1))
    index++
  }
  return { content: content.join("\n"), next: index }
}

function parseUpdate(
  lines: readonly string[],
  start: number,
  end: number,
  path: string,
  hunk: number,
): { chunks: UpdateFileChunk[]; next: number } | { error: string } {
  const chunks: { oldLines: string[]; newLines: string[]; changeContext?: string; endOfFile?: boolean }[] = []
  let index = start
  let afterEndOfFile = false
  while (index < end) {
    const line = lines[index]!
    const updateLine = line.trimEnd()
    if (afterEndOfFile) {
      if (updateLine === "") {
        index++
        continue
      }
      if (updateLine === "@@" || updateLine.startsWith("@@ ")) afterEndOfFile = false
      else if (isBoundary(updateLine)) break
      else return { error: invalidHeader(line, index + 1, `Expected update hunk to start with a @@ context marker, got: '${line}'`) }
    }
    if (updateLine === "*** End of File") {
      const chunk = chunks.at(-1)
      if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) return { error: invalidHeader(updateLine, index + 1, "Update hunk does not contain any lines") }
      if (chunk) {
        chunk.endOfFile = true
        afterEndOfFile = true
      }
      index++
      continue
    }
    if (isBoundary(updateLine)) break
    if (updateLine === "@@" || updateLine.startsWith("@@ ")) {
      const previous = chunks.at(-1)
      if (previous && previous.oldLines.length === 0 && previous.newLines.length === 0) {
        return { error: invalidHeader(line, index + 1, `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`) }
      }
      chunks.push({ oldLines: [], newLines: [], ...(updateLine === "@@" ? {} : { changeContext: updateLine.slice("@@ ".length) }) })
      index++
      continue
    }
    if (chunks.length === 0) chunks.push({ oldLines: [], newLines: [] })
    const chunk = chunks.at(-1)!
    if (line === "") {
      chunk.oldLines.push("")
      chunk.newLines.push("")
    } else if (line.startsWith(" ")) {
      chunk.oldLines.push(line.slice(1))
      chunk.newLines.push(line.slice(1))
    } else if (line.startsWith("-")) {
      chunk.oldLines.push(line.slice(1))
    } else if (line.startsWith("+")) {
      chunk.newLines.push(line.slice(1))
    } else {
      const populated = chunk.oldLines.length > 0 || chunk.newLines.length > 0
      return {
        error: invalidHeader(
          line,
          index + 1,
          populated
            ? `Expected update hunk to start with a @@ context marker, got: '${line}'`
            : `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        ),
      }
    }
    index++
  }
  if (chunks.length === 0) return { error: invalidHeader(lines[hunk]!.trim(), hunk + 1, `Update file hunk for path '${path}' is empty`) }
  const last = chunks.at(-1)!
  if (last.oldLines.length === 0 && last.newLines.length === 0) {
    const line = lines[index]!.trim()
    return {
      error: invalidHeader(
        line,
        index + 1,
        line === END
          ? "Update hunk does not contain any lines"
          : `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      ),
    }
  }
  return { chunks, next: index }
}

function isBoundary(line: string): boolean {
  return line === END || line.startsWith("*** Add File: ") || line.startsWith("*** Delete File: ") || line.startsWith("*** Update File: ")
}

function computeReplacements(lines: readonly string[], path: string, chunks: readonly UpdateFileChunk[]): [number, number, readonly string[]][] {
  const replacements: [number, number, readonly string[]][] = []
  let lineIndex = 0
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = seek(lines, [chunk.changeContext], lineIndex)
      if (context === -1) throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`)
      lineIndex = context + 1
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines])
      continue
    }
    let oldLines = chunk.oldLines
    let newLines = chunk.newLines
    let found = seek(lines, oldLines, lineIndex, chunk.endOfFile)
    if (found === -1 && oldLines.at(-1) === "") {
      oldLines = oldLines.slice(0, -1)
      if (newLines.at(-1) === "") newLines = newLines.slice(0, -1)
      found = seek(lines, oldLines, lineIndex, chunk.endOfFile)
    }
    if (found === -1 && chunk.oldLines.every((line) => line === "")) {
      const expected = chunk.oldLines.length === 1 ? "an expected blank line" : `${chunk.oldLines.length} consecutive blank lines`
      throw new Error(`Failed to find ${expected} in ${path}`)
    }
    if (found === -1) throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`)
    replacements.push([found, oldLines.length, newLines])
    lineIndex = found + oldLines.length
  }
  return replacements.sort((left, right) => left[0] - right[0])
}

function seek(lines: readonly string[], pattern: readonly string[], start: number, eof = false): number {
  if (pattern.length === 0) return -1
  if (eof) {
    const offset = lines.length - pattern.length
    if (offset < start) return -1
    for (const compare of COMPARES) if (matches(lines, pattern, offset, compare)) return offset
    return -1
  }
  for (const compare of COMPARES) {
    for (let offset = start; offset <= lines.length - pattern.length; offset++) {
      if (matches(lines, pattern, offset, compare)) return offset
    }
  }
  return -1
}

function matches(lines: readonly string[], pattern: readonly string[], offset: number, compare: (left: string, right: string) => boolean): boolean {
  return pattern.every((line, index) => compare(lines[offset + index]!, line))
}

const normalize = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ")

const COMPARES: ((left: string, right: string) => boolean)[] = [
  (left, right) => left === right,
  (left, right) => left.trimEnd() === right.trimEnd(),
  (left, right) => left.trim() === right.trim(),
  (left, right) => normalize(left.trim()) === normalize(right.trim()),
]

/** A patch a model wrapped in a shell heredoc - `cat <<'EOF' … EOF` - is the patch inside it. */
const stripHeredoc = (input: string) => input.match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/)?.[3] ?? input
