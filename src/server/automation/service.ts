import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { AgentName, Effort, Message, ModelRef, ServerEvent, SessionInfo, UserMessage } from "@shared/protocol"
import { quarantine, writeAtomic } from "../storage"
import { ToolError } from "../tool/types"
import { menuEfforts } from "@shared/effort-menu"
import { chineseSchedule, nextOccurrence, parseRRule, scheduleKey, scheduleLabel } from "./rrule"

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
  /** Set once the user has been told about a run that did not finish. */
  reported?: boolean
}

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
}

/** Raise this only when a change would be misread by a build that predates it. */
export const AUTOMATION_SCHEMA_VERSION = 1

/** MiMo keeps the last 256 operation receipts, so a retried call is answered as it was the first time. */
const RECEIPTS_KEPT = 256
/** How many runs a task remembers. */
const RUNS_KEPT = 20
/** What a run that the app ended is recorded as. */
const CLOSED_MID_RUN = "The app closed before the run finished."
const TICK_MS = 1000

export interface AutomationDeps {
  file: string
  now(): number
  sessions: {
    get(sessionID: string): Promise<SessionInfo | undefined>
    create(input: { directory: string; model: ModelRef; agent?: AgentName; title?: string; scratch?: boolean }): Promise<SessionInfo>
    messages(sessionID: string): Promise<Message[]>
  }
  prompt(input: { sessionID: string; text: string; inbox: UserMessage["inbox"] }): Promise<unknown>
  busy(sessionID: string): boolean
  /** The models of connected providers, as `provider/model` with a display name. */
  models(): { provider: string; id: string; name: string }[]
  agent(): AgentName
  /** The app-wide reasoning level. */
  effort(): Effort | undefined
  /** A fresh folder for a task with no project. */
  scratch(): Promise<string>
  publish(event: ServerEvent): void
  /** The interface language, which the schedules a task view shows are written in. */
  locale?(): string | undefined
}

/** MiMo's rule for telling the user about a finished run. */
export function notifies(policy: NotificationPolicy, runMode: RunMode, status: "succeeded" | "failed" | "skipped", hasReply: boolean): boolean {
  if (policy === "all-runs") return true
  if (policy === "failed-runs") return status === "failed" || status === "skipped"
  return runMode === "existing-task" && status === "succeeded" && hasReply
}

/** MiMo refuses the two pairings where the notification rule could never, or would always, fire. */
export function clashes(runMode: RunMode, notification: NotificationPolicy): boolean {
  return (runMode === "new-task" && notification === "important-updates") || (runMode === "existing-task" && notification === "all-runs")
}

