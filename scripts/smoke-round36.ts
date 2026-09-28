/**
 * Round 36: the app tool - operating the app being built, as fast as a person
 * clicks (the user's 2026-09-28 request, after watching WorkBuddy do it).
 *
 * Runs the real tool against scripts/fixtures/app-demo in this machine's own
 * Edge or Chrome, and against the same page in an Electron window reached
 * through its DevTools port. Both browsers get throwaway profiles; nothing of
 * the user's is opened.
 *
 * smoke.ts calls `roundThirtySixChecks` with its own check and section.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { spawn } from "node:child_process"
import { desktopState } from "./smoke-round37"
import { pathToFileURL } from "node:url"
import type { Check } from "./smoke-round5"
import { AppTool, closeAllApps } from "../src/server/tool/app"
import { TOOLS, reachOf } from "../src/server/tool/registry"
import { findBrowser } from "../src/server/appdrive/browser"
import { formatSnapshot } from "../src/server/appdrive/driver"
import type { ToolContext } from "../src/server/tool/types"

const root = process.cwd()
const page = path.join(root, "scripts", "fixtures", "app-demo", "index.html")

function contextFor(sessionID: string, asked: string[]): ToolContext {
  return {
    sessionID,
    messageID: "msg",
    callID: "call",
    directory: os.tmpdir(),
    permissions: { ask: async (request: { subject: string }) => void asked.push(request.subject) } as unknown as ToolContext["permissions"],
    questions: {} as ToolContext["questions"],
    signal: new AbortController().signal,
    progress: () => undefined,
    snapshot: async () => undefined,
  }
}

/** The number the snapshot gave the element with this name. */
function refOf(output: string, name: string): number {
  const match = output.match(new RegExp(`\\[(\\d+)\\] [\\w-]+ "${name}"`))
  return match ? Number(match[1]) : NaN
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

export async function roundThirtySixChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 36: the app tool - offered to the model, and how it reads a page")
  {
    check("offered last, after every earlier tool, so no cached prefix moves", TOOLS.at(-1)?.name === "app")
    check("asked about like a command, and treated as able to change anything", AppTool.permission === "bash" && reachOf("app") === "opaque")
    const description = AppTool.description
    check("its description tells the model to batch its steps", /one do/.test(description) && /fast/.test(description))
    check("and how to start an Electron app it can reach", /--remoteDebuggingPort 9222/.test(description) && /--remote-debugging-port=9222/.test(description))

    const others = Array.from({ length: 10 }, (_, index) => `[${index + 10}] button "N${index}"`)
    const base = { title: "T", url: "http://a/", modal: "", elements: ["[1] button \"A\"", "[2] tab \"B\"", ...others], more: 0, text: ["hello"] }
    check("a first look shows the whole page", /\[1\] button "A"/.test(formatSnapshot(base)) && /Text on the page:\nhello/.test(formatSnapshot(base)))
    const changed = formatSnapshot({ ...base, elements: ["[1] button \"A\"", "[2] tab \"B\" selected", "[3] button \"C\"", ...others], text: ["hello", "saved"] }, base)
    check("after that, only what changed - a state change once, as a change", /Changed:\n\[2\] tab "B" selected/.test(changed) && /Now shown:\n\[3\]/.test(changed) && !/Gone:/.test(changed) && /New text:\nsaved/.test(changed), changed)
    check("and nothing changing is said in one line", /Nothing on the page changed/.test(formatSnapshot(base, base)))
    check("a different page is shown whole", /\[1\] button "A"/.test(formatSnapshot({ ...base, url: "http://b/" }, base)))
  }

  section("Round 36: the browser it opens pages in never signs into the user's account")
  {
    const source = fs.readFileSync(path.join(root, "src", "server", "appdrive", "browser.ts"), "utf8")
    const list = source.slice(source.indexOf("function candidates"), source.indexOf("export function findBrowser"))
    check("Chrome is preferred to Edge, which signs a fresh profile in by itself", list.indexOf("chrome.exe") > 0 && list.indexOf("chrome.exe") < list.indexOf("msedge.exe"))
    check("sync is off in every browser it starts, and Edge's page runs in a guest window", /"--disable-sync"/.test(source) && /edge \? \["--guest"\]/.test(source))
    check("the browser's own pages - sign-in, sync, settings - are never taken for the app", /edge\|chrome\|chrome-extension/.test(fs.readFileSync(path.join(root, "src", "server", "appdrive", "driver.ts"), "utf8")))
    check("it opens in a throwaway profile, never the user's", /mkdtemp\(path\.join\(os\.tmpdir\(\), "mcode-app-browser-"\)\)/.test(source) && /--user-data-dir=\$\{profile\}/.test(source))
  }

  section("Round 36: the app tool driving a real page in Edge or Chrome")
  if (!findBrowser()) {
    check("(skipped: no Chrome or Edge on this machine)", true)
  } else {
    const asked: string[] = []
    const context = contextFor("r36-web", asked)
    const run = (input: Record<string, unknown>) => AppTool.execute(input, context)
    try {
      const refused = await run({ action: "snapshot" }).then(() => "", (error: Error) => error.message)
      check("nothing open yet: it says what to do first", /open with a URL, window or launch for a native app, android for a device, or attach/.test(refused), refused)

      const opened = await run({ action: "open", url: pathToFileURL(page).href })
      check("open asks once, like a command, naming the page", asked.length === 1 && asked[0]!.startsWith("open file:///"), asked)
      check("and lists the tabs and the div that is a button", /\[\d+\] tab "首页" selected/.test(opened.output) && /\[\d+\] clickable "打个招呼"/.test(opened.output), opened.output)
      const counterTab = refOf(opened.output, "计数")
      const homeTab = refOf(opened.output, "首页")

      const shown = await run({ action: "do", steps: [{ action: "click", ref: counterTab }] })
      const plus = refOf(shown.output, "加一")
      const minus = refOf(shown.output, "减一")
      check("a click on a tab shows its buttons", plus > 0 && minus > 0, shown.output)
      check("and the numbers from before still hold", refOf(shown.output, "首页") === homeTab)

      const started = Date.now()
      const clicked = await run({ action: "do", steps: [{ action: "click", ref: plus }, { action: "click", ref: plus }, { action: "click", ref: plus }, { action: "click", ref: minus }] })
      const took = Date.now() - started
      check("four clicks in one call land, and the answer shows the new count", /当前计数：2/.test(clicked.output) && clicked.title === "4/4", clicked.output)
      check("and take less than two seconds together - no fixed sleeps", took < 2_000, { took })
      check(
        "every step says what it did by itself, so one call can test several buttons",
        /1\. click \[\d+\] -> shows: 当前计数：1\n2\. click \[\d+\] -> shows: 当前计数：2\n3\. click \[\d+\] -> shows: 当前计数：3\n4\. click \[\d+\] -> shows: 当前计数：2\n/.test(clicked.output),
        clicked.output,
      )
      check("the answer is what changed, not the page again", /What changed/.test(clicked.output) && !/\[\d+\] tab "设置"/.test(clicked.output), clicked.output)

      const settings = await run({ action: "do", steps: [{ action: "click", ref: refOf(opened.output, "设置") }] })
      check("a select is named by its label, not by its options", /\[\d+\] combobox "语言" value="中文"/.test(settings.output), settings.output)
      const form = await run({
        action: "do",
        steps: [
          { action: "type", ref: refOf(settings.output, "昵称"), text: "小王" },
          { action: "select", ref: refOf(settings.output, "语言"), value: "English" },
          { action: "click", ref: refOf(settings.output, "深色模式") },
          { action: "click", ref: refOf(settings.output, "保存") },
        ],
      })
      check("typing, choosing and ticking fill the form, and saving says so", /已保存：小王，English，深色/.test(form.output), form.output)
      // A native select's list is drawn by the browser, outside the page: clicking one is refused with the way to choose instead.
      const native = await run({ action: "do", steps: [{ action: "click", ref: refOf(settings.output, "语言") }, { action: "press", key: "ArrowUp" }] })
      check("a click on a native select is refused, naming select and its options, and no key follows it", /1\. click \[\d+\] failed: .*native select; choose with select \{ref, value\}.*中文, English, 日本語/.test(native.output) && /remaining 1 step/.test(native.output) && /value="English"/.test(native.output + form.output), native.output)

      // The user keeps working while a page is driven: its browser window must not come to the front.
      if (process.platform === "win32") {
        const work = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "fixtures", "user-work.ps1")], { stdio: "ignore" })
        for (let attempt = 0; attempt < 40 && !/User Work$/.test(desktopState()); attempt++) await new Promise((resolve) => setTimeout(resolve, 150))
        const beforeState = desktopState()
        await run({ action: "do", steps: [{ action: "click", ref: refOf(opened.output, "计数") }, { action: "hover", ref: plus }, { action: "type", ref: refOf(settings.output, "昵称"), text: "x" }, { action: "press", key: "Tab" }, { action: "click", ref: refOf(opened.output, "设置") }] })
        const afterState = desktopState()
        work.kill()
        check("driving the page never brings its browser window to the front", !/演示应用/.test(beforeState) && !/演示应用/.test(afterState), { beforeState, afterState })
      }
      const dialog = await run({ action: "do", steps: [{ action: "click", ref: refOf(settings.output, "删除账户") }] })
      check("a modal dialog: only what is inside it is listed", /modal dialog is open/.test(dialog.output) && /"确定删除"/.test(dialog.output) && !/"保存"/.test(dialog.output), dialog.output)
      const confirmed = await run({ action: "do", steps: [{ action: "click", ref: refOf(dialog.output, "确定删除") }, { action: "wait", text: "账户已删除" }] })
      check("confirming closes it, and wait sees the result appear", /^1\. click \[\d+\] -> the dialog closed\n2\. wait for "账户已删除" -> it appeared\n/.test(confirmed.output), confirmed.output)

      const broken = await run({ action: "do", steps: [{ action: "click", ref: refOf(settings.output, "检查更新") }, { action: "wait", ms: 300 }] })
      check("the step that made the page complain is named", /1\. click \[\d+\] -> [^\n]*the page reported an error/.test(broken.output), broken.output)
      const idle = await run({ action: "do", steps: [{ action: "click", ref: refOf(settings.output, "设置") }] })
      check("a click that changes nothing says so, out loud", /1\. click \[\d+\] -> no visible change/.test(idle.output), idle.output)
      check("the page's own errors come back with the answer", /console\.error: 检查更新失败/.test(broken.output) && /uncaught: .*update check crashed/.test(broken.output), broken.output)

      const failing = await run({ action: "do", steps: [{ action: "click", ref: 99_999 }, { action: "click", ref: homeTab }] })
      check("a number not on the page fails that step, says why, and runs nothing after it", /1\. click \[99999\] failed: .*take a new one/.test(failing.output) && /remaining 1 step/.test(failing.output) && failing.title === "0/2", failing.output)

      const value = await run({ action: "eval", expression: "document.getElementById('value').textContent" })
      check("eval reads the page's state directly", value.output === '"2"', value.output)
      // Two calls in one step: the runner starts them together, and the second must still see the first's clicks.
      const [batch, counted] = await Promise.all([run({ action: "do", steps: [{ action: "click", ref: counterTab }, { action: "click", ref: plus }, { action: "click", ref: plus }, { action: "click", ref: plus }, { action: "wait", ms: 300 }] }), run({ action: "eval", expression: "document.getElementById('value').textContent" })])
      check("one conversation's calls run one after another, even when started together", counted.output === '"5"', { counted: counted.output, batch: batch.output })
      check("a button hidden at the last look is clicked by its old number once the batch shows its tab", /^1\. click \[\d+\] -> [^\n]*\n2\. click \[\d+\] -> shows: 当前计数：3\n/.test(batch.output) && !/failed/.test(batch.output), batch.output)
      const tabs = await run({ action: "tabs" })
      check("tabs lists the window it is on", /^\* \S+\s+演示应用/.test(tabs.output), tabs.output)
      // A browser window nobody can see draws no frame; the tool then says so within its bound rather than hanging.
      const shotStarted = Date.now()
      const shot = await run({ action: "screenshot" }).catch((error: Error) => ({ output: error.message, metadata: {} as Record<string, unknown> }))
      const file = String(shot.metadata?.path ?? "")
      check(
        "a screenshot is a PNG file, or a bounded, plain refusal when the window cannot be seen",
        (fs.existsSync(file) && fs.readFileSync(file).subarray(1, 4).toString() === "PNG") || (/could not be captured within 10s/.test(shot.output) && Date.now() - shotStarted < 15_000),
        shot.output,
      )
      if (file) fs.rmSync(file, { force: true })

      const badStep = await run({ action: "do", steps: [{ action: "fly" }] }).then(() => "", (error: Error) => error.message)
      check("a step it does not know is refused before anything runs", /unknown action "fly"/.test(badStep), badStep)
      const closed = await run({ action: "close" })
      check("close closes the browser it opened", /Closed/.test(closed.output))
      const after = await run({ action: "snapshot" }).then(() => "", (error: Error) => error.message)
      check("and afterwards nothing is open", /Nothing is open/.test(after), after)
    } finally {
      await closeAllApps()
    }
  }

  section("Round 36: the app tool reaching an Electron window through its DevTools port")
  {
    const electron = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron")
    const port = await freePort()
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-r36-electron-"))
    const child = spawn(electron, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, page], { stdio: "ignore" })
    const asked: string[] = []
    const context = contextFor("r36-electron", asked)
    try {
      let attached: Awaited<ReturnType<typeof AppTool.execute>> | undefined
      let last = ""
      for (let attempt = 0; attempt < 75 && !attached; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        attached = await AppTool.execute({ action: "attach", port, target: "演示" }, context).catch((error: Error) => {
          last = error.message
          return undefined
        })
      }
      check("attach reaches the app's window by its title", Boolean(attached) && /\[\d+\] tab "计数"/.test(attached?.output ?? ""), attached?.output ?? last)
      // The loop above retries while Electron starts, and each try is its own call with its own question.
      check("and every call asks, naming the port", asked.length >= 1 && asked.every((subject) => subject === `attach 127.0.0.1:${port}`), asked)
      const clicked = await AppTool.execute({ action: "do", steps: [{ action: "click", ref: refOf(attached?.output ?? "", "计数") }] }, context)
      check("a click in the Electron window works the same way", /当前计数：0/.test(clicked.output), clicked.output)
      check("Electron's %c-styled warnings arrive as plain words", !/%c/.test(attached?.output ?? ""), attached?.output)
      await AppTool.execute({ action: "close" }, context)
      await new Promise((resolve) => setTimeout(resolve, 300))
      check("closing only lets go: the app itself keeps running", child.exitCode === null)
    } finally {
      await closeAllApps()
      child.kill()
      // Electron can hold its profile for a moment after it is killed; a leftover temp folder is harmless.
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      } catch {
        // still locked; the system's temp cleanup takes it
      }
    }
  }
}
