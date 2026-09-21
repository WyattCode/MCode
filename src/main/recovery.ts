import { app, type BrowserWindow, type WebContents } from "electron"
import { formatArgs, type DailyLog } from "./log-file"
import { RecoverySchedule, RendererHealth, STARTUP_TIMEOUT, recoveryVisibility } from "./renderer-health"

/**
 * What the app does when the window it is showing stops working: MiMo's silent
 * renderer recovery.
 *
 * A renderer can fail while the main process stays healthy: its process can be
 * killed (out of memory, a GPU fault, a crash in Chromium), its page can fail to
 * load, or it can never finish starting. None of the three close the window,
 * and none raise anything the page could catch, because the page is the part
 * that stopped. MiMo asks nothing: it records what happened and puts a fresh
 * window in place of the broken one. MCode's backend lives in this process, so
 * a new window loses nothing but the page state. The rules and the retry
 * schedule are in renderer-health.ts; this wires them to Electron.
 *
 * A hang is only recorded. A page that stops answering may start again, and
 * replacing it would throw away whatever it was in the middle of.
 */

/* The day's log file (MiMo's userData/logs), once main has opened it. */
let log: DailyLog | undefined

/*
 * Set while this module is the one writing to the console, so the capture below
 * does not record its own output and then record recording it.
 */
let reporting = false

function record(window: string, what: string, detail: Record<string, unknown> = {}): void {
  log?.write("error", formatArgs([`[recovery] ${what}`, { window, ...detail }]))
  // Goes to the terminal in development; the log file has it either way.
  reporting = true
  try {
    console.error(`[recovery] ${what}`, { window, ...detail })
  } catch {
    // A closed stdout must not turn a record into a crash.
  } finally {
    reporting = false
  }
}

/** Stands in for a URL that cannot be read because the window has gone. */
const DESTROYED = "<destroyed>"

/*
 * Reading a URL off contents is the first thing these handlers want and the
 * most likely to throw, because they run exactly while the window is being
 * torn down underneath them.
 */
function contentsURL(contents: WebContents): string {
  try {
    return contents.isDestroyed() ? DESTROYED : contents.getURL()
  } catch {
    return DESTROYED
  }
}

/**
 * An exception or rejection nothing in the main process caught (MiMo's
 * uncaughtException / unhandledRejection handlers): recorded, and the app runs
 * on. With a handler attached Electron no longer raises its modal "A JavaScript
 * error occurred in the main process" box, which for a backend that lives in
 * this process turned one stray throw into a frozen-looking app.
 */
export function recordProcessError(what: "uncaught exception" | "unhandled rejection", error: unknown): void {
  try {
    record("main", what, { error: formatArgs([error]) })
  } catch {
    // Recording is the last resort; a failure inside it has nowhere else to go.
  }
}

/**
 * Sends what the main process says to the day's log file.
 *
 * The backend runs in this process, and everything it warns or complains about
 * goes to a console that exists only while the app is started from a terminal.
 * Packaged, that output had nowhere to go at all.
 */
export function captureConsole(file: DailyLog): void {
  log = file
  for (const level of ["info", "warn", "error"] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      try {
        original(...args)
      } catch {
        // A closed stdout (EPIPE) must not turn a log line into a crash.
      }
      if (reporting) return
      file.write(level, formatArgs(args))
    }
  }
}

/*
 * Whether the app is on its way out. A renderer disappearing during shutdown is
 * exactly what shutdown looks like from here, and must not bring a window back.
 */
let quitting = false

/**
 * Restarts the app.
 *
 * app.relaunch only queues a second start for whenever this process exits, so
 * a quit has to follow it. It goes through app.quit rather than app.exit so
 * that before-quit still closes the backend and the shells it spawned.
 *
 * The renderer's own error page asks for this over the bridge: a page that has
 * failed to render has no other way out.
 */
export function relaunch(): void {
  quitting = true
  app.relaunch()
  app.quit()
}

/** Says the quit about to happen was asked for, so closing windows are not taken for failures. */
export function beginIntentionalQuit(): void {
  quitting = true
}

let gaveUp: (() => void) | undefined

/*
 * Told once recovery has run out of attempts and there will be no window at
 * all. Nothing else notices: session-end is registered per window (N11-33), so
 * from here on an OS shutdown has nobody to hear it.
 */
export function onRecoveryGaveUp(listener: () => void): void {
  gaveUp = listener
}

/** How recovery makes a window, and whether there is work that wants one while hidden. */
export interface RecoveryHost {
  create(show: boolean): BrowserWindow
  hasPendingWork(): boolean
}

let host: RecoveryHost | undefined
const health = new RendererHealth<WebContents>()
const schedule = new RecoverySchedule<ReturnType<typeof setTimeout>>({
  schedule: (run, ms) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle),
})
/* MiMo tracks one current renderer: the window made last. Events from a retired one are ignored. */
let current: BrowserWindow | undefined
/* Windows whose close went ahead, so their contents being destroyed is a close and not a failure. */
const closing = new WeakSet<BrowserWindow>()

export function setRecoveryHost(next: RecoveryHost): void {
  host = next
}

/** Called when a window's close goes ahead rather than hiding it. */
export function markClosing(window: BrowserWindow): void {
  closing.add(window)
}

/* A replacement is up: the broken window goes, without a close event, so nothing hides it to the tray. */
function retire(old: BrowserWindow | undefined, next: BrowserWindow): void {
  if (!old || old === next) return
  try {
    if (!old.isDestroyed()) old.destroy()
  } catch (error) {
    record(String(old.id), "old window cleanup failed", { error: String(error) })
  }
}

