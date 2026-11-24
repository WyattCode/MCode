/**
 * Round 36: the armed quit has to name the key that would actually quit, on the one
 * surface that stays legible with every window closed.
 *
 * The defect the round before this one left behind: the menu bar's quit row took its
 * words from a sentence that names ⌘Q, while the same row's accelerator column is
 * built from the binding — so a person who bound Control+Shift+Q read "press ⌘Q
 * again" above "⌃⇧Q". Checked with the binding default and with a rebind, on macOS
 * where a first press only arms and elsewhere where it leaves at once. (The same
 * report's second finding — that with no window on screen only a toast speaks — is
 * fixed on the `feat/quit-notice` branch, for the next version.)
 *
 * Checked by running the menu module against `scripts/electron-double.ts` — an
 * object that is not Electron, records what it is asked for, and never opens a
 * window — rather than by reading menu.ts for a shape. The previous file could go
 * fully green with a menu bar that never changed its words at all; that blind spot is
 * the reason this one exists.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { QUIT_ARM_MS, armQuitLabel } from "../src/main/desktop-rules"

type Check = (label: string, ok: boolean, detail?: unknown) => void

const root = process.cwd()
const HINT = "Press ⌘Q again to Quit"

/** The menu module and the stand-in it was bundled against, out of one built file, so both read one record. */
async function load(): Promise<{ menu: typeof import("../src/main/menu"); double: typeof import("./electron-double").double }> {
  const entry = path.join(root, "out", "round36-entry.ts")
  await fs.mkdir(path.dirname(entry), { recursive: true })
  await fs.writeFile(entry, 'export * as menu from "../src/main/menu"\nexport { double } from "../scripts/electron-double"\n')
  const bundle = entry.replace(/\.ts$/, ".cjs")
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "silent",
    alias: { electron: path.join(root, "scripts/electron-double.ts"), "@shared": path.join(root, "src/shared") },
  })
  const created = (await import(pathToFileURL(bundle).href)) as {
    menu: typeof import("../src/main/menu")
    double: typeof import("./electron-double").double
  }
  return created
}

/** Runs the scenario on the platform named: macOS is where a first press only arms the quit. */
function onPlatform(name: string, run: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: name, configurable: true })
  return run().finally(() => {
    if (descriptor) Object.defineProperty(process, "platform", descriptor)
  })
}

