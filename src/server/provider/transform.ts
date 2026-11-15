import type { AssistantMessage, Message, ModelRef, UserMessage } from "@shared/protocol"
import type { ToolDefinition } from "../tool/types"
import { schemaFor } from "./tool-schema"

const CONTINUE = "Continue."

function sendable(message: UserMessage): boolean {
  return Boolean(message.text.trim() || message.attachments?.length || message.annotations?.length)
}

/** Ciphertext can carry meaning without summary text; a pruned Anthropic signature cannot. */
function encrypted(part: AssistantMessage["parts"][number]): boolean {
  return part.type === "reasoning" && Boolean(
    (typeof part.native?.encrypted_content === "string" && part.native.encrypted_content) || (part.signature && part.itemID),
  )
}

function spoken(message: AssistantMessage): boolean {
  return message.parts.some((part) => (part.type === "text" && part.text.trim() !== "") || part.type === "tool" || encrypted(part))
}

/**
 * Request-only invariants, shared by every wire through requestHistory.
 * Empty blocks first, empty messages second, prefill last: no later filter can
 * erase the user turn that prevents a trailing assistant prefill. Tool parts
 * and empty results stay paired; signed Responses ciphertext stays replayable.
 */
export function transformMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const message of messages) {
    if (message.role === "user") {
      out.push(sendable(message) ? message : { ...message, text: CONTINUE })
      continue
    }
    const parts = message.parts.filter((part) => part.type === "tool" || part.text.trim() !== "" || encrypted(part))
    if (!parts.length) continue
    out.push(parts.length === message.parts.length ? message : { ...message, parts })
  }
  // Preserve the old history rule: trailing unsigned thinking alone is not an answer.
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

/**
 * Preserve optional arguments: Responses defaults omitted strict to true, so
 * explicitly opt out. Messages and generic compatible servers keep their own
 * defaults. Never expand required or rewrite additionalProperties for strict.
 */
export function transformTool(tool: Pick<ToolDefinition, "name" | "description" | "parameters">, model: ModelRef, wire: "anthropic" | "chat" | "responses") {
  return {
    name: tool.name,
    description: tool.description,
    parameters: schemaFor(model, tool.parameters),
    ...(wire === "responses" ? { strict: false } : {}),
  }
}
