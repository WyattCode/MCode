/**
 * Packages the app: places the verified score soundfont (see soundfont.mjs)
 * and, for Windows, the bundled runtimes (see runtimes.mjs),
 * advances the version one step (see bump-version.mjs), builds, and runs
 * electron-builder with whatever flags follow the script
 * name (`--win`, `--mac`, `--linux`, or none for the host platform). A build
 * for another system than this one stops first (see package-target.mjs).
 *
 * The bump has to come first so the installer carries the new number - but a
 * build that fails is not a package, and the user's rule counts packages. So
 * on failure the two manifests are put back exactly as they were, and the
 * next successful run takes the number this one would have.
 */
import fs from "node:fs"
import { spawnSync } from "node:child_process"
import { packageTarget } from "./package-target.mjs"

const flags = process.argv.slice(2)
const { target, error } = packageTarget(flags, process.platform)
if (error) {
  console.error(error)
  process.exit(1)
}

const FILES = ["package.json", "package-lock.json"].filter((p) => fs.existsSync(p))
const before = new Map(FILES.map((p) => [p, fs.readFileSync(p)]))

const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" }).status ?? 1

// The score soundfont ships beside the asar and is not in git: place it and verify its size and hash, or stop here.
let status = run("node", ["scripts/soundfont.mjs"])
// A Windows package carries the bundled runtimes (see runtimes.mjs), verified the same way.
if (status === 0 && target === "win32") status = run("node", ["scripts/runtimes.mjs"])
if (status === 0) status = run("node", ["scripts/bump-version.mjs"])
if (status === 0) status = run("npx", ["electron-vite", "build"])
// Nothing is uploaded from here: a release is published by hand (see electron-builder.yml).
if (status === 0) status = run("npx", ["electron-builder", "--publish", "never", ...flags])

if (status !== 0) {
  for (const [p, bytes] of before) fs.writeFileSync(p, bytes)
  console.error(`package failed (exit ${status}); version restored`)
}
process.exit(status)
