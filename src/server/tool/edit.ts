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

export const WriteTool: ToolDefinition = {
  name: "write",
  description:
    "Write a complete file, creating it or replacing its contents. Prefer the edit tool for changes to an existing file - write replaces everything and is easy to get wrong on a file you have not read.",
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
  description:
    "Replace exact text in a file. old_string has to appear exactly once unless replace_all is set - include enough surrounding lines to make it unique, and quote it as the read tool showed it, without the `N: ` line prefix. An empty old_string writes new_string as the whole file, creating it if needed.",
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

      // The file's own line endings win: text quoted with \n still lands as \r\n in a CRLF file.
      const ending = original.includes("\r\n") ? "\r\n" : "\n"
      const inFileEndings = (text: string) => {
        const plain = text.replaceAll("\r\n", "\n")
        return ending === "\n" ? plain : plain.replaceAll("\n", "\r\n")
      }
      const find = inFileEndings(oldString)
      const replacement = inFileEndings(newString)

      const first = original.indexOf(find)
      if (first === -1) {
        const hint = closestMatch(original, oldString)
        const shown = hint && hint.length > HINT_MAX_CHARS ? `${hint.slice(0, HINT_MAX_CHARS)}\n… (cut)` : hint
        throw new ToolError(
          `old_string was not found in ${display}. It has to match the file exactly, including whitespace, indentation and line endings.` +
            (shown ? `\n\nThe closest text in the file - note its exact whitespace, and send it again as old_string:\n${shown}` : ""),
        )
      }
      const occurrences = original.split(find).length - 1
      if (occurrences > 1 && !replaceAll) {
        throw new ToolError(
          `old_string appears ${occurrences} times in ${display}, and replace_all is not set. Set replace_all to change every one, or include surrounding lines so it matches only once.`,
        )
      }

      const updated = replaceAll ? original.split(find).join(replacement) : original.slice(0, first) + replacement + original.slice(first + find.length)
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
