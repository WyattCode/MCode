/**
 * Times three consecutive no-op spawns of the bash tool's platform shell.
 * On a cold Windows PowerShell the first is often ~10–20s; later ~0.2s.
 * Usage (from repo root, after build or via node --experimental-strip-types if available):
 *   node --import tsx scripts/probe-first-bash.mjs   # if tsx available
 * Or: esbuild this file with bash.ts bundled.
 */
import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"
import { platformShell } from "../src/server/shell-path.ts"

const file = platformShell()
const name = file.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat)$/i, "").toLowerCase()
const isPosh = name === "powershell" || name === "pwsh"
const isCmd = process.platform === "win32" && name === "cmd"
const args = isPosh
  ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]
  : isCmd
    ? ["/d", "/s", "/c", "exit 0"]
    : ["-c", "true"]

async function once() {
  const t0 = performance.now()
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("exit " + code))))
    child.on("error", reject)
  })
  return Math.round(performance.now() - t0)
}

console.log("shell:", file)
for (let i = 1; i <= 3; i++) {
  const ms = await once()
  console.log(`spawn #${i}: ${ms} ms`)
}
