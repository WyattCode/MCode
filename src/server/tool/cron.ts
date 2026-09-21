import { cronScheduler, type CronScheduler } from "../cron/scheduler"
import { nextCronRun, parseCron, LOOP_MAX_SECONDS, LOOP_MIN_SECONDS } from "../cron/expr"
import type { ToolContext, ToolDefinition } from "./types"
import { ToolError } from "./types"
import { insideReal, repositoryRoot } from "./fs-util"

/**
 * cron: MiMo's scheduled prompts - schedule a prompt on a cron expression,
 * arm a self-paced loop, and list, look at, cancel or reword what is
 * scheduled - in this app's own words. The scheduler lives in the backend
 * (`cron/scheduler.ts`); this only reads arguments and words the results.
 */

export const CRON_ACTIONS = ["schedule", "loop", "list", "get", "delete", "cancel", "rename"] as const
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, at) => at)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = kept
    }
  }
  return row[b.length]!
}

/**
 * The operation, however it arrived: nested as asked, as a JSON string, or
 * flat with a cron and a prompt - the shapes MiMo also accepts.
 */
export function cronOperation(input: Record<string, unknown>): Record<string, unknown> | undefined {
  let operation = input.operation
  if (typeof operation === "string") {
    try {
      operation = JSON.parse(operation)
    } catch {
      operation = undefined
    }
  }
  if (operation && typeof operation === "object" && !Array.isArray(operation)) return operation as Record<string, unknown>
  if (typeof input.cron === "string" && typeof input.prompt === "string") return { action: "schedule", ...input }
  return undefined
}

/** The conversation a call acts for: the one named, or the caller - or, for a subagent, the conversation it works for. */
async function ownerOf(scheduler: CronScheduler, context: ToolContext, named: string | undefined) {
  const caller = await scheduler.session(context.sessionID)
  if (caller?.subagent?.type === "explore") throw new ToolError("An explore subagent cannot schedule prompts.")
  const id = named ?? caller?.parentID ?? context.sessionID
  const owner = await scheduler.session(id)
  if (!owner) throw new ToolError(`There is no session ${id}.`)
  /*
   * session_id names a conversation, and `contacts` hands out the id and the
   * working directory of every conversation in the app - including those of
   * other projects. The owner's directory is what a job is scoped to and where
   * a durable one is written, and none of that goes through `resolvePath`: a
   * call naming a conversation next door created `<that project>/.mcode/`,
   * wrote its task file and installed a prompt that would later start a turn
   * there, without the write or the outside question being asked once. A job
   * belongs to the project the call is made in, as the tool's own description
   * says ("Schedule prompts to run later in this project").
   */
  if (!(await insideProject(context, owner.directory))) {
    throw new ToolError(`Session ${id} works in another project (${owner.directory}), and a job belongs to the project it is scheduled from.`)
  }
  return owner
}

/** Whether a conversation's project is this call's own, by the test `resolvePath` makes for a path. */
async function insideProject(context: ToolContext, directory: string): Promise<boolean> {
  if (!directory) return false
  if (await insideReal(context.directory, directory)) return true
  const repository = await repositoryRoot(context.directory)
  return repository ? insideReal(repository, directory) : false
}

