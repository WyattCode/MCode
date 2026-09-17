import type { SessionInfo } from "@shared/protocol"
import { sessionGroup } from "@shared/session-group"
import { useApp } from "../stores/app"

/**
 * The project a conversation is filed under, as the side column shows it:
 * its label, else its folder when that is a project, else the main repository
 * its folder belongs to (nothing for a folder that is gone).
 */
export function projectOf(session: Pick<SessionInfo, "directory" | "scratch" | "group">): string | undefined {
  return sessionGroup(session, useApp().groupContext)
}
