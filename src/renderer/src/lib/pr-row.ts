import type { PullRequestState } from "@shared/protocol"

/**
 * What the info card's last row shows for the branch's pull request, as MiMo
 * draws it: nothing away from GitHub; a disabled line while asking, when there
 * is none, and when it cannot be known - a failed lookup or a detached HEAD -
 * and the pull request itself once found.
 */
export type PrRow = "hidden" | "loading" | "none" | "unavailable" | "found"

/* `result` is the answer for the project and branch on screen, or undefined while it is still being asked. */
export function prRowState(github: boolean, result: PullRequestState | undefined): PrRow {
  if (!github) return "hidden"
  if (!result) return "loading"
  if (!result.ok) return "unavailable"
  return result.kind === "none" ? "none" : "found"
}
