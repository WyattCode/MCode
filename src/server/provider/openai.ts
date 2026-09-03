import type { Message } from "@shared/protocol"
import type { ToolDefinition } from "../tool/types"
import type { Emit, ProviderAdapter, ToolCall, TurnOutcome, TurnRequest } from "./types"
import { ProviderError } from "./types"

/**
 * Adapter for OpenAI-compatible chat completions.
 *
 * Written against the wire format directly rather than through a client
 * library: the whole point of this path is that it serves a dozen providers
 * that each diverge slightly, so tolerating missing fields matters more than
 * having typed bindings.
 */

interface Delta {
  content?: string | null
  /** Several providers stream chain-of-thought under one of these names. */
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: {
    /** Omitted by servers that only ever emit one call per message. */
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }[]
}

interface Chunk {
  choices?: { delta?: Delta; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  /** Sent inside a 200 stream by providers that fail after the headers. */
  error?: { message?: string } | string
}

function toolSchemas(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

/**
 * Flattens the stored transcript into chat messages. Tool results become
 * `role: "tool"` entries keyed by call id, which is what this format expects
 * in place of Anthropic's batched tool_result blocks.
 */
export function toMessages(system: string, history: Message[]) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }]

  for (const message of history) {
    if (message.role === "user") {
      const attachments = message.attachments ?? []
      const images = attachments.filter((attachment) => attachment.mime.startsWith("image/"))
      const files = attachments
        .filter((attachment) => !attachment.mime.startsWith("image/"))
        .map((attachment) => `<file path="${attachment.path}">\n${attachment.data}\n</file>`)
      const text = [...files, message.text].filter(Boolean).join("\n\n")

      /*
       * A plain string while there are no images: the multipart form is
       * understood by far fewer of the servers that speak this format,
       * and there is no reason to reach for it when there is only text.
       */
      if (images.length) {
        out.push({
          role: "user",
          content: [
            ...(text ? [{ type: "text", text }] : []),
            ...images.map((image) => ({
              type: "image_url",
              image_url: { url: `data:${image.mime};base64,${image.data}` },
            })),
          ],
        })
      } else if (text) {
        out.push({ role: "user", content: text })
      }
      continue
    }

    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim()

    const calls = message.parts.filter(
      (part) => part.type === "tool" && (part.status === "completed" || part.status === "error"),
    )

    if (text || calls.length) {
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((part) =>
                part.type === "tool"
                  ? {
                      id: part.callID,
                      type: "function",
                      function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
                    }
                  : null,
              ),
            }
          : {}),
      })
    }

    for (const part of calls) {
      if (part.type !== "tool") continue
      out.push({
        role: "tool",
        tool_call_id: part.callID,
        content: part.status === "error" ? (part.error ?? "Tool failed") : (part.output ?? ""),
      })
    }
  }

  return out
}

const MAX_TOKENS = 32_000

