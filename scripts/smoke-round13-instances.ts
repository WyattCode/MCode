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
import { pinnedProfile, relaunchArgs } from "../src/main/desktop-rules"
import { startBounds } from "../src/main/work-area"

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
    check("the tray's Open does nothing while quitting", /const open = \(\) => \{\s*if \(!closing\) activate\(raise\)/.test(main))
    check("nor does a tray profile switch, which would build a window", /click: \(\) => \{\s*if \(closing\) return\s*const window = currentWindow\(\) \?\? createWindow\(\)/.test(main))
    check("nor does the Dock's activate", /^\{\s*\/\/[^\n]*\n\s*if \(closing\) return/.test(body(main, 'app.on("activate", () => {')))
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
}
