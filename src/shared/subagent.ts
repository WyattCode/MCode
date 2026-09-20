import type { AssistantPart, Message, SubagentNotice, SubagentNoticeStatus } from "./protocol"

/**
 * subagents: what the server and the window both need to know about a
 * subagent's answer, its avatar, and the actions of the actor tool.
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

/**
 * The actor call's output: a line naming the subagent, then its final message
 * inside these tags. As MiMo's, the tag always carries a status - `unknown`
 * when the answer reported none - and the reported summary when there is one.
 */
export function subagentOutput(actorID: string, answer: string, status?: string, summary?: string): string {
  const said = summary?.replace(/\s+/g, " ").replace(/"/g, "'").trim()
  const open = `<actor_result status="${status ?? "unknown"}"${said ? ` summary="${said}"` : ""}>`
  return `actor_id: ${actorID}\n\n${open}\n${answer}\n</actor_result>`
}

/** The subagent's final message inside an actor call's output, or the output as it is. Calls saved before the rename used other tags. */
export function subagentAnswer(output: string | undefined): string {
  const text = output ?? ""
  const found = /<(actor_result|subagent_result)[^>]*>\n?([\s\S]*?)\n?<\/\1>/.exec(text)
  return (found ? found[2]! : text).trim()
}

/** MiMo's four words a general subagent opens its final message with. */
export const RESULT_STATUSES = ["success", "partial", "failed", "blocked"] as const
export type ResultStatus = (typeof RESULT_STATUSES)[number]

/** The status and one-line summary a final message opens with, when it does. */
export function statusHeader(answer: string): { status: ResultStatus; summary: string } | undefined {
  const found = /^\s*\*\*Status\*\*:\s*(success|partial|failed|blocked)\b[^\n]*\n\s*\*\*Summary\*\*:\s*([^\n]+)/i.exec(answer)
  if (!found) return undefined
  return { status: found[1]!.toLowerCase() as ResultStatus, summary: found[2]!.trim() }
}

/** What a pill or a tab row shows of an answer: its summary line when it has one, else the answer. */
export function answerSummary(answer: string): string {
  return statusHeader(answer)?.summary ?? answer
}

/** The actor tool's actions, MiMo's seven. */
export const SUBAGENT_ACTIONS = ["run", "spawn", "status", "wait", "cancel", "send", "models"] as const

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number]

/**
 * A call's arguments as one flat object. The task and actor tools take
 * MiMo's `{ operation: { action, ... } }`; like MiMo's, they also accept the
 * fields written flat, and calls saved before the change are flat - so every
 * reader goes through this.
 */
export function operationInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {}
  const operation = input.operation
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return input
  const { operation: _wrapped, ...rest } = input
  return { ...rest, ...(operation as Record<string, unknown>) }
}

/**
 * A call's action; one that names none is a blocking run, which is all the tool
 * used to do.
 *
 * MiMo reads `background: true` or `async: true` on an action-less call as a
 * spawn before it falls back, and it is right to: the tool MCode renamed had a
 * `background` parameter of its own, so a saved record and a model's habit both
 * produce that shape - and falling back to `run` for it holds the whole
 * conversation up waiting for work that was asked for in the background.
 */
export function actorAction(input: Record<string, unknown> | undefined): SubagentAction {
  const flat = operationInput(input)
  const named = SUBAGENT_ACTIONS.find((action) => action === flat.action)
  if (named) return named
  return flat.background === true || flat.async === true ? "spawn" : "run"
}

/** Run and spawn start a subagent; the rest act on one that exists, or list models. */
export function launches(action: SubagentAction): boolean {
  return action === "run" || action === "spawn"
}

/** The subagent a status, wait, cancel or send call names. */
export function actorTarget(input: Record<string, unknown> | undefined): string {
  const flat = operationInput(input)
  const raw = flat.actor_id ?? flat.to_actor_id
  return typeof raw === "string" ? raw.trim() : ""
}

/* ------------------------------------------------ calls saved before the rename */

/** The task registry's verbs, which a subagent call never used. */
const REGISTRY_ACTIONS = new Set(["create", "list", "get", "start", "block", "unblock", "done", "abandon", "rename"])

/**
 * Whether a saved `task` call is a subagent call from before the tool was named
 * actor. The task tool that now has the name only ever takes registry verbs, and
 * the old one never did, so the two can be told apart by what was passed.
 */
export function isLegacySubagentCall(part: { type: string; name?: string; input?: Record<string, unknown> }): boolean {
  if (part.type !== "tool" || part.name !== "task") return false
  const input = operationInput(part.input)
  const action = input.action
  if (typeof action === "string") return !REGISTRY_ACTIONS.has(action)
  return ["subagent_type", "prompt", "description", "subagent_id"].some((key) => key in input)
}

/**
 * A saved part as it reads today: an old subagent call becomes an actor call,
 * with its fields under MiMo's names. The copy on disk is never rewritten.
 */
export function readLegacyPart<T extends AssistantPart>(part: T): T {
  if (part.type !== "tool" || !isLegacySubagentCall(part)) return part
  const { subagent_id: id, message, ...rest } = part.input ?? {}
  const send = rest.action === "send"
  const input: Record<string, unknown> = {
    ...rest,
    ...(typeof id === "string" ? (send ? { to_actor_id: id } : { actor_id: id }) : {}),
    ...(typeof message === "string" ? { content: message } : {}),
  }
  return { ...part, name: "actor", input }
}

/** A saved message as it reads today; the same object when nothing in it is old. */
export function readLegacyMessage<T extends Message>(message: T): T {
  if (message.role !== "assistant" || !message.parts.some((part) => part.type === "tool" && isLegacySubagentCall(part))) return message
  return { ...message, parts: message.parts.map((part) => readLegacyPart(part)) }
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
 * first line of; for a failure it is the error, and `partial` whatever answer
 * the subagent had given by then. An answer that reported failed or blocked is
 * said to have finished with that status, as MiMo's notice says it.
 */
export function noticeText(entries: { notice: SubagentNotice; result?: string; partial?: string }[]): string {
  const blocks = entries.map(({ notice, result, partial }) => {
    const who = `Background subagent "${notice.description}" (actor_id: ${notice.subagentID})`
    const head = `${who} ${SAID[notice.status]}.`
    const reported = notice.reported
    if (reported) {
      const settled = reported === "failed" || reported === "blocked" ? `${who} finished and reported ${reported}.` : `${who} completed.\nStatus: ${reported}`
      const summary = notice.summary ? `\nSummary: ${notice.summary}` : ""
      return `${settled}${summary}\nResult:\n${result ?? ""}`
    }
    if (notice.status === "completed") return `${head}\nResult:\n${result ?? notice.summary ?? ""}`
    if (notice.status === "failed") return `${head}\nError: ${result ?? notice.summary ?? "unknown"}${partial ? `\nPartial result:\n${partial}` : ""}`
    if (notice.status === "stalled") {
      const quiet = notice.quietSeconds === undefined ? "" : ` Nothing has happened in it for ${notice.quietSeconds}s.`
      return `${head}${quiet} It is still running: check on it with status, send it a message, or cancel it.`
    }
    return head
  })
  return `<actor-notification>\n${blocks.join("\n\n")}\n</actor-notification>`
}