/** A value with its keys in order, so two equal objects write out the same. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** The ten things MiMo compares to tell whether a task asked for is one already kept. */
export function taskIdentity(automation: Automation): string {
  return JSON.stringify(
    ordered({
      title: automation.title,
      prompt: automation.prompt,
      enabled: automation.enabled,
      runMode: automation.runMode,
      targetThreadId: automation.targetThreadId ?? null,
      project: automation.project,
      model: { provider: automation.model.provider, model: automation.model.model, name: automation.model.name },
      reasoning: automation.reasoning ?? null,
      schedule: scheduleKey(automation.rrule, automation.label),
      notification: automation.notification,
    }),
  )
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

export class AutomationService {
  private saved: Saved = { automations: [], seq: 0, receipts: [] }
  private readonly next = new Map<string, number>()
  /** Runs whose turn has not ended yet, by the conversation they run in. */
  private readonly runs = new Map<string, Automation>()
  private readonly starting = new Set<string>()
  /** Runs that ended with the app and have not been reported yet; sent on the first check. */
  private readonly pendingReports: { sessionID: string; notify: boolean }[] = []
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
      this.pendingReports.push({ sessionID: report.sessionID, notify: report.notify })
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
          automations: Array.isArray(parsed.automations) ? parsed.automations.filter((entry) => entry && typeof entry.id === "string" && parseRRule(entry.rrule ?? "")) : [],
          seq: typeof parsed.seq === "number" ? parsed.seq : 0,
          receipts: Array.isArray(parsed.receipts) ? parsed.receipts.slice(-RECEIPTS_KEPT) : [],
        }
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
          settled = true
        }
        if (record.status !== "skipped" || record.reported) continue
        record.reported = true
        settled = true
        if (record.resultThreadId) {
          this.pendingReports.push({ sessionID: record.resultThreadId, notify: notifies(automation.notification, automation.runMode, "skipped", false) })
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
        ended = true
      }
    }
    this.runs.clear()
    if (ended) void this.save()
    return this.writing
  }

  /** Opens a record for a run that is starting, keeping only the last few. */
  private openRun(automation: Automation, sessionID: string): void {
    const at = this.deps.now()
    const record: RunRecord = {
      runId: `run-${at.toString(36)}-${sessionID.slice(-8)}`,
      scheduledFor: this.next.get(automation.id) ?? at,
      startedAt: at,
      status: "running",
      resultThreadId: sessionID,
    }
    automation.runHistory = [...(automation.runHistory ?? []), record].slice(-RUNS_KEPT)
    void this.save()
  }

  /** Records a run that could not start - its conversation or folder is gone - as skipped. */
  private skipRun(automation: Automation, why: string, sessionID?: string): void {
    const at = this.deps.now()
    const record: RunRecord = {
      runId: `run-${at.toString(36)}-skipped`,
      scheduledFor: this.next.get(automation.id) ?? at,
      startedAt: at,
      finishedAt: at,
      status: "skipped",
      error: why,
      reported: true,
      ...(sessionID ? { resultThreadId: sessionID } : {}),
    }
    automation.runHistory = [...(automation.runHistory ?? []), record].slice(-RUNS_KEPT)
  }

  list(): Automation[] {
    return this.saved.automations.map((automation) => structuredClone(automation))
  }

  dueAt(id: string): number | undefined {
    return this.next.get(id)
  }

  private save(): Promise<void> {
    // Never written over a document that would not parse: what is in it is the
    // user's only copy, and an empty one on top makes the loss permanent.
    if (this.blocked) return this.writing
    // Nor over one a newer build wrote, for the same reason in a different key.
    if (this.fromNewerVersion) return this.writing
    const snapshot = JSON.stringify({ schemaVersion: AUTOMATION_SCHEMA_VERSION, ...this.saved }, null, 2)
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
      schedule: scheduleLabel(automation.rrule, automation.label, chineseSchedule(this.deps.locale?.())),
      notification: automation.notification,
    }
  }

  /**
   * A task's reasoning level for its model, as MiMo checks it: one the model
   * offers, when one is asked for; otherwise the app's level where the model
   * offers it, or the model's usual one. A model that offers none takes none.
   */
  private reasoningFor(model: Automation["model"], asked: string | undefined): { reasoning?: Effort } {
    const offered = menuEfforts(model.model, model.name)
    if (asked) {
      if (!offered.includes(asked as Effort)) {
        const choices = offered.length ? `supported values: ${offered.join(", ")}` : "this model takes no reasoning level, so leave reasoning out"
        throw new ToolError(`reasoning "${asked}" is not supported by model "${model.provider}/${model.model}"; ${choices}.`)
      }
      return { reasoning: asked as Effort }
    }
    if (!offered.length) return {}
    const effort = this.deps.effort()
    return { reasoning: effort && offered.includes(effort) ? effort : offered.includes("medium") ? "medium" : offered[0] }
  }

  /**
   * Where an existing-task run may go: this conversation, or another the side
   * column shows - one that is there, not archived and not a subagent's. MCode
   * has no pinned conversations, which is what MiMo accepts besides the caller.
   */
  private async checkTarget(id: string, caller: SessionInfo): Promise<string> {
    if (id === caller.id) return id
    const target = await this.deps.sessions.get(id)
    if (!target || target.archived || target.parentID) {
      throw new ToolError(
        `targetThreadId must be this conversation or another conversation in the side column that is not archived and is not a subagent's; "${id}" is not one. Leave it out to run in this conversation.`,
      )
    }
    return id
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

    // The two notification pairings MiMo refuses, on create and on the merged result of an update.
    const clash = (mode: RunMode, policy: NotificationPolicy) => {
      if (!clashes(mode, policy)) return
      const allowed = NOTIFICATIONS.filter((entry) => !clashes(mode, entry)).join(" or ")
      throw new ToolError(`notification "${policy}" does not go with runMode "${mode}"; use ${allowed}.`)
    }

    if (mode === "create") {
      const title = text(input.title)
      const prompt = text(input.prompt)
      const missing = [!title && "title", !prompt && "prompt", !rrule && "rrule"].filter(Boolean)
      if (missing.length) throw new ToolError(`create needs: ${missing.join(", ")}`)
      const chosenMode = (runMode as RunMode | undefined) ?? "new-task"
      const policy = (notification as NotificationPolicy | undefined) ?? (chosenMode === "existing-task" ? "important-updates" : "all-runs")
      clash(chosenMode, policy)
      const model = this.model(text(input.model), caller.model)
      const draft: Automation = {
        id: "",
        title: title!,
        prompt: prompt!,
        enabled: status !== "paused",
        runMode: chosenMode,
        ...(chosenMode === "existing-task" ? { targetThreadId: await this.checkTarget(text(input.targetThreadId) ?? caller.id, caller) } : {}),
        project,
        model,
        ...this.reasoningFor(model, reasoning),
        rrule: rrule!,
        ...(text(input.scheduleLabel) ? { label: text(input.scheduleLabel) } : {}),
        notification: policy,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        anchorAt: now,
      }
      // The same task asked for twice is kept once, compared as MiMo compares them - its runs so far do not count.
      const identity = taskIdentity(draft)
      const duplicate = this.saved.automations.find((automation) => taskIdentity(automation) === identity)
      if (duplicate) return answer({ ok: true, created: false, deduplicated: true, automation: this.view(duplicate) })
      draft.id = `auto-${++this.saved.seq}`
      this.saved.automations.push(draft)
      this.plan(draft, true)
      return answer({ ok: true, automation: this.view(draft) })
    }

    const automation = find(idOf())
    if (mode === "delete") {
      this.saved.automations = this.saved.automations.filter((entry) => entry.id !== automation.id)
      this.next.delete(automation.id)
      return answer({ ok: true, id: automation.id })
    }
    if (mode === "pause" || mode === "resume") {
      automation.enabled = mode === "resume"
    } else {
      // A title or prompt passed empty is refused, as MiMo's check refuses it, rather than quietly kept.
      for (const field of ["title", "prompt"] as const) {
        if (input[field] !== undefined && !text(input[field])) throw new ToolError(`${field} cannot be empty; leave it out to keep the current one.`)
      }
      // Worked out on a copy, so a change refused below leaves the task as it was.
      const next: Automation = structuredClone(automation)
      const title = text(input.title)
      const prompt = text(input.prompt)
      if (title) next.title = title
      if (prompt) next.prompt = prompt
      if (input.model !== undefined) next.model = this.model(text(input.model), next.model)
      if (input.model !== undefined || reasoning) {
        const { reasoning: level } = this.reasoningFor(next.model, reasoning ?? (next.reasoning && menuEfforts(next.model.model, next.model.name).includes(next.reasoning) ? next.reasoning : undefined))
        if (level) next.reasoning = level
        else delete next.reasoning
      }
      if (rrule !== undefined) {
        next.rrule = rrule
        next.anchorAt = now
      }
      if (input.scheduleLabel !== undefined) next.label = text(input.scheduleLabel)
      if (input.project !== undefined) next.project = project
      if (status) next.enabled = status === "active"
      const before = next.runMode
      if (runMode) next.runMode = runMode as RunMode
      // MiMo's defaults when the run target changes and nothing else was said.
      if (notification) next.notification = notification as NotificationPolicy
      else if (next.runMode === "existing-task" && before !== "existing-task" && next.notification === "all-runs") next.notification = "important-updates"
      else if (next.runMode === "new-task" && before !== "new-task" && next.notification === "important-updates") next.notification = "all-runs"
      clash(next.runMode, next.notification)
      const target = text(input.targetThreadId)
      if (next.runMode === "new-task") delete next.targetThreadId
      else if (target) next.targetThreadId = await this.checkTarget(target, caller)
      else if (!next.targetThreadId) next.targetThreadId = caller.id
      Object.assign(automation, next)
      if (!next.reasoning) delete automation.reasoning
      if (!next.targetThreadId) delete automation.targetThreadId
      if (next.label === undefined) delete automation.label
    }
    automation.revision++
    automation.updatedAt = now
    this.plan(automation, mode === "resume")
    return answer({ ok: true, automation: this.view(automation) })
  }

  /** One check: every task that is due and can start, starts. */
  async tick(): Promise<void> {
    /*
     * Runs that ended with the app are told of on the first check rather than
     * at start-up: nothing is listening while the backend is still opening its
     * socket, and an event published then would be published to nobody.
     */
    for (const report of this.pendingReports.splice(0)) {
      this.deps.publish({ type: "automation.run", sessionID: report.sessionID, phase: "finished", notify: report.notify })
    }
    const now = this.deps.now()
    const due = [...this.next.entries()].filter(([id, at]) => at <= now && !this.starting.has(id)).sort((a, b) => a[1] - b[1])
    for (const [id] of due) {
      const automation = this.saved.automations.find((entry) => entry.id === id)
      if (!automation) {
        this.next.delete(id)
        continue
      }
      this.starting.add(id)
      try {
        const started = await this.run(automation)
        // A conversation that is busy is tried again on the next check; anything else moves the schedule on.
        if (started === "waiting") continue
        automation.lastFiredAt = now
        this.plan(automation)
        await this.save()
      } finally {
        this.starting.delete(id)
      }
    }
  }

  private async run(automation: Automation): Promise<"started" | "skipped" | "waiting"> {
    const inbox = { from: automation.title, automationID: automation.id }
    if (automation.runMode === "existing-task") {
      const target = automation.targetThreadId ? await this.deps.sessions.get(automation.targetThreadId) : undefined
      // A conversation that is gone - deleted, or put away - is a run skipped, and recorded as one.
      if (!target || target.archived) {
        this.skipRun(automation, "The conversation this task runs in no longer exists.", automation.targetThreadId)
        return "skipped"
      }
      if (this.deps.busy(target.id)) return "waiting"
      this.runs.set(target.id, structuredClone(automation))
      this.openRun(automation, target.id)
      this.deps.publish({ type: "automation.run", sessionID: target.id, phase: "started" })
      await this.deps.prompt({ sessionID: target.id, text: automation.prompt, inbox }).catch(() => this.runs.delete(target.id))
      return "started"
    }
    let directory = automation.project?.path
    if (directory && !(await fs.stat(directory).then((stat) => stat.isDirectory(), () => false))) {
      this.skipRun(automation, "The project folder this task runs in no longer exists.")
      return "skipped"
    }
    directory ??= await this.deps.scratch()
    const session = await this.deps.sessions.create({
      directory,
      model: { provider: automation.model.provider, model: automation.model.model },
      agent: this.deps.agent(),
      title: automation.title,
      ...(automation.project ? {} : { scratch: true }),
    })
    this.runs.set(session.id, structuredClone(automation))
    this.openRun(automation, session.id)
    this.deps.publish({ type: "automation.run", sessionID: session.id, phase: "started" })
    await this.deps.prompt({ sessionID: session.id, text: automation.prompt, inbox }).catch(() => this.runs.delete(session.id))
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
    this.deps.publish({ type: "automation.run", sessionID, phase: "finished", notify })
    this.reports = this.reports.filter((entry) => entry !== report)
    await this.writeJournal()
  }

  /** Whether a conversation's current turn is a run, for the checks. */
  running(sessionID: string): boolean {
    return this.runs.has(sessionID)
  }

  /** What went wrong reading the saved tasks, and where the damaged file was kept. */
  get unreadable(): { problem?: string; evidence?: string; blocked: boolean } {
    return { problem: this.problem, evidence: this.evidence, blocked: Boolean(this.blocked) }
  }
}

let bound: AutomationService | undefined

export function bindAutomations(service: AutomationService | undefined): void {
  bound = service
}

export function automationService(): AutomationService | undefined {
  return bound
}
