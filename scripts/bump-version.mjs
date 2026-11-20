/**
 * Each local package build advances one patch step, carrying at ten
 * (0.1.9 -> 0.2.0). Windows releases can supply a version selected before
 * packaging. Both manifests must agree before npm can use the new version.
 */
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const MANIFEST = "package.json"
const LOCKFILE = "package-lock.json"
const PENDING = ".bump-version.pending.json"
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parts(version) {
  const match = typeof version === "string" && VERSION.exec(version)
  if (!match) throw new Error(`version is not x.y.z: ${version}`)
  return match.slice(1).map(BigInt)
}

export function next(version) {
  let [major, minor, patch] = parts(version)
  patch += 1n
  if (patch === 10n) {
    patch = 0n
    minor += 1n
  }
  if (minor === 10n) {
    minor = 0n
    major += 1n
  }
  return `${major}.${minor}.${patch}`
}

export function selectVersion(base, requested, tags) {
  let highest = parts(base)
  const occupied = new Set(tags)
  if (requested) {
    parts(requested)
    if (occupied.has(`v${requested}`)) throw new Error(`tag v${requested} already exists`)
    return requested
  }
  for (const tag of occupied) {
    if (!tag.startsWith("v") || !VERSION.test(tag.slice(1))) continue
    const candidate = parts(tag.slice(1))
    const difference = candidate.findIndex((part, index) => part !== highest[index])
    if (difference >= 0 && candidate[difference] > highest[difference]) highest = candidate
  }
  return next(highest.join("."))
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function writeAtomic(file, data, mode) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const fd = fs.openSync(temp, "wx", mode)
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n", "utf8")
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

function bump(requested) {
  const pkg = read(MANIFEST)
  const lock = read(LOCKFILE)
  const root = lock.packages?.[""]
  const versions = [pkg.version, lock.version, root?.version]
  versions.forEach(parts)
  if (lock.version !== root.version) throw new Error("lockfile version fields differ")
  if (requested) parts(requested)

  // Keep the intended target until both replacements have landed. A retry can
  // see either file at either version, including after package.mjs restores
  // the originals on a failed build.
  let pending
  try {
    pending = read(PENDING)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (!pending) {
    const from = pkg.version
    if (lock.version !== from) throw new Error("manifest and lockfile versions differ")
    const to = requested || next(from)
    if (from === to) {
      console.log(`version ${to} already selected`)
      return
    }
    pending = { from, to }
    writeAtomic(PENDING, pending, 0o600)
  }
  const { from, to } = pending
  parts(from)
  parts(to)
  if ((requested && requested !== to) || versions.some((version) => version !== from && version !== to)) {
    throw new Error(`cannot resume pending version change ${from} -> ${to}`)
  }

  if (pkg.version !== to) {
    pkg.version = to
    writeAtomic(MANIFEST, pkg, fs.statSync(MANIFEST).mode)
  }
  if (lock.version !== to) {
    lock.version = root.version = to
    writeAtomic(LOCKFILE, lock, fs.statSync(LOCKFILE).mode)
  }
  fs.unlinkSync(PENDING)
  console.log(`version ${from} -> ${to}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === "--select") {
    const tags = execFileSync("git", ["tag", "--list"], { encoding: "utf8" }).split(/\r?\n/)
    console.log(selectVersion(read(MANIFEST).version, process.argv[3], tags))
  } else {
    bump(process.env.MCODE_RELEASE_VERSION)
  }
}
