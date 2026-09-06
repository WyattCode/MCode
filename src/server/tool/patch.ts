import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { unifiedDiff } from "../diff"

/*
 * The reference's `apply_patch` tool, and the patch language it parses.
 *
 * Everything below is a transcription of `exports_patch2` (node-BBwF64dM.js
 * @23412382) and `ApplyPatchTool` (@23431367). This is a first-party tool, not
 * something borrowed from the AI SDK: an earlier look on this project found
 * only the AI SDK's OpenAI provider mentioning `apply_patch` and concluded the
 * reference had none of its own. It does - `ApplyPatchTool = define7("apply_patch", ...)`
 * - and it is in the desktop builtin list as `patch: init3(patchtool)`
 * (@32844717, @32849132).
 *
 * It is not offered alongside `edit` and `write`; it REPLACES them, and only
 * for one family of models. The registry decides with
 *
 *   usePatch = modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
 *
 * and then keeps `apply_patch` when that is true and `edit`/`write` when it is
 * false (@32851400). See `toolsFor` in registry.ts.
 */

/** One file operation inside a patch. */
type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: Chunk[] }

interface Chunk {
  oldLines: string[]
  newLines: string[]
  /** The `@@ ...` line, which anchors the search rather than giving a number. */
  context?: string
  endOfFile?: boolean
}

/**
 * Undoes a shell heredoc around the patch.
 *
 * The reference carries this because the same patch language arrives through
 * `bash` as `apply_patch <<'EOF' ... EOF`, and the text it wants is the body.
 */
function stripHeredoc(input: string): string {
  const found = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)
  return found ? found[2] : input
}

function parseHeader(lines: string[], at: number): { filePath: string; movePath?: string; next: number } | undefined {
  const line = lines[at]
  for (const marker of ["*** Add File:", "*** Delete File:"]) {
    if (line.startsWith(marker)) {
      const filePath = line.slice(marker.length).trim()
      return filePath ? { filePath, next: at + 1 } : undefined
    }
  }
  if (!line.startsWith("*** Update File:")) return undefined
  const filePath = line.slice("*** Update File:".length).trim()
  let movePath: string | undefined
  let next = at + 1
  if (next < lines.length && lines[next].startsWith("*** Move to:")) {
    movePath = lines[next].slice("*** Move to:".length).trim()
    next += 1
  }
  return filePath ? { filePath, movePath, next } : undefined
}

function parseChunks(lines: string[], from: number): { chunks: Chunk[]; next: number } {
  const chunks: Chunk[] = []
  let at = from
  while (at < lines.length && !lines[at].startsWith("***")) {
    if (!lines[at].startsWith("@@")) {
      at += 1
      continue
    }
    const context = lines[at].substring(2).trim()
    at += 1
    const oldLines: string[] = []
    const newLines: string[] = []
    let endOfFile = false
    while (at < lines.length && !lines[at].startsWith("@@") && !lines[at].startsWith("***")) {
      const line = lines[at]
      if (line === "*** End of File") {
        endOfFile = true
        at += 1
        break
      }
      if (line.startsWith(" ")) {
        oldLines.push(line.substring(1))
        newLines.push(line.substring(1))
      } else if (line.startsWith("-")) {
        oldLines.push(line.substring(1))
      } else if (line.startsWith("+")) {
        newLines.push(line.substring(1))
      }
      at += 1
    }
    chunks.push({ oldLines, newLines, context: context || undefined, endOfFile: endOfFile || undefined })
  }
  return { chunks, next: at }
}

function parseAddContents(lines: string[], from: number): { contents: string; next: number } {
  let contents = ""
  let at = from
  while (at < lines.length && !lines[at].startsWith("***")) {
    // Only `+` lines count, which is why the description insists on the prefix
    // even for a brand new file.
    if (lines[at].startsWith("+")) contents += lines[at].substring(1) + "\n"
    at += 1
  }
  if (contents.endsWith("\n")) contents = contents.slice(0, -1)
  return { contents, next: at }
}

export function parsePatch(patchText: string): Hunk[] {
  const lines = stripHeredoc(patchText.trim()).split("\n")
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  const end = lines.findIndex((line) => line.trim() === "*** End Patch")
  if (begin === -1 || end === -1 || begin >= end) {
    throw new Error("Invalid patch format: missing Begin/End markers")
  }

  const hunks: Hunk[] = []
  let at = begin + 1
  while (at < end) {
    const header = parseHeader(lines, at)
    if (!header) {
      at += 1
      continue
    }
    if (lines[at].startsWith("*** Add File:")) {
      const { contents, next } = parseAddContents(lines, header.next)
      hunks.push({ type: "add", path: header.filePath, contents })
      at = next
    } else if (lines[at].startsWith("*** Delete File:")) {
      hunks.push({ type: "delete", path: header.filePath })
      at = header.next
    } else {
      const { chunks, next } = parseChunks(lines, header.next)
      hunks.push({ type: "update", path: header.filePath, movePath: header.movePath, chunks })
      at = next
    }
  }
  return hunks
}

