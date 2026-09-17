import fs from "node:fs/promises"
import path from "node:path"
import type { Bus } from "../bus"
import type { Storage } from "../storage"
import type { SessionStore } from "../session/store"
import { IndexDatabase } from "./database"
import { HistoryIndex } from "./index"
import { MemoryIndex } from "../memory/index"
import { insideMemory, memoryFiles } from "../memory/paths"

/**
 * history: the index the backend keeps, reached by the tools.
 *
 * Bound once when the backend starts, the way the desktop settings tools are,
 * so a tool stays a function of its arguments and context. A runner made
 * without a backend - as the checks make them - has none, and the tools say so.
 */

export interface HistoryService {
  database: IndexDatabase
  index: HistoryIndex
  memory: MemoryIndex
  store: SessionStore
  storage: Storage
  /** Where memory markdown lives: `<data>/memory`. */
  memoryRoot: string
}

let bound: HistoryService | undefined

export function bindHistory(service: HistoryService | undefined): void {
  bound = service
}

/** memory: whether memory may be written - config's `memory.disableWrite` turned round, read at each write. */
let writable: () => boolean = () => true

export function bindMemoryWrites(read: () => boolean): void {
  writable = read
}

export function memoryWritable(): boolean {
  return writable()
}

export function historyService(): HistoryService | undefined {
  return bound
}

/** memory: the files a top-level conversation is told about, when the backend keeps memory at all. */
export function memoryFilesFor(directory: string, sessionID: string): (ReturnType<typeof memoryFiles> & { root: string; readOnly: boolean }) | undefined {
  return bound ? { ...memoryFiles(bound.memoryRoot, directory, sessionID), root: bound.memoryRoot, readOnly: !writable() } : undefined
}

/**
 * memory: the note MiMo adds to a turn whose conversation already has memory
 * of its own - notes in its folder, or tasks in its registry - naming where it
 * is and how to find what is not in view. Undefined when there is nothing to
 * recall. Request only.
 */
export async function recallNote(sessionID: string, hasTasks: boolean, hasActor: boolean): Promise<string | undefined> {
  if (!bound) return undefined
  const folder = path.join(bound.memoryRoot, "sessions", sessionID)
  const kept = await fs.readdir(folder).then(
    (entries) => entries.length > 0,
    () => false,
  )
  if (!kept && !hasTasks) return undefined
  return [
    "<system-reminder>",
    `This conversation keeps memory in ${folder}${path.sep}. What has dropped out of view can be found again:`,
    "- the memory tool searches it (with the project's and the global memory);",
    `- read opens a file there directly;`,
    "- the task tool's list shows the task registry;",
    ...(hasActor ? ["- the actor tool's status shows what subagents are doing;"] : []),
    "",
    "Look there before asking the user something the memory may already hold.",
    "</system-reminder>",
  ].join("\n")
}

/** memory: whether a path is a memory file, which MiMo reads and writes without asking. */
export function isMemoryPath(target: string): boolean {
  return bound ? insideMemory(bound.memoryRoot, target) : false
}

/** The index file inside the app's data folder. */
export function indexFile(dataDirectory: string): string {
  return path.join(dataDirectory, "index", "search.db")
}

/**
 * Opens the index and starts filling it. Never throws: without SQLite the app
 * still runs, and only history and memory search are missing.
 */
export function startHistory(dataDirectory: string, store: SessionStore, storage: Storage, bus: Bus): HistoryService | undefined {
  try {
    const database = IndexDatabase.open(indexFile(dataDirectory))
    const index = new HistoryIndex(database, store, storage, bus)
    void index.start()
    const memoryRoot = path.join(dataDirectory, "memory")
    const service = { database, index, memory: new MemoryIndex(database, memoryRoot), store, storage, memoryRoot }
    bindHistory(service)
    return service
  } catch {
    return undefined
  }
}

export function stopHistory(service: HistoryService | undefined): void {
  if (!service) return
  service.index.close()
  service.database.close()
  if (bound === service) bindHistory(undefined)
}
