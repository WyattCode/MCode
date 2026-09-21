import fs from "node:fs/promises"
import path from "node:path"
import { quarantine, writeAtomic } from "../storage"
import { parseCron } from "./expr"

/**
 * cron: a scheduled prompt, and the project file durable ones are kept in -
 * `<project>/.mcode/scheduled_tasks.json`, `{ "tasks": [...] }`, as MiMo keeps
 * them in its own dot folder. A task that does not read as one is dropped on
 * the way in and on the way out rather than failing the whole file; one whose
 * schedule this build cannot read is kept, and never comes due.
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
  return typeof task.id === "string" && typeof task.cron === "string" && typeof task.prompt === "string" && typeof task.createdAt === "number"
}

/**
 * Whether this build can schedule a task.
 *
 * A task whose schedule it cannot read is still the user's (L12-8): a newer
 * build that accepts more cron syntax wrote it, or it was typed by hand. It is
 * kept in the file and listed, and simply never comes due here.
 */
export function schedulable(task: CronTask): boolean {
  return parseCron(task.cron) !== undefined
}

/**
 * A project's durable tasks, and whether its file may be written.
 *
 * A file that will not parse is a blocked read, not an empty one (L12-8): the
 * next schedule, fire or rename used to write `{tasks: []}` over it, and every
 * durable task of the project was gone. It is moved aside as
 * `scheduled_tasks.json.corrupt-<time>` and the project starts with no tasks;
 * if it cannot be moved, `blocked` says why and nothing is written over it.
 */
export async function readCronFile(directory: string): Promise<{ tasks: CronTask[]; blocked?: string }> {
  const file = cronFile(directory)
  const raw = await fs.readFile(file, "utf8").catch(() => undefined)
  if (raw === undefined) return { tasks: [] }
  try {
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { tasks?: unknown }
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isCronTask) : [] }
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause)
    const aside = await quarantine(file)
    if (aside) {
      console.warn(`[cron] ${file} could not be read (${why}); it was kept as ${aside}`)
      return { tasks: [] }
    }
    return {
      tasks: [],
      blocked: `The scheduled tasks in ${file} could not be read (${why}) and the file could not be moved aside, so nothing is saved over it. Repair or move that file first.`,
    }
  }
}

export async function readCronTasks(directory: string): Promise<CronTask[]> {
  return (await readCronFile(directory)).tasks
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
