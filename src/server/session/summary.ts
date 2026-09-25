import path from "node:path"
import type { AssistantPart, Message, ToolPart } from "@shared/protocol"
import { reminder } from "./reminders"
import { estimateTokens } from "./estimate"

/**
 * Compaction as MiMo does it, in MCode's words.
 *
 * The conversation is replayed to the model as it stands - its own system
 * prompt, its tools, its messages - with one instruction added at the end,
 * so the request reads back from the cache the turns already wrote. The reply
 * replaces everything before it: the next request opens with the summary,
 * tagged with what set the compaction off, and a list of the files the
 * summarised part had been working on, so the model reads them again before
 * editing them.
 */

/** What set a compaction off: the user's button, the count crossing the line at a turn's start, or a request too large for the model. */
export type CompactionTrigger = "manual" | "automatic" | "provider-overflow"

/** The instruction appended to the replayed conversation. */
export const SUMMARY_INSTRUCTION = [
  "Stop working on the task for a moment: this conversation is about to be compacted, and your reply will replace everything above it.",
  "Write a summary another agent can carry on from, with exactly these sections:",
  "",
  "## Task overview",
  "What the user asked for, and what finished looks like.",
  "",
  "## Current state",
  "What is done, which files were created or changed, and what came out of it.",
  "",
  "## Discoveries",
  "Constraints, decisions and their reasons, errors met, and approaches that did not work.",
  "",
  "## Next steps",
  "What to do next, anything in the way, and in what order.",
  "",
  "## Context to preserve",
  "The user's preferences, details of the domain, and anything promised to the user.",
  "",
  "Keep exact paths, names, commands and error text, and be brief. Do not call any tool. Put the whole summary between <summary> and </summary>.",
].join("\n")

/** The summary inside its tags, or the reply as it came when the tags were left off. */
export function extractSummary(text: string): string {
  const found = /<summary>([\s\S]*?)<\/summary>/i.exec(text)
  return (found ? found[1]! : text.replace(/<\/?summary>/gi, "")).trim()
}

/**
 * Whether a reply is a summary at all.
 *
 * A model that carries on with the task instead of summarising it returns a
 * sentence, and accepting that would replace the whole conversation with it.
 * The first section's heading is the plainest sign the instruction was
 * followed; three or more second-level headings count as well, for a model
 * that translates them.
 */
export function isSummary(text: string): boolean {
  if (/^\s*##\s*Task overview\b/im.test(text)) return true
  return (text.match(/^\s*##\s+\S/gm) ?? []).length >= 3
}

/** MiMo's `COMPACTION_TOOL_RESULT_LIMIT`: a completed tool result larger than this is not replayed in full. */
export const COMPACTION_TOOL_RESULT_LIMIT = 8_000

/** What stands in for a result too large to replay, in MCode's words. */
export function shrunkResult(name: string, tokens: number): string {
  return `[MCode left this ${name} result out of the compaction to make the request fit: about ${tokens} tokens. Run ${name} again if you need it.]`
}

/**
 * The conversation as the summary request should replay it, with the largest
 * tool results stood down (MiMo's `shrinkLargeToolResults`).
 *
 * Compaction happens exactly when a conversation has outgrown its model, and
 * until now the request that asked for the summary replayed that conversation
 * in full - so the one request most likely to be refused for length was also
 * the largest one MCode ever sent. Anything over the limit becomes a line
 * naming the tool and roughly what it cost, which is enough for a summary and
 * cheap enough to send.
 *
 * Request-only: nothing here is written back, so the transcript still holds
 * every result whole and the summary is the only thing built from the short
 * form. Only completed results are touched - a failed call's message is short
 * and is usually the very thing worth summarising.
 */
export function shrinkLargeToolResults(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message
    if (!message.parts.some((part) => part.type === "tool" && part.status === "completed" && estimateTokens(part.output) > COMPACTION_TOOL_RESULT_LIMIT)) {
      return message
    }
    const parts: AssistantPart[] = message.parts.map((part) => {
      if (part.type !== "tool" || part.status !== "completed") return part
      const tokens = estimateTokens(part.output)
      if (tokens <= COMPACTION_TOOL_RESULT_LIMIT) return part
      return { ...part, output: shrunkResult(part.name, tokens), attachments: [] }
    })
    return { ...message, parts }
  })
}

/** MiMo keeps the five files most recently worked on, and each one's last three events. */
const MANIFEST_FILES = 5
const MANIFEST_EVENTS = 3

function eventOf(part: ToolPart): string | undefined {
  const input = part.input ?? {}
  if (part.name === "read") {
    const offset = typeof input.offset === "number" ? input.offset : undefined
    const limit = typeof input.limit === "number" ? input.limit : undefined
    if (offset !== undefined && limit !== undefined) return `read: lines ${offset}-${offset + limit - 1}`
    if (offset !== undefined && offset > 1) return `read: from line ${offset}`
    return "read: full"
  }
  if (part.name === "write") return part.metadata?.created === true ? "written" : "edited"
  if (part.name === "edit") return input.old_string === "" ? "written" : "edited"
  return undefined
}

/**
 * The files the summarised conversation touched, newest last: each as a path
 * inside the project with forward slashes, followed by what happened to it.
 */
export function touchedFiles(messages: readonly Message[], directory: string): string[] {
  const order: string[] = []
  const events = new Map<string, string[]>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      const named = part.type === "tool" ? part.input?.file_path : undefined
      if (part.type !== "tool" || part.status !== "completed" || typeof named !== "string") continue
      const event = eventOf(part)
      if (!event) continue
      const absolute = path.resolve(directory, named)
      const inside = path.relative(directory, absolute)
      const file = (inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? inside : absolute).split(path.sep).join("/")
      events.set(file, [...(events.get(file) ?? []), event].slice(-MANIFEST_EVENTS))
      const at = order.indexOf(file)
      if (at >= 0) order.splice(at, 1)
      order.push(file)
    }
  }
  return order.slice(-MANIFEST_FILES).map((file) => `${file}: ${(events.get(file) ?? []).join(" then ")}`)
}

