// Temporary diagnostic (win-env-fixes): runs the bundled watch-electron probe
// under the repo's Electron and prints its verdict.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const electron = createRequire(import.meta.url)("electron")
const bundle = process.argv[2]
const verdict = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcode-diag-verdict-")), "watch.json")
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawnSync(electron, [bundle, `--user-data-dir=${verdict}.profile`, verdict], { stdio: "ignore", windowsHide: true, env, timeout: 240_000 })
console.log(`electron exit ${child.status}`)
try {
  console.log(fs.readFileSync(verdict, "utf8"))
} catch {
  console.log("(no verdict file)")
}
console.log("PROBE_WATCH_ELECTRON_DONE")
