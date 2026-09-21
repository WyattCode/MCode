import os from "node:os"

/**
 * A counting semaphore whose waiters can give up.
 *
 * Used for the process-wide subagent gate and for the tool calls of one step
 * (N11-20). A waiter whose turn is stopped while it is still queued leaves the
 * queue instead of taking a permit it would never use.
 */
export class Semaphore {
  private active = 0
  private readonly queue: { grant: () => void; refuse: (reason: unknown) => void }[] = []

  constructor(readonly permits: number) {}

  /** How many permits are held right now. */
  get held(): number {
    return this.active
  }

  /** How many callers are waiting for one. */
  get waiting(): number {
    return this.queue.length
  }

  /** Resolves with the function that gives the permit back, once one is free. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    const release = () => {
      let done = false
      return () => {
        if (done) return
        done = true
        this.active--
        this.queue.shift()?.grant()
      }
    }
    if (this.active < this.permits) {
      this.active++
      return Promise.resolve(release())
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort)
          this.active++
          resolve(release())
        },
        refuse: reject,
      }
      const onAbort = () => {
        const at = this.queue.indexOf(entry)
        if (at >= 0) this.queue.splice(at, 1)
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.queue.push(entry)
    })
  }

  /** Runs `work` holding a permit. */
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try {
      return await work()
    } finally {
      release()
    }
  }
}

/**
 * MiMo's subagent gate: one process-wide semaphore of min(16, 2 x cores)
 * permits, and excess subagents queue rather than being refused. Top-level
 * conversations are not gated, as MiMo's are not.
 */
export const SUBAGENT_LIMIT = Math.max(1, Math.min(16, 2 * (os.availableParallelism?.() ?? os.cpus().length)))

/**
 * How many tool calls of one step run at once. A model that asks for twenty
 * shell commands in one reply used to start twenty processes together, each
 * reporting its output ten times a second.
 */
export const STEP_TOOL_LIMIT = 8