export const OpenAICompatible: ProviderAdapter = {
  async stream(request: TurnRequest, emit: Emit): Promise<TurnOutcome> {
    const root = (request.baseURL ?? "").replace(/\/+$/, "")
    if (!root) throw new Error("This provider has no base URL configured")

    const response = await fetch(`${root}/chat/completions`, {
      method: "POST",
      headers: {
        /*
         * A custom provider's own headers, first, so that the two this call
         * cannot do without survive a collision. That is the reference's merge
         * order too: `{...providerHeaders(provider.options.headers),
         * ...input.headers}` at offset 22312491 - provider headers lose to the
         * request's, rather than being screened by a block-list.
         */
        ...request.headers,
        /*
         * Only when there is one. A provider whose credential lives in a header
         * has no key here, and writing `Bearer ` over the header the user typed
         * is how that provider's own authentication gets thrown away - the
         * reference has nothing to write in this case either, because the
         * bearer is the SDK's rendering of an apiKey it was never given.
         */
        ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
        "content-type": "application/json",
      },
      signal: request.signal,
      body: JSON.stringify({
        model: request.model.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: MAX_TOKENS,
        messages: toMessages(request.system, request.history),
        /*
         * The field the effort control has always meant and never sent.
         *
         * The reference emits exactly this for `@ai-sdk/openai-compatible`
         * (`{reasoningEffort: effort}`, which its SDK writes out as
         * `reasoning_effort`). It is withheld only where the caller has said
         * which levels the model accepts and this is not one of them - a model
         * with an empty list takes no effort parameter at all, and handing it
         * one is a field the provider will reject or drop. A caller that says
         * nothing gets the field, because sending it is what the control has
         * always claimed to do.
         */
        ...(request.variants && !request.variants.includes(request.effort)
          ? {}
          : { reasoning_effort: request.effort }),
        ...(request.tools.length ? { tools: toolSchemas(request.tools), tool_choice: "auto" } : {}),
      }),
    })

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "")
      throw new Error(describeHttp(response.status, detail))
    }

    // Blocks are indexed for the UI; text always occupies slot 0, reasoning 1,
    // since this format has no notion of interleaved blocks.
    let textOpen = false
    let reasoningOpen = false
    const pending = new Map<number, { id: string; name: string; args: string; announced: boolean }>()
    /**
     * Slot for a delta that carries no `index`.
     *
     * Servers that omit it send one call per message in the ordinary case, but
     * folding every such delta onto one slot concatenates two calls into a
     * nonsense third. A name starts a call; arguments continue the open one.
     * Counted down from -1 so these can never collide with a real index.
     */
    let anonymous = -1
    const slotFor = (call: { index?: number; function?: { name?: string } }): number => {
      if (call.index !== undefined) return call.index
      if (call.function?.name && pending.get(anonymous)?.name) anonymous--
      return anonymous
    }
    let finish: string | null = null
    let usage = { input: 0, output: 0 }

    for await (const data of sse(response.body, request.signal)) {
      if (data === "[DONE]") break
      let chunk: Chunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }

      if (chunk.usage) {
        usage = {
          input: chunk.usage.prompt_tokens ?? usage.input,
          output: chunk.usage.completion_tokens ?? usage.output,
        }
      }

      if (chunk.error) throw describeStreamError(chunk.error)

      const choice = chunk.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finish = choice.finish_reason

      const delta = choice.delta
      if (!delta) continue

      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (reasoning && request.showReasoning) {
        if (!reasoningOpen) {
          reasoningOpen = true
          emit({ type: "reasoning.start", index: 1 })
        }
        emit({ type: "reasoning.delta", index: 1, text: reasoning })
      }

      if (delta.content) {
        if (reasoningOpen) {
          reasoningOpen = false
          emit({ type: "block.end", index: 1 })
        }
        if (!textOpen) {
          textOpen = true
          emit({ type: "text.start", index: 0 })
        }
        emit({ type: "text.delta", index: 0, text: delta.content })
      }

      for (const call of delta.tool_calls ?? []) {
        const at = slotFor(call)
        const slot = pending.get(at) ?? { id: "", name: "", args: "", announced: false }
        if (call.id) slot.id = call.id
        if (call.function?.name) slot.name += call.function.name
        if (call.function?.arguments) slot.args += call.function.arguments
        pending.set(at, slot)

        // Announce as soon as the name is complete so the card appears while
        // the arguments are still streaming.
        if (!slot.announced && slot.name && slot.id) {
          slot.announced = true
          emit({ type: "tool", callID: slot.id, name: slot.name })
        }
      }
    }

    if (reasoningOpen) emit({ type: "block.end", index: 1 })
    if (textOpen) emit({ type: "block.end", index: 0 })

    // A stream that carried no reply and no stated reason is a failure the
    // provider did not name. Reporting it as a finished turn hides the fault.
    if (!textOpen && !pending.size && finish === null) {
      throw new ProviderError("The provider closed the connection without sending a reply.", "error.noReply")
    }

    let unnamed = 0
    const toolCalls: ToolCall[] = [...pending.values()]
      .filter((slot) => slot.name)
      .map((slot) => ({
        // An id only has to pair a call with its result, so one made up here
        // serves; dropping the call because the server sent none does not.
        callID: slot.id || `call_${++unnamed}`,
        name: slot.name,
        // Arguments arrive as a JSON string in fragments; a provider that
        // truncates mid-object should surface as an empty input rather than
        // taking down the turn.
        input: parseArguments(slot.args),
      }))

    return {
      stop: toolCalls.length ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn",
      toolCalls,
      usage: { ...usage, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    }
  },
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Pulls a usable sentence out of a streamed error.
 *
 * These arrive nested: a gateway wraps the engine's JSON in its own `message`
 * string, sometimes twice. The innermost message is the one that says what
 * actually went wrong, so it is the one worth showing.
 */
/**
 * Turns a streamed error into one the interface can show.
 *
 * These arrive nested: a gateway wraps the engine's JSON in its own `message`
 * string, sometimes twice. The innermost message is the one that says what
 * actually went wrong, so it is the one worth keeping.
 */
function describeStreamError(error: { message?: string } | string): ProviderError {
  // Nothing here is guaranteed to be a string, and calling a string method on
  // whatever arrived would replace the provider's error with a TypeError.
  const raw =
    typeof error === "string"
      ? error
      : typeof error?.message === "string"
        ? error.message
        : error
          ? JSON.stringify(error)
          : ""
  let message = raw
  // Each pass unwraps one layer of embedded JSON.
  for (const match of raw.matchAll(/"message"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      const inner = JSON.parse(match[1]) as string
      if (inner.trim()) message = inner
    } catch {
      // Keep the outer text rather than losing the error entirely.
    }
  }
  message = message.trim()

  /*
   * Local runtimes load a context far smaller than the model supports, and the
   * limit is only reached once tool output has piled up - by which point the
   * cause is not obvious from the conversation. The advice is the app's, so the
   * app phrases it; the numbers are the provider's, so they are passed through.
   */
  if (/context (size|length|window)/i.test(message)) {
    return new ProviderError(message, "error.contextExceeded", { detail: message })
  }
  return new ProviderError(message || "The provider reported an error but gave no detail.")
}

function describeHttp(status: number, detail: string): string {
  const trimmed = detail.slice(0, 300)
  if (status === 401 || status === 403) return "Authentication failed - check the API key in Settings."
  if (status === 404) return `The provider does not recognise this model (404). ${trimmed}`
  if (status === 429) return "Rate limited by the provider. Wait a moment and try again."
  if (status >= 500) return `The provider returned ${status}. This is usually transient.`
  return `Request failed (${status}). ${trimmed}`
}

/** Minimal SSE reader: yields the payload of each `data:` line. */
async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      if (signal.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith("data:")) yield line.slice(5).trim()
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}
