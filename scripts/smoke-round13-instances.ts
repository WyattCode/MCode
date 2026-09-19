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
}
