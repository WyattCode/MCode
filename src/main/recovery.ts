import fs from "node:fs/promises"
import path from "node:path"
import { app, dialog, shell, type BrowserWindow, type WebContents } from "electron"
import { label as L } from "./labels"
import { formatArgs, type DailyLog } from "./log-file"
import pkg from "../../package.json"

/**
 * What the app does when the window it is showing stops working.
 *
 * A renderer can fail in three ways that leave the main process running and
 * perfectly healthy, and in every one of them the app looks broken with no way
 * out of it. The page can hang, so the window takes clicks and answers none of
 * them. The renderer process can be killed - out of memory, a GPU fault, a
 * crash in Chromium - leaving a window that is now an empty frame. Or the page
 * can fail to load at all, leaving a blank one. None of the three close the
 * window, and none of them raise anything the page could catch and report,
 * because the page is the part that has stopped.
 *
 * Nothing in this app listened for any of them, so the only way out of all
 * three was the task manager. This module is the way out: it notices, says what
 * happened, and offers to restart.
 */

/** Stands in for a URL that cannot be read because the window has gone. */
const DESTROYED = "<destroyed>"

/*
 * Reading a URL off a window is the first thing every one of these handlers
 * wants to do and the most likely to throw, because they run at exactly the
 * moments the window is being torn down underneath them. A report that fails
 * to be written because it could not name the page is no report at all.
 */
function contentsURL(contents: WebContents): string {
  try {
    return contents.isDestroyed() ? DESTROYED : contents.getURL()
  } catch {
    return DESTROYED
  }
}

function windowURL(window: BrowserWindow): string {
  try {
    return window.isDestroyed() ? DESTROYED : contentsURL(window.webContents)
  } catch {
    return DESTROYED
  }
}

interface Entry {
  at: string
  window: string
  what: string
  detail: Record<string, unknown>
}

/*
 * Kept in memory, capped, and only ever read by the export below. The cap is
 * what stops a window that fails to load in a loop - a dev server that is down,
 * say, retrying every few seconds - from growing this without limit over the
 * hours an app can be left open.
 */
const entries: Entry[] = []
const MAX_ENTRIES = 100

/*
 * Set while this module is the one writing to the console, so the capture below
 * does not record its own output and then record recording it.
 */
let reporting = false

/* The day's log file (MiMo's userData/logs), once main has opened it. */
let log: DailyLog | undefined

function record(window: string, what: string, detail: Record<string, unknown> = {}): void {
  entries.push({ at: new Date().toISOString(), window, what, detail })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  log?.write("error", formatArgs([`[recovery] ${what}`, { window, ...detail }]))
  // Goes to the terminal in development; the log file has it either way.
  reporting = true
  try {
    console.error(`[recovery] ${what}`, { window, ...detail })
  } finally {
    reporting = false
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
 * Keeps what the main process says: in memory for the report, and in the day's
 * log file.
 *
 * The backend runs in this process, and everything it warns or complains about
 * goes to a console that exists only while the app is started from a terminal.
 * Packaged, that output had nowhere to go at all.
 *
 * Warnings and errors are kept in memory; the ordinary chatter of a running app
 * would fill the hundred lines long before anything went wrong. The file also
 * takes info lines, as MiMo's does, since it is not capped.
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
      reporting = true
      try {
        const text = formatArgs(args)
        file.write(level, text)
        if (level === "info") return
        entries.push({ at: new Date().toISOString(), window: "main", what: `console.${level}`, detail: { text } })
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
      } finally {
        reporting = false
      }
    }
  }
}

/**
 * Writes what went wrong to a file the user can find and send on.
 *
 * The reference zips its log directory at this point. MCode writes no log
 * files, so there is nothing to zip; what it does have is the record this
 * module has been keeping since launch, and the versions and paths that a bug
 * report always ends up having to ask for anyway. The crash dump directory is
 * named rather than copied, because dumps only exist there if the crash
 * reporter was started and this should not imply that it was.
 *
 * It lands in Downloads and the file manager opens on it, which is the same
 * gesture the reference performs.
 */
