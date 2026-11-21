/**
 * Temporary diagnostic (win-env-fixes): the M15-3 office-watch scenario,
 * replayed under Electron with longer observation than the battery's own
 * 1500 ms budget allows, in both a temp (8.3 short) folder and a plain one.
 * Written as JSON to argv's last entry: a GUI process has no stdout here.
 */
import { BrowserWindow, app, ipcMain } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerOffice } from "../../src/main/office"

const out = process.argv[process.argv.length - 1]
app.commandLine.appendSwitch("disable-gpu")

const uncaught = []
process.on("uncaughtException", (error) => uncaught.push(String(error && error.message ? error.message : error)))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fileURL = (file) => `file://${file.replace(/\\/g, "/")}`

const result = { rounds: [] }
const finish = () => {
  result.uncaught = uncaught
  fs.writeFileSync(out, JSON.stringify(result, null, 1), "utf8")
  app.exit(0)
}
setTimeout(() => {
  result.timedOut = true
  finish()
}, 180_000).unref()
app.on("window-all-closed", () => undefined)

app.whenReady().then(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-diag-e-"))
  app.setPath("userData", path.join(work, "profile"))
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-diag-w-"))
  const repoDir = fs.mkdtempSync(path.join(process.env.GITHUB_WORKSPACE || process.cwd(), "mcode-diag-w-"))
  registerOffice(ipcMain, path.join(work, "office"), async () => [tempDir, repoDir])
  for (const [kind, dir] of Object.entries({ temp: tempDir, repo: repoDir })) {
    for (let round = 1; round <= 3; round++) {
      const entry = { kind, round, events: [] }
      const watched = path.join(dir, `paper-${kind}-${round}.docx`)
      fs.writeFileSync(watched, "one")
      const startedAt = { at: 0 }
      const raw = fs.watch(dir, { persistent: false }, (ev, name) => {
        if (name && !String(name).startsWith(`paper-${kind}-${round}`)) return
        entry.events.push({ ev, name: String(name), at: startedAt.at ? Date.now() - startedAt.at : -1 })
      })
      const hostFile = path.join(dir, `host-${kind}-${round}.html`)
      fs.writeFileSync(hostFile, '<title>Host</title><script type="module">if (window.listen) window.listen()</script><p>host', "utf8")
      const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { preload, contextIsolation: false, sandbox: false } })
      await win.loadURL(fileURL(hostFile))
      const js = (code) => win.webContents.executeJavaScript(code)
      entry.watching = await js(`window.ask("mcode:watch-file", ${JSON.stringify(watched)})`)
      await wait(300)
      startedAt.at = Date.now()
      fs.writeFileSync(watched, `${Date.now()} ${Math.random()}`)
      let firstHitAt = -1
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        const hits = (await js("window.hits")) || []
        if (hits.length) {
          firstHitAt = Date.now() - startedAt.at
          break
        }
        await wait(50)
      }
      entry.firstHitAt = firstHitAt
      await wait(Math.max(0, 1600 - firstHitAt))
      entry.hitsAt1600 = firstHitAt >= 0 && firstHitAt <= 1500 ? "would-be-seen" : firstHitAt < 0 ? "never" : "late"
      win.webContents.reload()
      await new Promise((resolve) => {
        win.webContents.once("did-finish-load", () => resolve())
        setTimeout(resolve, 15_000)
      })
      await wait(500)
      await js("window.hits = []")
      fs.writeFileSync(watched, `${Date.now()} ${Math.random()} after-reload`)
      await wait(3_000)
      entry.afterReloadHits = await js("window.hits")
      raw.close()
      win.destroy()
      await wait(300)
      result.rounds.push(entry)
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true })
  fs.rmSync(repoDir, { recursive: true, force: true })
  finish()
})
