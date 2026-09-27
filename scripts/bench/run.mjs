/**
 * The coding benchmark: each task in scripts/bench/tasks run by the real app
 * against a real model, and judged by the task's own check.
 *
 * A task is a folder with its starting files and a task.json: the prompt as a
 * user would type it, the command that decides pass or fail, and the files the
 * model must not touch (the tests). Each run copies the folder somewhere
 * fresh, makes it a git repository, runs scripts/bench/agent.cjs in Electron
 * over the built app, then runs the check there.
 *
 * The model is whatever the profile is set to use. BENCH_PROFILE defaults to
 * %TEMP%\mcode-lan-trial, the throwaway profile set up for the user's LAN
 * model, whose key the user entered themselves; nothing here reads it.
 *
 * Run with: npm run build && node scripts/bench/run.mjs --label baseline [--runs 2] [--task bugfix-js]
 * Results: out/bench/<label>.json, and a table on the console.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..", "..")
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : fallback
}
const label = arg("label", "run")
const runs = Number(arg("runs", "1"))
const only = arg("task")
const profile = process.env.BENCH_PROFILE || path.join(os.tmpdir(), "mcode-lan-trial")
if (!fs.existsSync(path.join(profile, "storage", "config.json"))) throw new Error(`no profile at ${profile}`)

const tasksDir = path.join(here, "tasks")
const tasks = fs.readdirSync(tasksDir).filter((name) => !only || name === only)
const work = path.join(os.tmpdir(), "mcode-bench", `${label}-${Date.now()}`)
const outDir = path.join(repo, "out", "bench")
fs.mkdirSync(outDir, { recursive: true })
const electron = path.join(repo, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron")

const git = (cwd, ...args) => spawnSync("git", args, { cwd, windowsHide: true, encoding: "utf8" })
const results = []
for (let run = 1; run <= runs; run++) {
  for (const task of tasks) {
    const spec = JSON.parse(fs.readFileSync(path.join(tasksDir, task, "task.json"), "utf8"))
    const dir = path.join(work, `${task}-${run}`)
    fs.cpSync(path.join(tasksDir, task), dir, { recursive: true })
    fs.rmSync(path.join(dir, "task.json"))
    git(dir, "init", "-q")
    git(dir, "add", "-A")
    git(dir, "-c", "user.email=bench@example.com", "-c", "user.name=bench", "commit", "-q", "-m", "start")
    const out = path.join(work, `${task}-${run}.json`)
    process.stdout.write(`${task} #${run} ... `)
    const began = Date.now()
    spawnSync(electron, [path.join(here, "agent.cjs")], {
      env: { ...process.env, BENCH_TASK_DIR: dir, BENCH_PROMPT: spec.prompt, BENCH_OUT: out, BENCH_PROFILE: profile },
      stdio: "ignore",
      timeout: 12 * 60_000,
      windowsHide: true,
    })
    const measured = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { notes: ["the agent wrote nothing"] }
    const check = spawnSync(spec.verify[0], spec.verify.slice(1), { cwd: dir, encoding: "utf8", windowsHide: true, timeout: 60_000 })
    const touched = (spec.unchanged ?? []).filter((file) => git(dir, "diff", "--quiet", "HEAD", "--", file).status !== 0)
    const passed = check.status === 0 && touched.length === 0
    results.push({ task, run, passed, touched, check: (check.stdout + check.stderr).trim().split(/\r?\n/).slice(-3).join(" | "), wall: Math.round((Date.now() - began) / 1000), ...measured })
    console.log(`${passed ? "PASS" : "FAIL"}  ${measured.seconds ?? "?"}s  ${measured.steps ?? "?"} steps  ${measured.toolCalls ?? "?"} tools`)
  }
}

const file = path.join(outDir, `${label}.json`)
fs.writeFileSync(file, JSON.stringify({ label, profile: path.basename(profile), at: new Date().toISOString(), results }, null, 2))
const passed = results.filter((entry) => entry.passed).length
const mean = (key) => Math.round(results.reduce((total, entry) => total + (entry[key] ?? 0), 0) / Math.max(1, results.length))
console.log(`\n${label}: ${passed}/${results.length} passed; mean ${mean("seconds")}s, ${mean("steps")} steps, ${mean("toolCalls")} tool calls, ${mean("largestRequest")} tokens in the largest request, ${mean("promptTokens")} prompt tokens in all`)
console.log(`written to ${path.relative(repo, file)}`)
