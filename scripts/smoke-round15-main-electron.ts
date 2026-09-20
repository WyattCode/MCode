/**
 * Round 15 (lane M) under Electron itself: the browser panel's own bookkeeping
 * and the office file watches, driven through the real `src/main/browser.ts`
 * and `src/main/office.ts` rather than read as text.
 *
 * Bundled to a .cjs and started as Electron's main script by
 * smoke-round15-main.ts, with a throwaway user-data folder. What happened is
 * written as JSON to the file named in argv: a GUI process has no stdout the
 * parent can read.
 */
import { BrowserWindow, app, ipcMain, webContents } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { act, clearBrowsingData, closeTab, hasPanel, navigate, newTab, openPanel, panelState, selectTab, setBounds, type BrowserState } from "../src/main/browser"
import { registerOffice } from "../src/main/office"

const out = process.argv[process.argv.length - 1]!
app.commandLine.appendSwitch("disable-gpu")

const uncaught: string[] = []
process.on("uncaughtException", (error: Error) => uncaught.push(String(error?.message ?? error)))

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const fileURL = (file: string) => `file://${file.replace(/\\/g, "/")}`

/** A call and what it answered, so a throw is a result rather than the end of the run. */
function tried(run: () => unknown): { ok: boolean; value?: unknown; error?: string } {
  try {
    return { ok: true, value: run() }
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) }
  }
}

const result: Record<string, unknown> = {}
const finish = () => {
  result.uncaught = uncaught
  fs.writeFileSync(out, JSON.stringify(result, null, 1), "utf8")
  app.exit(0)
}
// Whatever happens below, the process must end.
setTimeout(() => {
  result.timedOut = true
  finish()
}, 90_000).unref()

app.on("window-all-closed", () => undefined)

app.whenReady().then(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-r15m-"))
  app.setPath("userData", path.join(work, "profile"))
  const page = (name: string, body: string) => {
    const file = path.join(work, name)
    fs.writeFileSync(file, body, "utf8")
    return fileURL(file)
  }
  const keep = page("keep.html", "<title>Keep</title><p>an ordinary page")
  /*
   * The window's own page. It starts listening from its own script, as the
   * interface does (App.vue's setup, not the preload), so what a message sent
   * before that reaches is measured rather than assumed.
   */
  const host = page("host.html", '<title>Host</title><script type="module">if (window.listen) window.listen()</script><p>a page of the window itself')
  const bye = page("bye.html", "<title>Bye</title><script>window.close()</script>")

  // ------------------------------------------------------------------ M15-1/2
  {
    const window = new BrowserWindow({ show: false, width: 900, height: 600 })
    await window.loadURL(host)
    const published: BrowserState[] = []
    openPanel(window, { x: 0, y: 50, width: 800, height: 500 }, (state) => published.push(state))
    navigate(window, keep)
    await wait(500)
    // A second page, which closes itself the way a sign-in callback page does.
    const second = newTab(window)
    navigate(window, bye)
    await wait(300)
    // A third, so the row still has more than one page once the second has gone.
    newTab(window)
    navigate(window, keep)
    await wait(1_500)

    const state = tried(() => panelState(window))
    const told = published.at(-1)?.tabs?.map((tab) => tab.id) ?? null
    result.dead = {
      closedTab: second?.active,
      panelState: state,
      tabs: (state.value as BrowserState | undefined)?.tabs?.length ?? null,
      hasClosedTab: ((state.value as BrowserState | undefined)?.tabs ?? []).some((tab) => tab.id === second?.active),
      act: tried(() => Boolean(act(window, "reload"))),
      newTab: tried(() => Boolean(newTab(window))),
      navigate: tried(() => Boolean(navigate(window, keep))),
      select: tried(() => Boolean(selectTab(window, (state.value as BrowserState | undefined)?.tabs?.[0]?.id ?? ""))),
      bounds: tried(() => {
        setBounds(window, { x: 0, y: 50, width: 700, height: 400 })
        return true
      }),
      clear: tried(() => {
        void clearBrowsingData().catch(() => undefined)
        return true
      }),
      /* The state the window was handed when the page went. */
      lastPublished: told,
    }
    await wait(500)

    window.destroy()
    await wait(300)
  }

  finish()
})
