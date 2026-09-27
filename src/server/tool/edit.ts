import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { changed, unifiedDiff } from "../diff"
import { isMemoryPath } from "../history/service"
import { guardPlanWrite } from "../session/plan"

/** The longest closest-match hint a failed edit carries. */
const HINT_MAX_CHARS = 2000

/** Edits to one file wait for each other, as MiMo's engine holds a lock per file. */
const locks = new Map<string, Promise<unknown>>()

export async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file)
  const before = locks.get(key) ?? Promise.resolve()
  const run = before.then(work)
  const held = run.catch(() => undefined)
  locks.set(key, held)
  try {
    return await run
  } finally {
    if (locks.get(key) === held) locks.delete(key)
  }
}

/** Blocks whose lines match once each side is trimmed. */
function* lineTrimmed(content: string, find: string): Generator<string> {
  const lines = content.split("\n")
  const wanted = find.split("\n")
  if (wanted[wanted.length - 1] === "") wanted.pop()
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    if (!wanted.every((line, j) => lines[i + j].trim() === line.trim())) continue
    yield lines.slice(i, i + wanted.length).join("\n")
  }
}

/** Lines, or blocks of lines, that match once runs of whitespace count as one space. */
function* whitespaceNormalized(content: string, find: string): Generator<string> {
  const normal = (text: string) => text.replace(/\s+/g, " ").trim()
  const target = normal(find)
  if (!target) return
  const lines = content.split("\n")
  const size = find.split("\n").length
  for (let i = 0; i + size <= lines.length; i++) {
    const block = lines.slice(i, i + size).join("\n")
    if (normal(block) === target) yield block
  }
}

const trimmedLines = (text: string) => {
  const lines = text.split("\n").map((line) => line.trim())
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * Blocks that start and end on the quoted first and last lines, whatever came
 * between: the one whose middle agrees most with the quote, when there are several.
 */
function* blockAnchor(content: string, find: string): Generator<string> {
  const wanted = trimmedLines(find)
  if (wanted.length < 3) return
  const lines = content.split("\n")
  const first = wanted[0]!
  const last = wanted[wanted.length - 1]!
  const middle = wanted.slice(1, -1)
  const candidates: { block: string; score: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== first) continue
    for (let j = i + 2; j < lines.length; j++) {
      if (lines[j]!.trim() !== last) continue
      const between = lines.slice(i + 1, j).map((line) => line.trim())
      const shared = middle.filter((line) => between.includes(line)).length
      candidates.push({ block: lines.slice(i, j + 1).join("\n"), score: middle.length ? shared / Math.max(middle.length, between.length) : 1 })
      break
    }
  }
  if (candidates.length === 1) yield candidates[0]!.block
  else {
    const best = candidates.sort((a, b) => b.score - a.score)[0]
    if (best && best.score >= 0.3) yield best.block
  }
}

/** Blocks that match once each side's common indentation is taken off. */
function* indentationFlexible(content: string, find: string): Generator<string> {
  const outdent = (text: string) => {
    const lines = text.split("\n")
    const depth = Math.min(...lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length))
    return lines.map((line) => (line.trim() ? line.slice(Number.isFinite(depth) ? depth : 0) : "")).join("\n")
  }
  const wanted = find.replace(/\n$/, "")
  const target = outdent(wanted)
  const lines = content.split("\n")
  const size = wanted.split("\n").length
  for (let i = 0; i + size <= lines.length; i++) {
    const block = lines.slice(i, i + size).join("\n")
    if (outdent(block) === target) yield block
  }
}

/** The quote without the blank space around it. */
function* trimmedBoundary(content: string, find: string): Generator<string> {
  const trimmed = find.trim()
  if (!trimmed || trimmed === find) return
  if (content.includes(trimmed)) yield trimmed
  const lines = content.split("\n")
  const size = find.split("\n").length
  for (let i = 0; i + size <= lines.length; i++) {
    const block = lines.slice(i, i + size).join("\n")
    if (block.trim() === trimmed) yield block
  }
}

const UNESCAPED: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\n": "\n" }

/** The quote with the escapes a model writes when it means the characters (`\n`, `\t`, `\"`) read as those characters. */
function* escapeNormalized(content: string, find: string): Generator<string> {
  const plain = find.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_, char: string) => UNESCAPED[char] ?? char)
  if (plain !== find && content.includes(plain)) yield plain
}

/** Blocks of the quote's length anchored on its first and last lines, with at least half the lines between agreeing. */
function* contextAware(content: string, find: string): Generator<string> {
  const wanted = trimmedLines(find)
  if (wanted.length < 3) return
  const lines = content.split("\n")
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    const block = lines.slice(i, i + wanted.length)
    if (block[0]!.trim() !== wanted[0] || block[block.length - 1]!.trim() !== wanted[wanted.length - 1]) continue
    const middle = wanted.slice(1, -1).map((line, at) => [line, block[at + 1]!.trim()] as const).filter(([line]) => line)
    const agreeing = middle.filter(([line, found]) => line === found).length
    if (!middle.length || agreeing / middle.length >= 0.5) yield block.join("\n")
  }
}

