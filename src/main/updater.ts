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
 *    folder has block maps), is copied over the cache's installer.exe as the
 *    next differential base, and the capsule says it is ready;
 *  - installing runs the installer silently with --updated and relaunches the
 *    app afterwards; an install under Program Files runs it with its window so
 *    Windows can ask for elevation (N9-3). The caller starts it only once the
 *    backend has shut down.
 *
 * Residual risk: this is feed authenticity, not publisher authenticity.
 * Without OS code signing or a publisherName check, a compromised HTTPS feed
 * (or DNS/MITM against a misconfigured feed) can still ship a malicious
 * installer whose sha512 matches the feed. The sha512 only proves the download
 * matches the feed, not that the feed is honest.
 *
 * Nothing here imports Electron: the caller passes electron-updater's
 * autoUpdater (or a fake), so smoke drives the schedule and the rules.
 */
import fs from "node:fs/promises"
import path from "node:path"

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

export const UPDATE_AUTH_RESIDUAL = "sha512 proves the download matches the feed only; there is no code signing or publisher check"

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

/**
 * MiMo's segment-wise version order: -1, 0 or 1. Missing or non-numeric segments count as 0.
 * A pre-release sorts before the release it belongs to (`1.2.0-beta.1 < 1.2.0`),
 * the way semver orders them - the old numeric-only read called a beta newer
 * than its own release and a `1.2.3-beta` equal to `1.2.3`.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { numbers: number[]; pre?: string } => {
    const text = String(value ?? "")
    const dash = text.indexOf("-")
    const core = dash === -1 ? text : text.slice(0, dash)
    const pre = dash === -1 ? undefined : text.slice(dash + 1)
    return {
      numbers: core.split(/[.+]/).map((segment) => {
        const number = Number.parseInt(segment, 10)
        return Number.isFinite(number) ? number : 0
      }),
      pre,
    }
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index++) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  // Same core numbers: a plain release is newer than any pre-release of it.
  const leftPre = left.pre
  const rightPre = right.pre
  if (!leftPre && !rightPre) return 0
  if (leftPre && !rightPre) return -1
  if (!leftPre && rightPre) return 1
  // Both pre-releases: compare their dot segments, numerically where both are numbers.
  const leftParts = leftPre!.split(".")
  const rightParts = rightPre!.split(".")
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const l = leftParts[index]
    const r = rightParts[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number.parseInt(l, 10)
    const rn = Number.parseInt(r, 10)
    const bothNumbers = Number.isFinite(ln) && String(ln) === l && Number.isFinite(rn) && String(rn) === r
    if (bothNumbers) {
      if (ln !== rn) return ln > rn ? 1 : -1
    } else if (l !== r) {
      return l > r ? 1 : -1
    }
  }
  return 0
}

/** A sha512 as electron-builder writes it: 64 bytes, base64 (or hex). */
const SHA512 = /^(?:[A-Za-z0-9+/]{86}==|[0-9a-fA-F]{128})$/
const ZERO_SHA512_HEX = "0".repeat(128)
const ZERO_SHA512_BASE64 = "A".repeat(86) + "=="

function isZeroSha512(value: string): boolean {
  return value === ZERO_SHA512_HEX || value === ZERO_SHA512_BASE64
}

function sha512Problem(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : ""
  if (!SHA512.test(text)) return "no sha512"
  if (isZeroSha512(text)) return "placeholder sha512"
  return undefined
}

/** Why a feed entry is refused, or undefined when it may be downloaded. */
export function refusal(info: FeedInfo, currentVersion: string, now: number): string | undefined {
  if (info.files !== undefined) {
    if (!Array.isArray(info.files) || info.files.length === 0) {
      return `the feed gives no files for ${info.version}, so it cannot be verified`
    }
    for (const file of info.files) {
      const sha512 = sha512Problem(file?.sha512)
      if (sha512 === "no sha512") return `the feed gives no sha512 for ${info.version}, so it cannot be verified`
      if (sha512 === "placeholder sha512") return `the feed gives a placeholder sha512 for ${info.version}, so it cannot be verified`
      if (typeof file?.url !== "string" || file.url.trim() === "") {
        return `the feed gives a file without a url for ${info.version}, so it cannot be downloaded`
      }
    }
  } else if (info.sha512 !== undefined) {
    const sha512 = sha512Problem(info.sha512)
    if (sha512 === "no sha512") return `the feed gives no sha512 for ${info.version}, so it cannot be verified`
    if (sha512 === "placeholder sha512") return `the feed gives a placeholder sha512 for ${info.version}, so it cannot be verified`
  } else {
    return `the feed gives no sha512 for ${info.version}, so it cannot be verified`
  }

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
  /** Undoes a hold whose session end was cancelled: an ordinary quit installs again. */
  resumeInstallOnQuit(): void
}

/*
 * electron-builder's name for the installer a differential download is built
 * against, kept in the updater cache's root (the downloads go to `pending`).
 */
const INSTALLER_BASE = "installer.exe"

/**
 * MiMo's re-sync once a download completes: the new installer is copied over
 * the cache's `installer.exe`. electron-updater has just put the new version's
 * `current.blockmap` there, so without this a newer release arriving before
 * the pending one is installed would plan its differential download against
 * the wrong base, fail the sha512 and fetch the whole installer again. Only a
 * Windows installer in a `pending` folder is copied; a failure is only logged.
 */
export async function resyncInstallerBase(downloaded: string | undefined, log: (line: string) => void): Promise<boolean> {
  if (!downloaded || !/\.exe$/i.test(downloaded) || path.basename(path.dirname(downloaded)) !== "pending") return false
  const target = path.join(path.dirname(path.dirname(downloaded)), INSTALLER_BASE)
  const staged = `${target}.tmp`
  try {
    await fs.copyFile(downloaded, staged)
    await fs.rename(staged, target)
    return true
  } catch (error) {
    await fs.rm(staged, { force: true }).catch(() => undefined)
    log(`[update] ${INSTALLER_BASE} was not re-synced: ${(error as Error).message}`)
    return false
  }
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
      if (refused && compareVersions(version, deps.currentVersion) > 0) {
        settle()
        deps.log(/sha512|placeholder|verified|url/i.test(refused) ? `[update] authenticity check refused ${version}: ${refused}` : `[update] ${refused}`)
        return result("failed", { error: refused, during: "check", version })
      }
      if (!checked.isUpdateAvailable) {
        settle()
        // A newer entry that cannot be verified is a failure; an older one without a rollback just leaves this version current.
        if (refused) deps.log(`[update] ${refused}`)
        return result("current", { version })
      }
      during = "download"
      move("downloading")
      if (!checked.downloadPromise) throw new Error("the download did not start")
      const downloaded = await checked.downloadPromise
      await resyncInstallerBase(downloaded?.[0], deps.log)
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
    resumeInstallOnQuit() {
      // A session end that was cancelled must not hold forever: the next
      // ordinary quit installs the ready update as normal.
      updater.autoInstallOnAppQuit = true
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