function requestReplacement(old: BrowserWindow | undefined, show: boolean): void {
  const outcome = schedule.request(() => {
    if (quitting) return true
    if (!host) return false
    try {
      const next = host.create(show)
      record(String(next.id), "renderer replaced", { replaced: old && !old.isDestroyed() ? old.id : null, shown: show })
      retire(old, next)
      return true
    } catch (error) {
      record("app", "renderer recovery failed", { error: formatArgs([error]) })
      return false
    }
  })
  if (outcome === "exhausted") {
    record("app", "renderer recovery gave up", schedule.snapshot)
    gaveUp?.()
  }
}

function recover(window: BrowserWindow, becameUnavailable: boolean, wasVisible: boolean): void {
  if (window !== current) return
  const visibility = recoveryVisibility({ becameUnavailable, windowClosing: closing.has(window), quitting, platform: process.platform })
  if (visibility === "none") return
  // macOS keeps a closed window's app alive; a hidden one is only rebuilt for a turn still running.
  if (visibility === "hidden" && !host?.hasPendingWork()) return
  requestReplacement(window, visibility === "preserve-visibility" ? wasVisible : false)
}

/**
 * MiMo's activate, for the tray, the Dock and a second launch: the current
 * window when its renderer is alive, otherwise a fresh visible one in place of
 * it (or, while a replacement is already queued, that one made visible).
 */
export function activate(show: (window: BrowserWindow) => void): void {
  const window = current && !current.isDestroyed() ? current : undefined
  const state = health.state(window?.webContents)
  if (schedule.snapshot.retryScheduled && (!window || state === "missing")) {
    requestReplacement(window, true)
    return
  }
  if (window && state !== "missing") {
    show(window)
    return
  }
  if (!host) return
  const next = host.create(true)
  retire(window, next)
}

/** The window recovery considers current, if it is still there. */
export function currentWindow(): BrowserWindow | undefined {
  return current && !current.isDestroyed() ? current : undefined
}

/**
 * The current window when its page has loaded and is not loading again, so a
 * message sent to it now is heard. Undefined while it starts or reloads, and
 * for a renderer that has failed, whose replacement is still to come.
 */
export function readyWindow(): BrowserWindow | undefined {
  const window = currentWindow()
  if (!window || health.state(window.webContents) !== "ready" || window.webContents.isLoading()) return undefined
  return window
}

/**
 * Attaches recovery to a new window, before anything is loaded into it: the
 * first thing that can fail is the load itself.
 */
export function wireRecovery(window: BrowserWindow): void {
  const contents = window.webContents
  const name = String(window.id)
  current = window
  health.track(contents)

  const visible = (starting: boolean): boolean => {
    if (starting) return true
    try {
      return window.isVisible()
    } catch {
      return false
    }
  }

  let watchdog: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    watchdog = undefined
    const unavailable = health.startupTimedOut(contents)
    if (!unavailable) return
    record(name, "renderer did not finish starting", { after: STARTUP_TIMEOUT })
    recover(window, unavailable, true)
  }, STARTUP_TIMEOUT)
  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = undefined
  }

  contents.on("did-finish-load", () => {
    if (!health.didFinishLoad(contents)) return
    clearWatchdog()
    if (window === current) schedule.rendererReady()
  })

  contents.on("did-fail-load", (_event, errorCode, description, url, isMainFrame) => {
    const starting = health.state(contents) === "starting"
    const wasVisible = visible(starting)
    const unavailable = health.didFailLoad(contents, { errorCode, isMainFrame })
    if (!unavailable) return
    clearWatchdog()
    record(name, "main frame failed to load", { code: errorCode, description, url })
    recover(window, unavailable, wasVisible)
  })

  contents.on("render-process-gone", (_event, details) => {
    const starting = health.state(contents) === "starting"
    const wasVisible = visible(starting)
    const unavailable = health.renderProcessGone(contents)
    clearWatchdog()
    record(name, "render process gone", { reason: details.reason, exitCode: details.exitCode, url: contentsURL(contents) })
    if (unavailable) recover(window, unavailable, wasVisible)
  })

  contents.on("destroyed", () => {
    const starting = health.state(contents) === "starting"
    const wasVisible = visible(starting)
    const unavailable = health.destroyed(contents)
    clearWatchdog()
    if (unavailable && !closing.has(window)) record(name, "web contents destroyed")
    if (unavailable) recover(window, unavailable, wasVisible)
  })

  // A hang is recorded and left alone; MiMo shows nothing for it either.
  window.on("unresponsive", () => record(name, "renderer unresponsive", { url: contentsURL(contents) }))
  window.on("responsive", () => record(name, "renderer responsive", { url: contentsURL(contents) }))

  /*
   * A preload that throws is the quietest failure: the page renders and
   * window.mcode is simply not there. The page may still be usable, so it is
   * only recorded.
   */
  contents.on("preload-error", (_event, preloadPath, error) => {
    record(name, "preload failed", { preloadPath, error: String(error) })
  })
}

/** The failures that belong to no particular window: recorded, never acted on. */
export function wireProcessRecovery(): void {
  app.on("before-quit", () => {
    quitting = true
    schedule.cancel()
  })
  app.on("will-quit", () => {
    quitting = true
  })

  app.on("child-process-gone", (_event, details) => {
    record("app", "child process gone", {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
    })
  })

  // Contents with no window of this app's behind them: a page the panel opened, say.
  app.on("render-process-gone", (_event, contents, details) => {
    if (currentWindow()?.webContents === contents) return
    record("app", "render process gone", { url: contentsURL(contents), reason: details.reason, exitCode: details.exitCode })
  })
}
