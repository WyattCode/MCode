import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

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

export async function scratchDirectory(now = new Date(), chosen = ""): Promise<string> {
  let root = scratchRoot(chosen)
  try {
    await fs.mkdir(root, { recursive: true })
  } catch (err) {
    // A chosen folder that can no longer be made - a drive since unplugged -
    // costs the task its place, not the task itself.
    if (!chosen.trim()) throw err
    root = scratchRoot()
    await fs.mkdir(root, { recursive: true })
  }
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
