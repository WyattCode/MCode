import fs from "node:fs/promises"
import path from "node:path"
import { writeAtomic } from "../storage"
import { parseCron } from "./expr"

/**
 * cron: a scheduled prompt, and the project file durable ones are kept in -
 * `<project>/.mcode/scheduled_tasks.json`, `{ "tasks": [...] }`, as MiMo keeps
 * them in its own dot folder. A task that does not read as one is dropped on
 * the way in and on the way out rather than failing the whole file.
 */

export interface CronTask {
  id: string
  cron: string
  prompt: string
  createdAt: number
  lastFiredAt?: number
  /** Fires on every match; otherwise once, then it is removed. */
  recurring?: boolean
  /** A recurring task that never ages out. */
  permanent?: boolean
  kind?: "loop"
  /**
   * The conversation it runs in: the one that made it, and after that one is
   * gone whichever conversation adopted it - the scheduler rewrites this rather
   * than adding a field, so a file written before durable tasks outlived their
   * conversation still reads exactly as it did.
   */
  createdBySessionId?: string
  /** Kept in the project file, so it lasts past a restart. */
  durable?: boolean
}

export function cronFile(directory: string): string {
  return path.join(directory, ".mcode", "scheduled_tasks.json")
}

export function isCronTask(value: unknown): value is CronTask {
  if (!value || typeof value !== "object") return false
  const task = value as Record<string, unknown>
  return typeof task.id === "string" && typeof task.cron === "string" && typeof task.prompt === "string" && typeof task.createdAt === "number" && parseCron(task.cron) !== undefined
}

export async function readCronTasks(directory: string): Promise<CronTask[]> {
  const raw = await fs.readFile(cronFile(directory), "utf8").catch(() => undefined)
  if (raw === undefined) return []
  try {
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { tasks?: unknown }
    return Array.isArray(parsed.tasks) ? parsed.tasks.filter(isCronTask) : []
  } catch {
    return []
  }
}

export async function writeCronTasks(directory: string, tasks: CronTask[]): Promise<void> {
  const kept = tasks.filter(isCronTask).map(({ durable: _durable, ...task }) => task)
  await writeAtomic(cronFile(directory), JSON.stringify({ tasks: kept }, null, 2))
}

/**
 * One-shot tasks whose time came while nothing was running to fire them. MiMo
 * fires these once, as soon as its scheduler starts, and removes them.
 */
export function missedTasks(tasks: CronTask[], now: number, next: (task: CronTask) => number | undefined): CronTask[] {
  return tasks.filter((task) => {
    if (task.recurring || task.createdAt > now) return false
    const due = next(task)
    return due !== undefined && due <= now
  })
}