async function exportReport(window: BrowserWindow): Promise<void> {
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")
    const file = path.join(app.getPath("downloads"), `mcode-diagnostics-${stamp}.txt`)
    const lines = [
      `MCode ${pkg.version}`,
      `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`,
      `${process.platform} ${process.arch}, packaged: ${app.isPackaged}`,
      `Locale: ${app.getLocale()}`,
      `Window URL: ${windowURL(window)}`,
      `User data: ${app.getPath("userData")}`,
      `Crash dumps: ${app.getPath("crashDumps")}`,
      "",
      `Recorded: ${entries.length} of the last ${MAX_ENTRIES} events and main-process warnings`,
      "",
      ...(entries.length === 0
        ? ["(nothing recorded)"]
        : entries.map((entry) => `${entry.at}  [${entry.window}] ${entry.what} ${JSON.stringify(entry.detail)}`)),
    ]
    await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8")
    shell.showItemInFolder(file)
  } catch (error) {
    // Nowhere left to report this to but the record itself - the window that
    // would have shown it is the one that is broken.
    record("app", "failed to write the diagnostics report", { error: String(error) })
  }
}

/*
 * Whether the app is on its way out.
 *
 * A renderer process disappearing during shutdown is exactly what shutdown
 * looks like from here, so without this the last thing a user would see on
 * their way out is a dialog telling them the window they just closed has
 * terminated unexpectedly.
 */
let quitting = false

/**
 * Restarts the app.
 *
 * app.relaunch only queues a second start for whenever this process exits, so
 * a quit has to follow it or nothing happens at all. It goes through app.quit
 * rather than app.exit so that the before-quit handler still gets its chance to
 * close the backend; exiting outright would leave the shells it spawned running
 * with nothing left to reap them.
 *
 * Exported because two quite different things ask for it: the dialogs below,
 * and the renderer's own error page over the bridge, which has no other way out
 * of a page that has failed to render.
 */
export function relaunch(): void {
  quitting = true
  app.relaunch()
  app.quit()
}

/**
 * Says the quit about to happen was asked for.
 *
 * The recovery dialogs exist to notice a window that went away on its own, and
 * they cannot tell that from one closed on purpose. Installing an update quits
 * deliberately - and would otherwise be met, on the way out, by an offer to
 * reopen the app that is being replaced.
 */
export function beginIntentionalQuit(): void {
  quitting = true
}

/** What a recovery dialog offers. The order is the order they are shown in. */
interface Action {
  id: "relaunch" | "export" | "wait" | "quit"
  label: string
}

/**
 * Attaches the recovery handlers to one window.
 *
 * `name` is how the window is identified in the dialogs and the report; with
 * more than one window open it is the only way to tell which of them failed.
 */