export const CronTool: ToolDefinition = {
  name: "cron",
  description: [
    "Schedule prompts to run later in this project, once or repeatedly. A scheduled prompt starts a turn when its time comes and the conversation it runs in is idle; it waits while a turn is running. Nothing runs while the app is closed.",
    "A durable job belongs to the project rather than to this conversation: deleting this conversation leaves it scheduled, and it is then carried on in a new conversation in the same project.",
    "Always pass the action inside an operation object.",
    "- schedule: cron (five fields - minute hour day-of-month month day-of-week, in UTC) and prompt. Repeats unless one_shot is true. durable: true keeps it in the project across restarts; only use it when the user asks for the job to last. Avoid :00 and :30 unless the user named that time, e.g. \"57 8 * * *\" for about 9am.",
    `- loop: prompt and delay_seconds (clamped to ${LOOP_MIN_SECONDS}-${LOOP_MAX_SECONDS}) for one more run of a self-paced loop. Call it again on each run to keep going; stop calling it to let the loop end. Always session-only.`,
    "- list: what is scheduled here; kind cron or loop, durable_only.",
    "- get: one job by id.",
    "- delete (or cancel): remove a job by id.",
    "- rename: replace a job's prompt.",
    'Examples: {"operation":{"action":"schedule","cron":"*/10 * * * *","prompt":"check the build"}} {"operation":{"action":"loop","delay_seconds":300,"prompt":"watch the deploy"}} {"operation":{"action":"delete","id":"a1b2c3d4"}}',
    "Which to use: schedule for work that belongs to a time - every morning, every ten minutes, once at a named hour. loop for work that paces itself, where each run decides whether there is any point in the next one; a loop that is no longer needed is ended simply by not calling it again.",
    "Write the prompt as an instruction to carry out, not as a note to yourself: the run that fires it starts from it and has none of this conversation's context, so name the project, the file or the command it is about.",
    "Tell the user the job id so they can cancel it; the list itself need not be repeated in your reply.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "object",
        description: "What to do",
        properties: {
          action: { type: "string", enum: [...CRON_ACTIONS], description: "The operation" },
          cron: { type: "string", description: "schedule: five-field cron expression, UTC" },
          prompt: { type: "string", description: "schedule, loop, rename: the prompt to run" },
          one_shot: { type: "boolean", description: "schedule: run once, then remove" },
          durable: { type: "boolean", description: "schedule: keep across restarts" },
          delay_seconds: { type: "integer", description: `loop: seconds until the next run, clamped to ${LOOP_MIN_SECONDS}-${LOOP_MAX_SECONDS}` },
          reason: { type: "string", description: "loop: why the loop is being armed or extended" },
          kind: { type: "string", enum: ["cron", "loop"], description: "list: only this kind" },
          durable_only: { type: "boolean", description: "list: only durable jobs" },
          id: { type: "string", description: "get, delete, rename: the job id" },
          session_id: { type: "string", description: "The conversation to act on; defaults to this one" },
        },
        required: ["action"],
      },
    },
  },
  async execute(input, context) {
    const scheduler = cronScheduler()
    if (!scheduler) throw new ToolError("Scheduled prompts are not available in this session.")
    const operation = cronOperation(input)
    if (!operation) throw new ToolError('Pass the action inside an operation object, e.g. {"operation":{"action":"list"}}.')
    const raw = text(operation.action) ?? ""
    const action = raw === "cancel" ? "delete" : raw
    if (!(CRON_ACTIONS as readonly string[]).includes(raw)) {
      const close = CRON_ACTIONS.filter((known) => distance(raw, known) <= 2)
      throw new ToolError(`Unknown action "${raw}". The actions are ${CRON_ACTIONS.join(", ")}.${close.length === 1 ? ` Did you mean ${close[0]}?` : ""}`)
    }
    const named = text(operation.session_id)
    const owner = await ownerOf(scheduler, context, named)
    /*
     * A job is looked up among the project's durable ones - which is where a
     * schedule now lives - and among the named conversation's own session-only
     * ones.
     */
    const scope = { ownerID: owner.id, directory: owner.directory }

    if (action === "schedule") {
      const cron = text(operation.cron)
      const prompt = text(operation.prompt)
      if (!cron || !prompt) throw new ToolError("schedule needs cron and prompt.")
      if (!parseCron(cron)) throw new ToolError(`"${cron}" is not a five-field cron expression (minute hour day-of-month month day-of-week).`)
      const oneShot = operation.one_shot === true
      const durable = operation.durable === true
      const task = await scheduler.add({ ownerID: owner.id, directory: owner.directory, cron, prompt, recurring: !oneShot, durable })
      const next = nextCronRun(cron, Date.now())
      let warning = ""
      if (next === undefined) warning = "\nWarning: this expression matches no time in the next year, so the job will never run. Check the fields (the 30th of February does not exist)."
      else if (oneShot && next - Date.now() > MONTH_MS) warning = `\nWarning: its next match is ${new Date(next).toISOString()}. A cron expression only looks forward; cancel and schedule again if you meant sooner.`
      return {
        title: `Scheduled ${task.id}`,
        output: `Scheduled ${task.id} (${cron}, ${oneShot ? "one-shot" : "recurring"}${durable ? ", durable" : ""}): ${prompt}${warning}`,
        metadata: { id: task.id, kind: "cron", ...(next !== undefined ? { scheduled_for: next } : {}) },
      }
    }

    if (action === "loop") {
      const prompt = text(operation.prompt)
      const delay = operation.delay_seconds
      if (!prompt || typeof delay !== "number" || !Number.isInteger(delay) || delay < 1) throw new ToolError("loop needs prompt and a whole number of delay_seconds.")
      const armed = scheduler.armLoop({ ownerID: owner.id, directory: owner.directory, prompt, delaySeconds: delay })
      if (!armed) return { title: "Loop ended", output: "This loop has been running for a week, so it has ended.", metadata: { aged_out: true } }
      return {
        title: `Loop armed: ${armed.clampedSeconds}s${armed.wasClamped ? " (clamped)" : ""}`,
        output: `Next run at ${new Date(armed.scheduledFor).toLocaleString()}${armed.superseded ? ` (replaced ${armed.superseded} earlier run)` : ""}`,
        metadata: { id: armed.id, kind: "loop", scheduled_for: armed.scheduledFor },
      }
    }

    if (action === "list") {
      const kind = operation.kind === "cron" || operation.kind === "loop" ? operation.kind : undefined
      const tasks = await scheduler.list({ scope, kind, durableOnly: operation.durable_only === true })
      return {
        title: `Jobs: ${tasks.length}`,
        output: tasks.length ? tasks.map((task) => `${task.id} ${task.cron} ${task.kind ?? "cron"} - ${task.prompt.slice(0, 60)}`).join("\n") : "Nothing is scheduled.",
        metadata: { count: tasks.length, ids: tasks.map((task) => task.id) },
      }
    }

    const id = text(operation.id)
    if (!id) throw new ToolError(`${action} needs an id.`)
    if (action === "get") {
      const task = await scheduler.get(id, scope)
      if (!task) return { title: `Job ${id}: not found`, output: `There is no job ${id}. List the jobs to see their ids.`, metadata: {} }
      return { title: `Job ${id}`, output: JSON.stringify(task, null, 2), metadata: { id, kind: task.kind ?? "cron" } }
    }
    if (action === "delete") {
      const removed = await scheduler.remove(id, scope)
      return { title: removed ? `Cancelled ${id}` : `${id} not found`, output: removed ? `Cancelled ${id}.` : `There is no job ${id} to cancel.`, metadata: { id } }
    }
    const prompt = text(operation.prompt)
    if (!prompt) throw new ToolError("rename needs a prompt.")
    const renamed = await scheduler.rename(id, prompt, scope)
    return { title: renamed ? `Renamed ${id}` : `${id} not found`, output: renamed ? `The prompt of ${id} is now: ${prompt}` : `There is no job ${id} to rename.`, metadata: { id } }
  },
}