/** What the next request opens with in place of the summarised conversation. */
export function compactedText(compacted: { summary: string; trigger?: CompactionTrigger; files?: readonly string[] }): string {
  const wrapper = [
    `<compacted-context trigger="${compacted.trigger ?? "manual"}">`,
    "The earlier part of this conversation was compacted into the summary below; nothing else arrived while it was being written.",
    "",
    compacted.summary,
    "</compacted-context>",
  ].join("\n")
  if (!compacted.files?.length) return wrapper
  return [
    wrapper,
    "",
    "# Attachments",
    "These files were worked on before the compaction. Their contents are no longer in the conversation, so read a file again before editing it:",
    ...compacted.files.map((file) => `- ${file}`),
  ].join("\n")
}

/** MiMo's continue message after a compaction nothing was re-posted after. Request only. */
export function continueNote(trigger: CompactionTrigger): string {
  const base = "The conversation was just compacted. If the summary lists next steps, carry on with them; if it is not clear what to do next, ask the user."
  return reminder(
    trigger === "provider-overflow"
      ? `Attached files were left out of the compaction to make the conversation fit; if the user sends large files, suggest smaller ones. ${base}`
      : base,
  )
}

/** How much of a request these messages make, by the same four-characters-to-a-token reckoning as everything else here. */
export function messagesTokens(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) {
    if (message.role === "user") {
      total += estimateTokens(message.text)
      continue
    }
    for (const part of message.parts) {
      if (part.type === "text" || part.type === "reasoning") total += estimateTokens(part.text)
      else if (part.type === "tool") total += estimateTokens(JSON.stringify(part.input ?? {})) + estimateTokens(part.output)
    }
  }
  return total
}

/**
 * The size of the next request after a compaction, before it is sent.
 *
 * Worked out as the share the new request is of the one just sent, both by the
 * same estimate, and applied to what the provider reported for the one just
 * sent. The part the two share - system prompt and tools, which are most of a
 * small conversation's request - is then counted by the provider's own
 * tokenizer rather than by characters; only the part that changed is estimated.
 * With nothing reported, the estimate is used as it is.
 *
 * @param fixed what both requests carry: the system prompt and the tools
 * @param sent the compaction request's own messages
 * @param next the messages the next request opens with
 * @param reported what the provider counted for the compaction request's input
 */
export function nextRequestEstimate(fixed: number, sent: number, next: number, reported: number): number {
  const before = fixed + sent
  const after = fixed + next
  if (reported > 0 && before > 0) return Math.max(0, Math.round((reported * after) / before))
  return after
}
