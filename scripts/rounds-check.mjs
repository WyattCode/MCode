/**
 * The round-by-round checks, which `smoke.ts` stopped calling when it started
 * again small (8d05f2da). What had broken was that one file; these modules were
 * sound, and a fix's check written in one of them never ran.
 *
 * Each module runs in a process of its own with a time limit, behind the fenced
 * home, so one that hangs or crashes takes only itself down. A module that drives
 * a window, a device or a real browser is left out and named: this runs on the
 * machine of whoever typed it, and must not tap through their phone.
 *
 * Needs a fresh `npm run build`: some modules read what the build produced.
 * `node scripts/rounds-check.mjs [name-part ...]` runs only the modules named.
 */
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { buildSync } from "esbuild"

const LIMIT_MS = 180_000
const AT_ONCE = 5
/** What a module has to contain to be left out of an unattended run. */
const NEEDS_THE_MACHINE = /BrowserWindow|\badb\b|launchBrowser|_electron|playwright|installDemo|MCODE_ANDROID|Win Demo|node_modules[\\/]electron|from "electron"/
/** Needs a program this suite cannot assume, named with what it needs. */
const NEEDS = { "smoke-round14-packaging": "openssl on the PATH" }

const asked = process.argv.slice(2)
const files = fs.readdirSync("scripts").filter((file) => /^smoke-.*\.ts$/.test(file) && (!asked.length || asked.some((name) => file.includes(name))))
const out = path.resolve("out")
/* Before anything a module imports: home off the person's own, and every server off the ports fetch refuses. */
const fences = ["fenced-home", "safe-listen"].map((name) => `import ${JSON.stringify(path.resolve("scripts", `${name}.ts`).replace(/\\/g, "/"))}`).join("\n")
const left = []
const jobs = []
fs.mkdirSync(out, { recursive: true })

for (const file of files) {
  const name = file.replace(/\.ts$/, "")
  const text = fs.readFileSync(path.join("scripts", file), "utf8")
  if (NEEDS[name]) left.push(`${name} (${NEEDS[name]})`)
  else if (NEEDS_THE_MACHINE.test(text)) left.push(`${name} (a window, a device or a real browser)`)
  else {
    const source = path.resolve("scripts", file).replace(/\\/g, "/")
    const checks = [...text.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)\(check\b/gm)].map((match) => match[1])
    // A module with no exported checks runs at its top level, and reports by its exit code.
    const contents = checks.length
      ? `${fences}
import * as checks from ${JSON.stringify(source)}
let passed = 0, failed = 0
const check = (label, ok, detail) => { if (ok) passed++; else { failed++; console.log("FAIL " + label + (detail === undefined ? "" : " -> " + String(JSON.stringify(detail)).slice(0, 200))) } }
for (const name of ${JSON.stringify(checks)}) await checks[name](check, () => {})
console.log("RESULT " + passed + " " + failed)
process.exit(failed ? 1 : 0)
`
      : `${fences}\nimport ${JSON.stringify(source)}\n`
    // Beside the other built checks: modules find the sources from where they run.
    const outfile = path.join(out, `rounds-${name}.mjs`)
    buildSync({ stdin: { contents, resolveDir: path.resolve("scripts"), loader: "ts" }, bundle: true, platform: "node", format: "esm", target: "node22", alias: { "@shared": path.resolve("src/shared") }, packages: "external", outfile, logLevel: "silent" })
    jobs.push({ name, outfile })
  }
}

const run = (job) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [job.outfile], { stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const take = (chunk) => (output = (output + chunk).slice(-20_000))
    child.stdout.on("data", take)
    child.stderr.on("data", take)
    const timer = setTimeout(() => child.kill(), LIMIT_MS)
    child.on("close", (code) => {
      clearTimeout(timer)
      const counted = output.match(/RESULT (\d+) (\d+)/) ?? [...output.matchAll(/(\d+) passed\D+(\d+) failed/g)].at(-1)
      resolve({ ...job, code, passed: Number(counted?.[1] ?? 0), failed: Number(counted?.[2] ?? 0), output })
    })
  })

const results = []
let next = 0
await Promise.all(
  Array.from({ length: AT_ONCE }, async () => {
    while (next < jobs.length) results.push(await run(jobs[next++]))
  }),
)

const bad = results.filter((result) => result.code !== 0).sort((a, b) => a.name.localeCompare(b.name))
for (const result of bad) {
  console.log(`\n${result.name}: exit ${result.code}`)
  const lines = result.output.split(/\r?\n/).filter((line) => /FAIL|^failed |Error/.test(line))
  console.log((lines.length ? lines : [result.output.slice(-400)]).slice(0, 12).join("\n"))
}
if (left.length) console.log(`\nleft out: ${left.join(", ")}`)
console.log(`\n${results.length} modules, ${results.reduce((sum, result) => sum + result.passed, 0)} checks passed, ${results.reduce((sum, result) => sum + result.failed, 0)} failed, ${bad.length} modules not clean`)
process.exit(bad.length || !results.length ? 1 : 0)
