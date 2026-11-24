/**
 * Round 36: the armed quit has to name the key that would actually quit, in the menu
 * that was actually installed, reached through the row's own click.
 *
 * Two defects this round chases. The first: the menu bar's quit row took its words
 * from a sentence naming ⌘Q while the same row's accelerator column is built from the
 * binding, so a person who bound Control+Shift+Q read "press ⌘Q again" above "⌃⇧Q".
 * The second is the shape of the checking: reading the last *built* template, or
 * calling the quit function by hand, both stay green while the bar a person looks at
 * never changes and the accelerator never passes the "was this the shortcut?" flag. So
 * every claim here is read off the menu handed to `setApplicationMenu`, and every
 * press goes through that row's own `click` with the event Electron would hand it.
 *
 * The notice carries a {key} hole rather than a key cap, so the wording and the
 * accelerator column cannot disagree in any of the eighteen languages; a sentence that
 * lost the hole, or a binding that cannot be spelled, says nothing at all rather than
 * naming a key that does not quit.
 *
 * (The report's third finding — that with no window on screen the notice is only the
 * menu row, never a system notification — is fixed on the `feat/quit-notice` branch,
 * for the next version. Nothing here claims a person *saw* the row: these checks
 * record what the app installed and sent, not what was on screen.)
 */
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { QUIT_ARM_MS } from "../src/main/desktop-rules"
import { fillQuitNotice, formatChord } from "../src/shared/chord"

type Check = (label: string, ok: boolean, detail?: unknown) => void

/** A quit row as the menu hands it over, with the click Electron would call. */
type Row = { label?: string; accelerator?: string; click?: (item: unknown, window: unknown, event: { triggeredByAccelerator?: boolean }) => void }

