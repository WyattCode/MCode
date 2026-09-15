import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { AgentName, Effort, Message, ModelRef, ServerEvent, SessionInfo, UserMessage } from "@shared/protocol"
import { writeAtomic } from "../storage"
import { ToolError } from "../tool/types"
import { nextOccurrence, parseRRule, scheduleLabel } from "./rrule"

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
}

interface Receipt {
  operationId: string
  fingerprint: string
  response: string
}

interface Saved {
  automations: Automation[]
  seq: number
  receipts: Receipt[]
}

/** MiMo keeps the last 256 operation receipts, so a retried call is answered as it was the first time. */
const RECEIPTS_KEPT = 256
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
}

/** MiMo's rule for telling the user about a finished run. */
export function notifies(policy: NotificationPolicy, runMode: RunMode, status: "succeeded" | "failed" | "skipped", hasReply: boolean): boolean {
  if (policy === "all-runs") return true
  if (policy === "failed-runs") return status === "failed" || status === "skipped"
  return runMode === "existing-task" && status === "succeeded" && hasReply
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

export class AutomationService {
  private saved: Saved = { automations: [], seq: 0, receipts: [] }
  private readonly next = new Map<string, number>()
  /** Runs whose turn has not ended yet, by the conversation they run in. */
  private readonly runs = new Map<string, Automation>()
  private readonly starting = new Set<string>()
  private interval: ReturnType<typeof setInterval> | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly deps: AutomationDeps) {}

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
      } catch {
        // An unreadable file starts empty rather than stopping the app; the file is left as it is until the next change.
      }
    }
    for (const automation of this.saved.automations) this.plan(automation, true)
    if (options.interval === false) return
    this.interval = setInterval(() => void this.tick(), TICK_MS)
    this.interval.unref?.()
  }

  stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval)
    this.interval = undefined
    return this.writing
  }

  list(): Automation[] {
    return this.saved.automations.map((automation) => structuredClone(automation))
  }

  dueAt(id: string): number | undefined {
    return this.next.get(id)
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.saved, null, 2)
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
    const at = nextOccurrence(rule, from, automation.anchorAt)
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
      schedule: scheduleLabel(automation.rrule, automation.label),
      notification: automation.notification,
    }
  }

  /** The app's reasoning level as a task's default; effort is one app-wide value here, not a conversation's own. */
  private appEffort(): { reasoning?: Effort } {
    const effort = this.deps.effort()
    return effort && (REASONING as readonly string[]).includes(effort) ? { reasoning: effort } : {}
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
    if (mode === "list") return JSON.stringify({ automations: this.saved.automations.map((automation) => this.view(automation)) })
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
      const draft: Automation = {
        id: "",
        title: title!,
        prompt: prompt!,
        enabled: status !== "paused",
        runMode: chosenMode,
        ...(chosenMode === "existing-task" ? { targetThreadId: text(input.targetThreadId) ?? caller.id } : {}),
        project,
        model: this.model(text(input.model), caller.model),
        ...(reasoning ? { reasoning: reasoning as Effort } : this.appEffort()),
        rrule: rrule!,
        ...(text(input.scheduleLabel) ? { label: text(input.scheduleLabel) } : {}),
        notification: (notification as NotificationPolicy | undefined) ?? (chosenMode === "existing-task" ? "important-updates" : "all-runs"),
        revision: 1,
        createdAt: now,
        updatedAt: now,
        anchorAt: now,
      }
      // The same task asked for twice is kept once, as MiMo does.
      const same = (automation: Automation) => {
        const { id: _a, revision: _b, createdAt: _c, updatedAt: _d, anchorAt: _e, lastFiredAt: _f, ...rest } = automation
        return JSON.stringify(rest)
      }
      const duplicate = this.saved.automations.find((automation) => same(automation) === same(draft))
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
      const title = text(input.title)
      const prompt = text(input.prompt)
      if (title) automation.title = title
      if (prompt) automation.prompt = prompt
      if (input.model !== undefined || reasoning) automation.model = this.model(text(input.model), automation.model)
      if (reasoning) automation.reasoning = reasoning as Effort
      if (rrule !== undefined) {
        automation.rrule = rrule
        automation.anchorAt = now
      }
      if (input.scheduleLabel !== undefined) automation.label = text(input.scheduleLabel)
      if (input.project !== undefined) automation.project = project
      if (status) automation.enabled = status === "active"
      const before = automation.runMode
      if (runMode) automation.runMode = runMode as RunMode
      // MiMo's defaults when the run target changes and nothing else was said.
      if (notification) automation.notification = notification as NotificationPolicy
      else if (automation.runMode === "existing-task" && before !== "existing-task" && automation.notification === "all-runs") automation.notification = "important-updates"
      else if (automation.runMode === "new-task" && before !== "new-task" && automation.notification === "important-updates") automation.notification = "all-runs"
      if (text(input.targetThreadId)) automation.targetThreadId = text(input.targetThreadId)
      else if (automation.runMode === "existing-task" && !automation.targetThreadId) automation.targetThreadId = caller.id
      if (automation.runMode === "new-task") delete automation.targetThreadId
    }
    automation.revision++
    automation.updatedAt = now
    this.plan(automation, mode === "resume")
    return answer({ ok: true, automation: this.view(automation) })
  }

  /** One check: every task that is due and can start, starts. */
  async tick(): Promise<void> {
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
      if (!target) return "skipped"
      if (this.deps.busy(target.id)) return "waiting"
      this.runs.set(target.id, structuredClone(automation))
      this.deps.publish({ type: "automation.run", sessionID: target.id, phase: "started" })
      await this.deps.prompt({ sessionID: target.id, text: automation.prompt, inbox }).catch(() => this.runs.delete(target.id))
      return "started"
    }
    let directory = automation.project?.path
    if (directory && !(await fs.stat(directory).then((stat) => stat.isDirectory(), () => false))) return "skipped"
    directory ??= await this.deps.scratch()
    const session = await this.deps.sessions.create({
      directory,
      model: { provider: automation.model.provider, model: automation.model.model },
      agent: this.deps.agent(),
      title: automation.title,
      ...(automation.project ? {} : { scratch: true }),
    })
    this.runs.set(session.id, structuredClone(automation))
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
    this.deps.publish({ type: "automation.run", sessionID, phase: "finished", notify })
  }

  /** Whether a conversation's current turn is a run, for the checks. */
  running(sessionID: string): boolean {
    return this.runs.has(sessionID)
  }
}

let bound: AutomationService | undefined

export function bindAutomations(service: AutomationService | undefined): void {
  bound = service
}

export function automationService(): AutomationService | undefined {
  return bound
}
