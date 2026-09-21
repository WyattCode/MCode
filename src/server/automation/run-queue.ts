/**
 * The queue a scheduled task's runs wait in, with leases - MiMo's run queue
 * (N11-2).
 *
 * Before this, a run that was due went straight at `prompt()`, and a `prompt()`
 * that threw was swallowed: the schedule moved on, the run record stayed
 * "running" for ever, and at the next start it was rewritten as "the app closed
 * before the run finished" - a reason that was simply untrue. Nothing retried
 * it, and nothing said it had not happened.
 *
 * So every due moment now becomes an entry here instead. An entry is handed out
 * under a lease; whoever took it must report back. A report that never comes -
 * because the app was killed between taking the entry and starting the turn -
 * lets the lease run out, and the entry becomes deliverable again. A run whose
 * conversation is busy is handed back on purpose and waits for the next round.
 *
 * Entries are frozen and keyed by `runId`, so the same due moment enqueued
 * twice is one entry: two checks a second apart cannot double-start a task.
 * They carry the schedule they were made under, so a task rescheduled while its
 * run waited can throw the stale run away rather than run it at the wrong time.
 */

/** One run waiting to start. Frozen: nothing downstream may edit an entry in place. */
export interface QueuedRun {
  readonly runId: string
  readonly automationID: string
  /** The moment the schedule asked for this run, which is what orders the queue. */
  readonly scheduledFor: number
  /** The schedule this run was made under, so a rescheduled task's stale runs are recognisable. */
  readonly scheduleFingerprint: string
  readonly source: "schedule" | "restored"
  /** Raised on every hand-out, so a late report from an earlier hand-out is ignored. */
  readonly deliveryGeneration: number
}

interface Entry {
  run: QueuedRun
  /** 0 while the entry is waiting to be handed out; a deadline while it is out. */
  leaseUntil: number
  /** How many times it has been handed out and failed to start. */
  attempts: number
}

/** What a holder says happened, once it has had its turn with an entry. */
export type RunReport =
  /** It started, or was settled for good; the entry is finished with. */
  | "settled"
  /** It could not start now but should be tried again; the wait does not count as an attempt. */
  | "later"
  /** It was handed out and failed to start; another attempt is spent. */
  | "failed"

export interface QueueState {
  entries: { run: QueuedRun; attempts: number }[]
}

/**
 * MiMo's lease: thirty seconds, after which an entry nobody reported on is
 * deliverable again.
 *
 * Fifteen minutes here meant a run the app was killed in the middle of taking
 * sat unrunnable for a quarter of an hour. MiMo also keeps a ten-second timer
 * of its own to redeliver expired leases; the once-a-second check here already
 * does that. A hand-out that is genuinely still working when the lease runs out
 * is not started twice: the check that takes the entry finds the same task
 * already starting and hands it straight back, and a run that has settled is
 * recognised by its id.
 */
export const LEASE_MS = 30_000
/** How many times a run may be handed out and fail to start before it is given up on. */
export const MAX_ATTEMPTS = 3

export class RunQueue {
  private readonly entries = new Map<string, Entry>()
  private readonly leaseMs: number
  private readonly maxAttempts: number

  constructor(options: { leaseMs?: number; maxAttempts?: number } = {}) {
    this.leaseMs = options.leaseMs ?? LEASE_MS
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  }

  /** The run id for one due moment of one task; the same moment always gives the same id. */
  static runIdFor(automationID: string, scheduledFor: number): string {
    return `run-${automationID}-${scheduledFor.toString(36)}`
  }

  /** Adds a run, or returns false when that exact run is already waiting or out. */
  enqueue(run: Omit<QueuedRun, "deliveryGeneration">): boolean {
    if (this.entries.has(run.runId)) return false
    this.entries.set(run.runId, { run: Object.freeze({ ...run, deliveryGeneration: 0 }), leaseUntil: 0, attempts: 0 })
    return true
  }

