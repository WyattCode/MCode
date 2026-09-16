/**
 * MiMo's silent renderer recovery, as rules with no Electron in them so smoke
 * can hold them.
 *
 * Each window's renderer is starting, ready or gone. It becomes gone when its
 * process dies, when a main-frame load fails (other than -3, a load the app
 * cancelled itself), when its contents are destroyed while the window is not
 * closing, or when it has not finished loading 30 seconds after it started.
 * A gone renderer is replaced by a fresh window, tried after 0, 250, 1000 and
 * 5000 ms; the count starts again once a replacement has stayed up for 30 s.
 */

export type RendererState = "starting" | "ready" | "gone"

export const STARTUP_TIMEOUT = 30_000
export const RECOVERY_DELAYS: readonly number[] = [0, 250, 1000, 5000]
export const STABLE_AFTER = 30_000

/**
 * MiMo's addDefaultShow fallback: a window is shown on whichever of
 * `ready-to-show`, `did-finish-load` and this timer comes first.
 *
 * Without it a first load that never finishes shows nothing at all until the
 * startup timeout above has run out and a replacement window has been built -
 * a wedged launch looked like an app that did not start for thirty seconds
 * rather than for three.
 */
export const SHOW_FALLBACK_MS = 3_000

/** Per-renderer state, with MiMo's transitions: each answers whether the renderer just became unavailable. */
export class RendererHealth<Key extends object> {
  private readonly states = new WeakMap<Key, RendererState>()

  track(key: Key): void {
    this.states.set(key, "starting")
  }

  /** "missing" for one never tracked or already gone. */
  state(key: Key | undefined): RendererState | "missing" {
    const state = key ? this.states.get(key) : undefined
    return !state || state === "gone" ? "missing" : state
  }

  didFinishLoad(key: Key): boolean {
    if (this.states.get(key) !== "starting") return false
    this.states.set(key, "ready")
    return true
  }

  didFailLoad(key: Key, failure: { errorCode: number; isMainFrame: boolean }): boolean {
    const state = this.states.get(key)
    if (!failure.isMainFrame || failure.errorCode === -3 || !state || state === "gone") return false
    this.states.set(key, "gone")
    return true
  }

  startupTimedOut(key: Key): boolean {
    if (this.states.get(key) !== "starting") return false
    this.states.set(key, "gone")
    return true
  }

  renderProcessGone(key: Key): boolean {
    const state = this.states.get(key)
    if (!state || state === "gone") return false
    this.states.set(key, "gone")
    return true
  }

  destroyed(key: Key): boolean {
    const state = this.states.get(key)
    if (!state) return false
    this.states.delete(key)
    return state !== "gone"
  }
}

export type RecoveryVisibility = "none" | "hidden" | "preserve-visibility"

/*
 * What a renderer that became unavailable gets: nothing while quitting or once
 * its window was being closed (macOS keeps a hidden one, where the app lives on
 * without windows), otherwise a replacement shown if the old one was.
 */
export function recoveryVisibility(input: { becameUnavailable: boolean; windowClosing: boolean; quitting: boolean; platform: string }): RecoveryVisibility {
  if (input.quitting || !input.becameUnavailable) return "none"
  if (input.windowClosing) return input.platform === "darwin" ? "hidden" : "none"
  return "preserve-visibility"
}

export interface Timers<Handle> {
  schedule(run: () => void, ms: number): Handle
  cancel(handle: Handle): void
}

/**
 * The retry schedule. `request` takes an attempt that answers whether it made
 * a window; a failed attempt is tried again at the next delay until the delays
 * run out.
 */
export class RecoverySchedule<Handle> {
  private attempts = 0
  private retry: Handle | undefined
  private stable: Handle | undefined
  private pending: (() => boolean) | undefined
  private stopped = false

  constructor(
    private readonly timers: Timers<Handle>,
    private readonly delays: readonly number[] = RECOVERY_DELAYS,
    private readonly stableMs = STABLE_AFTER,
  ) {}

  request(attempt: () => boolean): "scheduled" | "pending" | "exhausted" | "stopped" {
    if (this.stopped) return "stopped"
    this.pending = attempt
    if (this.retry !== undefined) return "pending"
    this.cancelStable()
    if (this.attempts >= this.delays.length) {
      this.pending = undefined
      return "exhausted"
    }
    return this.scheduleAttempt() ? "scheduled" : "exhausted"
  }

  /** A replacement loaded: stop retrying, and forget the attempts once it has stayed up. */
  rendererReady(): void {
    if (this.stopped || (this.attempts === 0 && this.retry === undefined)) return
    this.cancelRetry()
    this.pending = undefined
    this.cancelStable()
    if (this.attempts === 0) return
    this.stable = this.timers.schedule(() => {
      this.stable = undefined
      if (!this.stopped) this.attempts = 0
    }, this.stableMs)
  }

  cancel(): void {
    if (this.stopped) return
    this.stopped = true
    this.pending = undefined
    this.cancelRetry()
    this.cancelStable()
  }

  get snapshot(): { attempts: number; retryScheduled: boolean; stableScheduled: boolean; exhausted: boolean } {
    return {
      attempts: this.attempts,
      retryScheduled: this.retry !== undefined,
      stableScheduled: this.stable !== undefined,
      exhausted: this.attempts >= this.delays.length,
    }
  }

  private scheduleAttempt(): boolean {
    if (this.stopped || this.retry !== undefined || !this.pending || this.attempts >= this.delays.length) return false
    const delay = this.delays[this.attempts]!
    this.retry = this.timers.schedule(() => {
      this.retry = undefined
      const attempt = this.pending
      if (this.stopped || !attempt) return
      this.attempts += 1
      let made = false
      try {
        made = attempt()
      } catch {
        made = false
      }
      if (made || this.attempts >= this.delays.length) {
        this.pending = undefined
        return
      }
      this.scheduleAttempt()
    }, delay)
    return true
  }

  private cancelRetry(): void {
    if (this.retry === undefined) return
    const handle = this.retry
    this.retry = undefined
    this.timers.cancel(handle)
  }

  private cancelStable(): void {
    if (this.stable === undefined) return
    const handle = this.stable
    this.stable = undefined
    this.timers.cancel(handle)
  }
}
