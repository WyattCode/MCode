import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { SessionInfo } from "@shared/protocol"
import { scheduledPromptText } from "@shared/scheduled"
import { JITTER, clampLoopDelay, oneShotFireAt, recurringFireAt } from "./expr"
import type { Stats } from "node:fs"
import { cronFile, missedTasks, readCronFile, readCronTasks, schedulable, writeCronTasks, type CronTask } from "./tasks"

/**
 * cron: the scheduler behind the `cron` tool, as MiMo's runs it - a check once
 * a second while the app is open, firing at most one due task per check, and
 * only while the conversation it fires into is idle. A fired prompt runs as an
 * ordinary turn, so permissions ask as they always do.
 *
 * A durable task belongs to its project rather than to one conversation, as
 * MiMo's schedule does (the user's 2026-09-16 decision): it lives in the
 * project's `.mcode/scheduled_tasks.json`, and deleting the conversation that
 * made it leaves it running - the next run is adopted by a new conversation in
 * that project, and the file is rewritten to name it so later runs keep to the
 * same one. The stored shape does not change, so a file written before this
 * still reads: `createdBySessionId` simply stops meaning "delete me when that
 * conversation goes".
 *
 * Session-only tasks - and every loop, which MiMo keeps to its session - still
 * end with their conversation and with the app. A lock file beside a project's
 * task file keeps two copies of the app from firing the same task.
 */

export interface SchedulerHost {
  now(): number
  /** Starts a turn in the conversation with this text. */
  fire(sessionID: string, text: string): Promise<void>
  busy(sessionID: string): boolean
  session(sessionID: string): Promise<SessionInfo | undefined>
  /** Opens a conversation in a project, for a durable task whose own conversation is gone. */
  create(directory: string): Promise<SessionInfo>
  /** The project folders whose durable tasks are looked after. */
  directories(): Promise<string[]>
}

/** MiMo's loop keepalive: one extra run after a turn that did not re-arm, 20 minutes later. */
export const KEEPALIVE_BUDGET = 1
export const KEEPALIVE_DELAY_SECONDS = 1200

const TICK_MS = 1000
/** How often the list of project folders is read again. */
const DIRECTORIES_MS = 30_000
/** How often the holder of a project's lock stamps it. */
const LOCK_STAMP_MS = 30_000
/** How long after its last stamp a lock is treated as one a stopped run left behind. */
const LOCK_STALE_MS = 5 * 60_000

interface LoopState {
  ownerID: string
  prompt: string
  startedAt: number
  lastScheduledFor: number
  strikes: number
}

interface Durable {
  mtimeMs: number
  tasks: CronTask[]
  owned: boolean
}

export const newTaskID = () => randomUUID().replace(/-/g, "").slice(0, 8)

/** What a conversation opened to carry on a project's schedule is called. */
export const ADOPTED_TITLE = "Scheduled tasks"

/** What a fired prompt reads as, in the transcript and to the model; the window recognises it by the same words. */
export function firedText(task: CronTask, at: number): string {
  return scheduledPromptText(task.kind ?? "cron", task.id, at, task.prompt)
}

export class CronScheduler {
  private readonly sessionTasks = new Map<string, CronTask & { directory: string }>()
  private readonly nextFireAt = new Map<string, number>()
  private readonly inFlight = new Set<string>()
  private readonly durable = new Map<string, Durable>()
  private readonly loops = new Map<string, LoopState>()
  private readonly armedThisTurn = new Map<string, Set<string>>()
  private known: string[] = []
  private knownAt = -Infinity
  private interval: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private stampedAt = -Infinity
  private readonly startedAt = Date.now()

  constructor(private readonly host: SchedulerHost) {}

  /** A conversation, as the host knows it; the tool resolves who a call acts for through this. */
  session(sessionID: string): Promise<SessionInfo | undefined> {
    return this.host.session(sessionID)
  }

