/**
 * Round 37: the app tool on native Windows apps, through UI Automation.
 *
 * Runs the real tool against scripts/fixtures/win-demo.ps1, a WinForms window
 * with the web demo's tabs, counter, form and confirm dialog: started by the
 * tool itself (launch), and taken over while already open (window). Windows
 * only; elsewhere the section says it was skipped.
 *
 * smoke.ts calls `roundThirtySevenChecks` with its own check and section.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import type { Check } from "./smoke-round5"
import { AppTool, closeAllApps } from "../src/server/tool/app"
import { sendKeys } from "../src/server/appdrive/windows"
import { BashTool } from "../src/server/tool/bash"
import type { ToolContext } from "../src/server/tool/types"

const root = process.cwd()
const demo = path.join(root, "scripts", "fixtures", "win-demo.ps1")
const demoArgs = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", demo]

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

function refOf(output: string, name: string): number {
  const match = output.match(new RegExp(`\\[(\\d+)\\] [\\w-]+ "${name}"`))
  return match ? Number(match[1]) : NaN
}

function running(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function roundThirtySevenChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 37: keys for a native window, in SendKeys' notation")
  {
    check("named keys", sendKeys("Enter") === "{ENTER}" && sendKeys("Escape") === "{ESC}" && sendKeys("ArrowDown") === "{DOWN}" && sendKeys("F5") === "{F5}")
    check("modifiers", sendKeys("Control+a") === "^a" && sendKeys("Alt+F4") === "%{F4}" && sendKeys("Control+Shift+s") === "^+s")
    check("a character SendKeys reads specially is escaped, the plus key included", sendKeys("+") === "{+}" && sendKeys("Control++") === "^{+}" && sendKeys("%") === "{%}")
    let refused = ""
    try {
      sendKeys("Meta+r")
    } catch (error) {
      refused = (error as Error).message
    }
    check("a key it cannot press is refused, saying which it can", /Control, Alt or Shift/.test(refused), refused)
  }

  section("Round 37: a shell command that leaves something running in the background finishes")
  {
    // What a model did in a real run: `app.ps1 &`. The background process holds the output open for as long as it lives.
    const script = path.join(os.tmpdir(), `mcode-r37-linger-${process.pid}.cjs`)
    fs.writeFileSync(script, "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'inherit', detached: true, windowsHide: true }).unref()\nconsole.log('started')\n")
    const context = contextFor("r37-bash", [])
    const began = Date.now()
    const lingering = await BashTool.execute({ command: `node "${script}"`, timeout: 30_000 }, context)
    const took = Date.now() - began
    check("the command is done when its shell is, not when what it started ends", took < 5_000 && /started/.test(lingering.output), { took, output: lingering.output })
    check("and the model is told something it started is still running, and how to start a window program instead", /still running and was left running/.test(lingering.output) && /launch/.test(lingering.output), lingering.output)
    const plain = await BashTool.execute({ command: 'node -e "console.log(42)"', timeout: 30_000 }, context)
    check("an ordinary command says nothing of the kind", /42/.test(plain.output) && !/still running/.test(plain.output), plain.output)
    fs.rmSync(script, { force: true })
  }

  section("Round 37: the app tool starting and operating a native Windows app")
  if (process.platform !== "win32") {
    check("(skipped: native windows are driven on Windows only)", true)
    return
  }
  {
    const asked: string[] = []
    const context = contextFor("r37-launch", asked)
    const run = (input: Record<string, unknown>) => AppTool.execute(input, context)
    try {
      const started = Date.now()
      const opened = await run({ action: "launch", program: "powershell.exe", args: demoArgs, target: "Win Demo" })
      check("launch starts the program, asks once naming it, and lists its window", asked.length === 1 && /powershell\.exe/.test(asked[0]!) && /\[\d+\] tab "Home" selected/.test(opened.output), { asked, output: opened.output })
      check("the window's own title bar buttons are not the app's, and are left out", !/最小化|Minimize|最大化|Maximize/.test(opened.output), opened.output)
      check("and it is ready within ten seconds", Date.now() - started < 10_000, Date.now() - started)

      const clickedAt = Date.now()
      const counted = await run({
        action: "do",
        steps: [{ action: "click", ref: refOf(opened.output, "Count") }],
      })
      const plus = refOf(counted.output, "Plus")
      const minus = refOf(counted.output, "Minus")
      const clicks = await run({ action: "do", steps: [{ action: "click", ref: plus }, { action: "click", ref: plus }, { action: "click", ref: plus }, { action: "click", ref: minus }] })
      const took = Date.now() - clickedAt
      check(
        "every click reports what it did, as on a web page",
        /1\. click \[\d+\] -> shows: Count: 1\n2\. click \[\d+\] -> shows: Count: 2\n3\. click \[\d+\] -> shows: Count: 3\n4\. click \[\d+\] -> shows: Count: 2\n/.test(clicks.output),
        clicks.output,
      )
      check("a tab switch and four clicks take under five seconds", took < 5_000, { took })

      const settings = await run({ action: "do", steps: [{ action: "click", ref: refOf(opened.output, "Settings") }] })
      check("a combo box shows its value, named by its label", /\[\d+\] combobox "Language" value="English"/.test(settings.output), settings.output)
      const combo = await run({ action: "do", steps: [{ action: "click", ref: refOf(settings.output, "Language") }] })
      check("clicking a combo box is refused with the way to choose", /failed: \[\d+\] is a combo box; choose with select/.test(combo.output), combo.output)
      const missing = await run({ action: "do", steps: [{ action: "select", ref: refOf(settings.output, "Language"), value: "Klingon" }] })
      check("choosing an option that is not there lists the ones that are", /no option matches; the options are: English, Chinese, Japanese/.test(missing.output), missing.output)
      const form = await run({
        action: "do",
        steps: [
          { action: "type", ref: refOf(settings.output, "Nickname"), text: "Wang" },
          { action: "select", ref: refOf(settings.output, "Language"), value: "Japanese" },
          { action: "click", ref: refOf(settings.output, "Dark mode") },
          { action: "click", ref: refOf(settings.output, "Save") },
        ],
      })
      check("typing, choosing and ticking fill the form, and saving says so", /Saved: Wang, Japanese, dark/.test(form.output), form.output)

      const dialog = await run({ action: "do", steps: [{ action: "click", ref: refOf(settings.output, "Delete account") }] })
      check("a message box the app shows takes the listing, as a modal dialog", /a dialog opened \("Confirm"\)/.test(dialog.output) && /modal dialog is open/.test(dialog.output) && !/"Save"/.test(dialog.output), dialog.output)
      const ok = dialog.output.match(/\[(\d+)\] button "(?:OK|确定)"/)?.[1]
      const confirmed = await run({ action: "do", steps: [{ action: "click", ref: Number(ok) }, { action: "wait", text: "Account deleted" }] })
      check("confirming closes it, and wait sees the result", /1\. click \[\d+\] -> the dialog closed\n2\. wait for "Account deleted" -> it appeared/.test(confirmed.output), confirmed.output)

      const evaluated = await run({ action: "eval", expression: "1" }).then(() => "", (error: Error) => error.message)
      check("eval says it is for pages, not native windows", /no page to run it in/.test(evaluated), evaluated)
      const web = await run({ action: "do", steps: [{ action: "goto", url: "http://example.com" }] })
      check("so does a step that needs an address", /goto is for web pages/.test(web.output), web.output)
      const shot = await run({ action: "screenshot" })
      const file = String(shot.metadata?.path ?? "")
      check("a screenshot of the window is a PNG", fs.existsSync(file) && fs.readFileSync(file).subarray(1, 4).toString() === "PNG", file)
      fs.rmSync(file, { force: true })
      const tabs = await run({ action: "tabs" })
      check("tabs lists the app's own windows, marking the one in use", /^\* \S+\s+Win Demo - window:\/\/powershell/m.test(tabs.output), tabs.output)
      check("and nothing else on the desktop", tabs.output.split("\n").every((line) => /window:\/\/powershell$/.test(line)), tabs.output)

      const closed = await run({ action: "close" })
      check("close ends the program it started", /Closed Win Demo/.test(closed.output))
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const after = await run({ action: "window", target: "Win Demo" }).then(() => "still open", (error: Error) => error.message)
      check("and its window is gone afterwards", /No open window matches "Win Demo"/.test(after), after)
    } finally {
      await closeAllApps()
    }
  }

  section("Round 37: the app tool taking over a native window that is already open")
  {
    const child = spawn("powershell.exe", demoArgs, { stdio: "ignore" })
    const asked: string[] = []
    const context = contextFor("r37-window", asked)
    try {
      let taken: Awaited<ReturnType<typeof AppTool.execute>> | undefined
      let last = ""
      for (let attempt = 0; attempt < 40 && !taken; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        taken = await AppTool.execute({ action: "window", target: "Win Demo" }, context).catch((error: Error) => {
          last = error.message
          return undefined
        })
      }
      check("window takes over an open window by its title", Boolean(taken) && /\[\d+\] tab "Count"/.test(taken?.output ?? ""), taken?.output ?? last)
      check("and every call asks, naming it", asked.length >= 1 && asked.every((subject) => subject === "window Win Demo"), asked)
      const clicked = await AppTool.execute({ action: "do", steps: [{ action: "click", ref: refOf(taken?.output ?? "", "Say hello") }] }, context)
      check("a click there works the same way", /shows: Hello there/.test(clicked.output), clicked.output)
      await AppTool.execute({ action: "close" }, context)
      await new Promise((resolve) => setTimeout(resolve, 500))
      check("closing only lets go: the app keeps running", running(child.pid) && child.exitCode === null)

      // Minimised, a window lists nothing; taking it over restores it first.
      const handle = (await AppTool.execute({ action: "window", target: "Win Demo" }, context).then(() => AppTool.execute({ action: "tabs" }, context))).output.match(/^\* (\S+)/m)?.[1]
      await AppTool.execute({ action: "close" }, context)
      spawnSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'; [W.U]::ShowWindow([System.IntPtr]${handle}, 6) | Out-Null`], { windowsHide: true })
      await new Promise((resolve) => setTimeout(resolve, 500))
      const restored = await AppTool.execute({ action: "window", target: "Win Demo" }, context)
      check("a minimised window is restored when taken over, and lists what it holds", Boolean(handle) && /\[\d+\] tab "Count"/.test(restored.output), { handle, output: restored.output })
      // And one minimised while it is in use - by the user, or by the app - is put back before the next look.
      spawnSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'; [W.U]::ShowWindow([System.IntPtr]${handle}, 6) | Out-Null`], { windowsHide: true })
      await new Promise((resolve) => setTimeout(resolve, 500))
      const looked = await AppTool.execute({ action: "snapshot", full: true }, context)
      check("a window minimised while in use is put back before the next look", /\[\d+\] tab "Count"/.test(looked.output), looked.output)
      await AppTool.execute({ action: "close" }, context)
      const none = await AppTool.execute({ action: "window", target: "No Such Window Anywhere" }, context).then(() => "", (error: Error) => error.message)
      check("a window that is not open is refused, naming the recently started programs' windows", /No open window matches "No Such Window Anywhere"\. Windows of programs started in the last 15 minutes: .*"Win Demo" \(powershell\).*To start one, use launch/.test(none), none)
      check("and never the rest of the desktop - programs running since before, such as Explorer", !/\(explorer\)/i.test(none), none)
    } finally {
      await closeAllApps()
      child.kill()
    }
  }
}
