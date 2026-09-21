import type { AssistantPart, ToolPart } from "@shared/protocol"
import { createdFile, parseUnifiedDiff } from "@shared/unified-diff"

/*
 * What a run of tool calls did to the project's files, file by file.
 *
 * Read from the diffs the edit, write and notebook tools record, so it describes
 * the conversation's own changes and nothing else that happened to the tree.
 * The files-changed pill counts it over the whole conversation; the card at
 * the end of a turn counts it over that turn.
 */

export interface EditedFile {
  path: string
  add: number
  del: number
  /** The first change to it brought the file into being. */
  created: boolean
}

export interface EditedFiles {
  files: EditedFile[]
  add: number
  del: number
}

const EDITING = new Set(["edit", "write", "notebook_edit"])

function isAbsolute(file: string) {
  return file.startsWith("/") || file.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(file)
}

/* A path the model reached outside the project is not a change to it. */
export function inProject(file: string, directory?: string): boolean {
  if (file === ".." || file.startsWith("../") || file.startsWith("..\\")) return false
  if (!isAbsolute(file) || !directory) return true
  const root = directory.replace(/[\\/]+$/, "")
  const windows = root.includes("\\") || /^[a-zA-Z]:/.test(root)
  if (!windows) return file.startsWith(`${root}/`)
  const lower = file.toLowerCase()
  return lower.startsWith(`${root.toLowerCase()}\\`) || lower.startsWith(`${root.toLowerCase()}/`)
}

/**
 * `outside` keeps the files the run reached beyond the project. The card sets
 * it, because the undo behind its 撤销 works on those too and counts what it
 * could not put back as 项目外 - a number about rows the card had never shown.
 * The pill leaves it off: it counts what changed in the project.
 */
export function editedFiles(parts: readonly AssistantPart[], directory?: string, options: { outside?: boolean } = {}): EditedFiles {
  const byPath = new Map<string, EditedFile>()
  for (const part of parts) {
    if (part.type !== "tool" || !EDITING.has(part.name)) continue
    const tool = part as ToolPart
    if (tool.status === "error") continue
    const diff = tool.metadata?.diff
    if (typeof diff !== "string" || !diff) continue
    for (const section of parseUnifiedDiff(diff)) {
      if (!section.file.trim()) continue
      if (!options.outside && !inProject(section.file, directory)) continue
      let entry = byPath.get(section.file)
      if (!entry) {
        // An edit with nothing to find creates the file as write does, and says so the same way.
        const created = createdFile(tool.metadata?.created, section)
        entry = { path: section.file, add: 0, del: 0, created }
        byPath.set(section.file, entry)
      }
      for (const hunk of section.hunks) {
        entry.add += hunk.added
        entry.del += hunk.removed
      }
    }
  }
  const files = [...byPath.values()]
  return {
    files,
    add: files.reduce((sum, file) => sum + file.add, 0),
    del: files.reduce((sum, file) => sum + file.del, 0),
  }
}

/** The diffs the run's own edit, write and notebook calls recorded, joined: what the card reviews when git has nothing to show. */
export function recordedPatch(parts: readonly AssistantPart[]): string {
  const diffs: string[] = []
  for (const part of parts) {
    if (part.type !== "tool" || !EDITING.has(part.name) || part.status === "error") continue
    const diff = (part as ToolPart).metadata?.diff
    if (typeof diff === "string" && diff) diffs.push(diff)
  }
  return diffs.join("\n")
}
