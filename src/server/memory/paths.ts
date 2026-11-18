import { createHash } from "node:crypto"
import path from "node:path"
import { projectKey } from "../history/extract"
import { projectMemoryID } from "./project-id"

/**
 * memory: where memory markdown lives, as MiMo lays it out -
 * `<data>/memory/<scope>/<scope id>/<key>.md`, with scope `global` (no id),
 * `projects` (one folder per project) or `sessions` (one per conversation).
 *
 * A project is named as MiMo names it: one id per repository, shared by its
 * subdirectories and worktrees, and `global` for every folder outside one
 * (memory/project-id.ts).
 */

export const MEMORY_SCOPES = ["global", "projects", "sessions"] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * The folder name the layout before round ten gave a project: a short hash of
 * the conversation's folder, one per folder. Read only to move that memory
 * under its repository's id (memory/migrate.ts).
 */
export function folderMemoryID(directory: string): string {
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

const pending = new Map<string, Promise<unknown>>()

/** Orders reset, indexing and layout migration for the same memory directory. */
export function withMemoryLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(root) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  pending.set(root, next)
  const release = () => {
    if (pending.get(root) === next) pending.delete(root)
  }
  void next.then(release, release)
  return next
}