/**
 * Characters a model reliably substitutes when it retypes a line.
 *
 * The reference's last-resort comparison folds smart quotes, the four dash
 * widths, the ellipsis and the non-breaking space before giving up on a chunk.
 */
function normaliseUnicode(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
}

function tryMatch(
  lines: string[],
  pattern: string[],
  from: number,
  same: (a: string, b: string) => boolean,
  endOfFile?: boolean,
): number {
  const matches = (at: number) => pattern.every((line, offset) => same(lines[at + offset], line))
  // A chunk marked `*** End of File` is anchored to the tail first, so a
  // pattern that also occurs earlier still lands where it was meant to.
  if (endOfFile) {
    const fromEnd = lines.length - pattern.length
    if (fromEnd >= from && matches(fromEnd)) return fromEnd
  }
  for (let at = from; at <= lines.length - pattern.length; at += 1) {
    if (matches(at)) return at
  }
  return -1
}

/**
 * Finds a chunk's old lines, loosening the comparison one step at a time.
 *
 * Exact, then ignoring trailing whitespace, then ignoring indentation, then
 * folding the substituted characters above. The order matters: each step can
 * only match more than the one before it, so the tightest match that exists is
 * always the one taken.
 */
function seek(lines: string[], pattern: string[], from: number, endOfFile?: boolean): number {
  if (pattern.length === 0) return -1
  const passes: ((a: string, b: string) => boolean)[] = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
    (a, b) => normaliseUnicode(a.trim()) === normaliseUnicode(b.trim()),
  ]
  for (const same of passes) {
    const at = tryMatch(lines, pattern, from, same, endOfFile)
    if (at !== -1) return at
  }
  return -1
}

