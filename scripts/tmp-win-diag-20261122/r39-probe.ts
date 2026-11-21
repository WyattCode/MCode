// Temporary diagnostic (win-env-fixes): replays the round39 animating-page
// click five times exactly as the battery does, with the driver's own settle
// waits timed, so the wall-clock "took" can be split into wait vs overhead.
import "../fenced-home"
import "../safe-listen"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { AppTool, closeAllApps } from "../../src/server/tool/app"
import { AppDriver } from "../../src/server/appdrive/driver"
import { findBrowser } from "../../src/server/appdrive/browser"

const settleTimes = []
const proto = AppDriver.prototype
const original = proto.settle
proto.settle = async function () {
  const started = Date.now()
  try {
    return await original.call(this)
  } finally {
    settleTimes.push(Date.now() - started)
  }
}

if (!findBrowser()) {
  console.log("PROBE_R39_DONE (no browser)")
  process.exit(0)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-diag-r39-"))
const page = path.join(work, "index.html")
fs.writeFileSync(
  page,
  "<!doctype html><title>R39</title><button id=b onclick=\"this.textContent='clicked '+(++window.n||(window.n=1))\">press</button><a href=\"#\">link</a><div id=spin style=\"width:10px;height:10px;background:red\"></div><script>setInterval(function(){document.getElementById('spin').style.transform='rotate('+Date.now()%360+'deg)'},16)</script>",
)
const context = {
  sessionID: "diag-r39",
  messageID: "m",
  callID: "c",
  directory: work,
  permissions: { ask: async () => undefined, waive: () => undefined },
  questions: {},
  signal: new AbortController().signal,
  progress: () => undefined,
  snapshot: async () => undefined,
}
const run = (input) => AppTool.execute(input, context)

for (let round = 1; round <= 5; round++) {
  settleTimes.length = 0
  const openStarted = Date.now()
  const opened = await run({ action: "open", url: pathToFileURL(page).href })
  const openTook = Date.now() - openStarted
  const button = Number(String(opened.output).match(/\[(\d+)\] button "press"/)?.[1])
  const started = Date.now()
  const pressed = await run({ action: "do", steps: [{ action: "click", ref: button }] })
  const took = Date.now() - started
  console.log(JSON.stringify({ round, openTook, took, settleTimes: [...settleTimes], clickOk: /clicked 1/.test(String(pressed.output)) }))
  await closeAllApps()
  await new Promise((resolve) => setTimeout(resolve, 500))
}
fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
console.log("PROBE_R39_DONE")
