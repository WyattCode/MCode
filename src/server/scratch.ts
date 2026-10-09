import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectLocations, reservedProjectName } from "./project-location"
import { CodedError } from "@shared/errors"

/**
 * Where a task with no project works.
 *
 * The reference's home picker offers "no project" beside the real ones, and a
 * task started that way still needs a directory: the tools read and write
 * relative to one, and the terminal opens in it. Each such task gets a fresh,
 * empty folder of its own under one parent, so nothing it makes lands in
 * somebody's project and two of them never share a floor.
 *
 * The parent is the default project location chosen in settings when there is
 * one. Otherwise it can be moved with MCODE_SCRATCH_ROOT, which is how the test
 * suite keeps these folders out of the home directory of whoever runs it.
 */
export function scratchRoot(chosen = ""): string {
  return chosen.trim() || process.env.MCODE_SCRATCH_ROOT || path.join(os.homedir(), "MCodeProjects")
}

/*
 * The parent folder, made if need be. Invalid or forbidden locations fail
 * before writing; a verified location whose creation fails may fall back.
 */
async function ensureRoot(chosen: string, locations: ProjectLocations): Promise<string> {
  const root = scratchRoot(chosen)
  await locations.assert(root)
  try {
    await fs.mkdir(root, { recursive: true })
    return root
  } catch (err) {
    if (!chosen.trim()) throw err
    const fallback = scratchRoot()
    await locations.assert(fallback)
    await fs.mkdir(fallback, { recursive: true })
    return fallback
  }
}

/**
 * A folder name a person typed, made safe to create on every platform.
 *
 * Characters Windows refuses become spaces, runs of space collapse, and the
 * trailing dots and spaces Windows silently drops are dropped here first, so
 * the folder on disk is the name that was shown. A device name such as CON
 * cannot be a folder at all, so it gets a word after it.
 */
export function blankProjectName(raw: string): string {
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return `${cleaned} project`
  return cleaned
}

/**
 * A new, empty project folder named by the user, beside the scratch folders.
 *
 * MiMo's "create blank project": a name, and a folder of that name under the
 * default project location. A name already taken there gets " (2)", " (3)"...
 * rather than opening somebody's existing folder as if it were new.
 */
export async function blankProjectDirectory(name: string, chosen = "", locations = new ProjectLocations()): Promise<string> {
  const base = blankProjectName(name)
  if (!base) throw new Error("A project needs a name")
  if (reservedProjectName(base)) throw new CodedError("This name is reserved for automatic task folders", "error.projectNameReserved")
  const root = await ensureRoot(chosen, locations)
  for (let attempt = 1; ; attempt++) {
    const directory = path.join(root, attempt === 1 ? base : `${base} (${attempt})`)
    try {
      await fs.mkdir(directory)
      return directory
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
  }
}

export async function scratchDirectory(now = new Date(), chosen = "", locations = new ProjectLocations()): Promise<string> {
  const root = await ensureRoot(chosen, locations)
  const pad = (value: number) => String(value).padStart(2, "0")
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  // Two tasks started in the same second must not end up in one folder, so the
  // leaf is made without `recursive`, which is what reports it already exists.
  for (let attempt = 1; ; attempt++) {
    const directory = path.join(root, attempt === 1 ? `task-${stamp}` : `task-${stamp}-${attempt}`)
    try {
      await fs.mkdir(directory)
      return directory
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
  }
}