/** Applies one file's chunks, in the order they were written. */
export function applyChunks(filePath: string, chunks: Chunk[], original: string): string {
  const lines = original.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()

  const replacements: [number, number, string[]][] = []
  let cursor = 0

  for (const chunk of chunks) {
    if (chunk.context) {
      const at = seek(lines, [chunk.context], cursor)
      if (at === -1) throw new Error(`Failed to find context '${chunk.context}' in ${filePath}`)
      cursor = at + 1
    }

    if (chunk.oldLines.length === 0) {
      /*
       * The end of the file, exactly as the reference puts it:
       * `replacements.push([lines2.length, 0, chunk.newLines])`. This used to
       * step back one more line when the file ended in a blank, which put an
       * insertion one line earlier than opencode would - the trailing blank has
       * already been popped above, so the extra step was measuring the same
       * thing twice.
       */
      replacements.push([lines.length, 0, chunk.newLines])
      continue
    }

    let pattern = chunk.oldLines
    let replacement = chunk.newLines
    let at = seek(lines, pattern, cursor, chunk.endOfFile)
    /*
     * A chunk whose last old line is blank usually came from a model counting
     * the file's final newline as a line of its own. Dropping it from both
     * sides is the reference's one retry.
     */
    if (at === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1)
      if (replacement.length > 0 && replacement[replacement.length - 1] === "") {
        replacement = replacement.slice(0, -1)
      }
      at = seek(lines, pattern, cursor, chunk.endOfFile)
    }
    if (at === -1) {
      throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`)
    }
    replacements.push([at, pattern.length, replacement])
    cursor = at + pattern.length
  }

  replacements.sort((a, b) => a[0] - b[0])
  const result = [...lines]
  // Applied back to front so an earlier splice cannot move a later one.
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const [at, length, segment] = replacements[i]
    result.splice(at, length, ...segment)
  }
  if (result.length === 0 || result[result.length - 1] !== "") result.push("")
  return result.join("\n")
}

const DESCRIPTION =
  "Use the `apply_patch` tool to edit files. Your patch language is a stripped‑down, file‑oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high‑level envelope:\r\n" +
  "\r\n" +
  "*** Begin Patch\r\n" +
  "[ one or more file sections ]\r\n" +
  "*** End Patch\r\n" +
  "\r\n" +
  "Within that envelope, you get a sequence of file operations.\r\n" +
  "You MUST include a header to specify the action you are taking.\r\n" +
  "Each operation starts with one of three headers:\r\n" +
  "\r\n" +
  "*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\r\n" +
  "*** Delete File: <path> - remove an existing file. Nothing follows.\r\n" +
  "*** Update File: <path> - patch an existing file in place (optionally with a rename).\r\n" +
  "\r\n" +
  "Example patch:\r\n" +
  "\r\n" +
  "```\r\n" +
  "*** Begin Patch\r\n" +
  "*** Add File: hello.txt\r\n" +
  "+Hello world\r\n" +
  "*** Update File: src/app.py\r\n" +
  "*** Move to: src/main.py\r\n" +
  "@@ def greet():\r\n" +
  '-print("Hi")\r\n' +
  '+print("Hello, world!")\r\n' +
  "*** Delete File: obsolete.txt\r\n" +
  "*** End Patch\r\n" +
  "```\r\n" +
  "\r\n" +
  "It is important to remember:\r\n" +
  "\r\n" +
  "- You must include a header with your intended action (Add/Delete/Update)\r\n" +
  "- You must prefix new lines with `+` even when creating a new file\r\n"

interface Change {
  target: string
  display: string
  movePath?: string
  moveDisplay?: string
  type: "add" | "update" | "move" | "delete"
  contents: string
  diff: string
}

/**
 * One tool call that adds, edits, renames and deletes files in a single patch.
 *
 * The whole patch is parsed and computed against the files on disk BEFORE
 * anything is written or the user is asked, which is the reference's order and
 * the reason it can show one diff covering every file and then refuse the lot.
 * A patch that fails to apply to its third file changes nothing at all.
 */
export const ApplyPatchTool: ToolDefinition = {
  name: "apply_patch",
  description: DESCRIPTION,
  /*
   * The reference asks under `edit`, not a bucket of its own
   * (`ctx.ask({permission: "edit", ...})` @23436700), so a reader who has
   * allowed edits has allowed these too. That is also why no new permission
   * kind - and so no invented settings string - is needed.
   */
  permission: "edit",
  parameters: {
    type: "object",
    properties: {
      patchText: {
        type: "string",
        description: "The full patch text that describes all changes to be made",
      },
    },
    required: ["patchText"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const patchText = typeof input.patchText === "string" ? input.patchText : ""
    if (!patchText) throw new ToolError("patchText is required")

    let hunks: Hunk[]
    try {
      hunks = parsePatch(patchText)
    } catch (err) {
      throw new ToolError(`apply_patch verification failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (hunks.length === 0) {
      const normalised = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
      if (normalised === "*** Begin Patch\n*** End Patch") throw new ToolError("patch rejected: empty patch")
      throw new ToolError("apply_patch verification failed: no hunks found")
    }

    const changes: Change[] = []
    for (const hunk of hunks) {
      const target = await resolvePath(context, hunk.path)
      const display = relative(context.directory, target)

      if (hunk.type === "add") {
        const contents = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : hunk.contents + "\n"
        changes.push({ target, display, type: "add", contents, diff: unifiedDiff(display, "", contents) })
        continue
      }

      const original = await fs.readFile(target, "utf8").catch(() => undefined)

      if (hunk.type === "delete") {
        if (original === undefined) {
          throw new ToolError(`apply_patch verification failed: Failed to read file to delete: ${display}`)
        }
        changes.push({ target, display, type: "delete", contents: "", diff: unifiedDiff(display, original, "") })
        continue
      }

      if (original === undefined) {
        throw new ToolError(`apply_patch verification failed: Failed to read file to update: ${display}`)
      }
      let contents: string
      try {
        contents = applyChunks(display, hunk.chunks, original)
      } catch (err) {
        throw new ToolError(`apply_patch verification failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      const movePath = hunk.movePath ? await resolvePath(context, hunk.movePath) : undefined
      /*
       * A destination that is the project itself, which `relative` renders as
       * an empty string. The reference fixed the same thing in 1.18.26 - "no
       * longer produces empty move paths in permission metadata" - and here it
       * was worse than cosmetic: `moveDisplay ?? display` does not fall back for
       * an empty string, because `??` only catches null, so the approval named a
       * file with no name and the call went on to open the directory and leak a
       * raw EISDIR at the model.
       */
      const moveDisplay = movePath ? relative(context.directory, movePath) : undefined
      if (movePath && !moveDisplay) {
        throw new ToolError(`patch rejected: nowhere to move ${display} to`)
      }
      changes.push({
        target,
        display,
        movePath,
        moveDisplay,
        type: movePath ? "move" : "update",
        contents,
        diff: unifiedDiff(display, original, contents),
      })
    }

    const diff = changes.map((change) => change.diff).join("\n")

    await context.permissions.ask({
      signal: context.signal,
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "edit",
      title: "Edit file",
      subject: changes.map((change) => change.moveDisplay ?? change.display).join(", "),
      preview: diff,
    })

    for (const change of changes) {
      /*
       * Every path the patch touches is recorded before it is touched -
       * including the destination of a rename and the file a rename leaves
       * behind - so undo can put all of them back. A rename is two files, and
       * recording only one of them would half-restore it.
       */
      await context.snapshot(change.target)
      if (change.movePath) await context.snapshot(change.movePath)

      if (change.type === "delete") {
        await fs.rm(change.target, { force: true })
        continue
      }
      const destination = change.movePath ?? change.target
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, change.contents, "utf8")
      if (change.movePath) await fs.rm(change.target, { force: true })
    }

    /*
     * The summary is the reference's, line for line: `A`, `D` or `M` and the
     * project-relative path, under the sentence "Success. Updated the following
     * files:". The LSP diagnostics block it appends after that has no
     * counterpart here - this app runs no language server - so nothing stands
     * in for it.
     */
    const summary = changes
      .map((change) => {
        if (change.type === "add") return `A ${change.display}`
        if (change.type === "delete") return `D ${change.display}`
        return `M ${change.moveDisplay ?? change.display}`
      })
      .join("\n")
    const output = `Success. Updated the following files:\n${summary}`

    return {
      output,
      title: changes.map((change) => change.moveDisplay ?? change.display).join(", "),
      metadata: { diff, files: changes.map((change) => change.moveDisplay ?? change.display) },
    }
  },
}
