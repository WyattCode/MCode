import type { AssistantMessage, AssistantPart, Message, ToolPart, UserMessage } from "@shared/protocol"

/**
 * The stored transcript as MiMo shapes it for a provider, in the request only.
 *
 * Every adapter reads its history through this, so the three wire formats
 * agree on the same three rules:
 *
 *  - a tool call that never finished - the turn was stopped, or the app closed
 *    under it - is answered as interrupted rather than dropped, so the model
 *    still sees what it had asked for;
 *  - a user message with nothing to send says "Continue." instead of vanishing;
 *  - a conversation that ends on the model's own words, with no call waiting
 *    on a result, gets a trailing "Continue." from the user, since a request
 *    ending on an assistant message is a prefill to some providers;
 *  - a reply the output limit cut while it was only thinking is sent as where
 *    that thinking had got to (`thoughtDigest`), not dropped as empty.
 */

/** What a call that never finished reads as to the model. */
export const INTERRUPTED_RESULT = "[Tool execution was interrupted]"

/** What a call left unfinished is stored as once the next prompt settles it. */
export const ABORTED_TOOL = "Tool execution aborted"

const CONTINUE = "Continue."

/** How much of a cut-off thinking goes back to the model: some of its opening, more of where it had got to. */
const THOUGHT_HEAD = 1_500
const THOUGHT_TAIL = 6_000

/**
 * A model never reads its own thinking back - providers drop it from the
 * history - so a reply cut at the output limit while it was still thinking
 * looked empty, and the next step planned the whole thing again from nothing.
 * Its opening and the end it reached go back as the reply's text instead, in
 * the request only (reminders.ts THOUGHT_LENGTH_NOTE says to act on it).
 */
export function thoughtDigest(thinking: string): string {
  const text = thinking.trim()
  const kept = text.length <= THOUGHT_HEAD + THOUGHT_TAIL ? text : `${text.slice(0, THOUGHT_HEAD)}\n[…]\n${text.slice(-THOUGHT_TAIL)}`
  return `[My thinking so far - cut off at the output limit before I wrote anything]\n${kept}`
}

/** A reply that reached the output limit with only thinking in it. */
function cutWhileThinking(message: AssistantMessage): boolean {
  return (
    message.finish === "max_tokens" &&
    !message.parts.some((part) => part.type === "tool" || (part.type === "text" && part.text.trim() !== "")) &&
    message.parts.some((part) => part.type === "reasoning" && part.text.trim() !== "")
  )
}

function unfinished(part: ToolPart): boolean {
  return part.status === "pending" || part.status === "running"
}

/** A call stored as interrupted that had already produced output hands the model that output. */
function interruptedWithOutput(part: ToolPart): boolean {
  return part.status === "error" && part.metadata?.interrupted === true && typeof part.output === "string" && part.output !== ""
}

function settled(part: AssistantPart): AssistantPart {
  if (part.type !== "tool") return part
  if (unfinished(part)) return { ...part, status: "error", error: INTERRUPTED_RESULT }
  if (interruptedWithOutput(part)) return { ...part, status: "completed" }
  return part
}

function sendable(message: UserMessage): boolean {
  return Boolean(message.text.trim() || message.attachments?.length || message.annotations?.length)
}

/** Whether an assistant message says anything or asks for anything. */
function spoken(message: AssistantMessage): boolean {
  return message.parts.some((part) => (part.type === "text" && part.text.trim() !== "") || part.type === "tool")
}

export function requestHistory(messages: Message[]): Message[] {
  const out: Message[] = messages.map((message) => {
    if (message.role === "user") return sendable(message) ? message : { ...message, text: CONTINUE }
    if (cutWhileThinking(message)) {
      const thinking = message.parts.map((part) => (part.type === "reasoning" ? part.text : "")).join("\n")
      return { ...message, parts: [{ type: "text", text: thoughtDigest(thinking) }] as AssistantPart[] }
    }
    if (!message.parts.some((part) => part.type === "tool" && (unfinished(part) || interruptedWithOutput(part)))) return message
    return { ...message, parts: message.parts.map(settled) }
  })

  // A trailing reply with nothing in it is dropped; one with words but no calls is answered.
  while (out.length) {
    const last = out[out.length - 1]!
    if (last.role !== "assistant" || spoken(last)) break
    out.pop()
  }
  const last = out[out.length - 1]
  if (last?.role === "assistant" && !last.parts.some((part) => part.type === "tool")) {
    out.push({ id: `${last.id}:continue`, sessionID: last.sessionID, role: "user", text: CONTINUE, attachments: [], time: { created: last.time.created } })
  }
  return out
}
