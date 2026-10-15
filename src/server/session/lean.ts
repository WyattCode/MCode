/**
 * Whether this turn runs the lean coding prompt and tool list.
 *
 * MCODE_LEAN "1" forces it on, "0" forces it off; with neither set, a local
 * (custom-provider) model gets the lean prompt by default.
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
