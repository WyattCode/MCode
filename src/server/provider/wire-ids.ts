import type { AssistantMessage, Message, ModelRef } from "@shared/protocol"

/**
 * Tool-call ids as a provider will take them, in the request only - MiMo's
 * normalisation.
 *
 * A call id is whatever the provider that made it chose, and a conversation
 * can move between providers: an id another one wrote may carry characters
 * Claude refuses, and Mistral takes nine letters and digits and nothing else.
 * Mistral also refuses a tool result followed straight by a user message, so a
 * short assistant reply is put between the two. The stored transcript keeps
 * the ids it was given.
 */

function mistral(model: ModelRef): boolean {
  const id = model.model.toLowerCase()
  return model.provider === "mistral" || id.includes("mistral") || id.includes("devstral")
}

/** Claude's rule: anything but letters, digits, `_` and `-` becomes `_`. */
export function claudeCallID(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/** Mistral's rule: letters and digits only, the first nine, padded with zeros. */
export function mistralCallID(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 9).padEnd(9, "0")
}

export function forWire(history: Message[], model: ModelRef): Message[] {
  const rename = mistral(model) ? mistralCallID : model.model.toLowerCase().includes("claude") ? claudeCallID : undefined
  if (!rename) return history
  const out: Message[] = []
  history.forEach((message, index) => {
    if (message.role !== "assistant") {
      out.push(message)
      return
    }
    const renamed: AssistantMessage = {
      ...message,
      parts: message.parts.map((part) => (part.type === "tool" ? { ...part, callID: rename(part.callID) } : part)),
    }
    out.push(renamed)
    const answered = message.parts.some((part) => part.type === "tool")
    if (mistral(model) && answered && history[index + 1]?.role === "user") {
      out.push({
        id: `${message.id}:done`,
        sessionID: message.sessionID,
        role: "assistant",
        model: message.model,
        agent: message.agent,
        parts: [{ type: "text", id: `${message.id}:done-text`, text: "Done." }],
        time: message.time,
        finish: "end_turn",
      })
    }
  })
  return out
}
