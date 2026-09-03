import fs from "node:fs/promises"
import path from "node:path"

/**
 * What is actually true about a session's directory.
 *
 * The hero used to state "main branch" as a constant, which was a claim rather
 * than a fact: it read the same whether the directory was a git repo, sat on a
 * different branch, or had been deleted. Anything shown there now comes from
 * disk, and what cannot be established is simply not shown.
 */
export interface WorkspaceInfo {
  exists: boolean
  /** Branch name, or a short SHA when HEAD is detached. Absent if not a repo. */
  branch?: string
  /** Epoch ms of the newest change git knows about, or the directory itself. */
  modified?: number
}

/** Resolves the real git directory, following the `gitdir:` file a worktree uses. */
async function gitDirectory(directory: string): Promise<string | undefined> {
  const candidate = path.join(directory, ".git")
  let stats
  try {
    stats = await fs.stat(candidate)
  } catch {
    return undefined
  }

  if (stats.isDirectory()) return candidate

  // A linked worktree stores a pointer file instead of a directory.
  const pointer = await fs.readFile(candidate, "utf8").catch(() => "")
  const match = /^gitdir:\s*(.+)$/m.exec(pointer)
  if (!match) return undefined
  const target = match[1].trim()
  return path.isAbsolute(target) ? target : path.resolve(directory, target)
}

export async function workspaceInfo(directory: string): Promise<WorkspaceInfo> {
  const stats = await fs.stat(directory).catch(() => undefined)
  if (!stats?.isDirectory()) return { exists: false }

  const info: WorkspaceInfo = { exists: true, modified: stats.mtimeMs }

  const git = await gitDirectory(directory)
  if (!git) return info

  // Reading HEAD beats shelling out to git: no process, and it works the same
  // whether or not git is on PATH.
  const head = await fs.readFile(path.join(git, "HEAD"), "utf8").catch(() => "")
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head)
  if (ref) info.branch = ref[1].trim()
  else if (/^[0-9a-f]{40}/.test(head.trim())) info.branch = head.trim().slice(0, 7)

  const headStats = await fs.stat(path.join(git, "HEAD")).catch(() => undefined)
  if (headStats) info.modified = Math.max(info.modified ?? 0, headStats.mtimeMs)

  return info
}
