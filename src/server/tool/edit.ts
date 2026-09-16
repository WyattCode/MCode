import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { unifiedDiff } from "../diff"
import { isMemoryPath } from "../history/service"
import { guardPlanWrite } from "../session/plan"

/** The longest closest-match hint a failed edit carries. */
const HINT_MAX_CHARS = 2000

/** Edits to one file wait for each other, as MiMo's engine holds a lock per file. */
const locks = new Map<string, Promise<unknown>>()

async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
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

/**
 * The text in the file an edit most likely meant, for the error that says it
 * was not found - MiMo points the model at it so the retry quotes the file as
 * it is. Only the hint is loose; the replacement itself stays exact.
 */
export function closestMatch(content: string, find: string): string | undefined {
  for (const matcher of [lineTrimmed, whitespaceNormalized]) {
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
 * One exact replacement, on text rather than on the disk, so edit and
 * multiedit refuse the same things in the same words. Throws what the model
 * should read when the quote is missing or is not unique.
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
    "- Write only the files the work needs. Do not add a README, a summary of what you did, a licence header or a test file nobody asked for.",
    "- Follow the project's own conventions - imports, naming, formatting - rather than the ones you would choose on a blank page. Read a file beside it first when you are not sure what they are.",
    "The result is a diff of what changed, and the user sees it; there is no need to repeat the file back in your reply.",
  ].join("\n"),
  permission: "write",
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
    const target = await resolvePath(context, String(input.file_path))
    const display = relative(context.directory, target)
    // plan: planning writes its plan file and nothing else.
    guardPlanWrite(context, target, display)
    const content = String(input.content)

    return locked(target, async () => {
      const previous = await fs.readFile(target, "utf8").catch(() => undefined)
      const diff = unifiedDiff(display, previous ?? "", content)

      // memory: memory files are written without asking, as MiMo does.
      if (!isMemoryPath(target)) await context.permissions.ask({
        sessionID: context.sessionID,
        messageID: context.messageID,
        callID: context.callID,
        kind: "write",
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
        metadata: { path: display, diff, created: previous === undefined },
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
    "- One call changes one place in one file. For several changes to the same file, use multiedit, which makes them in one call and writes nothing unless every one of them applies.",
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
    const target = await resolvePath(context, String(input.file_path))
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
        const previous = await fs.readFile(target, "utf8").catch(() => undefined)
        const diff = unifiedDiff(display, previous ?? "", newString)
        await ask(diff)
        await context.snapshot(target)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, newString, "utf8")
        return {
          output: `${previous === undefined ? "Created" : "Overwrote"} ${display}`,
          title: display,
          metadata: { path: display, diff, created: previous === undefined },
        }
      }

      const stat = await fs.stat(target).catch(() => undefined)
      if (!stat) throw new ToolError(`File not found: ${display}`)
      if (stat.isDirectory()) throw new ToolError(`${display} is a folder, not a file`)
      const original = await fs.readFile(target, "utf8")

      const { updated, occurrences } = replaceIn(original, { oldString, newString, replaceAll }, endingOf(original), display)
      const diff = unifiedDiff(display, original.replaceAll("\r\n", "\n"), updated.replaceAll("\r\n", "\n"))
      await ask(diff)
      await context.snapshot(target)
      await fs.writeFile(target, updated, "utf8")

      return {
        output: `Edited ${display}${replaceAll ? ` (${occurrences} occurrences)` : ""}`,
        title: display,
        metadata: { path: display, diff, occurrences: replaceAll ? occurrences : 1 },
      }
    })
  },
}

/** What multiedit's `edits` holds, checked before anything is read. */
function readChanges(raw: unknown): Change[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ToolError("edits must be a non-empty array")
  return raw.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>
    if (typeof item.old_string !== "string" || typeof item.new_string !== "string") {
      throw new ToolError(`edits[${index}] needs old_string and new_string, both strings`)
    }
    if (item.old_string === item.new_string) throw new ToolError(`edits[${index}]: old_string and new_string are the same, so there is nothing to change`)
    if (item.old_string === "" && index > 0) throw new ToolError(`edits[${index}]: only the first edit may have an empty old_string, and only to create the file`)
    return { oldString: item.old_string, newString: item.new_string, replaceAll: item.replace_all === true }
  })
}