export async function quitWordsChecks(check: Check): Promise<void> {
  /*
   * The words themselves first, without any app around them: the sentence names
   * ⌘Q because that is the default, and only the binding decides what to show.
   */
  check("a default binding leaves the sentence alone", armQuitLabel(HINT, "Ctrl+Q", "darwin") === HINT, armQuitLabel(HINT, "Ctrl+Q", "darwin"))
  check("a rebind puts that key cap in its place", armQuitLabel(HINT, "Meta+Shift+Q", "darwin") === "Press ⌃⇧Q again to Quit", armQuitLabel(HINT, "Meta+Shift+Q", "darwin"))
  check("a Linux binding is spelled out", armQuitLabel(HINT, "Ctrl+Alt+Q", "linux") === "Press Ctrl+Alt+Q again to Quit", armQuitLabel(HINT, "Ctrl+Alt+Q", "linux"))
  check("a binding that spells nothing leaves the words as written", armQuitLabel(HINT, "", "darwin") === HINT, armQuitLabel(HINT, "", "darwin"))

  const { menu, double } = await load()
  /* One scenario: nothing left armed from the last, the given windows, the given
     binding. The binding goes in the way the window sends it — as the keys a menu is
     built for — which is also what rebuilds the bar, so the rebuild count is read
     from the moment the arm starts rather than "at least one". */
  let menuSetsBefore = 0
  const scenario = (windows: { shown?: boolean; minimized?: boolean }[], binds: Record<string, string> = {}): void => {
    double.reset()
    menu.forgetQuitArm()
    double.setWindows(windows)
    menu.buildMenu({ binds, recording: false })
    menuSetsBefore = double.menuSets()
  }
  const row = (): Record<string, unknown> => double.quitRow() ?? {}
  const label = (): string => String(row().label ?? "")

  await onPlatform("darwin", async () => {
    scenario([{ shown: true }])
    menu.requestAppQuit(true)
    check("a first press rewords the quit row", label().includes("⌘Q") && !label().includes("Quit MCode"), label())
    check("the reworded row still claims the keys it always claimed", row().accelerator === "CmdOrCtrl+Q", row())
    check("the window was told through the fixed channel", double.sent().filter((channel) => channel === "mcode:quit-hint").length === 1, double.sent())
    check("the menu bar was rebuilt to carry it", double.menuSets() > menuSetsBefore, { before: menuSetsBefore, after: double.menuSets() })

    scenario([{ shown: true }], { "app.quit": "Meta+Shift+Q" })
    menu.requestAppQuit(true)
    check("a rebound quit names the key that quits, not the sentence's", label().includes("⌃⇧Q") && !label().includes("⌘Q"), label())
    check("its accelerator column agrees", row().accelerator === "Control+Shift+Q", row())

    scenario([{ shown: false }])
    menu.requestAppQuit(true)
    check("a window hidden in the tray still gets its words in the menu row", label().includes("⌘Q"), label())
    check("and the toast still goes out to it as well", double.sent().includes("mcode:quit-hint"), double.sent())

    double.reset()
    menu.forgetQuitArm()
    double.setWindows([])
    menu.buildMenu({ binds: {}, recording: false })
    menu.requestAppQuit(true)
    check("with no window at all the menu row still says it", label().includes("⌘Q"), label())
    check("nothing is sent to a window that is not there", double.sent().length === 0, double.sent())

    double.reset()
    menu.forgetQuitArm()
    double.setWindows([{ shown: true }])
    menu.buildMenu({ binds: {}, recording: false })
    menu.requestAppQuit(true)
    menu.requestAppQuit(true)
    check("the second press inside the window reaches the app's own quit", double.calls.some((call) => call.method === "app.quit"), double.calls.map((call) => call.method))

    /*
     * The waiting row is a promise with a deadline: once the arm has expired the row
     * has to go back to its own name, or the menu bar keeps asking for a second press
     * that would only arm the quit again. The wait is the real one — the arm is two
     * seconds, and a check that pretended otherwise would not see the timer.
     */
    double.reset()
    menu.forgetQuitArm()
    double.setWindows([{ shown: true }])
    menu.buildMenu({ binds: {}, recording: false })
    menu.requestAppQuit(true)
    check("the row is worded for the wait", label().includes("⌘Q"), label())
    await new Promise((wake) => setTimeout(wake, QUIT_ARM_MS + 250))
    check("when the wait is over the row says its own name again", label() === "Quit MCode", label())
  })

  /*
   * Arming is a macOS habit; elsewhere the first press leaves. Without this, code
   * that armed on every platform would ask a Windows quit for two presses and every
   * check above would still be green, because each of them arms before it asks.
   */
  await onPlatform("win32", async () => {
    double.reset()
    menu.forgetQuitArm()
    double.setWindows([{ shown: true }])
    menu.buildMenu({ binds: {}, recording: false })
    menu.requestAppQuit(true)
    const quit = double.calls.some((call) => call.method === "app.quit")
    check("off macOS the first press leaves at once", quit && label() === "Quit MCode", { quit, label: label() })
    check("and nothing was broadcast about it", !double.sent().includes("mcode:quit-hint"), double.sent())
  })

  menu.forgetQuitArm()
}

/* Run me on my own: path.basename, because a Windows separator would otherwise
   make this entry never fire and the file would report nothing at all. */
if (path.basename(process.argv[1] ?? "") === "smoke-round36-quit-words.ts") {
  let failed = 0
  await quitWordsChecks((label, ok, detail) => {
    if (!ok) failed++
    console.log(ok ? "PASS" : "FAIL", label, detail ?? "")
  })
  process.exitCode = failed ? 1 : 0
}
