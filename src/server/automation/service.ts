import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { AgentName, Effort, Message, ModelRef, ServerEvent, SessionInfo, UserMessage } from "@shared/protocol"
import { quarantine, writeAtomic } from "../storage"
import { ToolError } from "../tool/types"
import { nextOccurrence, parseRRule, scheduleLabel } from "./rrule"
import { RunQueue, type QueueState, type QueuedRun } from "./run-queue"

/**
 * automation: MiMo desktop's scheduled tasks, as its release build offers them
 * to the model through `automation_update` (its management page is not shown
 * to users, so neither is one here).
 *
 * A task is a saved prompt, a recurrence rule, where it runs - a new
 * conversation each time, or one existing conversation - with which model and
 * reasoning, and when to be told about a run. Tasks are kept in the app's data
 * folder (`automations.json`); a check once a second starts the runs that are
 * due, each an ordinary turn, so permissions ask as they always do.
 */

export const RUN_MODES = ["new-task", "existing-task"] as const
export const NOTIFICATIONS = ["all-runs", "important-updates", "failed-runs"] as const
export const REASONING = ["low", "medium", "high", "xhigh", "max"] as const
export const AUTOMATION_MODES = ["list", "view", "create", "update", "pause", "resume", "delete"] as const

export type RunMode = (typeof RUN_MODES)[number]
export type NotificationPolicy = (typeof NOTIFICATIONS)[number]

export interface Automation {
  id: string
  title: string
  prompt: string
  enabled: boolean
  runMode: RunMode
  targetThreadId?: string
  project: { name: string; path: string } | null
  model: ModelRef & { name: string }
  reasoning?: Effort
  rrule: string
  label?: string
  notification: NotificationPolicy
  revision: number
  createdAt: number
  updatedAt: number
  /** Where the schedule is counted from: when it was made or last rescheduled. */
  anchorAt: number
  lastFiredAt?: number
  /** The last few runs, so one the app died in the middle of is not simply forgotten. */
  runHistory?: RunRecord[]
}

/**
 * One run of a task, as MiMo records one.
 *
 * MiMo keeps a runHistory entry per run and replays a journal of finished runs
 * at start-up, so an entry still "running" with no finishedAt is settled from
 * the journal rather than left hanging. Here the entry is the journal: it is
 * written when the run starts and settled when the turn ends, when the app
 * stops, or - if the app was killed outright - at the next start.
 */
export interface RunRecord {
  runId: string
  /** The moment the schedule asked for it. */
  scheduledFor: number
  startedAt: number
  status: "running" | "succeeded" | "failed" | "skipped"
  finishedAt?: number
  /** The conversation it ran in. */
  resultThreadId?: string
  hasNonEmptyReply?: boolean
  error?: string
  /** Why it failed or was skipped, in MiMo's words (L12-17); absent where none of them fits. */
  errorCode?: RunReason
  /** Set once the user has been told about a run that did not finish. */
  reported?: boolean
  /** Where the run came from. Only the schedule starts one here; MiMo also has a "run now" button, behind its E2E flag. */
  source?: "schedule" | "manual"
  /**
   * The task as it stood when this run was made.
   *
   * MiMo keeps one on every record, and it is the one thing a history cannot
   * be given afterwards: by the time anything reads the history, the task has
   * been edited and the run's own conditions are gone. Written now so that a
   * page built later can say what a run was actually asked to do.
   */
  contextSnapshot?: {
    title: string
    prompt: string
    runMode: RunMode
    notification: NotificationPolicy
    targetThreadId?: string
    project?: string
    model: string
  }
}

/**
 * MiMo's reasons for a run that failed or was skipped, as its run records keep
 * them in `errorCode` and its automations page maps them to a sentence each
 * (`automations.runReason.*`). Kept on the record here too, as data only, so a
 * history written now already says why when a page reads it. `app_interrupted`
 * is MiMo's own code for a run the app closed on.
 */
export const RUN_REASONS = [
  "unauthenticated",
  "model-unavailable",
  "project-unavailable",
  "empty-prompt",
  "target-missing",
  "target-busy",
  "overlap",
  "schedule-changed",
  "paused",
  "deleted",
  "duplicate-run",
  "app_interrupted",
] as const
export type RunReason = (typeof RUN_REASONS)[number]

interface Receipt {
  operationId: string
  fingerprint: string
  response: string
}

/**
 * MiMo's terminal-report journal, beside the tasks.
 *
 * A run's end is written here before anything else happens to it, and taken
 * out once the run is settled and the window told. The run record alone could
 * not cover the gap between those: an app killed after a turn ended but before
 * the record was saved came back to a record still "running", settled it as
 * skipped, and told the user a run had failed that had in fact answered. MiMo
 * replays this file at start ("replayed N terminal report(s)"); so does this.
 */
export const TERMINAL_REPORTS_FILE = "automation-terminal-reports.json"

interface TerminalReport {
  automationID: string
  runId?: string
  sessionID: string
  status: "succeeded" | "failed"
  finishedAt: number
  hasNonEmptyReply: boolean
  notify: boolean
}

interface Saved {
  /** Which build's idea of this document it is; the same bargain `config.json` makes. */
  schemaVersion?: number
  automations: Automation[]
  seq: number
  receipts: Receipt[]
  /** Runs that are due and have not started yet, so a quit does not lose them (N11-2). */
  runQueue?: QueueState
}

/** Raise this only when a change would be misread by a build that predates it. */
export const AUTOMATION_SCHEMA_VERSION = 1

/** MiMo keeps the last 256 operation receipts, so a retried call is answered as it was the first time. */
const RECEIPTS_KEPT = 256
/** How many runs a task remembers. */
const RUNS_KEPT = 20
/** How many settled run ids are kept, so one handed out twice is recognised; MiMo's ring is the same size. */
const SETTLED_RUNS_KEPT = 64
/** What a run that the app ended is recorded as. */
const CLOSED_MID_RUN = "The app closed before the run finished."
/** What a run still in the queue is recorded as when a newer run of the same task comes due. */
const OVERTAKEN = "A newer run of this task came due before this one could start."
/** What a run that could never be started is recorded as, once its attempts are used up. */
const COULD_NOT_START = "The run could not be started."
const TICK_MS = 1000
/**
 * How many runs one check may start.
 *
 * cron already fires at most one due task per check; this side used to start
 * every due task in the same tick, so ten tasks sharing a time hit the provider
 * together (N11-28). A small fan-out keeps the two schedulers in the same
 * shape, and the queue holds whatever does not fit until the next second.
 */