/**
 * The text in the file an edit most likely meant, for the error that says it
 * was not found - MiMo points the model at it so the retry quotes the file as
 * it is. Only the hint is loose; the replacement itself stays exact. The
 * matchers are tried in MiMo's order.
 */
export function closestMatch(content: string, find: string): string | undefined {
  for (const matcher of [lineTrimmed, blockAnchor, indentationFlexible, whitespaceNormalized, trimmedBoundary, escapeNormalized, contextAware]) {
    for (const match of matcher(content, find)) {
      if (match && match !== find && content.includes(match)) return match
    }
  }
  return undefined
}

/** The file's own line endings win: text quoted with \n still lands as \r\n in a CRLF file. */
function endingOf(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

interface Change {
  oldString: string
  newString: string
  replaceAll: boolean
}

/**
 * One exact replacement, on text rather than on the disk. Throws what the
 * model should read when the quote is missing or is not unique.
 */
function replaceIn(original: string, change: Change, ending: "\r\n" | "\n", display: string): { updated: string; occurrences: number } {
  const inFileEndings = (text: string) => {
    const plain = text.replaceAll("\r\n", "\n")
    return ending === "\n" ? plain : plain.replaceAll("\n", "\r\n")
  }
  const find = inFileEndings(change.oldString)
  const replacement = inFileEndings(change.newString)

  const first = original.indexOf(find)
  if (first === -1) {
    const hint = closestMatch(original, change.oldString)
    const shown = hint && hint.length > HINT_MAX_CHARS ? `${hint.slice(0, HINT_MAX_CHARS)}\n… (cut)` : hint
    throw new ToolError(
      `old_string was not found in ${display}. It has to match the file exactly, including whitespace, indentation and line endings.` +
        (shown ? `\n\nThe closest text in the file - note its exact whitespace, and send it again as old_string:\n${shown}` : ""),
    )
  }
  const occurrences = original.split(find).length - 1
  if (occurrences > 1 && !change.replaceAll) {
    throw new ToolError(
      `old_string appears ${occurrences} times in ${display}, and replace_all is not set. Set replace_all to change every one, or include surrounding lines so it matches only once.`,
    )
  }
  const updated = change.replaceAll ? original.split(find).join(replacement) : original.slice(0, first) + replacement + original.slice(first + find.length)
  return { updated, occurrences }
}

/**
 * What a file holds now, or undefined when there is no file there at all.
 *
 * Only a path that does not exist is a new file (T10-31). A folder, a file this
 * app may not read or anything else that fails is said before anyone is asked
 * to approve a "new" file - approving one used to end in a crash, or in a file
 * that could be written but not read being overwritten unseen.
 */
export async function currentText(target: string, display: string): Promise<string | undefined> {
  try {
    if ((await fs.stat(target)).isDirectory()) throw new ToolError(`${display} is a folder, not a file`)
    return await fs.readFile(target, "utf8")
  } catch (error) {
    if (error instanceof ToolError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      // Windows says ENOENT for a path that runs through a file; that is no place for a new one.
      for (let parent = path.dirname(target); parent !== path.dirname(parent); parent = path.dirname(parent)) {
        const stat = await fs.stat(parent).catch(() => undefined)
        if (!stat) continue
        if (!stat.isDirectory()) throw new ToolError(`${display} could not be read (${path.basename(parent)} is a file, not a folder), so it was not changed.`)
        break
      }
      return undefined
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new ToolError(`Permission denied: ${display} exists but this app is not allowed to read it, so it was not changed.`, "error.readDenied", { path: display })
    }
    throw new ToolError(`${display} could not be read (${code ?? (error as Error).message}), so it was not changed.`)
  }
}

export const WriteTool: ToolDefinition = {
  name: "write",
  description: [
    "Write a file: create it, or replace everything that was in it.",
    "",
    "Before using it",
    "- On a file that already exists, read it first. write replaces the whole file, so anything you did not know was there is gone.",
    "- For a change to part of a file, use edit instead. Rewriting a file wholesale to change three lines loses whatever you had not noticed and makes the change unreadable to the user.",
    "- For a Jupyter notebook (.ipynb), use notebook_edit: writing the JSON by hand loses outputs and cell ids.",
    "",
    "Writing it",
    "- file_path is absolute, or relative to the project root. Missing folders on the way to it are created.",
    "- content is the file as it should end up, in full, with the line endings and final newline the rest of the project uses.",
    "- Build a large file in parts: write a first portion with this tool, then add the rest with edit calls. A single call carrying the whole of a big file can run past the reply's output limit, and then the file is left cut off part way through.",
    "- Write only the files the work needs. Do not add a README, a summary of what you did, a licence header or a test file nobody asked for.",
    "- Follow the project's own conventions - imports, naming, formatting - rather than the ones you would choose on a blank page. Read a file beside it first when you are not sure what they are.",
    "The result is a diff of what changed, and the user sees it; there is no need to repeat the file back in your reply.",
  ].join("\n"),
  permission: "edit",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file, absolute or relative to the project root" },
      content: { type: "string", description: "Full contents to write" },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const target = await resolvePath(context, String(input.file_path), "write")
    const display = relative(context.directory, target)
    // plan: planning writes its plan file and nothing else.
    guardPlanWrite(context, target, display)
    const content = String(input.content)

    return locked(target, async () => {
      const previous = await currentText(target, display)
      const { diff, filediff } = changed(display, unifiedDiff(display, previous ?? "", content))

      // memory: memory files are written without asking, as MiMo does.
      if (!isMemoryPath(target)) await context.permissions.ask({
        sessionID: context.sessionID,
        messageID: context.messageID,
        callID: context.callID,
        // Creating a file is judged as an edit, as MiMo and OpenCode judge it (R16-C6).
        kind: "edit",
        directory: context.directory,
        title: previous === undefined ? "Create file" : "Overwrite file",
        subject: display,
        preview: diff,
      })

      await context.snapshot(target)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, "utf8")

      return {
        output: `${previous === undefined ? "Created" : "Overwrote"} ${display} (${content.split("\n").length} lines)`,
        title: display,
        metadata: { path: display, diff, filediff, created: previous === undefined },
      }
    })
  },
}

