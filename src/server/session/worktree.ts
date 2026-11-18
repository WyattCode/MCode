import fs from "node:fs/promises"
import path from "node:path"
import { runGit, type GitRunOptions } from "../git-process"

export function addWorktree(root: string, args: readonly string[], options?: GitRunOptions): Promise<string> {
  return runGit(root, ["worktree", "add", ...args], options)
}

export function removeWorktree(root: string, directory: string, force: boolean, options?: GitRunOptions): Promise<string> {
  return runGit(root, ["worktree", "remove", ...(force ? ["--force"] : []), directory], options)
}

/**
 * Which git worktree a path is in, read off the file system the way MiMo reads
 * it - no git process. The nearest `.git` above a path marks its worktree's
 * top: a folder means the repository's main worktree, a file pointing at a
 * `gitdir:` means a linked one.
 */
export interface WorktreeTop {
  root: string
  main: boolean
}

export async function worktreeTop(start: string): Promise<WorktreeTop | undefined> {
  let at = path.resolve(start)
  for (;;) {
    const marker = path.join(at, ".git")
    const stat = await fs.stat(marker).catch(() => undefined)
    if (stat?.isDirectory()) return { root: at, main: true }
    if (stat?.isFile()) {
      const text = await fs.readFile(marker, "utf8").catch(() => "")
      if (/^gitdir:/m.test(text)) return { root: at, main: false }
    }
    const parent = path.dirname(at)
    if (parent === at) return undefined
    at = parent
  }
}

/** The folders from `start` up to its worktree's top, nearest first; to the file system's root outside a worktree. */
export async function foldersUp(start: string): Promise<string[]> {
  const top = await worktreeTop(start)
  const out: string[] = []
  let at = path.resolve(start)
  for (;;) {
    out.push(at)
    if (top && at === top.root) return out
    const parent = path.dirname(at)
    if (parent === at) return out
    at = parent
  }
}
