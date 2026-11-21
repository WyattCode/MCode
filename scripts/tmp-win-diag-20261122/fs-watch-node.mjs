// Temporary diagnostic (win-env-fixes): plain-Node fs.watch behavior on the
// Windows runner — does a write inside a watched folder deliver at all, how
// fast, and does the 8.3 temp spelling matter? Prints JSON lines.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const tryCombo = (label, dir, watchTarget, opts) =>
  new Promise((resolve) => {
    const file = path.join(dir, "paper.docx")
    fs.writeFileSync(file, "one")
    const events = []
    const started = Date.now()
    let watcher
    try {
      watcher = fs.watch(watchTarget, opts, (ev, name) => events.push({ ev, name: String(name), at: Date.now() - started }))
    } catch (error) {
      console.log(JSON.stringify({ label, error: String(error?.message ?? error) }))
      return resolve()
    }
    setTimeout(() => {
      fs.writeFileSync(file, `${Date.now()} touched`)
      setTimeout(() => {
        watcher.close()
        console.log(JSON.stringify({ label, dirKind: dir.includes("~") ? "short" : "long", events }))
        resolve()
      }, 5_000)
    }, 120)
  })

const mk = (base, name) => {
  const dir = fs.mkdtempSync(path.join(base, name))
  return dir
}

const dirs = { temp: mk(os.tmpdir(), "mcode-diag-t-"), repo: mk(process.env.GITHUB_WORKSPACE || process.cwd(), "mcode-diag-r-") }
console.log(JSON.stringify({ tmpdir: os.tmpdir(), tempProbe: dirs.temp, repoProbe: dirs.repo, platform: process.platform, release: os.release(), node: process.version }))

for (const [kind, dir] of Object.entries(dirs)) {
  await tryCombo(`${kind}/dir-persistent`, dir, dir, { persistent: true })
  await tryCombo(`${kind}/dir-nonpersistent`, dir, dir, { persistent: false })
  await tryCombo(`${kind}/file-nonpersistent`, dir, path.join(dir, "paper.docx"), { persistent: false })
}
for (const dir of Object.values(dirs)) fs.rmSync(dir, { recursive: true, force: true })
console.log("PROBE_WATCH_NODE_DONE")
