import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * memory: which project a folder's memory belongs to, by MiMo's rule.
 *
 * MiMo files memory by a project id kept inside the repository's main `.git`
 * folder: a random id written the first time the repository is met, so every
 * subdirectory and every linked worktree of one clone shares it, and a second
 * clone of the same repository gets its own. A folder that is in no
 * repository - or whose `.git` sits at the home folder or the top of a drive -
 * has no project of its own, and all such folders share one id, `global`.
 *
 * The id file is named for this app (`mcode-project-id`), beside MiMo's own.
 * A repository whose `.git` cannot be written to still gets a stable id: one
 * derived from the main repository's folder.
 */

export const GLOBAL_PROJECT_ID = "global"
export const PROJECT_ID_FILE = "mcode-project-id"

/** An id read back from disk is used as a folder name, so only a plain token is accepted. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** How long a folder's answer is kept before the disk is asked again. */
const FRESH_MS = 60_000

const cache = new Map<string, { id: string; at: number }>()

/**
 * The repository's main `.git` folder for a directory, or undefined outside one.
 *
 * The nearest `.git` upward decides. A folder is the main repository's own; a
 * file is a linked worktree (or a submodule) whose `gitdir:` line points two
 * levels below the main one, as MiMo reads it.
 */
export function mainGitDir(start: string, home = os.homedir()): string | undefined {
  let at = path.resolve(start)
  for (;;) {
    const marker = path.join(at, ".git")
    let stat: fs.Stats | undefined
    try {
      stat = fs.statSync(marker)
    } catch {
      stat = undefined
    }
    if (stat) {
      // MiMo ignores a repository at the home folder or the top of a drive.
      if (samePath(at, home) || path.parse(at).root === at) return undefined
      if (stat.isDirectory()) return marker
      let text = ""
      try {
        text = fs.readFileSync(marker, "utf8").trim()
      } catch {
        return undefined
      }
      const pointer = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim()
      if (!pointer) return undefined
      return path.resolve(at, pointer, "..", "..")
    }
    const parent = path.dirname(at)
    if (parent === at) return undefined
    at = parent
  }
}

function samePath(a: string, b: string): boolean {
  const fold = (value: string) => {
    const resolved = path.resolve(value)
    return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved
  }
  return fold(a) === fold(b)
}

/** A fallback id for a repository whose `.git` will not take the id file. */
function derivedID(gitDir: string): string {
  const folder = path.dirname(gitDir)
  const key = process.platform === "win32" || process.platform === "darwin" ? folder.toLowerCase() : folder
  let hash = 0x811c9dc5
  for (const char of key) {
    hash ^= char.codePointAt(0)!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `repo-${hash.toString(16).padStart(8, "0")}`
}

/**
 * The memory project id for a folder: the repository's id, written on first
 * use, or `global` for a folder outside any repository.
 */
export function projectMemoryID(directory: string, options: { home?: string; now?: number } = {}): string {
  const now = options.now ?? Date.now()
  const key = path.resolve(directory)
  const known = cache.get(key)
  if (known && now - known.at < FRESH_MS) return known.id
  const id = resolveID(directory, options.home)
  cache.set(key, { id, at: now })
  return id
}

function resolveID(directory: string, home?: string): string {
  const gitDir = mainGitDir(directory, home)
  if (!gitDir) return GLOBAL_PROJECT_ID
  const file = path.join(gitDir, PROJECT_ID_FILE)
  try {
    const stored = fs.readFileSync(file, "utf8").trim()
    if (SAFE_ID.test(stored)) return stored
  } catch {
    // Not written yet.
  }
  const made = randomUUID()
  try {
    fs.writeFileSync(file, made)
    return made
  } catch {
    return derivedID(gitDir)
  }
}

/** Forgets the remembered answers, for the checks. */
export function forgetProjectIDs(): void {
  cache.clear()
}