export const EditTool: ToolDefinition = {
  name: "edit",
  description: [
    "Replace one exact piece of text in a file with another.",
    "",
    "Before using it",
    "Read the file first, in this conversation. The text you quote has to match the file byte for byte, and a file you have not read is one you are quoting from memory.",
    "",
    "Quoting old_string",
    "- Copy it from the read tool's output with the `N: ` line-number prefix removed. The number and colon are the tool's, not the file's.",
    "- Keep the indentation exactly as it is - tabs where the file has tabs - and do not normalise whitespace or line endings.",
    "- It has to appear exactly once in the file. If it does not, the call fails and nothing is written: take more of the surrounding lines until the quote is unique, rather than guessing.",
    "- Set replace_all to change every occurrence instead. That is the way to rename a symbol through a file; it is the wrong way to change one of several similar-looking lines.",
    "",
    "What it does",
    "- new_string has to differ from old_string, and is written exactly as given - it is not reindented for you.",
    "- An empty old_string writes new_string as the whole file, creating it when it is not there. Use write for that instead unless you are creating a small file in passing.",
    "- One call changes one place in one file; make one call per change.",
    "- The result is a diff, and the user sees it. Do not paste the changed lines back into your reply.",
  ].join("\n"),
  permission: "edit",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file, absolute or relative to the project root" },
      old_string: { type: "string", description: "Exact text to replace, including indentation" },
      new_string: { type: "string", description: "Replacement text, different from old_string" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one" },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const target = await resolvePath(context, String(input.file_path), "write")
    const display = relative(context.directory, target)
    // plan: planning writes its plan file and nothing else.
    guardPlanWrite(context, target, display)
    const oldString = String(input.old_string)
    const newString = String(input.new_string)
    const replaceAll = input.replace_all === true

    if (oldString === newString) throw new ToolError("old_string and new_string are the same, so there is nothing to change")

    return locked(target, async () => {
      // memory: memory files are edited without asking, as MiMo does.
      const ask = async (diff: string) =>
        isMemoryPath(target) ||
        context.permissions.ask({
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.callID,
          kind: "edit",
          directory: context.directory,
          title: "Edit file",
          subject: display,
          preview: diff,
        })

      // MiMo's edit with nothing to find writes the whole file.
      if (oldString === "") {
        const previous = await currentText(target, display)
        const { diff, filediff } = changed(display, unifiedDiff(display, previous ?? "", newString))
        await ask(diff)
        await context.snapshot(target)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, newString, "utf8")
        return {
          output: `${previous === undefined ? "Created" : "Overwrote"} ${display}`,
          title: display,
          metadata: { path: display, diff, filediff, created: previous === undefined },
        }
      }

      const stat = await fs.stat(target).catch(() => undefined)
      if (!stat) throw new ToolError(`File not found: ${display}`)
      if (stat.isDirectory()) throw new ToolError(`${display} is a folder, not a file`)
      const original = await fs.readFile(target, "utf8")

      const { updated, occurrences } = replaceIn(original, { oldString, newString, replaceAll }, endingOf(original), display)
      const { diff, filediff } = changed(display, unifiedDiff(display, original.replaceAll("\r\n", "\n"), updated.replaceAll("\r\n", "\n")))
      await ask(diff)
      await context.snapshot(target)
      await fs.writeFile(target, updated, "utf8")

      return {
        output: `Edited ${display}${replaceAll ? ` (${occurrences} occurrences)` : ""}`,
        title: display,
        metadata: { path: display, diff, filediff, occurrences: replaceAll ? occurrences : 1 },
      }
    })
  },
}
