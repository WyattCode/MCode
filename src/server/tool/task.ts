import { TASK_STATUSES, type TaskItem, type TaskStatus } from "@shared/protocol"
import { operationInput } from "@shared/subagent"
import type { ToolDefinition, ToolResult } from "./types"
import { ToolError } from "./types"

/**
 * The task registry: MiMo's work-item tool, under its name and in this app's
 * own words. Tasks belong to the conversation - a subagent works on its
 * parent's - and are kept on its record, so the info card's 任务清单 draws them
 * and they outlast a restart. Ids are T1, T2 at the top and T1.1, T1.2 under a
 * task. Nothing is asked first: MiMo's task tool never asks.
 */

/** A task id as the tool hands them out. */
export const TASK_ID = /^T\d+(\.\d+)*$/

/** Finished tasks drop out of lists this long after they end, as MiMo archives them. */
export const TASK_ARCHIVE_MS = 7 * 24 * 60 * 60 * 1000

export const TASK_ACTIONS = ["create", "list", "get", "start", "block", "unblock", "done", "abandon", "rename"] as const
export type TaskAction = (typeof TASK_ACTIONS)[number]

const TERMINAL = new Set<TaskStatus>(["done", "abandoned"])

/** The next free id at a level: one past the highest number already used there. */
export function nextTaskID(parentID: string | undefined, ids: readonly string[]): string {
  const prefix = parentID ? `${parentID}.` : "T"
  const used = ids
    .filter((id) => (parentID ? id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)) : /^T\d+$/.test(id)))
    .map((id) => Number(id.slice(prefix.length)))
  return `${prefix}${used.length ? Math.max(...used) + 1 : 1}`
}

export function isArchived(task: TaskItem, now: number): boolean {
  return task.ended !== undefined && TERMINAL.has(task.status) && now - task.ended >= TASK_ARCHIVE_MS
}

/** A list as `list` reads it: open, in progress and blocked unless asked for more, and never the archived. */
export function listedTasks(
  tasks: readonly TaskItem[],
  options: { status?: TaskStatus; includeTerminal?: boolean; includeArchived?: boolean },
  now: number,
): TaskItem[] {
  return tasks.filter((task) => {
    if (options.status && task.status !== options.status) return false
    if (!options.includeTerminal && TERMINAL.has(task.status)) return false
    if (!options.includeArchived && isArchived(task, now)) return false
    return true
  })
}

/** What one call does to the list, and what it says back. Pure, so the lifecycle can be checked on its own. */
export function applyTask(
  tasks: readonly TaskItem[],
  input: Record<string, unknown>,
  context: { owner: string; subagent: boolean; now: number },
): { tasks: TaskItem[]; result: ToolResult } {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  const action = TASK_ACTIONS.find((entry) => entry === input.action)
  if (!action) throw new ToolError(`Unknown action "${String(input.action)}". Use one of: ${TASK_ACTIONS.join(", ")}.`)
  const { now } = context
  const list = [...tasks]

  if (action === "create") {
    const summary = text(input.summary)
    if (!summary) throw new ToolError("create needs a summary.")
    const parentID = text(input.parent_id) || undefined
    const id = nextTaskID(parentID, list.map((task) => task.id))
    const task: TaskItem = { id, summary, status: "open", ...(parentID ? { parentID } : {}), owner: context.owner, created: now, updated: now }
    list.push(task)
    return { tasks: list, result: { output: `Created ${id} (open): ${summary}`, title: id, metadata: { id, status: "open" } } }
  }

  if (action === "list") {
    const status = TASK_STATUSES.find((entry) => entry === input.status)
    const shown = listedTasks(list, { status, includeTerminal: input.include_terminal === true, includeArchived: input.include_archived === true }, now)
    return {
      tasks: list,
      result: {
        output: shown.length ? shown.map((task) => `${task.id} ${task.status} - ${task.summary}`).join("\n") : "No tasks.",
        title: `${shown.length}`,
        metadata: { count: shown.length, ids: shown.map((task) => task.id) },
      },
    }
  }

  const id = text(input.id)
  const at = list.findIndex((task) => task.id === id)
  if (action === "get") {
    if (at < 0) return { tasks: list, result: { output: `There is no task ${id}. The list action shows the ids there are.`, title: id, metadata: {} } }
    return { tasks: list, result: { output: JSON.stringify(list[at], null, 2), title: id, metadata: { id, status: list[at]!.status } } }
  }
  if (at < 0) throw new ToolError(`There is no task ${id || "(no id given)"}. The list action shows the ids there are, and create adds one.`)
  const current = list[at]!
  const note = text(input.event_summary) || undefined
  const put = (next: TaskItem, said: string) => {
    list[at] = next
    return { tasks: list, result: { output: said, title: id, metadata: { id, status: next.status } } }
  }

  if (action === "rename") {
    const summary = text(input.summary)
    if (!summary) throw new ToolError("rename needs the new summary.")
    return put({ ...current, summary, updated: now }, `${id} renamed: ${summary}`)
  }
  if (action === "start") {
    // A finished task is not reopened, and starting one already under way changes nothing.
    if (TERMINAL.has(current.status)) return { tasks: list, result: { output: `${id} is ${current.status} and was left as it is.`, title: id, metadata: { id, status: current.status } } }
    // A subagent starting a task someone else holds leaves it with its holder.
    const owner = context.subagent && current.owner && current.owner !== context.owner ? current.owner : context.owner
    if (current.status === "in_progress" && owner === current.owner) return { tasks: list, result: { output: `${id} is already in progress.`, title: id, metadata: { id, status: current.status } } }
    return put({ ...current, status: "in_progress", owner, updated: now, ...(note ? { note } : {}) }, `${id} started (in progress)`)
  }
  if (action === "block") return put({ ...current, status: "blocked", updated: now, ...(note ? { note } : {}) }, `${id} blocked`)
  if (action === "unblock") return put({ ...current, status: "open", updated: now, ...(note ? { note } : {}) }, `${id} unblocked (open)`)
  const status: TaskStatus = action === "done" ? "done" : "abandoned"
  return put({ ...current, status, updated: now, ended: now, ...(note ? { note } : {}) }, `${id} ${status}`)
}

