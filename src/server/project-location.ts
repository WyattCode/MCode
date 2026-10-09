import fs from "node:fs/promises"
import path from "node:path"
import { CodedError } from "@shared/errors"

/** Resolve existing ancestors too, so a new folder through a junction is checked before mkdir. */
async function canonicalDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory) || directory.includes("\0")) throw new Error("An absolute directory is required")
  let ancestor = path.resolve(directory)
  const missing: string[] = []
  for (;;) {
    try {
      const real = await fs.realpath(ancestor)
      if (!(await fs.stat(real)).isDirectory()) throw new Error("The location is not a directory")
      return path.join(real, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw error
      missing.push(path.basename(ancestor))
      ancestor = parent
    }
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Each backend knows its own installation; development checkouts remain usable as projects. */
export class ProjectLocations {
  constructor(private readonly installationDirectory?: string) {}

  async assert(directory: string): Promise<void> {
    let candidate: string, installation: string | undefined
    try {
      candidate = await canonicalDirectory(directory)
      installation = this.installationDirectory ? await canonicalDirectory(this.installationDirectory) : undefined
    } catch {
      throw new CodedError("The project location could not be verified", "error.projectLocationInvalid")
    }
    if (installation && inside(installation, candidate)) {
      throw new CodedError("Projects cannot be stored in the application installation", "error.projectLocationInstall")
    }
  }
}

/** The automatically allocated task namespace must not also name a user-created project. */
export function reservedProjectName(name: string): boolean {
  return /^task-\d{8}-\d{6}(?:-\d+)?$/i.test(name)
}