  /**
   * Takes the locks, fires the one-shots missed while the app was closed, and
   * starts checking once a second - unless `interval` is false, for a caller
   * that drives `tick` itself.
   */
  async start(options: { interval?: boolean } = {}): Promise<void> {
    await this.refreshDirectories(true)
    const now = this.host.now()
    for (const [directory, state] of this.durable) {
      if (!state.owned) continue
      for (const task of missedTasks(state.tasks, now, (entry) => oneShotFireAt(entry.cron, entry.lastFiredAt ?? entry.createdAt, entry.id))) {
        // A task missed while the app was closed still runs, in a new conversation when its own is gone.
        const owner = (task.createdBySessionId ? await this.host.session(task.createdBySessionId) : undefined) ?? (await this.host.create(directory).catch(() => undefined))
        if (owner) await this.host.fire(owner.id, firedText(task, now)).catch(() => undefined)
        await this.rewrite(directory, (tasks) => tasks.filter((entry) => entry.id !== task.id))
      }
    }
    if (options.interval === false) return
    // A project file that cannot be written (L12-8) fails that check, never the process.
    this.interval = setInterval(() => void this.tick().catch((cause: unknown) => console.warn("[cron] a check failed:", cause instanceof Error ? cause.message : cause)), TICK_MS)
    this.interval.unref?.()
  }

