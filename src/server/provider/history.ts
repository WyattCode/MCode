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
 *    ending on an assistant message is a prefill to some providers.
 */

/** What a call that never finished reads as to the model. */
export const INTERRUPTED_RESULT = "[Tool execution was interrupted]"

/** What a call left unfinished is stored as once the next prompt settles it. */
export const ABORTED_TOOL = "Tool execution aborted"

const CONTINUE = "Continue."

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