const STARTS_PER_TICK = 4
/**
 * How far the wall clock and a monotonic clock beside it may disagree, and how
 * big a step forward is still an ordinary one - MiMo's two figures.
 *
 * Every due moment here is an absolute millisecond worked out from local wall
 * clock rules, and nothing recomputed them afterwards. A laptop asleep for
 * eight hours woke up with every task's moment in the past and let the lot off
 * in one tick; a daylight-saving change or a new timezone left every moment an
 * hour out until the task next fired. MiMo samples both clocks and the offset
 * at each tick, calls any of those a discontinuity, and replans from now -
 * dropping what was missed rather than firing it.
 */
const CLOCK_TOLERANCE_MS = 5_000
const CLOCK_GAP_MS = 60_000

interface ClockSample {
  wall: number
  monotonic: number
  /** Minutes west of UTC at that moment, so a timezone or daylight-saving change shows up. */
  offset: number
}

export interface AutomationDeps {
  file: string
  now(): number
  sessions: {
    get(sessionID: string): Promise<SessionInfo | undefined>
    create(input: { directory: string; model: ModelRef; agent?: AgentName; title?: string; scratch?: boolean }): Promise<SessionInfo>
    messages(sessionID: string): Promise<Message[]>
    /** Takes away a conversation this service made for a run that then would not start. */
    delete?(sessionID: string): Promise<unknown>
  }
  prompt(input: { sessionID: string; text: string; inbox: UserMessage["inbox"] }): Promise<unknown>
  busy(sessionID: string): boolean
  /** The models of connected providers, as `provider/model` with a display name and the reasoning levels each takes. */
  models(): { provider: string; id: string; name: string; efforts?: readonly string[] }[]
  agent(): AgentName
  /** The app-wide reasoning level. */
  effort(): Effort | undefined
  /** The interface language, which the schedule's words follow (T10-52). */
  locale?(): string
  /** A fresh folder for a task with no project. */
  scratch(): Promise<string>
  publish(event: ServerEvent): void
}

