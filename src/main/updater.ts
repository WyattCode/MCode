/**
 * MiMo's automatic updates, through electron-updater as MiMo does it.
 *
 * The feed is a generic update folder - what electron-builder writes for a
 * release: `latest.yml`, the installer and its `.blockmap`. MCode has no update
 * server of its own yet, so the folder is whatever the settings row (or the
 * MCODE_UPDATE_URL variable) names; with none, nothing is fetched at all.
 *
 * The rules, each MiMo's:
 *  - the first check 5 s after launch, then every 3 h; failures are silent;
 *  - only a newer version is an update. An older one is taken only when its
 *    `latest.yml` says `rollback: true` and it was released within 30 days
 *    (N9-1);
 *  - every file must carry the sha512 electron-updater verifies the download
 *    against; a feed without one offers nothing (N9-2);
 *  - a newer installer downloads in the background (differentially when the
 *    folder has block maps) and the capsule says it is ready;
 *  - installing runs the installer silently with --updated and relaunches the
 *    app afterwards; an install under Program Files runs it with its window so
 *    Windows can ask for elevation (N9-3). The caller starts it only once the
 *    backend has shut down.
 *
 * Nothing here imports Electron: the caller passes electron-updater's
 * autoUpdater (or a fake), so smoke drives the schedule and the rules.
 */

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready"

export interface UpdateState {
  phase: UpdatePhase
  ready: { version: string; notes: string } | null
}

export type CheckOutcome = "no-feed" | "current" | "ready" | "failed" | "busy"

export interface CheckResult extends UpdateState {
  outcome: CheckOutcome
  version?: string
  error?: string
  /** For a failure: whether reading the feed or fetching the installer failed. */
  during?: "check" | "download"
}

export const FIRST_CHECK_DELAY = 5_000
export const CHECK_INTERVAL = 3 * 60 * 60 * 1000
/** MiMo's rollback window. */
export const ROLLBACK_DAYS = 30
const NOTES_LIMIT = 20_000

export interface Scheduler {
  setTimeout(run: () => void, ms: number): unknown
  setInterval(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  clearInterval(handle: unknown): void
}

/** What electron-updater's UpdateInfo carries that these rules read. */
export interface FeedInfo {
  version: string
  releaseDate?: string
  releaseNotes?: string | { version?: string; note?: string | null }[] | null
  files?: { url?: string; sha512?: string }[]
  /** Legacy single-file form. */
  sha512?: string
  /** MiMo's explicit rollback declaration, written into latest.yml by hand. */
  rollback?: unknown
  /** The oldest OS release the version runs on, read by electron-updater's own check. */
  minimumSystemVersion?: string
}

/** The part of electron-updater's AppUpdater this module uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  allowPrerelease: boolean
  disableWebInstaller: boolean
  requestHeaders: Record<string, string> | null
  isUpdateSupported: (info: FeedInfo) => boolean | Promise<boolean>
  setFeedURL(options: { provider: "generic"; url: string; useMultipleRangeRequest?: boolean }): void
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: FeedInfo; downloadPromise?: Promise<string[]> | null } | null>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterDeps {
  currentVersion: string
  /** The configured feed folder; empty when there is none. */
  feedURL(): string
  autoUpdater: AutoUpdaterLike
  /** Every phase change, for the windows. */
  emit(state: UpdateState): void
  log(line: string): void
  now?(): number
  scheduler?: Scheduler
  firstDelayMs?: number
  intervalMs?: number
}

/** MiMo's segment-wise version order: -1, 0 or 1. Missing or non-numeric segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => String(value ?? "").split(/[.+-]/).map((segment) => {
    const number = Number.parseInt(segment, 10)
    return Number.isFinite(number) ? number : 0
  })
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

/** A sha512 as electron-builder writes it: 64 bytes, base64 (or hex). */
const SHA512 = /^(?:[A-Za-z0-9+/]{86}==|[0-9a-fA-F]{128})$/

