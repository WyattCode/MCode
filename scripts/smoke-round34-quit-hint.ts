/**
 * Round 34: an armed macOS quit must never be silent.
 *
 * On macOS a first Cmd+Q only arms the quit; a second press inside QUIT_ARM_MS is
 * what leaves. The hint that says so went to `getFocusedWindow()?.webContents`, and
 * a person who had hidden the only window - the red button hides it, and closing the
 * last window on macOS leaves the app running in any case - has no focused window at
 * all. The optional chain swallowed the message, the row in the menu bar never
 * changed, and the next Cmd+Q, later than the window, armed it again: Cmd+Q appears
 * to do nothing, forever. The arithmetic of that loop had no test either.
 *
 * Pinned here: the arm's arithmetic; the two notices arming owes (a broadcast that
 * asks nothing about what is on screen, and the menu rebuild that gives the row its
 * words); that the arm expires and takes those words with it; that no path out of the
 * app leaves the arm behind; and that a page which cannot be seen does not bank a
 * notice to pay back later.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { QUIT_ARM_MS, quitPress } from "../src/main/desktop-rules"

type Check = (label: string, ok: boolean, detail?: unknown) => void
const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/**
 * A function's own source, from its line to the first closing brace at column zero -
 * every inner brace in these bodies is indented. Empty when the name is gone, so a
 * rename cannot leave the checks below reading an empty string and agreeing.
 */
/** Every listener's own body, for an event a file may register more than once. */
function listenerBodies(source: string, event: string): string[] {
  const needle = `app.on("${event}"`
  const bodies: string[] = []
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    const end = source.indexOf("\n})", at)
    if (end > 0) bodies.push(source.slice(at, end))
  }
  return bodies
}

function fnBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) return ""
  const end = source.indexOf("\n}", start)
  return end < 0 ? "" : source.slice(start, end)
}