/** MiMo's rule for telling the user about a finished run. */
export function notifies(policy: NotificationPolicy, runMode: RunMode, status: "succeeded" | "failed" | "skipped", hasReply: boolean): boolean {
  if (policy === "all-runs") return true
  if (policy === "failed-runs") return status === "failed" || status === "skipped"
  return runMode === "existing-task" && status === "succeeded" && hasReply
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

/**
 * A schedule as MiMo compares two: hourly, daily, weekdays and weekly rules by
 * what they mean, so the order of their parts does not matter, and any other
 * rule by its lines together with its label.
 */
export function scheduleKey(rrule: string, label?: string): string {
  const rule = parseRRule(rrule)
  const lines = rrule.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n")
  if (!rule) return `invalid:${lines}`
  const simple = !rule.hasStart && !rule.extraLines
  const only = (allowed: string[]) => simple && rule.keys.every((key) => allowed.includes(key))
  const time = `${rule.byHours[0] ?? 9}:${rule.byMinutes[0] ?? 0}`
  if (rule.interval === 1 && rule.frequency === "HOURLY" && rule.byMinutes.join() === "0" && only(["FREQ", "BYMINUTE"])) return "hourly:0"
  if (rule.interval === 1 && rule.frequency === "DAILY" && rule.byHours.length === 1 && rule.byMinutes.length === 1 && !rule.byWeekdays.length && only(["FREQ", "BYHOUR", "BYMINUTE"])) return `daily:${time}`
  if (rule.interval === 1 && rule.frequency === "WEEKLY" && rule.byHours.length === 1 && rule.byMinutes.length === 1 && only(["FREQ", "BYHOUR", "BYMINUTE", "BYDAY"])) {
    if (rule.byWeekdays.join() === "1,2,3,4,5") return `weekdays:${time}`
    if (rule.byWeekdays.length === 1) return `weekly:${rule.byWeekdays[0]}:${time}`
  }
  return `custom:${lines}\u0000${label?.trim() ?? ""}`
}

/** The task as a run found it, kept on the run's record. */
function snapshotOf(automation: Automation): NonNullable<RunRecord["contextSnapshot"]> {
  return {
    title: automation.title,
    prompt: automation.prompt,
    runMode: automation.runMode,
    notification: automation.notification,
    ...(automation.targetThreadId ? { targetThreadId: automation.targetThreadId } : {}),
    ...(automation.project ? { project: automation.project.name } : {}),
    model: `${automation.model.provider}/${automation.model.model}`,
  }
}

/** Whether two tasks are the same task, on MiMo's ten fields: run history, labels on simple rules and key order do not count. */
export function sameTask(a: Automation, b: Automation): boolean {
  const fields = (task: Automation) =>
    JSON.stringify([
      task.title,
      task.prompt,
      task.enabled,
      task.runMode,
      task.targetThreadId ?? null,
      task.project ? [task.project.name, task.project.path] : null,
      [task.model.provider, task.model.model],
      task.reasoning ?? null,
      scheduleKey(task.rrule, task.label),
      task.notification,
    ])
  return fields(a) === fields(b)
}

export class AutomationService {
  private saved: Saved = { automations: [], seq: 0, receipts: [] }
  private readonly next = new Map<string, number>()
  /** Runs whose turn has not ended yet, by the conversation they run in. */
  private readonly runs = new Map<string, Automation>()
  private readonly starting = new Set<string>()
  /** Due runs waiting to start, under leases, so none is lost to a failure or a kill (N11-2). */
  private readonly queue = new RunQueue()
  /**
   * The last few run ids that were settled, so one handed out twice is not run
   * twice - MiMo keeps the same bounded ring. A lease can run out while the
   * turn it started is genuinely still going, and the entry then becomes
   * deliverable again; without this the same run went out a second time.
   */
  private readonly settledRuns = new Set<string>()
  /** Runs that ended with the app and have not been reported yet; sent on the first check. */
  private readonly pendingReports: { sessionID: string; notify: boolean; outcome?: "succeeded" | "failed" | "skipped" }[] = []
  private interval: ReturnType<typeof setInterval> | undefined
  private writing: Promise<void> = Promise.resolve()
  /** Set when the saved tasks could not be read and nothing may be written over them. */
  private blocked: string | undefined
  /** Set when they were written by a newer build, which nothing here may write over either. */
  private fromNewerVersion = false
  /** Where an unreadable file was kept, and what to tell anyone who asks. */
  private evidence: string | undefined
  private problem: string | undefined
  /** Runs that have ended and are not yet settled and told; mirrored to the journal. */
  private reports: TerminalReport[] = []
  /** How many reports the last start replayed, for the checks. */
  replayed = 0
  /** The start that read the saved tasks, for anything that reports on them once they are read (L12-14). */
  started: Promise<void> | undefined
  /** The clocks as the last check saw them, so this one can tell whether they jumped. */
  private lastClock: ClockSample | undefined

  constructor(private readonly deps: AutomationDeps) {}

  private get journal(): string {
    return path.join(path.dirname(this.deps.file), TERMINAL_REPORTS_FILE)
  }

  private writeJournal(): Promise<void> {
    if (this.blocked || this.fromNewerVersion) return this.writing
    const snapshot = JSON.stringify({ schemaVersion: AUTOMATION_SCHEMA_VERSION, reports: this.reports }, null, 2)
    this.writing = this.writing.then(() => writeAtomic(this.journal, snapshot)).catch(() => undefined)
    return this.writing
  }

  /**
   * The reports a previous run of the app wrote and did not get to finish:
   * each settles its run record with what really happened, and one the window
   * was never told about is queued, before the sweep below takes whatever is
   * still open for a run the app died in.
   */
  private async replayJournal(): Promise<boolean> {
    const raw = await fs.readFile(this.journal, "utf8").catch(() => undefined)
    if (raw === undefined) return false
    let reports: TerminalReport[] = []
    try {
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as { reports?: unknown }
      reports = Array.isArray(parsed.reports) ? (parsed.reports as TerminalReport[]).filter((entry) => entry && typeof entry.sessionID === "string") : []
    } catch {
      // A journal that will not parse holds nothing that can be trusted; the sweep still settles the runs.
    }
    let settled = false
    for (const report of reports) {
      const automation = this.saved.automations.find((entry) => entry.id === report.automationID)
      const record = automation?.runHistory?.find((entry) => (report.runId ? entry.runId === report.runId : entry.resultThreadId === report.sessionID) && entry.status === "running")
      if (record) {
        record.status = report.status
        record.finishedAt = report.finishedAt
        record.hasNonEmptyReply = report.hasNonEmptyReply
        record.reported = true
        settled = true
      }
      this.pendingReports.push({ sessionID: report.sessionID, notify: report.notify, outcome: report.status })
    }
    this.replayed = reports.length
    this.reports = []
    await this.writeJournal()
    return settled
  }

  async start(options: { interval?: boolean } = {}): Promise<void> {
    const raw = await fs.readFile(this.deps.file, "utf8").catch(() => undefined)
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Partial<Saved>
        this.saved = {
          automations: Array.isArray(parsed.automations) ? parsed.automations.filter((entry) => entry && typeof entry.id === "string" && typeof entry.rrule === "string") : [],
          seq: typeof parsed.seq === "number" ? parsed.seq : 0,
          receipts: Array.isArray(parsed.receipts) ? parsed.receipts.slice(-RECEIPTS_KEPT) : [],
        }
        this.queue.restore(parsed.runQueue)
        /*
         * A document from a later build is read - the tasks in it still run -
         * but nothing is written back over it, or the fields that build added
         * would be dropped the first time a task fired.
         */
        this.fromNewerVersion = typeof parsed.schemaVersion === "number" && parsed.schemaVersion > AUTOMATION_SCHEMA_VERSION
      } catch (cause) {
        /*
         * A file that will not parse is a blocked load, not an empty one.
         *
         * It used to start empty and be left "until the next change" - but the
         * next answer() or tick() called save(), which wrote the empty document
         * over it, so one truncated write turned every scheduled task into
         * nothing that could not be got back by hand either. The reference
         * blocks instead, keeping the raw text as evidence and writing nothing.
         *
         * So the damaged file is moved aside under a name of its own and the
         * app carries on with no tasks; if it cannot be moved, nothing is ever
         * written here and every change says why.
         */
        const aside = await quarantine(this.deps.file)
        const why = cause instanceof Error ? cause.message : String(cause)
        this.evidence = aside
        this.blocked = aside
          ? undefined
          : `The scheduled tasks in ${this.deps.file} could not be read (${why}) and the file could not be moved aside, so nothing is saved over it. Repair or move that file, then reopen the app.`
        this.problem = aside
          ? `The scheduled tasks in ${this.deps.file} could not be read (${why}). The file was kept as ${aside} and the app started with no tasks.`
          : this.blocked
      }
    }
    /*
     * Runs that were in flight when the app went away.
     *
     * A run used to exist only in memory, so killing the app while a scheduled
     * task was answering made it vanish: no failed entry, no notification,
     * nothing in the task to say it ever ran, and - because lastFiredAt was
     * advanced when the prompt started - no retry either. The user was told
     * about every other run and silently not that one. A record left "running"
     * is settled here, and one that nobody has been told about is queued.
     */
    let settled = await this.replayJournal()
    for (const automation of this.saved.automations) {
      for (const record of automation.runHistory ?? []) {
        if (record.status === "running") {
          record.status = "skipped"
          record.finishedAt = this.deps.now()
          record.error = CLOSED_MID_RUN
          record.errorCode = "app_interrupted"
          settled = true
        }
        if (record.status !== "skipped" || record.reported) continue
        record.reported = true
        settled = true
        if (record.resultThreadId) {
          this.pendingReports.push({
            sessionID: record.resultThreadId,
            notify: notifies(automation.notification, automation.runMode, "skipped", false),
            outcome: "skipped",
          })
        }
      }
    }
    if (settled) void this.save()
    for (const automation of this.saved.automations) this.plan(automation, true)
    if (options.interval === false) return
    this.interval = setInterval(() => void this.tick(), TICK_MS)
    this.interval.unref?.()
  }

  stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval)
    this.interval = undefined
    /*
     * A run still going when the app quits is recorded as skipped, which is
     * what MiMo's dispose() resolves a pending run to - and its notification
     * rule treats skipped as failed, so the user hears about it. The telling
     * happens at the next start, since the window is on its way out by now.
     */
    let ended = false
    for (const automation of this.saved.automations) {
      for (const record of automation.runHistory ?? []) {
        if (record.status !== "running") continue
        record.status = "skipped"
        record.finishedAt = this.deps.now()
        record.error = CLOSED_MID_RUN
        record.errorCode = "app_interrupted"
        ended = true
      }
    }
    this.runs.clear()
    if (ended) void this.save()
    return this.writing
  }

  /**
   * A run that could not start, recorded as MiMo records one (T10-22): it
   * shows in the task's history, and is not reported again at the next start,
   * since there is no conversation to point the user at.
   */
  private skipRun(automation: Automation, error: string, run?: QueuedRun, errorCode?: RunReason): void {
    const at = this.deps.now()
    const record: RunRecord = {
      runId: run ? `${run.runId}-skipped` : `run-${at.toString(36)}-skipped`,
      scheduledFor: run?.scheduledFor ?? this.next.get(automation.id) ?? at,
      startedAt: at,
      status: "skipped",
      finishedAt: at,
      error,
      ...(errorCode ? { errorCode } : {}),
      reported: true,
      source: "schedule",
      contextSnapshot: snapshotOf(automation),
    }
    automation.runHistory = [...(automation.runHistory ?? []), record].slice(-RUNS_KEPT)
  }

  /** Opens a record for a run that is starting, keeping only the last few. */
  private openRun(automation: Automation, sessionID: string, run?: QueuedRun): void {
    const at = this.deps.now()
    const record: RunRecord = {
      runId: run ? run.runId : `run-${at.toString(36)}-${sessionID.slice(-8)}`,
      scheduledFor: run?.scheduledFor ?? this.next.get(automation.id) ?? at,
      startedAt: at,
      status: "running",
      resultThreadId: sessionID,
      source: "schedule",
      contextSnapshot: snapshotOf(automation),
    }
    automation.runHistory = [...(automation.runHistory ?? []), record].slice(-RUNS_KEPT)
    void this.save()
  }

  list(): Automation[] {
    return this.saved.automations.map((automation) => structuredClone(automation))
  }

  dueAt(id: string): number | undefined {
    return this.next.get(id)
  }

  /** How many runs are still waiting to start, for the checks. */
  get queued(): number {
    return this.queue.size
  }

  private save(): Promise<void> {
    // Never written over a document that would not parse: what is in it is the
    // user's only copy, and an empty one on top makes the loss permanent.
    if (this.blocked) return this.writing
    // Nor over one a newer build wrote, for the same reason in a different key.
    if (this.fromNewerVersion) return this.writing
    const snapshot = JSON.stringify({ schemaVersion: AUTOMATION_SCHEMA_VERSION, ...this.saved, runQueue: this.queue.state }, null, 2)
    this.writing = this.writing.then(() => writeAtomic(this.deps.file, snapshot)).catch(() => undefined)
    return this.writing
  }

  /** When a task next runs: after its last run, or after it was scheduled; nothing while it is paused. */
  private plan(automation: Automation, initial = false): void {
    const rule = parseRRule(automation.rrule)
    if (!automation.enabled || !rule) {
      this.next.delete(automation.id)
      return
    }
    const from = initial ? Math.max(automation.lastFiredAt ?? 0, automation.anchorAt) || this.deps.now() : this.deps.now()
    const at = nextOccurrence(rule, from)
    if (at === undefined) this.next.delete(automation.id)
    else this.next.set(automation.id, at)
  }

  view(automation: Automation) {
    return {
      id: automation.id,
      title: automation.title,
      prompt: automation.prompt,
      status: automation.enabled ? "active" : "paused",
      runMode: automation.runMode,
      ...(automation.targetThreadId ? { targetThreadId: automation.targetThreadId } : {}),
      project: automation.project?.name ?? null,
      model: { id: `${automation.model.provider}/${automation.model.model}`, name: automation.model.name },
      ...(automation.reasoning ? { reasoning: automation.reasoning } : {}),
      schedule: scheduleLabel(automation.rrule, automation.label, this.deps.locale?.() ?? "en"),
      notification: automation.notification,
    }
  }

  /** The app's reasoning level as a task's default, when the task's model takes it; effort is one app-wide value here. */
  private appEffort(model: ModelRef): { reasoning?: Effort } {
    const effort = this.deps.effort()
    if (!effort || !(REASONING as readonly string[]).includes(effort)) return {}
    const efforts = this.effortsOf(model)
    return !efforts || efforts.includes(effort) ? { reasoning: effort } : {}
  }

  /** The reasoning levels a connected model takes; nothing when the model is not one this app lists. */
  private effortsOf(model: ModelRef): readonly string[] | undefined {
    return this.deps.models().find((entry) => entry.provider === model.provider && entry.id === model.model)?.efforts
  }

  /** MiMo's check that a task's reasoning is one its model takes (T10-53). */
  private checkReasoning(reasoning: string | undefined, model: ModelRef): void {
    if (!reasoning) return
    const efforts = this.effortsOf(model)
    if (!efforts || efforts.includes(reasoning)) return
    throw new ToolError(
      `reasoning "${reasoning}" is not a level model "${model.provider}/${model.model}" takes; it takes: ${efforts.length ? efforts.join(", ") : "none (leave reasoning out)"}.`,
    )
  }

  /** MiMo refuses a notification that cannot mean anything for where the task runs (T10-20). */
  private checkNotification(runMode: RunMode, notification: NotificationPolicy): void {
    if (runMode === "new-task" && notification === "important-updates") {
      throw new ToolError('notification "important-updates" does not fit runMode "new-task": it only reports replies in an existing conversation. Use all-runs or failed-runs.')
    }
    if (runMode === "existing-task" && notification === "all-runs") {
      throw new ToolError('notification "all-runs" does not fit runMode "existing-task". Use important-updates or failed-runs.')
    }
  }

  /**
   * Where an existing-task task may run: this conversation, or a conversation
   * the side column lists - not a subagent's, a side chat or an archived one
   * (the user's T10-22 decision; MiMo takes this or a pinned conversation).
   */
  private async checkTarget(id: string, caller: SessionInfo): Promise<void> {
    if (id === caller.id) return
    const target = await this.deps.sessions.get(id)
    if (target && !target.parentID && !target.sideOf && !target.archived) return
    throw new ToolError(`targetThreadId "${id}" is not a conversation a task can run in: give this conversation's id, or one listed in the side column that is not archived.`)
  }

  private model(ref: string | undefined, fallback: ModelRef): ModelRef & { name: string } {
    const models = this.deps.models()
    if (!ref) {
      const known = models.find((entry) => entry.provider === fallback.provider && entry.id === fallback.model)
      return { ...fallback, name: known?.name ?? fallback.model }
    }
    const slash = ref.indexOf("/")
    const exact = slash > 0 ? models.find((entry) => entry.provider === ref.slice(0, slash) && entry.id === ref.slice(slash + 1)) : undefined
    const byId = models.filter((entry) => entry.id === ref)
    const found = exact ?? (byId.length === 1 ? byId[0] : undefined)
    if (!found) throw new ToolError(`No connected model matches "${ref}". Pass a model id of a connected provider, as provider/model when two providers share it.`)
    return { provider: found.provider, model: found.id, name: found.name }
  }

  /** The tool's call, answered as JSON the way MiMo's handler answers it. */
  async handle(input: Record<string, unknown>, call: { sessionID: string }): Promise<string> {
    const caller = await this.deps.sessions.get(call.sessionID)
    if (!caller) throw new ToolError("Scheduled tasks are not available for this call.")
    if (caller.parentID) throw new ToolError("A subagent cannot manage scheduled tasks.")
    const mode = text(input.mode)
    if (!mode || !(AUTOMATION_MODES as readonly string[]).includes(mode)) throw new ToolError(`mode must be one of ${AUTOMATION_MODES.join(", ")}.`)
    if (mode === "list") return JSON.stringify({ automations: this.saved.automations.map((automation) => this.view(automation)), ...(this.problem ? { warning: this.problem } : {}) })
    // A change that cannot be saved is refused outright rather than accepted
    // and lost; reading what is there is still allowed.
    if (this.blocked && mode !== "view") throw new ToolError(this.blocked)
    const idOf = () => {
      const id = text(input.id)
      if (!id) throw new ToolError(`${mode} needs an automation id; list them to see the ids.`)
      return id
    }
    const find = (id: string) => {
      const found = this.saved.automations.find((automation) => automation.id === id)
      if (!found) throw new ToolError("No scheduled task has that id; list them to see the ids.")
      return found
    }
    if (mode === "view") return JSON.stringify({ automation: this.view(find(idOf())) })

    const reasoning = text(input.reasoning)
    if (reasoning && !(REASONING as readonly string[]).includes(reasoning)) throw new ToolError(`reasoning must be one of ${REASONING.join(", ")}.`)
    const runMode = text(input.runMode)
    if (runMode && !(RUN_MODES as readonly string[]).includes(runMode)) throw new ToolError(`runMode must be one of ${RUN_MODES.join(", ")}.`)
    const notification = text(input.notification)
    if (notification && !(NOTIFICATIONS as readonly string[]).includes(notification)) throw new ToolError(`notification must be one of ${NOTIFICATIONS.join(", ")}.`)
    const status = text(input.status)
    if (status && status !== "active" && status !== "paused") throw new ToolError('status must be "active" or "paused".')
    const rrule = typeof input.rrule === "string" ? input.rrule : undefined
    if (rrule !== undefined && !parseRRule(rrule)) {
      throw new ToolError(
        "The recurrence rule is not one scheduled tasks accept. Send a whole RRULE line in local time, e.g. RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0 (every day at 09:00) or RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0 (weekdays at 09:00).",
      )
    }

    const operationId = text(input.operationId)
    const fingerprint = createHash("sha1").update(JSON.stringify({ ...input, operationId: undefined })).digest("hex")
    const receipt = operationId ? this.saved.receipts.find((entry) => entry.operationId === operationId) : undefined
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new ToolError("That operationId was already used for a different change; pass a new one.")
      return receipt.response
    }
    const answer = async (response: unknown) => {
      const written = JSON.stringify(response)
      if (operationId) this.saved.receipts = [...this.saved.receipts, { operationId, fingerprint, response: written }].slice(-RECEIPTS_KEPT)
      await this.save()
      return written
    }
    const now = this.deps.now()
    const project = input.project === "none" || caller.scratch ? null : { name: path.basename(caller.directory) || caller.directory, path: caller.directory }

    if (mode === "create") {
      const title = text(input.title)
      const prompt = text(input.prompt)
      const missing = [!title && "title", !prompt && "prompt", !rrule && "rrule"].filter(Boolean)
      if (missing.length) throw new ToolError(`create needs: ${missing.join(", ")}`)
      const chosenMode = (runMode as RunMode | undefined) ?? "new-task"
      const chosenModel = this.model(text(input.model), caller.model)
      this.checkReasoning(reasoning, chosenModel)
      const chosenNotification = (notification as NotificationPolicy | undefined) ?? (chosenMode === "existing-task" ? "important-updates" : "all-runs")
      this.checkNotification(chosenMode, chosenNotification)
      const target = chosenMode === "existing-task" ? (text(input.targetThreadId) ?? caller.id) : undefined
      if (target) await this.checkTarget(target, caller)
      const draft: Automation = {
        id: "",
        title: title!,
        prompt: prompt!,
        enabled: status !== "paused",
        runMode: chosenMode,
        ...(target ? { targetThreadId: target } : {}),
        project,
        model: chosenModel,
        ...(reasoning ? { reasoning: reasoning as Effort } : this.appEffort(chosenModel)),
        rrule: rrule!,
        ...(text(input.scheduleLabel) ? { label: text(input.scheduleLabel) } : {}),
        notification: chosenNotification,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        anchorAt: now,
      }
      // The same task asked for twice is kept once, as MiMo does, judged on its ten fields (T10-21).
      const duplicate = this.saved.automations.find((automation) => sameTask(automation, draft))
      if (duplicate) return answer({ ok: true, created: false, deduplicated: true, automation: this.view(duplicate) })
      draft.id = `auto-${++this.saved.seq}`
      this.saved.automations.push(draft)
      this.plan(draft, true)
      return answer({ ok: true, automation: this.view(draft) })
    }

    const found = find(idOf())
    if (mode === "delete") {
      const automation = found
      this.saved.automations = this.saved.automations.filter((entry) => entry.id !== automation.id)
      this.next.delete(automation.id)
      return answer({ ok: true, id: automation.id })
    }
    // Changed on a copy, which replaces the task only once every check has passed.
    const automation = structuredClone(found)
    if (mode === "pause" || mode === "resume") {
      automation.enabled = mode === "resume"
      /*
       * Coming back from paused, the schedule is counted from now.
       *
       * `plan(automation, true)` counts from the later of lastFiredAt and
       * anchorAt, so resuming a 09:00 daily task at 14:00 worked out "today at
       * 09:00", found it already past, and let a run off in the same second.
       * MiMo's PATCH moves the anchor whenever a paused task is made active
       * again, and counts the first occurrence from there.
       */
      if (mode === "resume" && !found.enabled) automation.anchorAt = now
    } else {
      // An empty title or prompt is refused, as MiMo's check refuses it, rather than quietly ignored (T10-53).
      for (const field of ["title", "prompt"] as const) {
        if (typeof input[field] === "string" && !text(input[field])) throw new ToolError(`${field} cannot be empty; leave it out to keep the task's ${field}.`)
      }
      const title = text(input.title)
      const prompt = text(input.prompt)
      if (title) automation.title = title
      if (prompt) automation.prompt = prompt
      if (input.model !== undefined || reasoning) automation.model = this.model(text(input.model), automation.model)
      if (reasoning) automation.reasoning = reasoning as Effort
      if (input.model !== undefined && !reasoning && automation.reasoning) {
        const efforts = this.effortsOf(automation.model)
        if (efforts && !efforts.includes(automation.reasoning)) delete automation.reasoning
      }
      this.checkReasoning(reasoning, automation.model)
      if (rrule !== undefined) {
        automation.rrule = rrule
        automation.anchorAt = now
      }
      if (input.scheduleLabel !== undefined) automation.label = text(input.scheduleLabel)
      if (input.project !== undefined) automation.project = project
      if (status) automation.enabled = status === "active"
      // The same move of the anchor as resume, since an update may be the thing that makes a paused task active.
      if (automation.enabled && !found.enabled) automation.anchorAt = now
      const before = automation.runMode
      if (runMode) automation.runMode = runMode as RunMode
      // MiMo's defaults when the run target changes and nothing else was said.
      if (notification) automation.notification = notification as NotificationPolicy
      else if (automation.runMode === "existing-task" && before !== "existing-task" && automation.notification === "all-runs") automation.notification = "important-updates"
      else if (automation.runMode === "new-task" && before !== "new-task" && automation.notification === "important-updates") automation.notification = "all-runs"
      const named = text(input.targetThreadId)
      if (named) {
        await this.checkTarget(named, caller)
        automation.targetThreadId = named
      } else if (automation.runMode === "existing-task" && !automation.targetThreadId) automation.targetThreadId = caller.id
      if (automation.runMode === "new-task") delete automation.targetThreadId
      this.checkNotification(automation.runMode, automation.notification)
    }
    automation.revision++
    automation.updatedAt = now
    this.saved.automations = this.saved.automations.map((entry) => (entry.id === found.id ? automation : entry))
    this.plan(automation, automation.enabled && !found.enabled)
    return answer({ ok: true, automation: this.view(automation) })
  }

  /** Both clocks and the offset, as this check sees them; nothing when any of the three is not a number. */
  private sampleClock(): ClockSample | undefined {
    const wall = this.deps.now()
    const monotonic = globalThis.performance?.now?.() ?? Date.now()
    const offset = new Date(wall).getTimezoneOffset()
    if (![wall, monotonic, offset].every((value) => Number.isFinite(value))) return undefined
    return { wall, monotonic, offset }
  }

  /**
   * Whether the clock moved in a way no ordinary second could explain: the
   * offset changed, either clock went backwards, the two disagree about how
   * much time passed, or one of them jumped forward past a minute. MiMo's rule,
   * with its two figures.
   */
  private clockJumped(before: ClockSample, now: ClockSample): boolean {
    if (before.offset !== now.offset) return true
    const wall = now.wall - before.wall
    const monotonic = now.monotonic - before.monotonic
    const forward = Math.max(TICK_MS + CLOCK_TOLERANCE_MS, CLOCK_GAP_MS)
    if (wall < -CLOCK_TOLERANCE_MS || monotonic < -CLOCK_TOLERANCE_MS) return true
    if (Math.abs(wall - monotonic) > CLOCK_TOLERANCE_MS) return true
    return wall > forward || monotonic > forward
  }

  /** One check: every task that is due and can start, starts. */
  async tick(): Promise<void> {
    /*
     * Runs that ended with the app are told of on the first check rather than
     * at start-up: nothing is listening while the backend is still opening its
     * socket, and an event published then would be published to nobody.
     */
    for (const report of this.pendingReports.splice(0)) {
      this.deps.publish({ type: "automation.run", sessionID: report.sessionID, phase: "finished", notify: report.notify, outcome: report.outcome ?? "skipped" })
    }
    /*
     * A clock that jumped makes every moment already worked out meaningless, so
     * they are worked out again from now and this check scans nothing: what was
     * missed while the machine slept is missed, not fired all at once.
     */
    const clock = this.sampleClock()
    if (clock) {
      const jumped = this.lastClock !== undefined && this.clockJumped(this.lastClock, clock)
      this.lastClock = clock
      if (jumped) {
        for (const automation of this.saved.automations) this.plan(automation)
        return
      }
    }
    const now = this.deps.now()
    let dirty = false

    /*
     * Every due moment becomes a queue entry, and the schedule moves on at
     * once. Before this the schedule waited on the run: a busy conversation
     * held lastFiredAt back, so a day's worth of 09:00 runs collapsed into
     * whichever single one happened to find the conversation idle (N11-22).
     */
    const due = [...this.next.entries()].filter(([id, at]) => at <= now).sort((a, b) => a[1] - b[1])
    for (const [id, at] of due) {
      const automation = this.saved.automations.find((entry) => entry.id === id)
      if (!automation) {
        this.next.delete(id)
        continue
      }
      const fingerprint = scheduleKey(automation.rrule, automation.label)
      // A run still waiting when the next one comes due has waited long enough; it is given up on and said so.
      for (const waiting of this.queue.forAutomation(id)) {
        this.queue.drop(waiting.runId)
        this.settleQueuedRecord(automation, waiting, OVERTAKEN)
        dirty = true
      }
      this.queue.enqueue({ runId: RunQueue.runIdFor(id, at), automationID: id, scheduledFor: at, scheduleFingerprint: fingerprint, source: "schedule" })
      automation.lastFiredAt = now
      this.plan(automation)
      dirty = true
    }

    // A holder that never reported - the app was killed between taking a run and starting it - lets its lease go.
    for (const freed of this.queue.releaseExpired(now)) {
      console.warn(`[automation] run ${freed.runId} was taken but never reported; it is deliverable again`)
    }
    // And one that has been handed out as often as it may be is given up on rather than tried for ever.
    for (const gone of this.queue.exhausted()) {
      const automation = this.saved.automations.find((entry) => entry.id === gone.automationID)
      if (automation) {
        this.skipRun(automation, COULD_NOT_START, gone)
        this.tellAbout(automation, undefined, "skipped")
      }
      dirty = true
    }

    for (const entry of this.queue.drain(now, STARTS_PER_TICK)) {
      const automation = this.saved.automations.find((candidate) => candidate.id === entry.automationID)
      /*
       * The queue is on disk and comes back with the app, so an entry may
       * outlive the task it belongs to or the state it was made under. MiMo
       * checks all four of these again at the moment of delivery, by name, and
       * so does its renderer before it dispatches.
       */
      if (!automation) {
        // Deleted under it. Nothing is left to hold the record, so it is only logged.
        this.queue.drop(entry.runId)
        console.warn(`[automation] run ${entry.runId} was dropped: its task no longer exists`)
        dirty = true
        continue
      }
      // Paused under it - by the user or by the model - between being queued and being handed out.
      if (!automation.enabled) {
        this.queue.drop(entry.runId)
        this.skipRun(automation, "The task was paused before this run could start.", entry, "paused")
        dirty = true
        continue
      }
      // Rescheduled while this run waited: running it now would run it at a time nobody asked for.
      if (entry.scheduleFingerprint && entry.scheduleFingerprint !== scheduleKey(automation.rrule, automation.label)) {
        this.queue.drop(entry.runId)
        this.skipRun(automation, "The task was rescheduled before this run could start.", entry, "schedule-changed")
        dirty = true
        continue
      }
      // Already settled once and handed out again - a lease that ran out while the turn was in fact still going.
      if (this.settledRuns.has(entry.runId)) {
        this.queue.drop(entry.runId)
        this.skipRun(automation, "This run had already been started once.", entry, "duplicate-run")
        dirty = true
        continue
      }
      // The last run of this same task has not finished yet; MiMo refuses to lay a second one on top of it.
      if ([...this.runs.values()].some((running) => running.id === automation.id)) {
        this.queue.drop(entry.runId)
        this.skipRun(automation, "The previous run of this task had not finished.", entry, "overlap")
        this.tellAbout(automation, automation.targetThreadId, "skipped")
        dirty = true
        continue
      }
      if (this.starting.has(entry.automationID)) {
        this.queue.report(entry.runId, entry.deliveryGeneration, "later")
        continue
      }
      this.starting.add(entry.automationID)
      let outcome: "started" | "skipped" | "failed" = "failed"
      try {
        outcome = await this.run(automation, entry)
      } finally {
        this.starting.delete(entry.automationID)
      }
      // Started, skipped or failed: either way this entry is finished with, and the failure has been recorded.
      this.queue.report(entry.runId, entry.deliveryGeneration, "settled")
      this.noteSettled(entry.runId)
      dirty = true
    }
    if (dirty) await this.save()
  }

  /** Remembers a settled run id, keeping the ring at its size by dropping the oldest. */
  private noteSettled(runId: string): void {
    this.settledRuns.add(runId)
    while (this.settledRuns.size > SETTLED_RUNS_KEPT) {
      const oldest = this.settledRuns.values().next().value
      if (oldest === undefined) break
      this.settledRuns.delete(oldest)
    }
  }

  /** Records a run a newer one of the same task overtook, and tells the user by the task's policy. */
  private settleQueuedRecord(automation: Automation, run: QueuedRun, why: string): void {
    this.skipRun(automation, why, run, "overlap")
    this.tellAbout(automation, automation.targetThreadId, "skipped")
  }

  /** Tells the window about a run that ended without a turn, when the task's policy says to. */
  private tellAbout(automation: Automation, sessionID: string | undefined, status: "failed" | "skipped"): void {
    if (!notifies(automation.notification, automation.runMode, status, false)) return
    this.deps.publish({ type: "automation.run", sessionID: sessionID ?? "", phase: "finished", notify: true, outcome: status })
  }

  /**
   * A run whose turn would not even begin.
   *
   * `prompt()` can throw for real reasons - a full disk on the first save, a
   * routing call that failed - and its rejection used to be swallowed, leaving
   * the record "running" for ever and the user told nothing (N11-2).
   *
   * `opened` says this run made the conversation it was to run in. One that
   * never got as far as a message is taken away again, so a task that cannot
   * start does not leave an untitled empty conversation in the side column on
   * every occurrence. MiMo does the same by building the conversation
   * unpublished and discarding it on every failing path.
   */
  private async failRun(automation: Automation, sessionID: string, cause: unknown, opened = false): Promise<void> {
    this.runs.delete(sessionID)
    if (opened) {
      const empty = (await this.deps.sessions.messages(sessionID).catch(() => [])).length === 0
      if (empty) await this.deps.sessions.delete?.(sessionID).catch(() => undefined)
    }
    const saved = this.saved.automations.find((entry) => entry.id === automation.id)
    const record = [...(saved?.runHistory ?? [])].reverse().find((entry) => entry.resultThreadId === sessionID && entry.status === "running")
    if (record) {
      record.status = "failed"
      record.finishedAt = this.deps.now()
      record.error = cause instanceof Error ? cause.message : String(cause)
      const reason = this.failureReason(automation)
      if (reason) record.errorCode = reason
      record.reported = true
    }
    console.warn(`[automation] the run of "${automation.title}" could not start`, cause)
    if (notifies(automation.notification, automation.runMode, "failed", false)) {
      this.deps.publish({ type: "automation.run", sessionID, phase: "finished", notify: true, outcome: "failed" })
    } else {
      this.deps.publish({ type: "automation.run", sessionID, phase: "finished", notify: false, outcome: "failed" })
    }
  }

  /**
   * Which of MiMo's reasons a turn that would not begin comes under, when one
   * does: nothing to send, or a model no connected provider offers any more.
   */
  private failureReason(automation: Automation): RunReason | undefined {
    if (!automation.prompt?.trim()) return "empty-prompt"
    const offered = this.deps.models().some((model) => model.provider === automation.model.provider && model.id === automation.model.model)
    return offered ? undefined : "model-unavailable"
  }

  private async run(automation: Automation, entry: QueuedRun): Promise<"started" | "skipped" | "failed"> {
    const inbox = { from: automation.title, automationID: automation.id }
    if (automation.runMode === "existing-task") {
      const target = automation.targetThreadId ? await this.deps.sessions.get(automation.targetThreadId) : undefined
      if (!target) {
        this.skipRun(automation, "The conversation this task runs in no longer exists.", entry, "target-missing")
        this.tellAbout(automation, automation.targetThreadId, "skipped")
        return "skipped"
      }
      /*
       * MiMo skips this run rather than holding it. A conversation that is busy
       * at the minute the task asked for is a run that did not happen, and the
       * sentence it shows the user says so - 本次已跳过, 请稍后重试. Holding it
       * meant the run could land minutes or hours after the time the user
       * chose, and only if the conversation happened to fall idle before the
       * next occurrence came due.
       */
      if (this.deps.busy(target.id)) {
        this.skipRun(automation, "The conversation this task runs in was busy.", entry, "target-busy")
        this.tellAbout(automation, target.id, "skipped")
        return "skipped"
      }
      this.runs.set(target.id, structuredClone(automation))
      this.openRun(automation, target.id, entry)
      this.deps.publish({ type: "automation.run", sessionID: target.id, phase: "started" })
      try {
        await this.deps.prompt({ sessionID: target.id, text: automation.prompt, inbox })
      } catch (cause) {
        await this.failRun(automation, target.id, cause)
        return "failed"
      }
      return "started"
    }
    let directory = automation.project?.path
    if (directory && !(await fs.stat(directory).then((stat) => stat.isDirectory(), () => false))) {
      this.skipRun(automation, "The project folder this task runs in no longer exists.", entry, "project-unavailable")
      this.tellAbout(automation, undefined, "skipped")
      return "skipped"
    }
    directory ??= await this.deps.scratch()
    let session
    try {
      session = await this.deps.sessions.create({
        directory,
        model: { provider: automation.model.provider, model: automation.model.model },
        agent: this.deps.agent(),
        title: automation.title,
        ...(automation.project ? {} : { scratch: true }),
      })
    } catch (cause) {
      this.skipRun(automation, cause instanceof Error ? cause.message : String(cause), entry)
      this.tellAbout(automation, undefined, "skipped")
      return "skipped"
    }
    this.runs.set(session.id, structuredClone(automation))
    this.openRun(automation, session.id, entry)
    this.deps.publish({ type: "automation.run", sessionID: session.id, phase: "started" })
    try {
      await this.deps.prompt({ sessionID: session.id, text: automation.prompt, inbox })
    } catch (cause) {
      await this.failRun(automation, session.id, cause, true)
      return "failed"
    }
    return "started"
  }

  /** A conversation's turn ended: if it was a run, whether to tell the user, by the task's policy. */
  async turnEnded(sessionID: string): Promise<void> {
    const automation = this.runs.get(sessionID)
    if (!automation) return
    this.runs.delete(sessionID)
    const messages = await this.deps.sessions.messages(sessionID)
    const last = [...messages].reverse().find((message) => message.role === "assistant")
    const failed = !last || Boolean(last.role === "assistant" && (last.error || last.finish === "error"))
    const reply = last?.role === "assistant" ? last.parts.some((part) => part.type === "text" && part.text.trim()) : false
    const notify = notifies(automation.notification, automation.runMode, failed ? "failed" : "succeeded", reply)
    // The record this run opened is settled here, so only a run the app outlived stays open.
    const saved = this.saved.automations.find((entry) => entry.id === automation.id)
    const record = [...(saved?.runHistory ?? [])].reverse().find((entry) => entry.resultThreadId === sessionID && entry.status === "running")
    const report: TerminalReport = {
      automationID: automation.id,
      ...(record ? { runId: record.runId } : {}),
      sessionID,
      status: failed ? "failed" : "succeeded",
      finishedAt: this.deps.now(),
      hasNonEmptyReply: reply,
      notify,
    }
    // Journaled first: from here on, a kill anywhere below is replayed at the next start.
    this.reports.push(report)
    await this.writeJournal()
    if (record) {
      record.status = report.status
      record.finishedAt = report.finishedAt
      record.hasNonEmptyReply = reply
      record.reported = true
      await this.save()
    }
    this.deps.publish({ type: "automation.run", sessionID, phase: "finished", notify, outcome: report.status })
    this.reports = this.reports.filter((entry) => entry !== report)
    await this.writeJournal()
  }

  /** Whether a conversation's current turn is a run, for the checks. */
  running(sessionID: string): boolean {
    return this.runs.has(sessionID)
  }

  /** What went wrong reading the saved tasks, and where the damaged file was kept. */
  get unreadable(): { problem?: string; evidence?: string; blocked: boolean; file: string } {
    return { problem: this.problem, evidence: this.evidence, blocked: Boolean(this.blocked), file: this.deps.file }
  }
}

let bound: AutomationService | undefined

export function bindAutomations(service: AutomationService | undefined): void {
  bound = service
}

export function automationService(): AutomationService | undefined {
  return bound
}
