/**
 * Round 13 (lane I): instances and the window's life around them - which
 * profile a run uses, what a second launch does while the app is quitting or
 * still loading, the Windows shutdown path, and where the window opens. Kept
 * apart from smoke.ts the way the earlier rounds are; smoke.ts calls
 * `roundThirteenInstanceChecks` with its own check and section.
 *
 * Nothing here starts Electron: the rules are plain functions, and the wiring
 * is read out of the main process's source.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { WINDOW_MIN, WINDOW_PREFERRED, pinnedProfile, relaunchArgs } from "../src/main/desktop-rules"
import { fillsWorkArea, linuxMaximizeToggle, startBounds } from "../src/main/work-area"

const posix = (...parts: string[]) => parts.join("/")
const win = (...parts: string[]) => parts.join("\\")

/** The braces that follow `opening` in the source, or "" when it is not there. */
function body(source: string, opening: string): string {
  const start = source.indexOf(opening)
  if (start < 0) return ""
  const open = source.indexOf("{", start + opening.length - 1)
  let depth = 0
  for (let i = open; i >= 0 && i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1)
  }
  return ""
}

export async function roundThirteenInstanceChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = process.cwd()
  const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")

  // ------------------------------------------------------------------ I13-1
  section("Round 13 (I13-1): an unpackaged run keeps a profile of its own")
  {
    check(
      "the development build's default profile is the default's name plus -dev",
      pinnedProfile("C:\\Users\\u\\AppData\\Roaming\\MCode", "C:\\Users\\u\\AppData\\Roaming", "MCode", win, false) === "C:\\Users\\u\\AppData\\Roaming\\MCode-dev" &&
        pinnedProfile("/home/u/.config/MCode", "/home/u/.config", "MCode", posix, false) === "/home/u/.config/MCode-dev" &&
        pinnedProfile("/Users/u/Library/Application Support/MCode", "/Users/u/Library/Application Support", "MCode", posix, false) ===
          "/Users/u/Library/Application Support/MCode-dev",
    )
    check(
      "a profile chosen on purpose (--user-data-dir, or a probe's setPath) still wins in development",
      pinnedProfile("/tmp/probe-data", "/home/u/.config", "MCode", posix, false) === undefined &&
        pinnedProfile("C:\\probe\\data", "C:\\Users\\u\\AppData\\Roaming", "MCode", win, false) === undefined,
    )
    check(
      "the packaged build keeps the folder every release used",
      pinnedProfile("C:\\Users\\u\\AppData\\Roaming\\MCode", "C:\\Users\\u\\AppData\\Roaming", "MCode", win, true) === "C:\\Users\\u\\AppData\\Roaming\\mcode" &&
        pinnedProfile("/home/u/.config/MCode", "/home/u/.config", "MCode", posix) === "/home/u/.config/mcode",
    )
    check(
      "the main process says which build it is",
      /pinnedProfile\(app\.getPath\("userData"\), app\.getPath\("appData"\), app\.getName\(\), path\.join, app\.isPackaged\)/.test(main),
    )
    check(
      "the single-instance lock stays per profile, packaged only, so dev and packaged run side by side",
      /if \(app\.isPackaged && !app\.requestSingleInstanceLock\(\)\)/.test(main) && !/requestSingleInstanceLock\([^)]/.test(main),
    )
  }

  // ------------------------------------------------------------------ I13-6
  section("Round 13 (I13-6): a second launch hands over before the environment is set up")
  {
    const lockAt = main.indexOf("requestSingleInstanceLock()")
    const profileAt = main.indexOf('if (pinned) app.setPath("userData", pinned)')
    const later = ["refreshEnvironment({", "new DailyLog(", "startLocalCrashDumps({", "fcitxEnvironment(", "displaySwitches(", "bundledRuntimeEnv({", "readBootPrefs("].map((marker) => [marker, main.indexOf(marker)] as const)
    // Between the two there is only the lock's own comment.
    const between = profileAt > 0 && lockAt > profileAt ? main.slice(main.indexOf("\n", profileAt), lockAt).replace(/\/\*[\s\S]*?\*\//g, "").trim() : "missing"
    check("the lock is taken right after the profile is set", between === "if (app.isPackaged && !app.", { profileAt, lockAt, between: between.slice(0, 200) })
    check("and before the log, the crash reporter, the environment refresh and the rest", later.every(([, at]) => at > lockAt), later)
    check("a second launch leaves at once, not after the rest of the module has run", /if \(app\.isPackaged && !app\.requestSingleInstanceLock\(\)\) process\.exit\(0\)/.test(main))
  }

  // ------------------------------------------------------------------ I13-2
  section("Round 13 (I13-2): a launch made while quitting starts once the quit is done")
  {
    const handedOver = ["C:\\MCode\\MCode.exe", "--allow-file-access-from-files", "--original-process-start-time=1325", "mcode://open-session?id=s1", "--flag"]
    check(
      "the relaunch keeps the second launch's own arguments, a link among them, less the executable and Chromium's additions",
      JSON.stringify(relaunchArgs(handedOver)) === JSON.stringify(["mcode://open-session?id=s1", "--flag"]),
      relaunchArgs(handedOver),
    )
    check("a plain second launch relaunches with nothing", relaunchArgs(["C:\\MCode\\MCode.exe"]).length === 0)
    const second = body(main, 'app.on("second-instance", (_event, argv) => {')
    const queue = body(main, "function relaunchAfterQuit(argv: readonly string[]) {")
    check("while quitting, a second launch is queued instead of raising the window the quit hid", /^\{\s*if \(closing\) return relaunchAfterQuit\(argv\)/.test(second), second.slice(0, 120))
    check("queued once, as app.relaunch with the handed-over arguments", /if \(relaunchQueued\) return/.test(queue) && /app\.relaunch\(\{ args: relaunchArgs\(argv\) \}\)/.test(queue), queue)
    check("a macOS link while quitting is queued the same way", /if \(closing\) return relaunchAfterQuit\(\[process\.execPath, url\]\)/.test(body(main, 'app.on("open-url", (event, url) => {')))
    check("the tray's Open does nothing while quitting", /const open = \(\) => \{\s*if \(!closing\) activate\(\(window\) => \{\s*cancelPendingHide\(window\)\s*raise\(window\)/.test(main))
    check("nor does the Dock's activate", /^\{\s*if \(closing\) return/.test(body(main, 'app.on("activate", () => {')))
  }

  // ------------------------------------------------------------------ I13-5
  section("Round 13 (I13-5): a second launch always brings the window up, and a link is never lost")
  {
    const recovery = await fs.readFile(path.join(root, "src/main/recovery.ts"), "utf8")
    const deliver = body(main, "function deliverLink(raw: string) {")
    const activateAt = deliver.indexOf("activate(raise)")
    check(
      "the window is activated first, before the link is even judged (a link this app does not open still raises it)",
      activateAt > 0 && deliver.indexOf("if (!target) return") > activateAt && !/if \(!target\) return/.test(deliver.slice(0, activateAt)),
      deliver,
    )
    check(
      "the link goes to the window recovery holds current, and only once its page is ready",
      /const window = readyWindow\(\)/.test(deliver) && !/\[\.\.\.windows\]/.test(deliver) && /window\.webContents\.send\("mcode:open-link", target\)/.test(deliver),
    )
    check("otherwise it is kept for the page to take when it connects", /if \(!window\) \{\s*pendingLink = raw/.test(deliver) && /ipcMain\.handle\("mcode:take-link"/.test(main))
    check("before the app is ready it is only kept: there is no window to raise yet", /if \(!app\.isReady\(\)\) \{\s*if \(target\) pendingLink = raw\s*return/.test(deliver))
    const ready = body(recovery, "export function readyWindow(): BrowserWindow | undefined {")
    check(
      "ready means recovery's current window, its renderer loaded and not loading again",
      /currentWindow\(\)/.test(ready) && /health\.state\(window\.webContents\) !== "ready"/.test(ready) && /window\.webContents\.isLoading\(\)/.test(ready),
      ready,
    )
    const second = body(main, 'app.on("second-instance", (_event, argv) => {')
    check("a second launch without a link is activated too", /if \(raw\) return deliverLink\(raw\)\s*\/\/[^\n]*\n\s*if \(app\.isReady\(\)\) activate\(raise\)/.test(second), second)
  }

  // ------------------------------------------------------------------ I13-4
  section("Round 13 (I13-4): a saved position is put wholly on a screen at startup")
  {
    const primary = { x: 0, y: 0, width: 1920, height: 1040 }
    const right = { x: 1920, y: 0, width: 1280, height: 984 }
    const min = { width: 720, height: 640 }
    const titleAbove = startBounds({ x: 200, y: -300, width: 1200, height: 800 }, [primary], min)
    check("a window whose title bar was above the screen comes down onto it", JSON.stringify(titleAbove) === JSON.stringify({ x: 200, y: 0, width: 1200, height: 800 }), titleAbove)
    const hanging = startBounds({ x: 1500, y: 600, width: 1000, height: 800 }, [primary], min)
    check("one hanging past the right and bottom edges is pulled back in", hanging.x === 920 && hanging.y === 240 && hanging.width === 1000 && hanging.height === 800, hanging)
    const gone = startBounds({ x: -2000, y: 100, width: 1000, height: 700 }, [primary, right], min)
    check("one left on a monitor that is gone lands on the nearest one there is", gone.x === 0 && gone.y === 100, gone)
    const tooBig = startBounds({ x: 1900, y: 0, width: 3000, height: 1500 }, [primary, right], min)
    check("one larger than the screen it mostly covers is shrunk to fit", JSON.stringify(tooBig) === JSON.stringify(primary) || JSON.stringify(tooBig) === JSON.stringify(right), tooBig)
    const fine = startBounds({ x: 2000, y: 50, width: 1000, height: 700 }, [primary, right], min)
    check("one already on a screen stays exactly where it was", JSON.stringify(fine) === JSON.stringify({ x: 2000, y: 50, width: 1000, height: 700 }), fine)
    const small = startBounds({ x: 10, y: 10, width: 300, height: 200 }, [primary], min)
    check("a saved size below the minimum is grown to it", small.width === 720 && small.height === 640, small)
    check("with no displays to ask (a locked workstation) the saved bounds are kept", JSON.stringify(startBounds({ x: -50, y: -50, width: 800, height: 700 }, [], min)) === JSON.stringify({ x: -50, y: -50, width: 800, height: 700 }))
    const state = await fs.readFile(path.join(root, "src/main/window-state.ts"), "utf8")
    const restoreBody = state.slice(state.indexOf("export function restore()"), state.indexOf("const baselines"))
    check(
      "restore() places saved bounds with that rule, over every display's work area",
      /startBounds\(saved\.bounds, areas, MIN\)/.test(restoreBody) && /screen\.getAllDisplays\(\)\.map\(\(display\) => display\.workArea\)/.test(restoreBody) && !/overlapX|>= 120/.test(state),
    )
  }

  // ------------------------------------------------------------------ I13-3
  section("Round 13 (I13-3): a Windows shutdown or logoff runs the quit's teardown")
  {
    const query = body(main, 'window.on("query-session-end", () => {')
    const end = body(main, 'window.on("session-end", () => {')
    const beforeQuit = body(main, 'app.on("before-quit", (event) => {')
    check("query-session-end asks for the quit, so before-quit's teardown runs", /noteOsQuit\(\)/.test(query) && /app\.quit\(\)/.test(query), query)
    check("and never holds the shutdown up", query !== "" && !/preventDefault/.test(query))
    check(
      "the teardown it reaches saves the windows, closes the backend and runs a pending install",
      /saveWindowState\(window\)/.test(beforeQuit) && /started\.close\(\)/.test(beforeQuit) && /runPendingInstall\(\)/.test(beforeQuit),
    )
    check(
      "session-end writes every window's state synchronously, and starts the teardown if nothing has",
      /for \(const each of windows\) saveWindowState\(each\)/.test(end) && /if \(!closing\) app\.quit\(\)/.test(end) && end.indexOf("saveWindowState") < end.indexOf("app.quit()"),
      end,
    )
    const state = await fs.readFile(path.join(root, "src/main/window-state.ts"), "utf8")
    check("that save is synchronous", /writeAtomicSync\(file\(\)/.test(body(state, "export function saveWindowState(window: BrowserWindow): void {")))
    check(
      "the comment no longer blames the shared flag for the skipped teardown",
      !/Sharing one flag meant an OS shutdown set it through session-end and then\s*\n\s*\* before-quit's first line returned/.test(main) && /Electron emits no before-quit/.test(main),
    )
  }

  // ------------------------------------------------------------------ I13-7
  section("Round 13 (I13-7, Linux): maximize fills the work area and is saved as maximized")
  {
    const area = { x: 0, y: 27, width: 1920, height: 1053 }
    const sizes = { min: WINDOW_MIN, preferred: WINDOW_PREFERRED }
    check("a window within 2 px of the work area's size fills it; 3 px short does not", fillsWorkArea({ x: 5, y: 30, width: 1918, height: 1051 }, area) && !fillsWorkArea({ x: 0, y: 27, width: 1917, height: 1053 }, area))
    const normal = { x: 200, y: 150, width: 1100, height: 760 }
    const up = linuxMaximizeToggle(normal, area, undefined, sizes)
    check("maximizing a normal window sizes it to the work area", up.maximized && JSON.stringify(up.bounds) === JSON.stringify(area), up)
    const down = linuxMaximizeToggle(area, area, normal, sizes)
    check("toggling a filled window puts back the bounds it had", !down.maximized && JSON.stringify(down.bounds) === JSON.stringify(normal), down)
    const fresh = linuxMaximizeToggle(area, area, undefined, sizes)
    check("with nothing to go back to, the preferred size in the middle of the area", !fresh.maximized && fresh.bounds.width === 1340 && fresh.bounds.height === 880 && fresh.bounds.x === 290 && fresh.bounds.y === 114, fresh)
    const again = linuxMaximizeToggle(area, area, { x: 0, y: 27, width: 1921, height: 1060 }, sizes)
    check("saved bounds that would fill the area again give the preferred size instead", !again.maximized && again.bounds.width === 1340, again)
    const tiny = linuxMaximizeToggle(area, area, { x: 40, y: 60, width: 300, height: 200 }, sizes)
    check("saved bounds below the minimum are grown to it", tiny.bounds.width === WINDOW_MIN.width && tiny.bounds.height === WINDOW_MIN.height && tiny.bounds.x === 40, tiny)
    const state = await fs.readFile(path.join(root, "src/main/window-state.ts"), "utf8")
    const menu = await fs.readFile(path.join(root, "src/main/menu.ts"), "utf8")
    const toggle = body(state, "export function toggleMaximize(window: BrowserWindow): void {")
    const save = body(state, "export function saveWindowState(window: BrowserWindow): void {")
    check(
      "on Linux the toggle sets bounds from that rule; elsewhere it stays the native maximize",
      /if \(process\.platform !== "linux"\) \{\s*if \(window\.isMaximized\(\)\) window\.unmaximize\(\)\s*else window\.maximize\(\)/.test(toggle) &&
        /linuxMaximizeToggle\(current, area, beforeFill\.get\(window\) \?\? baselines\.get\(window\)/.test(toggle) &&
        /window\.setBounds\(next\.bounds\)/.test(toggle),
      toggle,
    )
    check(
      "a window that fills its work area is saved as maximized, with the bounds it had before",
      /const fills = fillsItsWorkArea\(window\)/.test(save) && /maximized: fills \|\| window\.isMaximized\(\)/.test(save) && /normalBounds: fills \? \(beforeFill\.get\(window\) \?\? baseline\)/.test(save) &&
        /if \(process\.platform !== "linux"\) return false/.test(body(state, "function fillsItsWorkArea(window: BrowserWindow): boolean {")),
    )
    check(
      "a window saved as maximized opens filling its display's work area on Linux",
      /if \(saved\.maximized\) maximizeAtStart\(window, requested\)/.test(main) &&
        /beforeFill\.set\(window, bounds\)\s*window\.setBounds\(screen\.getDisplayMatching\(bounds\)\.workArea\)/.test(body(state, "export function maximizeAtStart(window: BrowserWindow, bounds: Rectangle): void {")),
    )
    check(
      "the title bar's toggle and the menu's both go through it",
      /case "maximize":\s*return toggleMaximize\(window\)/.test(main) && /if \(window\) toggleMaximize\(window\)/.test(menu) && !/window\.unmaximize\(\)/.test(main + menu),
    )
  }
}