export async function quitHintChecks(check: Check): Promise<void> {
  // The arithmetic the loop turns on, which no check held before.
  const first = quitPress(undefined, 1_000)
  check("a first press arms without quitting", first.quit === false && first.armedAt === 1_000, first)
  const inside = quitPress(1_000, 1_000 + QUIT_ARM_MS)
  check("a second press inside the window quits", inside.quit === true, inside)
  const late = quitPress(1_000, 1_001 + QUIT_ARM_MS)
  check("a late second press re-arms instead of quitting", late.quit === false && late.armedAt === 1_001 + QUIT_ARM_MS, late)

  const menu = await read("src/main/menu.ts")
  const armed = fnBody(menu, "sayQuitArmed")
  check("the arming step is there to be read", armed.length > 0, armed.slice(0, 60))
  /*
   * The broadcast exists for the person whose window is hidden, so it may not be
   * narrowed to what happens to be on screen: an isVisible() filter in here is the
   * original defect wearing a new coat, and it passed the first draft of this file.
   */
  check("arming broadcasts to every window", /getAllWindows\(\)[\s\S]{0,200}send\("mcode:quit-hint"\)/.test(armed), armed.slice(0, 80))
  check("the broadcast asks nothing about visibility or focus", !/\bisVisible\(|\bisMinimized\(|getFocusedWindow\(/.test(armed))
  // The menu bar's row is the one surface a windowless app still shows, and only arming can word it.
  check("arming rebuilds the menu", /buildMenu\(\)/.test(armed))
  check("arming sets the arm to expire", /setTimeout\(expireQuitArm, QUIT_ARM_MS\)/.test(armed))
  /*
   * Scheduled before the rebuild on purpose: should building the menu throw, the arm
   * still expires by itself. The two checks above are satisfied by either order, so
   * the order itself is what is read here.
   */
  const timerAt = armed.indexOf("setTimeout(expireQuitArm, QUIT_ARM_MS)")
  const rebuildAt = armed.indexOf("buildMenu()")
  check("the expiry is scheduled before the menu is rebuilt", timerAt >= 0 && rebuildAt >= 0 && timerAt < rebuildAt, { timerAt, rebuildAt })
  const expires = fnBody(menu, "expireQuitArm")
  check("expiry clears the arm and rewords the row", /forgetQuitArm\(\)/.test(expires) && /buildMenu\(\)/.test(expires), expires.slice(0, 120))

  /*
   * The row's hint words have to be chosen by the arm, and the key they name has to
   * come from the binding rather than from the sentence: a row reading "⌘Q" over an
   * accelerator reading "⌃⇧Q" tells two stories at once. Read the label expression
   * itself — a label that stopped answering to the arm, or a notice that stopped
   * asking what is bound, goes red.
   */
  const rowLabel = /label:\s*(quitArmedAt[^\n]*)/.exec(menu)?.[1] ?? ""
  check("the row's words answer to the armed state", /quitArmedNotice\(\)/.test(rowLabel) && /L\("menu\.quitApp"/.test(rowLabel), rowLabel.slice(0, 160))
  const notice = fnBody(menu, "quitArmedNotice")
  check("the arm's notice spells the key off the binding", /armQuitLabel\(/.test(notice) && /menuCommandChord\(/.test(notice), notice.slice(0, 200))
  check("no hint is sent through a focused window alone", !/getFocusedWindow\(\)\s*\??\.\s*webContents\.send\("mcode:quit-hint"\)/.test(menu))

  const index = await read("src/main/index.ts")
  /* More than one before-quit listener exists, so each is read as its own body: a distance would go red the next time a line is added at the top of one. */
  const listeners = listenerBodies(index, "before-quit")
  const heard = listeners.filter((body) => /forgetQuitArm\(\)/.test(body))
  check("every path out of the app forgets the arm", heard.length > 0, `${listeners.length} before-quit listeners, ${heard.length} forget the arm`)
  const leaving = fnBody(menu, "requestAppQuit")
  const forgotten = leaving.indexOf("forgetQuitArm()")
  const exits = [leaving.indexOf("beginIntentionalQuit("), leaving.indexOf("app.quit()")].filter((at) => at >= 0).sort((a, b) => a - b)
  check("the menu forgets the arm before it quits", forgotten >= 0 && exits.length > 0 && forgotten < exits[0], { forgotten, exits })

  const app = await read("src/renderer/src/App.vue")
  const handler = /onQuitHint\(\(\) => \{[\s\S]*?\n\s*\}\)/.exec(app)?.[0] ?? ""
  /*
   * A hidden page keeps a notice's clock stopped instead of letting it run out
   * (lib/toast.ts), so the guard has to turn the notice away rather than bank it.
   * Polarity and position are the assertion: `if (!document.hidden) return`, or the
   * same line placed after the notify, restores the defect exactly, and a check that
   * only looked for the words would call both of those correct.
   */
  const guardAt = handler.search(/if \(document\.hidden\) return/)
  const shownAt = handler.indexOf("notify(")
  check("a page that cannot be seen is turned away before the notice", guardAt >= 0 && shownAt >= 0 && guardAt < shownAt, { guardAt, shownAt, handler })

  const i18n = await read("src/renderer/src/lib/i18n.ts")
  const published = i18n.slice(i18n.indexOf("MENU_KEYS"), i18n.indexOf("publishMenuLabels"))
  /*
   * Which languages hold the words is i18ncheck's job: it reads all eighteen tables
   * against every `t()` call. The seam no gate watched is this one - the main
   * process keeps no table of its own, so a row built out there reads correctly
   * only if the window sent the key along.
   */
  check("the hint's words are sent to the main process", /["']quit\.hint["']/.test(published))
}

/* Run me on my own: path.basename, because a Windows separator would otherwise
   make this entry never fire and the file would report nothing at all. */
if (path.basename(process.argv[1] ?? "") === "smoke-round34-quit-hint.ts") {
  let failed = 0
  await quitHintChecks((label, ok, detail) => {
    if (!ok) failed++
    console.log(ok ? "PASS" : "FAIL", label, detail ?? "")
  })
  process.exitCode = failed ? 1 : 0
}