/**
 * MiMo's multiedit: several exact replacements in one file, in one call.
 *
 * The changes are applied in order to the text in memory, each to what the
 * ones before it left, and the file is written once at the end - or not at
 * all, when any one of them does not apply. That is the whole point of the
 * tool: an edit that fails half way through a batch leaves no half-changed
 * file for the next call to trip over, and the user is asked once, over the
 * whole diff, rather than once per change.
 */
export const MultiEditTool: ToolDefinition = {
  name: "multiedit",
  description: [
    "Make several exact replacements in one file, in a single call.",
    "",
    "Before using it",
    "- Read the file first, in this conversation, as you would for edit. Every old_string has to match byte for byte.",
    "- Use it when one file needs more than one change. For a single change, edit is simpler; for changes to different files, make one call per file.",
    "",
    "How the edits are applied",
    "- In the order given, each to the file as the edits before it left it. Quote what the text will be at that point, not what it was when you read it: if an earlier edit rewrote a line, a later one has to quote the rewritten line.",
    "- All or nothing. If any one old_string is missing, or appears more than once without replace_all, the call fails, says which edit it was, and the file is not touched. Fix that edit and send the whole batch again.",
    "- Each edit follows edit's rules: quote without the read tool's `N: ` line-number prefix, keep the indentation exactly, include enough surrounding lines to be unique, and set replace_all on one edit to change every occurrence of its text.",
    "- new_string has to differ from old_string, and is written exactly as given.",
    "",
    "Creating a file",
    "Give a path that does not exist, an empty old_string and the whole content as new_string in the first edit; later edits in the same call then change that new content. Only the first edit may have an empty old_string.",
    "",
    "Watch for",
    "- Two edits whose quotes overlap. The second will not find its text once the first has changed it; merge them into one edit.",
    "- An order that breaks the file part way through. That is fine - only the result is written - but the result must be complete and correct.",
    "The result is one diff for the whole batch, and the user is asked about it once. Do not paste the changes back into your reply.",
  ].join("\n"),
  permission: "edit",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path of the file, absolute or relative to the project root" },
      edits: {
        type: "array",
        minItems: 1,
        description: "The replacements, applied in this order, each to the text the ones before it left",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to replace, including indentation; empty only in the first edit, to create the file" },
            new_string: { type: "string", description: "Replacement text, different from old_string" },
            replace_all: { type: "boolean", description: "Replace every occurrence of this edit's text instead of requiring exactly one" },
          },
          required: ["old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
    required: ["file_path", "edits"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const target = await resolvePath(context, String(input.file_path))
    const display = relative(context.directory, target)
    // plan: planning writes its plan file and nothing else.
    guardPlanWrite(context, target, display)
    const changes = readChanges(input.edits)

    return locked(target, async () => {
      const stat = await fs.stat(target).catch(() => undefined)
      if (stat?.isDirectory()) throw new ToolError(`${display} is a folder, not a file`)
      const creating = changes[0]!.oldString === ""
      if (!stat && !creating) throw new ToolError(`File not found: ${display}. To create it, give the first edit an empty old_string and the whole content as new_string.`)

      const original = stat ? await fs.readFile(target, "utf8") : ""
      // An empty first quote writes the whole file, as it does for edit; the rest apply to that.
      let text = creating ? changes[0]!.newString : original
      const ending = endingOf(stat ? original : text)
      for (const [index, change] of changes.entries()) {
        if (index === 0 && creating) continue
        try {
          text = replaceIn(text, change, ending, display).updated
        } catch (err) {
          if (!(err instanceof ToolError)) throw err
          throw new ToolError(`Edit ${index + 1} of ${changes.length} did not apply, so nothing was written. ${err.message}`)
        }
      }

      const diff = unifiedDiff(display, original.replaceAll("\r\n", "\n"), text.replaceAll("\r\n", "\n"))
      // memory: memory files are edited without asking, as MiMo does.
      if (!isMemoryPath(target)) {
        await context.permissions.ask({
          sessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.callID,
          kind: "edit",
          directory: context.directory,
          title: stat ? "Edit file" : "Create file",
          subject: display,
          preview: diff,
        })
      }
      await context.snapshot(target)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, text, "utf8")

      return {
        output: `${stat ? "Edited" : "Created"} ${display} with ${changes.length} edit${changes.length === 1 ? "" : "s"}`,
        title: display,
        metadata: { path: display, diff, edits: changes.length, created: !stat },
      }
    })
  },
}
