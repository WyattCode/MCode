/**
 * Session-scoped verification loop state.
 *
 * The loop is deliberately small: it counts consecutive problem rounds for one
 * session, where a round is either a post-edit check that found problems or a
 * failed verify command. The tool output and loop-health notes then tell the
 * model what to do next instead of letting the turn stop at a request for
 * advice.
 */

const rounds = new Map<string, number>()

/** Default number of automatic fix rounds before the note changes to "stuck". */
export const VERIFY_LOOP_DEFAULT_MAX = 3

/** The max can be lowered or raised for a run without changing the prompt. */
export function verifyLoopMax(): number {
  const raw = process.env.MCODE_VERIFY_LOOP_MAX
  if (!raw) return VERIFY_LOOP_DEFAULT_MAX
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : VERIFY_LOOP_DEFAULT_MAX
}

export function getVerifyLoopRound(sessionID: string): number {
  return rounds.get(sessionID) ?? 0
}

export function resetVerifyLoop(sessionID: string): void {
  rounds.delete(sessionID)
}

export function incrementVerifyLoop(sessionID: string): number {
  const next = getVerifyLoopRound(sessionID) + 1
  rounds.set(sessionID, next)
  return next
}

/** Test helper. Production code should reset by session, not globally. */
export function clearVerifyLoops(): void {
  rounds.clear()
}

export interface VerifyLoopCheck {
  checker: string
  problems: number
  path?: string
  status?: string
}

/** A concrete next step for a failed post-edit check. */
export function concreteStepFromPostEdit(check: VerifyLoopCheck): string {
  const target = check.path ?? "the edited file"
  const checker = check.checker || "check"
  if (check.status === "timeout") {
    return `Re-run the ${checker} check on ${target} with a longer timeout, then fix what it reports.`
  }
  return `Re-read ${target}, fix the ${checker} error(s), then re-edit.`
}

/** A concrete next step for a failed verify command. */
export function concreteStepFromBashRetry(command: string): string {
  return `Re-read the failing assertion output above, change the code (not the test), rerun: ${command}`
}

/** Note appended while the automatic loop still has rounds left. */
export function formatVerifyLoopNote(problems: number, round: number, max: number, concreteStep: string): string {
  return `\n\nVerify loop: ${problems} problem(s) remain (round ${round}/${max}). ${concreteStep}`
}

/** Note appended after the automatic loop has run out of rounds. */
export function formatStuckSuggestion(problems: number, round: number, max: number, concreteStep: string): string {
  return `\n\nVerify loop stuck after ${round} rounds (max ${max}): ${problems} problem(s) remain. Next step: ${concreteStep}`
}