  async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval)
    this.interval = undefined
    for (const [directory, state] of this.durable) if (state.owned) await this.releaseLock(directory)
  }

  private lockFile(directory: string) {
    return path.join(directory, ".mcode", ".cron-lock")
  }

  /** Claims a project's durable tasks for this process, unless a live one holds them. */
  private async takeLock(directory: string): Promise<boolean> {
    const file = this.lockFile(directory)
    const mine = JSON.stringify({ pid: process.pid, startedAt: this.startedAt })
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined)
    const created = await fs.writeFile(file, mine, { flag: "wx" }).then(
      () => true,
      () => false,
    )
    if (created) return true
    const held = await fs.readFile(file, "utf8").then((raw) => JSON.parse(raw) as { pid?: unknown; startedAt?: unknown }).catch(() => undefined)
    if (held && held.pid === process.pid && held.startedAt === this.startedAt) return true
    /*
     * A pid that is alive is not proof that the app holding this lock is: the
     * file outlives a hard kill or a power loss (only `stop()` removes it), and
     * Windows hands a dead run's pid on to something unrelated soon enough. So
     * a lock is only respected while its holder keeps stamping it, which a
     * running scheduler does on every pass (`stampLocks`).
     */
    if (held && typeof held.pid === "number" && held.pid !== process.pid && alive(held.pid)) {
      // The file's own clock, so a host with a scripted `now()` is not what decides this.
      const stamped = await fs.stat(file).then((info) => info.mtimeMs, () => 0)
      if (Date.now() - stamped < LOCK_STALE_MS) return false
    }
    // A lock nobody holds any more, or one that cannot be read, is taken over.
    await fs.writeFile(file, mine).catch(() => undefined)
    return true
  }

  /**
   * Keeps this process's locks stamped, so another copy can tell one that is
   * held from one a killed run left behind.
   */
  private async stampLocks(): Promise<void> {
    const now = Date.now()
    if (now - this.stampedAt < LOCK_STAMP_MS) return
    this.stampedAt = now
    const at = new Date(now)
    for (const [directory, state] of this.durable) {
      if (state.owned) await fs.utimes(this.lockFile(directory), at, at).catch(() => undefined)
    }
  }

  private async releaseLock(directory: string): Promise<void> {
    const file = this.lockFile(directory)
    const held = await fs.readFile(file, "utf8").then((raw) => JSON.parse(raw) as { pid?: unknown }).catch(() => undefined)
    if (held?.pid === process.pid) await fs.rm(file, { force: true }).catch(() => undefined)
  }

  private async refreshDirectories(force = false): Promise<void> {
    const now = Date.now()
    if (!force && now - this.knownAt < DIRECTORIES_MS) return
    this.knownAt = now
    this.known = [...new Set([...(await this.host.directories().catch(() => [])), ...this.durable.keys()])]
    for (const directory of this.known) await this.load(directory)
  }

  /** A project's durable tasks, read again only when the file has changed. */
  private async load(directory: string): Promise<Durable | undefined> {
    /*
     * Only a file that is genuinely gone empties the list. A failed stat used to
     * do it too - and it emptied the cache in place without moving `mtimeMs`, so
     * the next tick found the file unchanged, returned the emptied cache, and
     * the project's durable tasks never fired again for the life of the process.
     * One blink of EBUSY out of a once-a-second poll was enough, and nothing
     * was logged or shown (R25-A3).
     */
    let stat: Stats | undefined
    let unreadable = false
    try {
      stat = await fs.stat(cronFile(directory))
    } catch (cause) {
      unreadable = (cause as NodeJS.ErrnoException).code !== "ENOENT"
    }
    const cached = this.durable.get(directory)
    if (unreadable) return cached
    if (!stat) {
      if (cached) cached.tasks = []
      return cached
    }
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached
    const read = await readCronFile(directory)
    // A read that is blocked leaves the cache as it was rather than replacing it with nothing.
    if (read.blocked) return cached
    const tasks = read.tasks.map((task) => ({ ...task, durable: true }))
    const owned = cached?.owned === true ? true : await this.takeLock(directory)
    const state = { mtimeMs: stat.mtimeMs, tasks, owned }
    this.durable.set(directory, state)
    return state
  }

  private async rewrite(directory: string, change: (tasks: CronTask[]) => CronTask[]): Promise<void> {
    const read = await readCronFile(directory)
    // Never over a file that could not be read or moved aside: it holds the project's only copy of its tasks.
    if (read.blocked) throw new Error(read.blocked)
    const next = change(read.tasks)
    await writeCronTasks(directory, next)
    const stat = await fs.stat(cronFile(directory)).catch(() => undefined)
    const state = this.durable.get(directory)
    this.durable.set(directory, { mtimeMs: stat?.mtimeMs ?? 0, tasks: next.map((task) => ({ ...task, durable: true })), owned: state?.owned === true ? true : await this.takeLock(directory) })
  }

  private fireAt(task: CronTask, from: number): number {
    const at = task.recurring ? recurringFireAt(task.cron, from, task.id) : oneShotFireAt(task.cron, from, task.id)
    return at ?? Number.POSITIVE_INFINITY
  }

  /** One check: the first due task whose conversation is idle fires. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.refreshDirectories()
      await this.stampLocks()
      const entries: { task: CronTask; directory?: string }[] = []
      for (const [directory, state] of this.durable) {
        /*
         * A lock somebody else holds is tried again on every pass. It used to
         * be asked for once and the refusal kept for the life of the process,
         * so a lock file a killed run left behind - or one whose pid had been
         * handed on - stopped every durable task in that project for good, with
         * nothing said on screen or in the log.
         */
        if (!state.owned) state.owned = await this.takeLock(directory)
        if (!state.owned) continue
        const fresh = await this.load(directory)
        for (const task of fresh?.tasks ?? []) entries.push({ task, directory })
      }
      for (const task of this.sessionTasks.values()) entries.push({ task })
      const now = this.host.now()
      for (const { task, directory } of entries) {
        if (this.inFlight.has(task.id) || !schedulable(task)) continue
        if (!this.nextFireAt.has(task.id)) this.nextFireAt.set(task.id, this.fireAt(task, task.lastFiredAt ?? task.createdAt))
        if (now < (this.nextFireAt.get(task.id) ?? Number.POSITIVE_INFINITY)) continue
        const ownerID = task.createdBySessionId
        const known = ownerID ? await this.host.session(ownerID) : undefined
        /*
         * A durable task outlives the conversation that made it: when that one
         * is gone a new conversation in the task's own project takes it over,
         * and the file is rewritten to name it. A session-only task still ends
         * with its conversation, since it never outlived the app run anyway.
         */
        let owner = known
        let adopted = false
        if (!owner && directory) {
          owner = await this.host.create(directory).catch(() => undefined)
          // Nothing to run it in this time round; the task keeps its place and is tried again.
          if (!owner) continue
          adopted = true
        }
        if (owner && this.host.busy(owner.id)) continue
        this.inFlight.add(task.id)
        try {
          const aged = task.recurring === true && task.permanent !== true && now - task.createdAt >= JITTER.recurringMaxAgeMs
          if (owner) await this.host.fire(owner.id, firedText(task, now)).catch(() => undefined)
          if (owner && task.recurring && !aged) {
            const taken = adopted ? owner.id : undefined
            this.nextFireAt.set(task.id, this.fireAt(task, now))
            if (directory) {
              await this.rewrite(directory, (tasks) =>
                tasks.map((entry) => (entry.id === task.id ? { ...entry, lastFiredAt: now, ...(taken ? { createdBySessionId: taken } : {}) } : entry)),
              )
            }
          } else {
            // A one-shot has run, a recurring task has aged out, or its conversation is gone: it ends.
            this.nextFireAt.delete(task.id)
            if (directory) await this.rewrite(directory, (tasks) => tasks.filter((entry) => entry.id !== task.id))
            else this.sessionTasks.delete(task.id)
            if (task.kind === "loop" && ownerID && !owner) this.loops.delete(loopKey(ownerID, task.prompt))
          }
        } finally {
          this.inFlight.delete(task.id)
        }
        return
      }
    } finally {
      this.ticking = false
    }
  }

  async add(input: { ownerID: string; directory: string; cron: string; prompt: string; recurring: boolean; durable: boolean }): Promise<CronTask> {
    const task: CronTask = { id: newTaskID(), cron: input.cron, prompt: input.prompt, createdAt: this.host.now(), recurring: input.recurring, createdBySessionId: input.ownerID, durable: input.durable }
    if (input.durable) {
      await this.rewrite(input.directory, (tasks) => [...tasks, task])
      if (!this.known.includes(input.directory)) this.known.push(input.directory)
    } else {
      this.sessionTasks.set(task.id, { ...task, directory: input.directory })
    }
    return task
  }

  private async all(): Promise<{ task: CronTask; directory: string }[]> {
    await this.refreshDirectories()
    const out: { task: CronTask; directory: string }[] = []
    for (const [directory] of this.durable) for (const task of (await this.load(directory))?.tasks ?? []) out.push({ task, directory })
    for (const { directory, ...task } of this.sessionTasks.values()) out.push({ task: { ...task, durable: false }, directory })
    return out
  }

  async get(id: string, scope?: Scope): Promise<CronTask | undefined> {
    const found = (await this.all()).find((entry) => entry.task.id === id)
    if (!found || !reaches(scope, found.task, found.directory)) return undefined
    return found.task
  }

  async list(filter: { scope?: Scope; kind?: "cron" | "loop"; durableOnly?: boolean }): Promise<CronTask[]> {
    return (await this.all())
      .filter((entry) => reaches(filter.scope, entry.task, entry.directory))
      .map((entry) => entry.task)
      .filter((task) => {
        if (filter.kind === "loop" && task.kind !== "loop") return false
        if (filter.kind === "cron" && task.kind === "loop") return false
        if (filter.durableOnly && task.durable !== true) return false
        return true
      })
  }

  async remove(id: string, scope?: Scope): Promise<boolean> {
    const found = (await this.all()).find((entry) => entry.task.id === id)
    if (!found || !reaches(scope, found.task, found.directory)) return false
    this.nextFireAt.delete(id)
    if (this.sessionTasks.delete(id)) return true
    await this.rewrite(found.directory, (tasks) => tasks.filter((task) => task.id !== id))
    return true
  }

  async rename(id: string, prompt: string, scope?: Scope): Promise<boolean> {
    const found = (await this.all()).find((entry) => entry.task.id === id)
    if (!found || !reaches(scope, found.task, found.directory)) return false
    const session = this.sessionTasks.get(id)
    if (session) {
      this.sessionTasks.set(id, { ...session, prompt })
      return true
    }
    await this.rewrite(found.directory, (tasks) => tasks.map((task) => (task.id === id ? { ...task, prompt } : task)))
    return true
  }

  /**
   * A self-paced loop: one run `delaySeconds` from now (clamped to 60-3600,
   * on a whole minute), replacing the same prompt's earlier run. A loop ends
   * when it has gone a week, and nothing is armed then.
   */
  armLoop(input: { ownerID: string; directory: string; prompt: string; delaySeconds: number; viaKeepalive?: boolean }) {
    const now = this.host.now()
    const key = loopKey(input.ownerID, input.prompt)
    const existing = this.loops.get(key)
    if (existing && now - existing.startedAt >= JITTER.recurringMaxAgeMs) {
      this.endLoop(input.ownerID, input.prompt)
      return undefined
    }
    const clamped = clampLoopDelay(input.delaySeconds)
    const target = new Date(now + clamped * 1000)
    target.setUTCSeconds(0, 0)
    if (target.getTime() <= now) target.setUTCMinutes(target.getUTCMinutes() + 1)
    const superseded = this.dropLoopRuns(input.ownerID, input.prompt)
    const id = newTaskID()
    this.sessionTasks.set(id, {
      id,
      cron: `${target.getUTCMinutes()} ${target.getUTCHours()} * * *`,
      prompt: input.prompt,
      createdAt: now,
      kind: "loop",
      recurring: false,
      createdBySessionId: input.ownerID,
      directory: input.directory,
    })
    this.nextFireAt.set(id, target.getTime())
    this.loops.set(key, { ownerID: input.ownerID, prompt: input.prompt, startedAt: existing?.startedAt ?? now, lastScheduledFor: target.getTime(), strikes: existing?.strikes ?? 0 })
    if (!input.viaKeepalive) this.armedThisTurn.set(input.ownerID, new Set([...(this.armedThisTurn.get(input.ownerID) ?? []), input.prompt]))
    return { id, scheduledFor: target.getTime(), clampedSeconds: clamped, wasClamped: clamped !== input.delaySeconds, superseded }
  }

  private dropLoopRuns(ownerID: string, prompt: string): number {
    let dropped = 0
    for (const [id, task] of this.sessionTasks) {
      if (task.kind !== "loop" || task.prompt !== prompt || task.createdBySessionId !== ownerID) continue
      this.sessionTasks.delete(id)
      this.nextFireAt.delete(id)
      dropped++
    }
    return dropped
  }

  endLoop(ownerID: string, prompt: string): void {
    this.dropLoopRuns(ownerID, prompt)
    this.loops.delete(loopKey(ownerID, prompt))
  }

  /**
   * After a conversation's turn: a loop it re-armed starts its count again; a
   * loop whose run has come and gone without being re-armed gets one more run
   * twenty minutes on, and ends if it had that already.
   */
  turnEnded(ownerID: string): void {
    const armed = this.armedThisTurn.get(ownerID) ?? new Set<string>()
    this.armedThisTurn.delete(ownerID)
    const now = this.host.now()
    for (const loop of [...this.loops.values()]) {
      if (loop.ownerID !== ownerID) continue
      if (armed.has(loop.prompt)) {
        loop.strikes = 0
        continue
      }
      if (loop.lastScheduledFor > now) continue
      if (loop.strikes >= KEEPALIVE_BUDGET) {
        this.endLoop(ownerID, loop.prompt)
        continue
      }
      const directory = [...this.sessionTasks.values()].find((task) => task.createdBySessionId === ownerID)?.directory ?? ""
      loop.strikes++
      if (!this.armLoop({ ownerID, directory, prompt: loop.prompt, delaySeconds: KEEPALIVE_DELAY_SECONDS, viaKeepalive: true })) this.loops.delete(loopKey(ownerID, loop.prompt))
    }
  }

  /** The loops a conversation has, for the checks. */
  loopsOf(ownerID: string): LoopState[] {
    return [...this.loops.values()].filter((loop) => loop.ownerID === ownerID)
  }

  /** When a task will next fire, as last worked out. */
  dueAt(id: string): number | undefined {
    return this.nextFireAt.get(id)
  }
}