export function wireRecovery(window: BrowserWindow, name: string): void {
  /*
   * One dialog at a time per window. These failures arrive in clusters - a
   * renderer that dies fires the process event and then usually a load failure
   * behind it - and without this the user would be answering the same question
   * several times over before the app would let them go.
   */
  let asking = false

  const ask = async (message: string, detail: string, hung: boolean): Promise<void> => {
    if (asking || quitting || window.isDestroyed()) return
    asking = true
    try {
      /*
       * Exporting the report has to leave the user where they were rather than
       * dismissing the only thing offering to fix their app, so the dialog is
       * raised again after it. Every other answer ends the conversation.
       */
      while (!window.isDestroyed() && !quitting) {
        /*
         * A hung window may yet come back, so waiting is worth offering and
         * quitting is not the third choice. A dead or blank one will not, so
         * there the third choice is to give up on it.
         */
        const actions: Action[] = hung
          ? [
              { id: "relaunch", label: L("desktop.recovery.action.relaunch", "Relaunch") },
              { id: "export", label: L("desktop.recovery.action.exportLogs", "Export Logs") },
              { id: "wait", label: L("desktop.recovery.action.keepWaiting", "Keep Waiting") },
            ]
          : [
              { id: "relaunch", label: L("desktop.recovery.action.relaunch", "Relaunch") },
              { id: "export", label: L("desktop.recovery.action.exportLogs", "Export Logs") },
              { id: "quit", label: L("desktop.recovery.action.quit", "Quit") },
            ]

        const answer = await dialog.showMessageBox(window, {
          type: "warning",
          buttons: actions.map((action) => action.label),
          defaultId: 0,
          /*
           * Dismissing the dialog - Escape, or the close button on platforms
           * that draw one - counts as the third button. For a hung window that
           * is "keep waiting", which is the harmless reading of walking away.
           * For a dead one it is "quit", which is deliberate: there is nothing
           * left behind the dialog to go back to, so leaving it there would
           * only trap the user in front of a window that will never draw again.
           */
          cancelId: 2,
          message,
          detail,
        })

        const chosen = actions[answer.response]?.id
        if (chosen === "export") {
          await exportReport(window)
          continue
        }
        if (chosen === "relaunch") relaunch()
        else if (chosen === "quit") {
          quitting = true
          app.quit()
        }
        return
      }
    } finally {
      asking = false
    }
  }

  const loadFailed = (
    event: string,
    code: number,
    description: string,
    url: string,
    mainFrame: boolean,
  ): void => {
    record(name, event, { code, description, url, mainFrame, currentURL: windowURL(window) })
    /*
     * A subframe that will not load leaves the app itself perfectly usable, and
     * -3 is the code Chromium reports for a load the app itself cancelled -
     * navigating away, or reloading before the first load had finished. Neither
     * is a failure anyone needs to be told about, and raising a modal dialog on
     * an ordinary reload would be worse than the gap this module fills.
     */
    if (!mainFrame || code === -3) return
    void ask(
      L("desktop.recovery.loadFailed", "MCode failed to load"),
      L(
        "desktop.recovery.loadFailed.detail",
        "Window: {{window}}\nURL: {{url}}\nError: {{code}} {{description}}",
        { window: name, url, code, description },
      ),
      false,
    )
  }

  window.webContents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
    loadFailed("did-fail-load", code, description, url, mainFrame)
  })

  /*
   * The provisional event is the one that fires when the load never got as far
   * as a response - the file is missing, or in development the dev server is
   * not up. Listening only for did-fail-load would miss exactly the case where
   * the window has nothing in it at all.
   */
  window.webContents.on("did-fail-provisional-load", (_event, code, description, url, mainFrame) => {
    loadFailed("did-fail-provisional-load", code, description, url, mainFrame)
  })

  window.webContents.on("render-process-gone", (_event, details) => {
    record(name, "render process gone", {
      reason: details.reason,
      exitCode: details.exitCode,
      currentURL: windowURL(window),
    })
    void ask(
      L("desktop.recovery.terminated", "MCode window terminated unexpectedly"),
      L(
        "desktop.recovery.terminated.detail",
        "Window: {{window}}\nReason: {{reason}}\nCode: {{code}}",
        {
          window: name,
          reason: details.reason,
          // Some reasons carry no exit code at all, and the details object is
          // built by Chromium rather than by us, so the field is not always
          // there to read despite what its type says.
          code: typeof details.exitCode === "number" ? details.exitCode : L("desktop.recovery.unknown", "<unknown>"),
        },
      ),
      false,
    )
  })

  /*
   * Chromium raises this once the window has failed to answer for a few
   * seconds, and raises it again only after a matching "responsive". So
   * choosing to keep waiting genuinely means waiting: the dialog does not come
   * straight back while the page is still stuck.
   */
  window.on("unresponsive", () => {
    record(name, "renderer unresponsive", { currentURL: windowURL(window) })
    void ask(
      L("desktop.recovery.unresponsive", "MCode is not responding"),
      L("desktop.recovery.unresponsive.detail", "You can relaunch the app, open the logs, or keep waiting."),
      true,
    )
  })

  // Worth recording even though there is nothing to do about it: a hang that
  // ended on its own tells you how long it lasted, which is the first thing
  // anyone reading the report will want to know.
  window.on("responsive", () => {
    record(name, "renderer responsive", { currentURL: windowURL(window) })
  })

  /*
   * A preload that throws is the quietest failure of the lot. The page loads,
   * it renders, and window.mcode is simply not there - so every menu command,
   * the clipboard, the file dialogs and the backend port are all missing at
   * once and the app just sits there looking normal. No dialog, because the
   * page may still be usable, but it must be in the report.
   */
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    record(name, "preload failed", { preloadPath, error: String(error) })
  })
}

/**
 * The failures that belong to no particular window.
 *
 * A utility or GPU process going away does not necessarily break anything the
 * user can see, so none of this interrupts them; it is here so that when they
 * do export a report after something else goes wrong, the thing that actually
 * started it is in the file.
 */
export function wireProcessRecovery(): void {
  app.on("before-quit", () => {
    quitting = true
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

  // The window-level handler above covers the windows this app opened. This
  // one also catches contents with no window behind them, which is where a
  // failure in something the page opened for itself would surface.
  app.on("render-process-gone", (_event, contents, details) => {
    record("app", "render process gone", {
      url: contentsURL(contents),
      reason: details.reason,
      exitCode: details.exitCode,
    })
  })
}
