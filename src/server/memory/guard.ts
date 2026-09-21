import path from "node:path"
import { projectKey } from "../history/extract"
import { MEMORY_SCOPES, memoryFiles } from "./paths"
import { PROJECT_CONFIG_DIR } from "../skill"

/**
 * memory: what may be written under the memory folder, and by whom - MiMo's
 * rules (`memory-path-guard`), in this app's words.
 *
 * - Nothing at all while `memory.disableWrite` is on; what is there can still
 *   be searched and read.
 * - Every file sits at `<scope>/…/<key>.md` with scope global, projects or
 *   sessions; anything else could never be found by the memory search.
 * - `sessions/<id>/tasks/…` is kept for the record of work on a task: only a
 *   subagent started for that task writes there, and only its own folder.
 * - The two consolidation agents (`/dream`, `/distill`) write nowhere but the
 *   memory folder and the project's `.mcode` folder.
 */

/** The agents whose writes are held to the memory folder and the project's own config folder. */
export const MEMORY_SANDBOXED_AGENTS: ReadonlySet<string> = new Set(["dream", "distill"])

const TASK_ID = /^T\d+(\.\d+)*$/

function contains(root: string, target: string): boolean {
  const relative = path.relative(projectKey(root), projectKey(target))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export interface MemoryWrite {
  /** The absolute path being written. */
  target: string
  memoryRoot: string
  /** The conversation's folder, which names its project memory. */
  directory: string
  sessionID: string
  /** False while `memory.disableWrite` is on. */
  writeEnabled: boolean
  /** The task a subagent was started for, if any. */
  taskID?: string
  /** The conversation a subagent works for, whose task folders it may reach. */
  parentID?: string
}

/** Why this memory write is refused, or undefined when it may go ahead. Paths outside the memory folder are not judged here. */
export function memoryWriteRefusal(input: MemoryWrite): string | undefined {
  if (!contains(input.memoryRoot, input.target) || projectKey(input.memoryRoot) === projectKey(input.target)) return undefined
  const files = memoryFiles(input.memoryRoot, input.directory, input.sessionID)
  if (!input.writeEnabled) {
    return [
      `Memory writing is switched off (memory.disableWrite is true in config.json), so nothing may be written under ${input.memoryRoot}.`,
      `Refused: ${input.target}`,
      "Do not try another path in that folder: all of them are refused while the switch is on.",
      "What is already there can still be used: search it with the memory tool, or read the files directly.",
    ].join("\n")
  }
  const parts = path.relative(input.memoryRoot, input.target).split(path.sep)
  const scope = parts[0] as (typeof MEMORY_SCOPES)[number]
  const shaped = MEMORY_SCOPES.includes(scope) && parts.length >= (scope === "global" ? 2 : 3) && /\.md$/i.test(parts[parts.length - 1]!)
  if (!shaped) {
    return [
      `A memory file has to be <memory>/<scope>/<scope id>/<name>.md, with scope global, projects or sessions (global has no scope id). Refused: ${input.target}`,
      "",
      "The files this conversation keeps - use these paths as they are:",
      `  ${files.project}`,
      "    project memory: sections such as ## Rules, ## Architecture decisions, ## Discovered durable knowledge",
      `  ${files.notes}`,
      "    this conversation's notes: add entries headed ## [turn N · YYYY-MM-DDTHH:MM:SSZ]",
      "",
      "Another <name>.md inside one of those scope folders is allowed too.",
    ].join("\n")
  }
  if (scope === "sessions" && parts[2] === "tasks") {
    const owner = parts[1]
    const own = input.taskID && parts[3] === input.taskID && TASK_ID.test(input.taskID) && parts.length >= 5 && (owner === input.parentID || owner === input.sessionID)
    if (own) return undefined
    return [
      `${parts.slice(0, 3).join("/")} holds the record of work on tasks; only a subagent started for a task writes there, in its own tasks/<task id>/ folder. Refused: ${input.target}`,
      "Write here instead:",
      `  ${files.project}`,
      `  ${files.notes}`,
    ].join("\n")
  }
  return undefined
}

/** Why a consolidation agent may not write this path, or undefined when it may. */
export function sandboxRefusal(input: { agent: string; target: string; memoryRoot: string; projectRoot: string }): string | undefined {
  if (!MEMORY_SANDBOXED_AGENTS.has(input.agent)) return undefined
  const config = path.join(input.projectRoot, PROJECT_CONFIG_DIR)
  if (contains(input.memoryRoot, input.target) || contains(config, input.target)) return undefined
  return [
    `The /${input.agent} pass writes only under the memory folder and the project's ${PROJECT_CONFIG_DIR} folder.`,
    `  memory: ${input.memoryRoot}`,
    `  project config: ${config}`,
    `Refused: ${input.target}`,
  ].join("\n")
}