export const TaskTool: ToolDefinition = {
  name: "task",
  description: [
    "Keep track of the work: tasks with ids (T1, T2, and T1.1, T1.2 under a task) that stay with this conversation and are shown to the user in its task list.",
    "Pass the action and its fields inside an operation object.",
    "",
    "- create: add a task. Needs summary; parent_id puts it under another task.",
    "- list: the open, in-progress and blocked tasks. status filters by one status; include_terminal adds done and abandoned ones; include_archived adds those finished over a week ago.",
    "- get: one task in full. Needs id.",
    "- start: mark a task in progress as you begin it. Needs id.",
    "- block: mark a task blocked, with event_summary saying on what. Needs id.",
    "- unblock: put a blocked task back to open. Needs id.",
    "- done: mark a task finished, as soon as it is. Needs id; event_summary can say what was done.",
    "- abandon: drop a task that will not be finished. Needs id; event_summary can say why.",
    "- rename: change a task's summary. Needs id and summary.",
    "",
    "Use it for work of three or more steps, work that spans turns, or work a subagent does (pass the task's id to the actor tool as task_id). Skip it for a single quick action.",
    "Start a task before working on it and mark it done straight after. Only mark it done when it is wholly done: if tests fail or something is left, keep it in progress or block it. Keep one task in progress at a time when working alone.",
    "The user sees the list already, so do not repeat it in your reply; say what you are working on or what changed.",
    'Examples: {"operation":{"action":"create","summary":"Fix the login redirect"}} {"operation":{"action":"done","id":"T1","event_summary":"redirect fixed"}}',
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "object",
        description: "What to do, and its fields",
        properties: {
          action: { type: "string", enum: [...TASK_ACTIONS], description: "What to do" },
          summary: { type: "string", description: "create, rename: what the task is, in a short line" },
          parent_id: { type: "string", description: "create: the task this one goes under, such as T1" },
          id: { type: "string", description: "get, start, block, unblock, done, abandon, rename: the task's id, such as T1 or T1.1" },
          event_summary: { type: "string", description: "start, block, unblock, done, abandon: a short note on why or what" },
          status: { type: "string", enum: [...TASK_STATUSES], description: "list: only tasks with this status" },
          include_terminal: { type: "boolean", description: "list: also done and abandoned tasks" },
          include_archived: { type: "boolean", description: "list: also tasks finished over a week ago" },
        },
        required: ["action"],
      },
    },
  },
  async execute(input, context) {
    const tasks = context.tasks
    if (!tasks) throw new ToolError("Tasks are not available here.")
    // MiMo's shape, or the same fields written flat, as MiMo also takes them.
    const flat = operationInput(input)
    return tasks.update((list, who) => {
      const applied = applyTask(list, flat, { ...who, now: Date.now() })
      return { list: applied.tasks, result: applied.result }
    })
  },
}