const root = process.cwd()
const HINT = "Press {key} again to Quit"
const PLAIN = "Quit MCode"

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
   * The words themselves first, with no app around them: the sentence names no key of
   * its own, and only the binding decides what fills the hole.
   */
  check("a default binding names the command key", fillQuitNotice(HINT, "Ctrl+Q", "darwin") === "Press ⌘Q again to Quit", fillQuitNotice(HINT, "Ctrl+Q", "darwin"))
  check("a rebind names the key that quits", fillQuitNotice(HINT, "Meta+Shift+Q", "darwin") === "Press ⌃⇧Q again to Quit", fillQuitNotice(HINT, "Meta+Shift+Q", "darwin"))
  check("a Linux binding is spelled out", fillQuitNotice(HINT, "Ctrl+Alt+Q", "linux") === "Press Ctrl+Alt+Q again to Quit", fillQuitNotice(HINT, "Ctrl+Alt+Q", "linux"))
  check("a sentence in another language still gets the real cap", fillQuitNotice("Appuyez de nouveau sur {key} pour quitter", "Meta+Shift+Q", "darwin") === "Appuyez de nouveau sur ⌃⇧Q pour quitter", fillQuitNotice("Appuyez de nouveau sur {key} pour quitter", "Meta+Shift+Q", "darwin"))
  check("a sentence that lost its hole says nothing", fillQuitNotice("Press again to Quit", "Ctrl+Q", "darwin") === "", fillQuitNotice("Press again to Quit", "Ctrl+Q", "darwin"))
  check("a binding that cannot be spelled says nothing", fillQuitNotice(HINT, "", "darwin") === "", fillQuitNotice(HINT, "", "darwin"))
  // The keypad's operators are spelled by the legend on the key, never by the recorder's token.
  check("the keypad key is read off its cap", formatChord("Ctrl+NumpadAdd", "darwin") === "⌘+", formatChord("Ctrl+NumpadAdd", "darwin"))

  const { menu, double } = await load()
  /*
   * One scenario at a time: nothing left armed from the last, the given windows, the
   * given binding. The binding arrives the way the window sends it — as the keys a menu
   * is built for — which rebuilds the bar itself, so the install count is read from the
   * moment the arm starts rather than as "at least one".
   */
  let installsBefore = 0
  const scenario = (windows: { shown?: boolean }[], keys: Record<string, string> = {}, recording = false): void => {
    double.reset()
    menu.forgetQuitArm()
    double.setWindows(windows)
    menu.buildMenu({ binds: keys, recording })
    installsBefore = double.menuSets()
  }
  const row = (): Row => (double.quitRow() ?? {}) as Row
  const label = (): string => String(row().label ?? "")
  const quitCalls = (): number => double.calls.filter((call) => call.method === "app.quit").length
  const hints = (): number => double.sent().filter((channel) => channel === "mcode:quit-hint").length
  const installs = (): number => double.menuSets() - installsBefore
  /** The row's own click, with the event Electron gives a chord that fired the menu item. */
  const pressChord = (): void => {
    const click = row().click
    if (typeof click !== "function") throw new Error("the installed menu has no quit row to press")
    click(undefined, undefined, { triggeredByAccelerator: true })
  }
  /** The same row picked with a mouse: no chord, so no waiting. */
  const clickWithMouse = (): void => {
    const click = row().click
    if (typeof click !== "function") throw new Error("the installed menu has no quit row to click")
    click(undefined, undefined, {})
  }

  await onPlatform("darwin", async () => {
    scenario([{ shown: true }])
    pressChord()
    check("a first press rewords the installed row", label().includes("⌘Q") && label() !== PLAIN, label())
    check("the reworded row still claims the keys it always claimed", row().accelerator === "CmdOrCtrl+Q", row())
    check("the first press does not leave the app", quitCalls() === 0, double.calls.map((call) => call.method))
    check("the window was told through the fixed channel", hints() === 1, double.sent())
    check("the menu bar was installed once more to carry it", installs() === 1, installs())

    scenario([{ shown: true }])
    pressChord()
    pressChord()
    check("the second chord inside the window leaves", quitCalls() === 1, double.calls.map((call) => call.method))

    scenario([{ shown: true }])
    clickWithMouse()
    check("a mouse on the row leaves at once, without a notice first", quitCalls() === 1 && hints() === 0 && label() === PLAIN, { quit: quitCalls(), hints: hints(), label: label() })

    scenario([{ shown: true }], { "app.quit": "Meta+Shift+Q" })
    pressChord()
    check("a rebound quit names the key that quits, not the sentence's", label().includes("⌃⇧Q") && !label().includes("⌘Q"), label())
    check("its accelerator column agrees", row().accelerator === "Control+Shift+Q", row())

    /* A promise the app cannot keep is not made at all: with the quit unbound there is
       no second press to wait for, so the row keeps its own name and this press leaves. */
    scenario([{ shown: true }], { "app.quit": "" })
    pressChord()
    check("an unbound quit does not hold the app waiting", quitCalls() === 1 && label() === PLAIN, { quit: quitCalls(), label: label() })
    check("and nothing was announced about a key that is not there", hints() === 0 && installs() === 0, { hints: hints(), installs: installs() })

    /*
     * A chord built on the keypad's plus key is one Electron's menu vocabulary may not
     * register, so this row tells no story at all: no accelerator promised, and no
     * notice that would name a key the bar cannot show. The alternative — building the
     * chord from the input matcher's name and printing the recorder's — is what left a
     * bare "+" in one half of the row and "⌘NumpadAdd" in the other. The key still
     * quits the app from a focused window; the settings list spells it by its keycap.
     */
    scenario([{ shown: true }], { "app.quit": "Ctrl+NumpadAdd" })
    check("a keypad chord the menu cannot name is not promised as a shortcut", row().accelerator === undefined, row())
    pressChord()
    check("and no notice names a key the bar cannot show", label() === PLAIN && hints() === 0, { label: label(), hints: hints() })

    /* While a chord is being recorded the running one is withdrawn, so a row still
       asking for a second press of it would be pointing at a key the app ignores. */
    scenario([{ shown: true }])
    pressChord()
    check("the row asked for the second press first", label().includes("⌘Q"), label())
    menu.buildMenu({ binds: {}, recording: true })
    check("starting to record puts the arm away, so the row stops promising", label() === PLAIN && row().accelerator === undefined, { label: label(), accelerator: row().accelerator })
    const installsAfterRecording = installs()
    await new Promise((wake) => setTimeout(wake, QUIT_ARM_MS + 250))
    check("and no timer is left to rebuild the row behind it", installs() === installsAfterRecording && label() === PLAIN, { installs: installs(), label: label() })

    scenario([{ shown: false }])
    pressChord()
    check("a window hidden in the tray still gets its words in the menu row", label().includes("⌘Q"), label())
    check("and the notice was sent to that window as well", hints() === 1, double.sent())

    scenario([{ shown: true }])
    menu.buildMenu({ binds: { "app.quit": "Meta+Shift+Q" }, recording: false })
    check("rebinding while armed puts the old promise away", label() === PLAIN, label())
    const installsAfterRebind = installs()
    await new Promise((wake) => setTimeout(wake, QUIT_ARM_MS + 250))
    check("with no timer left over to install the same words twice", installs() === installsAfterRebind, { installs: installs(), installsAfterRebind })

    double.reset()
    menu.forgetQuitArm()
    double.setWindows([])
    menu.buildMenu({ binds: {}, recording: false })
    pressChord()
    check("with no window at all the menu row still says it", label().includes("⌘Q"), label())
    check("nothing is sent to a window that is not there", double.sent().length === 0, double.sent())

    /*
     * The waiting row is a promise with a deadline: once the arm expires, the installed
     * menu has to carry the plain row, or the bar keeps asking for a second press that
     * would only arm the quit again. The wait is the real one — the arm is two seconds,
     * and a check that pretended otherwise would not see the timer.
     */
    scenario([{ shown: true }])
    pressChord()
    check("the row is worded for the wait", label().includes("⌘Q"), label())
    await new Promise((wake) => setTimeout(wake, QUIT_ARM_MS + 250))
    check("when the wait is over the installed row says its own name again", label() === PLAIN, label())
    check("the expiry was installed, not merely built", installs() === 2, installs())
  })

  /*
   * Arming is a macOS habit; elsewhere the first press leaves. Without this, code that
   * armed on every platform would ask a Windows quit for two presses and every check
   * above would still be green, because each of them arms before it asks.
   */
  await onPlatform("win32", async () => {
    scenario([{ shown: true }])
    pressChord()
    check("off macOS the first press leaves at once", quitCalls() === 1 && label() === PLAIN, { quit: quitCalls(), label: label() })
    check("and nothing was announced about it", hints() === 0, double.sent())
  })

  menu.forgetQuitArm()
}

/** The menu module and the stand-in it was bundled against, out of one built file, so both read one record. */
async function load(): Promise<{ menu: typeof import("../src/main/menu"); double: typeof import("./electron-double").double }> {
  /* One path per process: two rounds running in one workspace must not rebuild each
     other's entry half-way through an import. */
  const entry = path.join(root, "out", `round36-quit-words-entry-${process.pid}.ts`)
  const bundle = entry.replace(/\.ts$/, ".cjs")
  await fs.mkdir(path.dirname(entry), { recursive: true })
  await fs.writeFile(entry, 'export * as menu from "../src/main/menu"\nexport { double } from "../scripts/electron-double"\n')
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      logLevel: "silent",
      alias: { electron: path.join(root, "scripts/electron-double.ts"), "@shared": path.join(root, "src/shared") },
    })
    return (await import(pathToFileURL(bundle).href)) as {
      menu: typeof import("../src/main/menu")
      double: typeof import("./electron-double").double
    }
  } finally {
    await fs.rm(entry, { force: true })
    await fs.rm(bundle, { force: true })
  }
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