const loopKey = (ownerID: string, prompt: string) => `${ownerID}\u0000${prompt}`

/** Who is asking about a task: the conversation, and the project it works in. */
export interface Scope {
  ownerID?: string
  directory?: string
}

const samePlace = (a: string, b: string) => {
  const one = path.resolve(a)
  const two = path.resolve(b)
  return process.platform === "win32" ? one.toLowerCase() === two.toLowerCase() : one === two
}

/**
 * Whether a scope reaches a task.
 *
 * A durable task belongs to its project, so anyone working in that project
 * reaches it whichever conversation made it - that is what lets a schedule
 * outlive the conversation (the user's 2026-09-16 decision). A session-only
 * task is still its own conversation's, since it never outlives the app run.
 */
export function reaches(scope: Scope | undefined, task: CronTask, directory: string): boolean {
  if (!scope || (!scope.ownerID && !scope.directory)) return true
  if (task.durable === true) return Boolean(scope.directory && samePlace(scope.directory, directory))
  return !scope.ownerID || task.createdBySessionId === scope.ownerID
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (failure) {
    return (failure as NodeJS.ErrnoException).code === "EPERM"
  }
}

let bound: CronScheduler | undefined

export function bindScheduler(scheduler: CronScheduler | undefined): void {
  bound = scheduler
}

export function cronScheduler(): CronScheduler | undefined {
  return bound
}
