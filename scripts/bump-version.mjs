/**
 * Advances the version by one patch step before every package build, carrying
 * at ten: 0.1.9 -> 0.2.0, 0.9.9 -> 1.0.0. The rule the user set on
 * 2026-09-06: 每打包一次递进一位，逢十进一.
 *
 * Writes package.json and both version fields of package-lock.json so that
 * `npm ci` keeps agreeing with the manifest. Idempotent per build: it is run
 * once, by the `package*` scripts, never by `build` or the checks.
 */
import fs from "node:fs"

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"))
const write = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n", "utf8")

export function next(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`version is not x.y.z: ${version}`)
  let [major, minor, patch] = m.slice(1).map(Number)
  patch += 1
  if (patch === 10) {
    patch = 0
    minor += 1
  }
  if (minor === 10) {
    minor = 0
    major += 1
  }
  return `${major}.${minor}.${patch}`
}

if (process.argv[1] && process.argv[1].endsWith("bump-version.mjs")) {
  const pkg = read("package.json")
  const from = pkg.version
  const to = next(from)
  pkg.version = to
  write("package.json", pkg)
  if (fs.existsSync("package-lock.json")) {
    const lock = read("package-lock.json")
    lock.version = to
    if (lock.packages && lock.packages[""]) lock.packages[""].version = to
    write("package-lock.json", lock)
  }
  console.log(`version ${from} -> ${to}`)
}
