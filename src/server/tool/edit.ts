import fs from "node:fs/promises"
import path from "node:path"
import type { ToolDefinition } from "./types"
import { ToolError } from "./types"
import { relative, resolvePath } from "./fs-util"
import { unifiedDiff } from "../diff"
import { isMemoryPath } from "../history/service"

export const WriteTool: ToolDefinition = {
  name: "write",
  description:
    "Write a complete file, creating it or replacing its contents. Prefer the edit tool for changes to an existing file - write replaces everything and is easy to get wrong on a file you have not read.",
  permission: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the project root" },
      content: { type: "string", description: "Full contents to write" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const target = await resolvePath(context, String(input.path))
    const display = relative(context.directory, target)
    const content = String(input.content)

    const previous = await fs.readFile(target, "utf8").catch(() => undefined)
    const diff = unifiedDiff(display, previous ?? "", content)

    // memory: memory files are written without asking, as MiMo does.
    if (!isMemoryPath(target)) await context.permissions.ask({
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "write",
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
  },
}

export const EditTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace an exact string in a file. The old string must appear exactly once unless replaceAll is set - include enough surrounding context to make it unique. Read the file first so you quote it exactly.",
  permission: "edit",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the project root" },
      oldString: { type: "string", description: "Exact text to replace, including indentation" },
      newString: { type: "string", description: "Replacement text" },
      replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one" },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const target = await resolvePath(context, String(input.path))
    const display = relative(context.directory, target)
    const oldString = String(input.oldString)
    const newString = String(input.newString)
    const replaceAll = Boolean(input.replaceAll)

    if (oldString === newString) throw new ToolError("oldString and newString are identical - nothing to change")

    const original = await fs.readFile(target, "utf8").catch(() => {
      throw new ToolError(`File not found: ${display}`)
    })

    const occurrences = original.split(oldString).length - 1
    if (occurrences === 0) {
      throw new ToolError(
        `oldString was not found in ${display}. Read the file again - it may have changed, or the indentation may differ.`,
      )
    }
    if (occurrences > 1 && !replaceAll) {
      throw new ToolError(
        `oldString appears ${occurrences} times in ${display}. Add surrounding context to make it unique, or pass replaceAll.`,
      )
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, () => newString)
    const diff = unifiedDiff(display, original, updated)

    if (!isMemoryPath(target)) await context.permissions.ask({
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      kind: "edit",
      title: "Edit file",
      subject: display,
      preview: diff,
    })

    await context.snapshot(target)
    await fs.writeFile(target, updated, "utf8")

    return {
      output: `Edited ${display}${replaceAll ? ` (${occurrences} occurrences)` : ""}`,
      title: display,
      metadata: { path: display, diff, occurrences: replaceAll ? occurrences : 1 },
    }
  },
}