/** Why a feed entry is refused, or undefined when it may be downloaded. */
export function refusal(info: FeedInfo, currentVersion: string, now: number): string | undefined {
  const files = info.files?.length ? info.files : info.sha512 !== undefined ? [{ sha512: info.sha512 }] : []
  if (!files.length || files.some((file) => !SHA512.test(String(file.sha512 ?? "")))) return `the feed gives no sha512 for ${info.version}, so it cannot be verified`
  const order = compareVersions(info.version, currentVersion)
  if (order > 0) return undefined
  if (order === 0) return "not newer"
  if (info.rollback !== true) return `${info.version} is older than ${currentVersion} and the feed does not declare a rollback`
  const released = Date.parse(String(info.releaseDate ?? ""))
  if (!Number.isFinite(released)) return `the rollback to ${info.version} has no release date`
  if (now - released > ROLLBACK_DAYS * 24 * 60 * 60 * 1000) return `the rollback to ${info.version} was released more than ${ROLLBACK_DAYS} days ago`
  return undefined
}

/** https, or http only to this machine (a local test server). */
export function feedProblem(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "the update feed is not a valid address"
  }
  if (parsed.protocol === "https:") return undefined
  if (parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return undefined
  return "the update feed must be an https address"
}

function notesOf(info: FeedInfo): string {
  const notes = info.releaseNotes
  const text = typeof notes === "string" ? notes : Array.isArray(notes) ? notes.map((entry) => entry?.note ?? "").filter(Boolean).join("\n\n") : ""
  return text.slice(0, NOTES_LIMIT)
}

/** Program Files needs elevation, which a silent installer cannot ask for (MiMo's rule). */
export function isProtectedInstall(execPath: string): boolean {
  return /\/program files( \(x86\))?\//.test(String(execPath).replace(/\\/g, "/").toLowerCase())
}

export interface Updater {
  start(): void
  stop(): void
  checkNow(): Promise<CheckResult>
  state(): UpdateState
  /** The version ready to install, if any. */
  readyVersion(): string | undefined
  /** Runs the downloaded installer (see the module notes); false when nothing is ready. */
  install(execPath: string): boolean
  /**
   * The OS is ending the session: a downloaded update must not start
   * installing on this quit, where Windows may kill the installer halfway.
   * It stays in the cache and installs on the next ordinary quit.
   */
  holdInstallOnQuit(): void
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const scheduler: Scheduler = deps.scheduler ?? {
    setTimeout: (run, ms) => setTimeout(run, ms),
    setInterval: (run, ms) => setInterval(run, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  }
  const now = deps.now ?? (() => Date.now())
  const updater = deps.autoUpdater
  let phase: UpdatePhase = "idle"
  let ready: { version: string; notes: string } | undefined
  let busy = false
  let first: unknown
  let timer: unknown
  /** Why the last feed entry was turned down, for the check that is reading it. */
  let refused: string | undefined

  // MiMo downloads on its own and installs on quit when an update is waiting.
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.allowPrerelease = false
  updater.disableWebInstaller = true
  /*
   * electron-updater would send every check a random per-install id (for staged
   * rollouts, which MCode does not use). A fixed value keeps checks anonymous.
   */
  updater.requestHeaders = { "x-user-staging-id": "none" }
  /*
   * Downgrades are decided here, not by the library: it is told a downgrade is
   * allowed, and this hook turns down every older entry that is not a declared,
   * recent rollback - and every entry without a sha512.
   */
  updater.allowDowngrade = true
  /*
   * The library's own check runs first: it refuses a version whose feed names
   * a `minimumSystemVersion` above this OS release. That is not a failure,
   * just an update this machine cannot take, so the check stays "current".
   */
  const supportedHere = updater.isUpdateSupported
  updater.isUpdateSupported = async (info) => {
    refused = undefined
    if (!(await supportedHere.call(updater, info))) {
      deps.log(`[update] ${info.version} needs a newer system (${info.minimumSystemVersion ?? "its minimumSystemVersion"})`)
      return false
    }
    refused = refusal(info, deps.currentVersion, now())
    return refused === undefined
  }

  const state = (): UpdateState => ({ phase, ready: ready ? { ...ready } : null })
  const move = (next: UpdatePhase) => {
    if (next === phase) return
    phase = next
    deps.emit(state())
  }
  const settle = () => move(ready ? "ready" : "idle")
  const result = (outcome: CheckOutcome, extra: Pick<CheckResult, "version" | "error" | "during"> = {}): CheckResult => ({ ...state(), outcome, ...extra })
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 500)

