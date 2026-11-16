/**
 * Round 39: the second review of rounds 35 to 38 (the app tool on the web,
 * Electron, Windows and Android; the shell's background and window handling).
 *
 * Each check pins one thing the review found:
 * - an app question answered "always" covered the whole command bucket, so
 *   "always open this page" let every shell command through;
 * - a page loaded anew numbered its elements from 1 again, so an old number
 *   landed on a new element - silently, and at the same address the answer
 *   even said earlier numbers still held;
 * - a page animating from script (style rewritten every frame) kept every
 *   step waiting its full cap;
 * - the permission card showed the app tool's questions as a shell command,
 *   under an English label;
 * - the tool's description still named only web pages and Electron;
 * - a deleted conversation's browser or program stayed open until quit;
 * - native keys went on to the last window's field after a switch, a picture
 *   of a minimised window was blank, and a shell command's window search
 *   followed stale parent ids to the user's own windows.
 *
 * smoke.ts calls `roundThirtyNineChecks` with its own check and section.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Check } from "./smoke-round5"
import { Bus } from "../src/server/bus"
import { Config } from "../src/server/config"
import { Permissions } from "../src/server/permission"
import { Storage } from "../src/server/storage"
import { AppTool, closeAllApps } from "../src/server/tool/app"
import { findBrowser } from "../src/server/appdrive/browser"
import type { ToolContext } from "../src/server/tool/types"

const root = process.cwd()
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8")

export async function roundThirtyNineChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 39: \"always\" on an app question covers that kind of action, never the shell")
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-r39-perm-"))
    const storage = new Storage(path.join(home, "storage"))
    const bus = new Bus()
    const config = new Config(storage, bus, path.join(home, "credentials.json"))
    await storage.write("config", { accessLevel: "ask", permissions: { bash: "ask" } })
    await config.load()
    const permissions = new Permissions(bus, config)
    let asked = 0
    let answer: "always" | "once" | "reject" = "always"
    const cards: { subject: string; titleCode?: string }[] = []
    bus.subscribe((event) => {
      if (event.type !== "permission.requested") return
      asked += 1
      const request = (event as unknown as { request: { id: string; subject: string; titleCode?: string } }).request
      cards.push({ subject: request.subject, titleCode: request.titleCode })
      setTimeout(() => permissions.respond(request.id, answer), 0)
    })
    const context = { sessionID: "r39", messageID: "m", callID: "c", directory: home, permissions, questions: {}, signal: new AbortController().signal, progress: () => undefined, snapshot: async () => undefined } as unknown as ToolContext

    // Nothing listens on these ports: each call asks, and then fails to connect - no browser needed.
    const failed = await AppTool.execute({ action: "attach", port: 1 }, context).then(() => "", (error: Error) => error.message)
    check("an app question is asked, titled in the reader's words, naming only its target", asked === 1 && cards[0]?.subject === "127.0.0.1:1" && cards[0]?.titleCode === "perm.app.attach" && /nothing is listening/.test(failed), { cards, failed })
    await AppTool.execute({ action: "attach", port: 2 }, context).catch(() => undefined)
    check("\"always\" lets the same kind of action through afterwards", asked === 1, { asked })
    answer = "once"
    const before = asked
    await permissions.ask({ sessionID: "r39", messageID: "m", callID: "c2", kind: "bash", directory: home, title: "Run command", subject: "npm install", patterns: ["npm install"], always: ["npm *"] })
    check("but a shell command is still asked about - the approval was for attaching, not for the bucket", asked === before + 1, { before, after: asked })
    fs.rmSync(home, { recursive: true, force: true })
  }

  section("Round 39: a page loaded anew never reuses an old element's number")
  if (!findBrowser()) {
    check("(skipped: no Chrome or Edge on this machine)", true)
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-r39-page-"))
    const page = path.join(work, "index.html")
    // A button that counts, and a box animated from script: its style is rewritten every frame, for ever.
    fs.writeFileSync(
      page,
      "<!doctype html><title>R39</title><button id=b onclick=\"this.textContent='clicked '+(++window.n||(window.n=1))\">press</button><a href=\"#\">link</a><div id=spin style=\"width:10px;height:10px;background:red\"></div><script>setInterval(function(){document.getElementById('spin').style.transform='rotate('+Date.now()%360+'deg)'},16)</script>",
    )
    const context = { sessionID: "r39-web", messageID: "m", callID: "c", directory: work, permissions: { ask: async () => undefined, waive: () => undefined }, questions: {}, signal: new AbortController().signal, progress: () => undefined, snapshot: async () => undefined } as unknown as ToolContext
    const run = (input: Record<string, unknown>) => AppTool.execute(input, context)
    try {
      const opened = await run({ action: "open", url: pathToFileURL(page).href })
      const button = Number(opened.output.match(/\[(\d+)\] button "press"/)?.[1])
      const started = Date.now()
      const pressed = await run({ action: "do", steps: [{ action: "click", ref: button }] })
      const took = Date.now() - started
      check("a page animating from script does not keep a step waiting its full cap", /shows: clicked 1|clicked 1/.test(pressed.output) && took < 1_500, { took, output: pressed.output })

      const reloaded = await run({ action: "do", steps: [{ action: "reload" }, { action: "click", ref: button }] })
      check("after a reload, the old number is refused rather than landing on a new element", /1\. reload -> [^\n]*the page reloaded/.test(reloaded.output) && /2\. click \[\d+\] failed: \[\d+\] is not in the last snapshot/.test(reloaded.output), reloaded.output)
      check("and the answer says the numbers are new, instead of that earlier ones still hold", /The page was loaded again; its elements have new numbers/.test(reloaded.output) && !/earlier references still hold/.test(reloaded.output), reloaded.output)
      const renumbered = Number(reloaded.output.match(/\[(\d+)\] button "press"/)?.[1])
      check("its new number carries on past every number used before", renumbered > button && renumbered > 2, { button, renumbered })
      const again = await run({ action: "do", steps: [{ action: "click", ref: renumbered }] })
      check("and the new number works", /clicked 1/.test(again.output), again.output)
    } finally {
      await closeAllApps()
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }

  section("Round 39: the smaller findings, each held in place")
  {
    const dialog = read("src", "renderer", "src", "components", "PermissionDialog.vue")
    check("the permission card shows an app question in its own words, and no shell prompt before it", /titleCode\?\.startsWith\("perm\.app\."\)\) return t\(request\.titleCode\)/.test(dialog) && /isBash\.value && !props\.request\.titleCode\?\.startsWith\("perm\.app\."\)/.test(dialog))
    const i18n = read("src", "renderer", "src", "lib", "i18n.ts")
    check("and those words exist in every language", (i18n.match(/"perm\.app\.launch":/g) ?? []).length === 18)
    check("the tool's description names all four kinds of app from its first line", /a web page, an Electron app, a native Windows program, or an Android app/.test(AppTool.description.split("\n")[0]!))
    const index = read("src", "server", "index.ts")
    check("a deleted conversation's app is closed with it", /event\.type === "session\.deleted"\) void closeAppOf\(event\.sessionID\)/.test(index))
    const host = read("src", "server", "appdrive", "windows-host.ts")
    const attach = host.slice(host.indexOf("static object Attach("), host.indexOf("static bool Alive("))
    check("taking over another window forgets the last window's field for keys", /typedInto = IntPtr\.Zero;/.test(attach))
    const shot = host.slice(host.indexOf("static object Screenshot("))
    check("a minimised window is shown, without activating it, before its picture is taken", /IsIconic\(handle\)\) \{ ShowWindow\(handle, SW_SHOWNOACTIVATE\)/.test(shot))
    const tree = host.slice(host.indexOf("static object TreeWindows("), host.indexOf("static object Windows("))
    check("a command's windows are searched only among processes started after their parent", /CreationDate/.test(tree) && /string\.CompareOrdinal\(childBorn, parentBorn/.test(tree))
  }
}
