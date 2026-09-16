import type { SessionInfo } from "./protocol"

/**
 * Which project a conversation is filed under, as MiMo files one.
 *
 * MiMo's 移动至项目 writes a `groupProject` label and nothing else: the
 * conversation keeps working where it always worked, and only the side
 * column's grouping moves. This reads that label back.
 *
 * - a label naming a project: that project;
 * - the empty label (MiMo's 移出项目): no project, so Recent lists it;
 * - no label at all - which is every conversation stored before the label
 *   existed - the folder it works in, which is how it has always been filed;
 * - a folder made for a task nobody gave a project: no project either.
 */
export function sessionGroup(session: Pick<SessionInfo, "directory" | "scratch" | "group">): string | undefined {
  if (session.group !== undefined) return session.group || undefined
  return session.scratch ? undefined : session.directory || undefined
}

/** Whether a conversation is filed under this project, for the side column's tree. */
export function groupedUnder(session: Pick<SessionInfo, "directory" | "scratch" | "group">, directory: string): boolean {
  return sessionGroup(session) === directory
}
