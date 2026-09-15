/**
 * MiMo's automatic updates, on MCode's own JSON feed.
 *
 * The first check runs 5 s after launch and then every 3 h. A check that finds
 * a newer version downloads its installer in the background - or reuses one
 * already downloaded whose sha256 matches the feed - and says it is ready; the
 * update capsule and the settings row react to that. Failures are silent: they
 * are logged and the phase falls back to what it was.
 *
 * Nothing here touches Electron or the network directly, so smoke drives the
 * schedule and the phases with fakes.
 */

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready"

export interface FeedEntry {
  version: string
  url: string
  sha256: string
  notes: string
}

export interface UpdateState {
  phase: UpdatePhase
  ready: { version: string; notes: string } | null
}

export type CheckOutcome = "no-feed" | "current" | "no-installer" | "ready" | "failed" | "busy"

export interface CheckResult extends UpdateState {
  outcome: CheckOutcome
  version?: string
  error?: string
  /** For a failure: whether reading the feed or fetching the installer failed. */
  during?: "check" | "download"
}

export const FIRST_CHECK_DELAY = 5_000
export const CHECK_INTERVAL = 3 * 60 * 60 * 1000

export interface Scheduler {
  setTimeout(run: () => void, ms: number): unknown
  setInterval(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  clearInterval(handle: unknown): void
}

export interface UpdaterDeps {
  currentVersion: string
  /** The configured feed address; empty when there is none. */
  feedURL(): string
  fetchFeed(url: string): Promise<FeedEntry>
  /** Where the installer for this entry is kept. */
  installerFile(entry: FeedEntry): string
  /** The bytes of a file, or undefined when there is none. */
  readFile(file: string): Promise<Uint8Array | undefined>
  sha256(bytes: Uint8Array): string
  /** Fetches, verifies and writes the installer; throws on any failure. */
  download(entry: FeedEntry, file: string): Promise<void>
  /** Every phase change, for the windows. */
  emit(state: UpdateState): void
  log(line: string): void
  scheduler?: Scheduler
  firstDelayMs?: number
  intervalMs?: number
}

/** The feed's JSON as MCode reads it; missing fields are empty, notes are capped. */
export function parseFeed(payload: unknown): FeedEntry {
  const entry = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  return {
    version: text(entry.version),
    url: text(entry.url),
    // Optional, and checked only when the feed offers one.
    sha256: text(entry.sha256).toLowerCase(),
    notes: typeof entry.notes === "string" ? entry.notes.slice(0, 20_000) : "",
  }
}

export interface Updater {
  start(): void
  stop(): void
  checkNow(): Promise<CheckResult>
  state(): UpdateState
  /** The installer this process downloaded or verified, once an update is ready. */
  readyFile(): string | undefined
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const scheduler: Scheduler = deps.scheduler ?? {
    setTimeout: (run, ms) => setTimeout(run, ms),
    setInterval: (run, ms) => setInterval(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  }
  let phase: UpdatePhase = "idle"
  let ready: { version: string; notes: string; file: string } | undefined
  let busy = false
  let first: unknown
  let timer: unknown

  const state = (): UpdateState => ({ phase, ready: ready ? { version: ready.version, notes: ready.notes } : null })
  const move = (next: UpdatePhase) => {
    if (next === phase) return
    phase = next
    deps.emit(state())
  }
  const settle = () => move(ready ? "ready" : "idle")
  const result = (outcome: CheckOutcome, extra: Pick<CheckResult, "version" | "error" | "during"> = {}): CheckResult => ({ ...state(), outcome, ...extra })

  async function cached(entry: FeedEntry, file: string): Promise<boolean> {
    // Only a file whose hash the feed vouches for is run without fetching it again.
    if (!entry.sha256) return false
    try {
      const bytes = await deps.readFile(file)
      return bytes !== undefined && deps.sha256(bytes) === entry.sha256
    } catch {
      return false
    }
  }

  async function checkNow(): Promise<CheckResult> {
    if (busy) {
      deps.log("[update] a check is already running; this one is skipped")
      return result("busy")
    }
    const feed = deps.feedURL().trim()
    if (!feed) return result("no-feed")
    busy = true
    let during: "check" | "download" = "check"
    try {
      move("checking")
      const entry = await deps.fetchFeed(feed)
      if (!entry.version) throw new Error("the feed named no version")
      if (entry.version === deps.currentVersion) {
        settle()
        return result("current", { version: entry.version })
      }
      // A feed that names a version but no installer can only say where to get it.
      if (!entry.url) {
        settle()
        return result("no-installer", { version: entry.version })
      }
      if (ready?.version === entry.version) {
        settle()
        return result("ready", { version: entry.version })
      }
      during = "download"
      move("downloading")
      const file = deps.installerFile(entry)
      if (await cached(entry, file)) deps.log(`[update] reusing the downloaded installer for ${entry.version}`)
      else await deps.download(entry, file)
      ready = { version: entry.version, notes: entry.notes, file }
      deps.log(`[update] ${entry.version} is ready to install`)
      move("ready")
      return result("ready", { version: entry.version })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.log(`[update] check failed (silent): ${message}`)
      settle()
      return result("failed", { error: message, during })
    } finally {
      busy = false
    }
  }

  return {
    start() {
      if (first !== undefined) return
      first = scheduler.setTimeout(() => void checkNow(), deps.firstDelayMs ?? FIRST_CHECK_DELAY)
      timer = scheduler.setInterval(() => void checkNow(), deps.intervalMs ?? CHECK_INTERVAL)
    },
    stop() {
      if (first !== undefined) scheduler.clearTimeout(first)
      if (timer !== undefined) scheduler.clearInterval(timer)
      first = undefined
      timer = undefined
    },
    checkNow,
    state,
    readyFile: () => ready?.file,
  }
}
