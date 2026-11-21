/**
 * Round 15 (lane M) under Electron itself: the browser panel's own bookkeeping
 * and the office file watches, driven through the real `src/main/browser.ts`
 * and `src/main/office.ts` rather than read as text.
 *
 * Bundled to a .mjs and started as Electron's main script by
 * smoke-round15-main.ts, with a throwaway user-data folder. What happened is
 * written as JSON to the file named in argv: a GUI process has no stdout the
 * parent can read.
 */
import { BrowserWindow, app, ipcMain, webContents, type WebContentsView } from "electron"
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
    const closing = (window.contentView.children.at(-1) as WebContentsView).webContents
    navigate(window, bye)
    // Wait for the fixture to close before hiding it. The old 300 + 1500 ms
    // budget stays intact; switching early could throttle its initial load.
    const closeBy = Date.now() + 1800
    while (!closing.isDestroyed() && Date.now() < closeBy) await wait(25)
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

    // M15-2: the interface loading again takes the panel with it, and every
    // page it held is closed rather than the loop stopping at a dead one.
    const pagesOn = (name: string) => webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL().endsWith(name)).length
    const living = panelState(window)?.tabs.length ?? 0
    const before = window.contentView.children.length
    const pagesBefore = pagesOn("keep.html")
    window.webContents.reload()
    await new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", () => resolve())
      setTimeout(resolve, 15_000)
    })
    await wait(1_000)
    result.reload = {
      tabsBefore: living,
      childrenBefore: before,
      hasPanel: hasPanel(window),
      children: window.contentView.children.length,
      /* Every page the panel held, closed with it: the loop reached them all. */
      pagesBefore,
      pagesAfter: pagesOn("keep.html"),
    }
    window.destroy()
    await wait(300)
  }

  // ------------------------------------------------------------------- M15-4
  {
    const window = new BrowserWindow({ show: false, width: 400, height: 300 })
    await window.loadURL(host)
    const start = window.listenerCount("closed")
    const navigation = window.webContents.listenerCount("did-navigate")
    for (let round = 0; round < 12; round++) {
      const state = openPanel(window, { x: 0, y: 0, width: 300, height: 200 }, () => undefined)
      // Closing the last tab takes the panel down, so the next round opens a new one.
      for (const tab of state.tabs) closeTab(window, tab.id)
    }
    result.listeners = {
      start,
      closed: window.listenerCount("closed"),
      navigationStart: navigation,
      navigation: window.webContents.listenerCount("did-navigate"),
      warned: uncaught.length,
      hasPanel: hasPanel(window),
    }
    window.destroy()
    await wait(300)
  }

  // ------------------------------------------------------------------- M15-3
  {
    const preload = path.join(work, "preload.js")
    fs.writeFileSync(
      preload,
      [
        'const { ipcRenderer } = require("electron")',
        "window.hits = []",
        'window.listen = () => ipcRenderer.on("mcode:file-changed", (_event, spelling) => window.hits.push(spelling))',
        "window.ask = (channel, ...args) => ipcRenderer.invoke(channel, ...args)",
      ].join("\n"),
      "utf8",
    )
    /*
     * The watched paper sits under the repository's out/, not under the temp
     * folder. Measured on GitHub's Windows runner (run 44944764891): an
     * fs.watch inside an Electron main process receives nothing at all for a
     * folder under the runner's temp path (three replays, no event within
     * twelve seconds, while watching returned true), whereas the same
     * primitive in plain node on that very folder and in Electron on a folder
     * under the workspace both deliver the write within ~450 ms. That is the
     * runner's temp path and Electron, not the watch semantics this section
     * pins; the fixture moves, the production code path is untouched.
     */
    fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true })
    const watchDir = fs.mkdtempSync(path.join(process.cwd(), "out", "mcode-r15m-watch-"))
    registerOffice(ipcMain, path.join(work, "office"), async () => [work, watchDir])
    const watched = path.join(watchDir, "paper.docx")
    fs.writeFileSync(watched, "one")
    const window = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { preload, contextIsolation: false, sandbox: false } })
    await window.loadURL(host)
    const js = (code: string) => window.webContents.executeJavaScript(code)
    const touch = async () => {
      fs.writeFileSync(watched, `${Date.now()} ${Math.random()}`)
      await wait(1_500)
    }
    const watching = await js(`window.ask("mcode:watch-file", ${JSON.stringify(watched)})`)
    // The control: while the page that asked is on show, a change reaches it.
    await touch()
    const before = (await js("window.hits")) as string[]
    window.webContents.reload()
    await new Promise<void>((resolve) => {
      window.webContents.once("did-finish-load", () => resolve())
      setTimeout(resolve, 15_000)
    })
    await wait(500)
    await touch()
    result.watch = {
      watching,
      before,
      /* The page that asked is gone; the watch must have gone with it. */
      after: (await js("window.hits")) as string[],
      renderer: window.webContents.isDestroyed(),
    }
    window.destroy()
    await wait(300)
    fs.rmSync(watchDir, { recursive: true, force: true })
  }

  finish()
})
