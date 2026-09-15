import { createHash } from "node:crypto"
import path from "node:path"
import { projectKey } from "../history/extract"

/**
 * memory: where memory markdown lives, as MiMo lays it out -
 * `<data>/memory/<scope>/<scope id>/<key>.md`, with scope `global` (no id),
 * `projects` (one folder per project) or `sessions` (one per conversation).
 *
 * MiMo names a project by its own project id; this app names it by a short
 * hash of the project folder, so the same folder always finds the same file.
 */

export const MEMORY_SCOPES = ["global", "projects", "sessions"] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/** A project's folder name under `projects/`. */
export function projectMemoryID(directory: string): string {
  return createHash("sha1").update(projectKey(directory)).digest("hex").slice(0, 16)
}

/** The three files a conversation is told about: its project's memory, the global memory and its own notes. */
export function memoryFiles(root: string, directory: string, sessionID: string) {
  return {
    project: path.join(root, "projects", projectMemoryID(directory), "MEMORY.md"),
    global: path.join(root, "global", "MEMORY.md"),
    notes: path.join(root, "sessions", sessionID, "notes.md"),
  }
}

/** MiMo's types, read off the key: MEMORY / MEMORY-<topic>, checkpoint, task progress and notes; anything else is free. */
export function memoryType(key: string): string {
  if (/^memory$/i.test(key) || /^memory-/i.test(key)) return "memory"
  if (/^checkpoint$/.test(key) || /^checkpoint-/.test(key)) return "checkpoint"
  if (/^tasks\/[^/]+\/progress$/.test(key)) return "progress"
  if (/^tasks\/[^/]+\/notes$/.test(key)) return "notes"
  return "free"
}

export interface MemoryLocation {
  scope: MemoryScope
  scope_id: string
  type: string
  key: string
}

/** Where a markdown file sits in the layout, or nothing when it is outside it. */
export function memoryLocation(root: string, file: string): MemoryLocation | undefined {
  const relative = path.relative(root, file)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !relative.toLowerCase().endsWith(".md")) return undefined
  const parts = relative.split(path.sep)
  const scope = parts[0] as MemoryScope
  if (!MEMORY_SCOPES.includes(scope)) return undefined
  const idParts = scope === "global" ? 0 : 1
  const rest = parts.slice(1 + idParts)
  if (!rest.length) return undefined
  const key = rest.join("/").slice(0, -".md".length)
  return { scope, scope_id: idParts ? (parts[1] ?? "") : "", type: memoryType(key), key }
}

/** Whether a path is inside the memory folder, compared the way the file system compares names. */
export function insideMemory(root: string, target: string): boolean {
  const relative = path.relative(projectKey(root), projectKey(target))
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}