  async function checkNow(): Promise<CheckResult> {
    if (busy) {
      deps.log("[update] a check is already running; this one is skipped")
      return result("busy")
    }
    const feed = deps.feedURL().trim()
    if (!feed) return result("no-feed")
    const problem = feedProblem(feed)
    if (problem) return result("failed", { error: problem, during: "check" })
    busy = true
    let during: "check" | "download" = "check"
    try {
      move("checking")
      refused = undefined
      updater.setFeedURL({ provider: "generic", url: feed, useMultipleRangeRequest: false })
      const checked = await updater.checkForUpdates()
      if (!checked) throw new Error("updates apply to the installed app only")
      const version = checked.updateInfo.version
      if (!checked.isUpdateAvailable) {
        settle()
        // A newer entry that cannot be verified is a failure; an older one without a rollback just leaves this version current.
        if (refused && compareVersions(version, deps.currentVersion) > 0) return result("failed", { error: refused, during: "check", version })
        if (refused) deps.log(`[update] ${refused}`)
        return result("current", { version })
      }
      during = "download"
      move("downloading")
      if (!checked.downloadPromise) throw new Error("the download did not start")
      await checked.downloadPromise
      ready = { version, notes: notesOf(checked.updateInfo) }
      deps.log(`[update] ${version} is ready to install`)
      move("ready")
      return result("ready", { version })
    } catch (error) {
      const text = message(error)
      deps.log(`[update] check failed (silent): ${text}`)
      settle()
      return result("failed", { error: text, during })
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
    readyVersion: () => ready?.version,
    install(execPath) {
      if (!ready) return false
      const silent = !isProtectedInstall(execPath)
      if (!silent) deps.log("[update] installed under Program Files: the installer runs with its window so Windows can ask for elevation")
      // --updated, /S when silent, and --force-run so the new version opens once it is in place.
      updater.quitAndInstall(silent, true)
      return true
    },
    holdInstallOnQuit() {
      // electron-updater reads the flag in its quit handler, so this holds even after the download.
      updater.autoInstallOnAppQuit = false
      if (ready) deps.log(`[update] the OS is ending the session; ${ready.version} installs on the next quit`)
    },
  }
}

export const HELPER_SWEEP_TIMEOUT_MS = 3000

/**
 * MiMo's sweep before an install (Windows, packaged): every process still
 * running from the install's `resources\` folder - a bundled python or node the
 * agent started, say - is ended, so the installer is not blocked by files in
 * use. Returns the PowerShell command, or undefined when there is nothing safe
 * to sweep (no packaged exe, or a folder too short to be an install).
 */
export function helperSweep(execPath: string, platform: NodeJS.Platform, packaged: boolean): { file: string; args: string[]; prefix: string } | undefined {
  if (platform !== "win32" || !packaged || !/\.exe$/i.test(execPath)) return undefined
  const folder = execPath.replace(/\//g, "\\").replace(/\\[^\\]+$/, "")
  if (!folder || /^[A-Za-z]:\\*$/.test(folder)) return undefined
  const prefix = `${folder.replace(/\\+$/, "")}\\resources\\`
  if (prefix.length < 15) return undefined
  const quoted = prefix.replace(/'/g, "''")
  return {
    file: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$found = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${quoted}', [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 32); foreach ($p in $found) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }`,
    ],
    prefix,
  }
}

/**
 * Installers an earlier update left behind (N9-16): the old updater's copies in
 * the temporary folder, and electron-updater's pending installer once its
 * version is the running one (or older). Returns what to delete.
 */
export function staleInstallers(options: { tempNames: string[]; pendingFile?: string; currentVersion: string }): { temp: string[]; pending: boolean } {
  const temp = options.tempNames.filter((name) => /^mcode-\d+\.\d+\.\d+\.(exe|dmg|AppImage)$/.test(name))
  const version = /-(\d+\.\d+\.\d+)(?:-[^-]+)?\.(exe|dmg|AppImage|zip)$/.exec(options.pendingFile ?? "")?.[1]
  return { temp, pending: version !== undefined && compareVersions(version, options.currentVersion) <= 0 }
}
