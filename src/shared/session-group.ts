import type { SessionInfo } from "./protocol"

/**
 * What a conversation's filing can know about folders beyond its own record:
 * which folders are listed projects, which main repository a folder belongs
 * to, and which folders are gone. The window fills it from `git.repoRoots`.
 */
export interface GroupContext {
  /** The listed projects' folders. */
  listed: ReadonlySet<string>
  /** The main repository a folder is part of, when that is another folder. */
  root?: (directory: string) => string | undefined
  /** Whether a folder no longer exists. */
  missing?: (directory: string) => boolean
}

/**
 * Which project a conversation is filed under, as MiMo files one.
 *
 * MiMo's 移动至项目 writes a `groupProject` label and nothing else: the
 * conversation keeps working where it always worked, and only the side
 * column's grouping moves. This reads that label back.
 *
 * - a label naming a project: that project;
 * - the empty label (MiMo's 移出项目): no project, so Recent lists it;
 * - a folder made for a task nobody gave a project: no project either;
 * - no label at all: the folder it works in when that folder is a listed
 *   project; otherwise, as MiMo derives it, the main repository that folder
 *   belongs to - so a conversation in a linked worktree or a subdirectory is
 *   filed under the repository's project - and nothing for a folder that is
 *   gone. Without a context, the folder it works in.
 */
export function sessionGroup(
  session: Pick<SessionInfo, "directory" | "scratch" | "group">,
  context?: GroupContext,
): string | undefined {
  if (session.group !== undefined) return session.group || undefined
  if (session.scratch || !session.directory) return undefined
  const directory = session.directory
  if (!context || context.listed.has(directory)) return directory
  if (context.missing?.(directory)) return undefined
  return context.root?.(directory) ?? directory
}
