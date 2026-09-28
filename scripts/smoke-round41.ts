/**
 * Round 41: second review of round 40.
 *
 * - A change inside a web component or a frame now counts as the page
 *   changing: the watcher only saw the top document, so a component still
 *   updating after a click (a loading run, a list filling in) was read at
 *   its first quiet moment - here a change every 60 ms, eight times.
 * - A component's <style> no longer pours its CSS into the page's text
 *   (innerText of an element that is not rendered is its raw source).
 * - A hidden frame (a tracker, a helper) is not counted as one to open.
 * - A big page lists its widgets to the end: the walk that replaced the
 *   query stopped after 8000 elements.
 * - Waiting for text sees text inside components and frames.
 * - Android: typing with clear:false adds to the field instead of replacing
 *   it (checked on a device, as round 40's Android checks are).
 *
 * smoke.ts calls `roundFortyOneChecks` with its own check and section.
 */
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import type { Check } from "./smoke-round5"
import { AppTool, closeAllApps } from "../src/server/tool/app"
import { findBrowser } from "../src/server/appdrive/browser"
import { connectedDevices, findAdb } from "../src/server/appdrive/android"
import type { ToolContext } from "../src/server/tool/types"
import { installDemo } from "./smoke-round41-install"

const root = process.cwd()

function contextFor(sessionID: string, directory: string): ToolContext {
  return { sessionID, messageID: "m", callID: "c", directory, permissions: { ask: async () => undefined }, questions: {}, signal: new AbortController().signal, progress: () => undefined, snapshot: async () => undefined } as unknown as ToolContext
}

const refOf = (output: string, test: RegExp) => Number(output.split("\n").find((line) => test.test(line))?.match(/^\[(\d+)\]/)?.[1])

export async function roundFortyOneChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 41: web components and frames, second look")
  if (!findBrowser()) {
    check("(skipped: no Chrome or Edge on this machine)", true)
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-r41-"))
    fs.writeFileSync(path.join(work, "inner.html"), "<!doctype html><p id=said>frame idle</p><button onclick=\"var n=0,t=setInterval(function(){n++;document.getElementById('said').textContent=n<8?'frame step '+n:'frame later';if(n>=8)clearInterval(t)},60)\">slow in frame</button>")
    fs.writeFileSync(
      path.join(work, "index.html"),
      [
        "<!doctype html><title>R41</title>",
        "<x-slow></x-slow>",
        '<iframe src="inner.html" style="width:400px;height:100px"></iframe>',
        '<iframe src="data:text/html,<p>tracker</p>" style="display:none"></iframe>',
        '<iframe src="data:text/html,<p>pixel</p>" width="0" height="0" style="border:0"></iframe>',
        '<div id="filler"></div><button id="last">at the very end</button>',
        "<script>",
        "var filler = document.getElementById('filler'); var html = ''; for (var i = 0; i < 9000; i++) html += '<span>.</span>'; filler.innerHTML = html;",
        "customElements.define('x-slow', class extends HTMLElement { constructor() { super(); const r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<style>.card { color: rebeccapurple; }</style><p hidden>secret draft</p><p class=card id=out>component idle</p><button id=go>slow in component</button>'; r.getElementById('go').onclick = () => { let n = 0; const t = setInterval(() => { n++; r.getElementById('out').textContent = n < 8 ? 'component step ' + n : 'component later'; if (n >= 8) clearInterval(t) }, 60) } } })",
        "</script>",
      ].join("\n"),
    )
    const context = contextFor("r41-web", work)
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
      check("a component's style sheet is not read out as page text", /component idle/.test(opened.output) && !/rebeccapurple|\.card \{/.test(opened.output), opened.output)
      check("nor is a hidden part of a component", !/secret draft/.test(opened.output), opened.output)
      check("hidden and zero-size frames are not counted as frames to open", !/embedded frame\(s\) from another site/.test(opened.output), opened.output)
      check("a widget after 9000 other elements is still listed", refOf(opened.output, /button "at the very end"/) > 0, opened.output)
      const slow = await AppTool.execute({ action: "do", steps: [{ action: "click", ref: refOf(opened.output, /slow in component/) }] }, context)
      check("a component still changing after the click is waited for, and read when done", /shows: component later/.test(slow.output) && !/component step/.test(slow.output), slow.output)
      const framed = await AppTool.execute({ action: "do", steps: [{ action: "click", ref: refOf(opened.output, /slow in frame/) }] }, context)
      check("and so is a frame", /shows: frame later/.test(framed.output) && !/frame step/.test(framed.output), framed.output)
      const again = await AppTool.execute({ action: "open", url: address }, context)
      const waited = await AppTool.execute({ action: "do", steps: [{ action: "click", ref: refOf(again.output, /slow in component/) }, { action: "wait", text: "component later", ms: 3000 }] }, context)
      check("waiting for text finds it inside a component", /2\. wait[^\n]*it appeared/.test(waited.output), waited.output)
    } finally {
      await closeAllApps()
      server.close()
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
  }

  section("Round 41: Android typing that adds to a field")
  {
    const adb = findAdb()
    const devices = adb ? await connectedDevices(adb).catch(() => []) : []
    const javac = spawnSync(process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "javac") : "javac", ["-version"], { windowsHide: true }).status === 0
    if (!adb || devices.length !== 1 || !javac) {
      check(`(skipped: ${!adb ? "no adb" : devices.length !== 1 ? "not exactly one Android device connected" : "no JDK to build the demo app"})`, true)
      return
    }
    const apk = path.join(os.tmpdir(), `mcode-r41-demo-${process.pid}.apk`)
    execFileSync(process.execPath, [path.join(root, "scripts", "android-demo.mjs"), path.join(root, "scripts", "fixtures", "android-demo"), apk], { stdio: "ignore" })
    installDemo(adb, devices[0]!.serial, apk)
    fs.rmSync(apk, { force: true })
    const context = contextFor("r41-android", os.tmpdir())
    try {
      const opened = await AppTool.execute({ action: "android", package: "dev.mcode.demo" }, context)
      const field = refOf(opened.output, /textbox/)
      await AppTool.execute({ action: "do", steps: [{ action: "type", ref: field, text: "小王" }] }, context)
      const added = await AppTool.execute({ action: "do", steps: [{ action: "type", ref: field, text: "和小明", clear: false }] }, context)
      check("clear:false adds to what the field holds", /value="小王和小明"/.test(added.output), added.output)
      const replaced = await AppTool.execute({ action: "do", steps: [{ action: "type", ref: field, text: "小李" }] }, context)
      check("and without it the field is replaced", /value="小李"/.test(replaced.output), replaced.output)
    } finally {
      await AppTool.execute({ action: "close" }, context).catch(() => undefined)
      await closeAllApps()
    }
  }
}
