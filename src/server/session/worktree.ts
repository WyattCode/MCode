import fs from "node:fs/promises"
import path from "node:path"

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

/** Whether a main worktree's repository already has linked worktrees. */
export async function hasLinkedWorktrees(root: string): Promise<boolean> {
  const entries = await fs.readdir(path.join(root, ".git", "worktrees")).catch((): string[] => [])
  return entries.some((name) => !name.startsWith("."))
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

/**
 * The git main worktrees a set of paths falls in, each named once.
 *
 * MiMo's `mainWorktreeHits`: how a shell command reports what it changed, since
 * a command names no paths of its own the way a write tool does. A path inside
 * a linked worktree, or in no repository at all, is not one of these.
 */
export async function mainWorktreeRoots(targets: readonly string[]): Promise<string[]> {
  const roots = new Set<string>()
  for (const target of targets) {
    const top = await worktreeTop(target)
    if (top?.main) roots.add(top.root)
  }
  return [...roots]
}

/** MiMo's auto-worktree notice, in MCode's words: once per conversation, after a change to a repository's main worktree. */
export function worktreeNotice(root: string, linked: boolean): string {
  return linked
    ? `You are changing files in ${root}, the main worktree of a git repository that already has other worktrees. Keep this task's changes apart: create a new worktree for the task and carry on there instead of in the main worktree.`
    : `You are changing files in ${root}, the main worktree of a git repository. Do not create a worktree on your own; before changing more files here, ask the user whether to carry on in the main worktree, and treat other repositories the same way.`
}
