/**
 * subagents: what the server and the window both need to know about a
 * subagent's answer and its avatar.
 */

/** How many avatar tones there are, as in MiMo. */
export const SUBAGENT_TONES = 6

/**
 * Which avatar a subagent wears. A numbered general subagent takes the tone of
 * its number, so the first few in a conversation always look different; any
 * other name is hashed (FNV-1a) onto one, so the same name keeps its avatar.
 */
export function subagentTone(seed: string | undefined): number {
  const text = seed?.trim() ?? ""
  if (!text) return 0
  const numbered = /\bgeneral[-_ ]?([1-6])\b/i.exec(text)
  if (numbered) return Number(numbered[1]) - 1
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % SUBAGENT_TONES
}

/** The task call's output: a line naming the subagent, then its final message inside these tags. */
export function subagentOutput(sessionID: string, answer: string): string {
  return `subagent_id: ${sessionID}\n\n<subagent_result>\n${answer}\n</subagent_result>`
}

/** The subagent's final message inside a task call's output, or the output as it is. */
export function subagentAnswer(output: string | undefined): string {
  const text = output ?? ""
  const found = /<subagent_result>\n?([\s\S]*?)\n?<\/subagent_result>/.exec(text)
  return (found ? found[1] : text).trim()
}
