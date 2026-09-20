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

/**
 * MiMo's auto-worktree notice, in MCode's words: once per conversation, after a
 * change to a repository's main worktree.
 *
 * Four things MiMo says and this used to leave out, so the model was told what
 * to notice without being told what to do about it:
 *
 *  - why it matters, which is the same in both wordings: other agents and the
 *    user's own uncommitted work are writing in that folder at the same time;
 *  - in a repository that already keeps worktrees, that the answer is not a
 *    question - move first, then write - so the model stops stopping to ask;
 *  - in a repository that does not, what each answer means, since a model told
 *    to ask and not told what either answer leads to picks for itself;
 *  - in both, that the rule is about repositories, not about this one path.
 */
export function worktreeNotice(root: string, linked: boolean): string {
  const opening = `You are changing files in ${root}, the main worktree of a git repository${linked ? " that already keeps worktrees" : ""}. Writing, editing or running git there at the same time as other agents, or on top of changes the user has not committed, gets in their way.`
  return linked
    ? [
        opening,
        "You do not need to ask about this: before your next write or edit, make a worktree for this task and move into it, then carry on there.",
        "This is not only about the folder above. Whenever you start writing to another repository that keeps worktrees, isolate the work there the same way, again without asking.",
      ].join(" ")
    : [
        opening,
        "Do not make a worktree on your own. Before your next write or edit, ask the user whether this task should be isolated in one. If they say yes, make the worktree, move into it, and carry on there; if they say no, carry on as planned and do not make one.",
        "This is not only about the folder above: ask the same question the first time you start writing to another repository's main worktree.",
      ].join(" ")
}
