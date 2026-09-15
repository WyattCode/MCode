import type { SubagentNotice, SubagentNoticeStatus } from "./protocol"

/**
 * subagents: what the server and the window both need to know about a
 * subagent's answer, its avatar, and the actions of the task tool.
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
export function subagentOutput(subagentID: string, answer: string, status?: "timeout"): string {
  const open = status ? `<subagent_result status="${status}">` : "<subagent_result>"
  return `subagent_id: ${subagentID}\n\n${open}\n${answer}\n</subagent_result>`
}

/** The subagent's final message inside a task call's output, or the output as it is. */
export function subagentAnswer(output: string | undefined): string {
  const text = output ?? ""
  const found = /<subagent_result[^>]*>\n?([\s\S]*?)\n?<\/subagent_result>/.exec(text)
  return (found ? found[1] : text).trim()
}

/** The task tool's actions, MiMo's seven. */
export const SUBAGENT_ACTIONS = ["run", "spawn", "status", "wait", "cancel", "send", "models"] as const

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number]

/** A call's action; one that names none is a blocking run, which is all the tool used to do. */
export function taskAction(input: Record<string, unknown> | undefined): SubagentAction {
  const raw = input?.action
  return SUBAGENT_ACTIONS.find((action) => action === raw) ?? "run"
}

/** Run and spawn start a subagent; the rest act on one that exists, or list models. */
export function launches(action: SubagentAction): boolean {
  return action === "run" || action === "spawn"
}

/** The subagent a status, wait, cancel or send call names. */
export function taskTarget(input: Record<string, unknown> | undefined): string {
  const raw = input?.subagent_id
  return typeof raw === "string" ? raw.trim() : ""
}

/** How background work is timed. MiMo's figures; the checks shorten them. */
export interface SubagentTimers {
  /** Nothing happening in a running subagent for longer than this is a stall. */
  stallMs: number
  /** Past this it is taken as abandoned rather than stalled, and not reported again. */
  abandonMs: number
  /** How often the watchdog looks. */
  scanMs: number
  /** How long run and wait hold on by default. */
  waitMs: number
}

export const SUBAGENT_TIMERS: SubagentTimers = {
  stallMs: 6 * 60_000,
  abandonMs: 10 * 60_000,
  scanMs: 45_000,
  waitMs: 600_000,
}

/** MiMo's liveness for a running subagent: quiet past the stall mark, but not yet past the abandon mark. */
export function isStalled(quietMs: number, timers: SubagentTimers): boolean {
  return quietMs > timers.stallMs && quietMs <= timers.abandonMs
}

/** A line short enough for a pill's title: the first one with anything on it. */
export function firstLine(text: string | undefined, max = 200): string | undefined {
  const line = (text ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean)
  return line ? line.slice(0, max) : undefined
}

const SAID: Record<SubagentNoticeStatus, string> = {
  completed: "completed",
  failed: "failed",
  cancelled: "was cancelled",
  stalled: "may be stalled",
  ended: "ended without a final message",
}

/**
 * What the parent's model reads about its background subagents, in MCode's own
 * words. `result` is the whole answer, which the notice itself carries only the
 * first line of.
 */
export function noticeText(entries: { notice: SubagentNotice; result?: string }[]): string {
  const blocks = entries.map(({ notice, result }) => {
    const head = `Background subagent "${notice.description}" (subagent_id: ${notice.subagentID}) ${SAID[notice.status]}.`
    if (notice.status === "completed") return `${head}\nResult:\n${result ?? notice.summary ?? ""}`
    if (notice.status === "failed") return `${head}\nError: ${result ?? notice.summary ?? "unknown"}`
    if (notice.status === "stalled") {
      const quiet = notice.quietSeconds === undefined ? "" : ` Nothing has happened in it for ${notice.quietSeconds}s.`
      return `${head}${quiet} It is still running: check on it with status, send it a message, or cancel it.`
    }
    return head
  })
  return `<subagent-notification>\n${blocks.join("\n\n")}\n</subagent-notification>`
}
