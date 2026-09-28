/**
 * Round 40: filling the gaps round 39's review listed.
 *
 * - Web pages: controls inside web components (open shadow roots) and inside
 *   frames from the same site were never listed - a query stops at both - and
 *   a frame from another site now says it is there.
 * - Android: text in any language, written into the field through the
 *   accessibility service by the reader on the device (adb's own input types
 *   ASCII only); an empty field's hint no longer reads as its value. Checked
 *   against scripts/fixtures/android-demo, built on the spot with
 *   scripts/android-demo.mjs, when adb sees one device and a JDK is there.
 *
 * smoke.ts calls `roundFortyChecks` with its own check and section.
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import type { Check } from "./smoke-round5"
import { AppTool, closeAllApps } from "../src/server/tool/app"
import { findBrowser } from "../src/server/appdrive/browser"
import { connectedDevices, findAdb, listDevices, reconnectEmulators } from "../src/server/appdrive/android"
import type { ToolContext } from "../src/server/tool/types"

const root = process.cwd()

function contextFor(sessionID: string, directory: string): ToolContext {
  return { sessionID, messageID: "m", callID: "c", directory, permissions: { ask: async () => undefined }, questions: {}, signal: new AbortController().signal, progress: () => undefined, snapshot: async () => undefined } as unknown as ToolContext
}

const refOf = (output: string, test: RegExp) => Number(output.split("\n").find((line) => test.test(line))?.match(/^\[(\d+)\]/)?.[1])

export async function roundFortyChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 40: controls inside web components and frames are listed and reached")
  if (!findBrowser()) {
    check("(skipped: no Chrome or Edge on this machine)", true)
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-r40-deep-"))
    fs.writeFileSync(path.join(work, "inner.html"), "<!doctype html><p id=said>frame ready</p><button onclick=\"document.getElementById('said').textContent='frame clicked'\">in frame</button>")
    fs.writeFileSync(
      path.join(work, "index.html"),
      [
        "<!doctype html><title>R40</title>",
        "<p>top of the page</p>",
        "<x-card></x-card>",
        '<iframe src="inner.html" style="margin-top:40px;width:400px;height:120px"></iframe>',
        '<iframe src="data:text/html,<button>elsewhere</button>" style="width:200px;height:60px"></iframe>',
        "<script>customElements.define('x-card', class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: 'open' }); root.innerHTML = '<p id=out>shadow ready</p><button id=go>in shadow</button>'; root.getElementById('go').onclick = () => { root.getElementById('out').textContent = 'shadow clicked' } } })</script>",
      ].join("\n"),
    )
    const context = contextFor("r40-deep", work)
    // Served over http, as an app being built is: Chrome makes every file:// page its own origin, so no file frame is ever same-site.
    const server = http.createServer((request, response) => {
      const file = path.join(work, path.basename(new URL(request.url ?? "/", "http://x").pathname) || "index.html")
      if (!fs.existsSync(file)) {
        response.writeHead(404)
        return response.end()
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(fs.readFileSync(file))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = `http://127.0.0.1:${(server.address() as { port: number }).port}/index.html`
    try {
      const opened = await AppTool.execute({ action: "open", url: address }, context)
      const shadow = refOf(opened.output, /button "in shadow"/)
      const framed = refOf(opened.output, /button "in frame"/)
      check("a button inside a web component's shadow root is listed", shadow > 0, opened.output)
      check("and so is one inside a frame from the same site", framed > 0, opened.output)
      check("their text is on the page too", /shadow ready/.test(opened.output) && /frame ready/.test(opened.output), opened.output)
      check("a frame from another site is said to be there, unread", /1 embedded frame\(s\) from another site are not listed/.test(opened.output), opened.output)
      const clicked = await AppTool.execute({ action: "do", steps: [{ action: "click", ref: shadow }, { action: "click", ref: framed }] }, context)
      check("the shadow button is clicked, and not reported as covered by its host", /1\. click \[\d+\] -> shows: shadow clicked/.test(clicked.output) && !/covered/.test(clicked.output), clicked.output)
      check("the framed button is clicked where its frame puts it", /2\. click \[\d+\] -> shows: frame clicked/.test(clicked.output), clicked.output)
    } finally {
      await closeAllApps()
      server.close()
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }

  section("Round 40: Android text in any language, and empty fields read as empty")
  {
    const adb = findAdb()
    if (adb) {
      await reconnectEmulators(adb)
      // An emulator reachable on several local ports is listed once per port, and must still count as one device -
      // checked before anything is skipped, since counting it several times is exactly what would skip the rest.
      for (const port of [16384, 7555, 5555, 62001]) spawnSync(adb, ["connect", `127.0.0.1:${port}`], { windowsHide: true, timeout: 5_000 })
      const transports = (await listDevices(adb).catch(() => [])).filter((device) => device.state === "device").length
      if (transports > 1) check("one device reached through several ports counts once", (await connectedDevices(adb)).length === 1, { transports })
    }
    const devices = adb ? await connectedDevices(adb).catch(() => []) : []
    const javac = spawnSync(process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "javac") : "javac", ["-version"], { windowsHide: true }).status === 0
    if (!adb || devices.length !== 1 || !javac) {
      check(`(skipped: ${!adb ? "no adb" : devices.length !== 1 ? "not exactly one Android device connected" : "no JDK to build the demo app"})`, true)
      return
    }
    const apk = path.join(os.tmpdir(), `mcode-r40-demo-${process.pid}.apk`)
    execFileSync(process.execPath, [path.join(root, "scripts", "android-demo.mjs"), path.join(root, "scripts", "fixtures", "android-demo"), apk], { stdio: "ignore" })
    execFileSync(adb, ["-s", devices[0]!.serial, "install", "-r", apk], { stdio: "ignore" })
    fs.rmSync(apk, { force: true })
    const context = contextFor("r40-android", os.tmpdir())
    try {
      const opened = await AppTool.execute({ action: "android", package: "dev.mcode.demo" }, context)
      check("an empty field is named by its hint and reads as empty, not as holding its hint", /\[\d+\] textbox "昵称" value=""/.test(opened.output), opened.output)
      const started = Date.now()
      const done = await AppTool.execute(
        {
          action: "do",
          steps: [
            { action: "click", ref: refOf(opened.output, /"加一"/) },
            { action: "type", ref: refOf(opened.output, /textbox/), text: "小王" },
            { action: "click", ref: refOf(opened.output, /"深色模式"/) },
            { action: "click", ref: refOf(opened.output, /"保存"/) },
          ],
        },
        context,
      )
      const took = Date.now() - started
      check("Chinese is typed into the field and reaches the app", /4\. click \[\d+\] -> shows: 已保存：小王，深色/.test(done.output) && /value="小王"/.test(done.output), done.output)
      check("four steps on the device take seconds", took < 5_000, { took })
    } finally {
      await AppTool.execute({ action: "close" }, context).catch(() => undefined)
      await closeAllApps()
    }
  }
}
