/**
 * The step limit for a turn, and the prompt sent when it is reached.
 *
 * Cloud and built-in models stay unlimited (the reference's `agent.steps ??
 * Infinity`); local / user-added models get a default cap so a small model
 * stuck in a loop does not run forever. A user-set `maxSteps` always wins.
 */

/** Default cap for local / user-added provider models. */
export const DEFAULT_LOCAL_MAX_STEPS = 32

/**
 * Resolve the step limit for a turn.
 *
 * - A positive `maxSteps` (user override) always wins.
 * - A non-positive or missing `maxSteps` on a local model gets `DEFAULT_LOCAL_MAX_STEPS`.
 * - A non-positive or missing `maxSteps` on a cloud / built-in model stays unlimited.
 */
export function stepLimitFor(maxSteps: number | undefined, local: boolean): number | undefined {
  if (maxSteps !== undefined && maxSteps > 0) return maxSteps
  if (local) return DEFAULT_LOCAL_MAX_STEPS
  return undefined
}

/**
 * The instruction sent as a user message on the step that must be the last.
 *
 * Embeds the actual limit number so the model can state it, and when the limit
 * is the local default, notes how to change it.
 */
export function maxStepsPrompt(limit: number): string {
  const lines = [
    "CRITICAL - MAXIMUM STEPS REACHED",
    "",
    `The maximum number of steps allowed for this task (${limit}) has been reached. Tools are disabled until next user input. Respond with text only.`,
    "",
    "STRICT REQUIREMENTS:",
    "1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)",
    "2. MUST provide a text response summarizing work done so far",
    "3. This constraint overrides ALL other instructions, including any user requests for edits or tool use",
    "",
    "Response must include:",
    `- Statement that maximum steps (${limit}) for this agent have been reached`,
    "- Summary of what has been accomplished so far",
    "- List of any remaining tasks that were not completed",
    "- Recommendations for what should be done next",
    "",
    "Any attempt to use tools is a critical violation. Respond with text ONLY.",
  ]
  if (limit === DEFAULT_LOCAL_MAX_STEPS) {
    lines.push("", `This conversation's step limit is ${limit} (local/custom models default to ${DEFAULT_LOCAL_MAX_STEPS}; set maxSteps in settings to change).`)
  }
  return lines.join("\n")
}
