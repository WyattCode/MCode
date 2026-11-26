/**
 * Whether this turn runs the lean coding prompt and tool list.
 *
 * Three answers, one switch: `MCODE_LEAN=1` forces lean on whatever the endpoint is, `MCODE_LEAN=0`
 * forces the full set on whatever the endpoint is, and with neither set the endpoint decides - a
 * model served on this machine or the LAN runs lean, a remote one runs full.
 *
 * The answer is settled per turn and holds for the whole turn: the tool list, the skills, the
 * slash reminders, the runtime note and the dispatcher all answer to the one decision
 * (`SessionRunner.leanFor`, and the turn's captured locality in dispatch). The registry helpers
 * take the raw locality and apply this switch themselves; `skill.ts` trusts the finished decision.
 *
 * Lives in its own module so both prompts.ts and tool/registry.ts can import
 * it without creating a cycle (prompts.ts already imports schedulingOffered
 * from registry.ts).
 */
export function leanMode(local?: boolean): boolean {
  const env = process.env.MCODE_LEAN
  if (env === "1") return true
  if (env === "0") return false
  return local === true
}
