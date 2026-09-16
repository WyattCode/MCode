/**
 * Packages the app: places the verified score soundfont (see soundfont.mjs)
 * and, for Windows, the bundled runtimes (see runtimes.mjs),
 * advances the version one step (see bump-version.mjs), builds, and runs
 * electron-builder with whatever flags follow the script
 * name (`--win`, `--mac`, or none for the host platform).
 *
 * The bump has to come first so the installer carries the new number - but a
 * build that fails is not a package, and the user's rule counts packages. So
 * on failure the two manifests are put back exactly as they were, and the
 * next successful run takes the number this one would have.
 */
import fs from "node:fs"
import { spawnSync } from "node:child_process"

const FILES = ["package.json", "package-lock.json"].filter((p) => fs.existsSync(p))
const before = new Map(FILES.map((p) => [p, fs.readFileSync(p)]))

const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" }).status ?? 1

// The score soundfont ships beside the asar and is not in git: place it and verify its size and hash, or stop here.
let status = run("node", ["scripts/soundfont.mjs"])
// A Windows package carries the bundled runtimes (see runtimes.mjs), verified the same way.
const flags = process.argv.slice(2)
const forWindows = flags.includes("--win") || (process.platform === "win32" && !flags.some((flag) => flag === "--mac" || flag === "--linux"))
if (status === 0 && forWindows) status = run("node", ["scripts/runtimes.mjs"])
if (status === 0) status = run("node", ["scripts/bump-version.mjs"])
if (status === 0) status = run("npx", ["electron-vite", "build"])
// Nothing is uploaded from here: a release is published by hand (see electron-builder.yml).
if (status === 0) status = run("npx", ["electron-builder", "--publish", "never", ...process.argv.slice(2)])

if (status !== 0) {
  for (const [p, bytes] of before) fs.writeFileSync(p, bytes)
  console.error(`package failed (exit ${status}); version restored`)
}
process.exit(status)
