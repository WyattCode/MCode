import fs from "node:fs/promises"
import path from "node:path"
import type { Message, ToolPart, TurnRevertResult } from "@shared/protocol"
import { createsFile, parseUnifiedDiff, reverseSection, type DiffSection } from "@shared/unified-diff"

/** The tools whose calls change files and record the diff of what they did. */
const EDITING = new Set(["edit", "write", "patch"])

interface FileHistory {
  /** Where the file is on disk. */
  target: string
  /** The turn brought the file into being, so taking the turn back removes it. */
  created: boolean
  /** Its changes in the order the turn made them. */
  sections: DiffSection[]
}

/**
 * Takes one turn's file changes back out of the project, as MiMo's 撤销 on the
 * "edited N files" card does.
 *
 * Only what that turn did is undone. A file the turn edited has those hunks
 * reversed where they still stand, so the rounds before it and any change made
 * since elsewhere in the file are kept; a file the turn created is deleted. A
 * file whose changed lines are no longer there is left exactly as it is and
 * counted as failed, and a path outside the project is never touched.
 */
export async function revertTurnFiles(directory: string, messages: Message[]): Promise<TurnRevertResult> {
  const files = new Map<string, FileHistory>()
  let outside = 0
  const root = path.resolve(directory)

  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool" || !EDITING.has(part.name)) continue
      const tool = part as ToolPart
      if (tool.status !== "completed") continue
      const diff = tool.metadata?.diff
      if (typeof diff !== "string" || !diff) continue
      for (const section of parseUnifiedDiff(diff)) {
        if (!section.file) continue
        const target = path.resolve(root, section.file)
        const relative = path.relative(root, target)
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          outside++
          continue
        }
        const known = files.get(target)
        if (known) {
          known.sections.push(section)
          continue
        }
        const created = tool.name === "write" ? tool.metadata?.created === true : tool.name === "patch" && createsFile(section)
        files.set(target, { target, created, sections: [section] })
      }
    }
  }

  const result: TurnRevertResult = { restored: 0, removed: 0, failed: 0, outside }
  for (const file of files.values()) {
    try {
      if (file.created) {
        await fs.rm(file.target, { force: true })
        result.removed++
        continue
      }
      const current = await fs.readFile(file.target, "utf8").catch(() => "")
      let next: string | undefined = current
      for (const section of [...file.sections].reverse()) {
        next = reverseSection(next, section)
        if (next === undefined) break
      }
      if (next === undefined) {
        result.failed++
        continue
      }
      await fs.mkdir(path.dirname(file.target), { recursive: true })
      await fs.writeFile(file.target, next, "utf8")
      result.restored++
    } catch {
      result.failed++
    }
  }
  return result
}