  /** Entries whose holder never reported; they become deliverable again and are named so the caller can say so. */
  releaseExpired(now: number): QueuedRun[] {
    const freed: QueuedRun[] = []
    for (const entry of this.entries.values()) {
      if (entry.leaseUntil === 0 || entry.leaseUntil > now) continue
      entry.leaseUntil = 0
      entry.attempts++
      freed.push(entry.run)
    }
    return freed
  }

  /**
   * Up to `limit` runs that are ready to start, oldest due moment first, each
   * leased to the caller. A run that has used up its attempts is not handed out
   * again; `exhausted()` reports those instead.
   */
  drain(now: number, limit: number): QueuedRun[] {
    const ready = [...this.entries.values()]
      .filter((entry) => entry.leaseUntil === 0 && entry.attempts < this.maxAttempts && entry.run.scheduledFor <= now)
      .sort((a, b) => a.run.scheduledFor - b.run.scheduledFor)
      .slice(0, Math.max(0, limit))
    const out: QueuedRun[] = []
    for (const entry of ready) {
      entry.run = Object.freeze({ ...entry.run, deliveryGeneration: entry.run.deliveryGeneration + 1 })
      entry.leaseUntil = now + this.leaseMs
      out.push(entry.run)
    }
    return out
  }

  /** Runs that have been handed out as often as they are allowed to be and will not start; taken out of the queue. */
  exhausted(): QueuedRun[] {
    const out: QueuedRun[] = []
    for (const [id, entry] of [...this.entries]) {
      if (entry.leaseUntil !== 0 || entry.attempts < this.maxAttempts) continue
      this.entries.delete(id)
      out.push(entry.run)
    }
    return out
  }

  /**
   * What the holder of an entry found. "settled" finishes the run whichever
   * hand-out reports it: a slow start that outlived its lease has still
   * started, and the entry the lease passed on must not start it again. Any
   * other report from an earlier hand-out is ignored, which is what the
   * generation is for.
   */
  report(runId: string, deliveryGeneration: number, outcome: RunReport): boolean {
    const entry = this.entries.get(runId)
    if (!entry) return false
    if (outcome === "settled") {
      this.entries.delete(runId)
      return true
    }
    if (entry.run.deliveryGeneration !== deliveryGeneration) return false
    entry.leaseUntil = 0
    if (outcome === "failed") entry.attempts++
    return true
  }

  /** Every waiting run of one task, oldest due moment first. */
  forAutomation(automationID: string): QueuedRun[] {
    return [...this.entries.values()]
      .filter((entry) => entry.run.automationID === automationID)
      .map((entry) => entry.run)
      .sort((a, b) => a.scheduledFor - b.scheduledFor)
  }

  /** Throws a run away without a report; used when its task is gone or was rescheduled under it. */
  drop(runId: string): boolean {
    return this.entries.delete(runId)
  }

  get size(): number {
    return this.entries.size
  }

  /** The queue as it is saved; a restored entry is deliverable again whatever it was doing. */
  get state(): QueueState {
    return { entries: [...this.entries.values()].map((entry) => ({ run: { ...entry.run, source: "restored" as const }, attempts: entry.attempts })) }
  }

  restore(state: QueueState | undefined): void {
    this.entries.clear()
    for (const saved of state?.entries ?? []) {
      const run = saved.run
      if (!run || typeof run.runId !== "string" || typeof run.automationID !== "string" || typeof run.scheduledFor !== "number") continue
      this.entries.set(run.runId, {
        run: Object.freeze({
          runId: run.runId,
          automationID: run.automationID,
          scheduledFor: run.scheduledFor,
          scheduleFingerprint: typeof run.scheduleFingerprint === "string" ? run.scheduleFingerprint : "",
          source: "restored",
          deliveryGeneration: typeof run.deliveryGeneration === "number" ? run.deliveryGeneration : 0,
        }),
        leaseUntil: 0,
        attempts: typeof saved.attempts === "number" && saved.attempts >= 0 ? saved.attempts : 0,
      })
    }
  }
}
