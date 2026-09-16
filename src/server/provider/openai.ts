import type { Message, ModelModalities, Usage } from "@shared/protocol"
import { TOOL_MEDIA_NOTE, attachmentParts, type WirePart } from "./attachment-parts"
import { userText } from "@shared/annotations"
import type { ToolDefinition } from "../tool/types"
import type { Emit, ProviderAdapter, ToolCall, TurnOutcome, TurnRequest } from "./types"
import { ProviderError, ProviderHttpError, headersOf, isHtmlBody, systemText, wireOfBody } from "./types"
import { requestHistory } from "./history"
import { guarded, stallGuard } from "./stall"

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

interface ChunkUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/**
 * A chat-completions usage frame in MiMo's terms: fresh input apart from the
 * cached tokens `prompt_tokens` includes. OpenRouter, which MiMo reaches with
 * its own SDK, also reports cache writes and reasoning, and its output is then
 * counted without the reasoning; every other server gets the plain split.
 */
export function usageOf(reported: ChunkUsage, provider: string): Omit<Usage, "cost"> {
  const prompt = reported.prompt_tokens ?? 0
  const completion = reported.completion_tokens ?? 0
  const cacheRead = reported.prompt_tokens_details?.cached_tokens ?? 0
  if (provider !== "openrouter") return { input: prompt - cacheRead, output: completion, reasoning: 0, cacheRead, cacheWrite: 0 }
  const cacheWrite = reported.prompt_tokens_details?.cache_write_tokens ?? 0
  const reasoning = reported.completion_tokens_details?.reasoning_tokens ?? 0
  return { input: prompt - cacheRead - cacheWrite, output: completion - reasoning, reasoning, cacheRead, cacheWrite }
}

interface Chunk {
  choices?: { delta?: Delta; finish_reason?: string | null }[]
  usage?: ChunkUsage
  /** Sent inside a 200 stream by providers that fail after the headers. */
  error?: { message?: string; code?: unknown; type?: unknown } | string
}

function toolSchemas(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

/** One piece of media as this wire carries it, wherever it is placed; the text pieces are placed by the caller. */
function chatMedia(part: Exclude<WirePart, { kind: "text" }>): Record<string, unknown> {
  return part.kind === "image"
    ? { type: "image_url", image_url: { url: `data:${part.mime};base64,${part.data}` } }
    : part.kind === "pdf"
      ? { type: "file", file: { filename: part.name, file_data: `data:application/pdf;base64,${part.data}` } }
      : part.kind === "audio"
        ? { type: "input_audio", input_audio: { data: part.data, format: part.format } }
        : { type: "video_url", video_url: { url: `data:${part.kind === "video" ? part.mime : ""};base64,${part.data}` } }
}

/**
 * Flattens the stored transcript into chat messages. Tool results become
 * `role: "tool"` entries keyed by call id, which is what this format expects
 * in place of Anthropic's batched tool_result blocks.
 */
export function toMessages(system: string, history: Message[], inputs?: Partial<ModelModalities>, interleaved?: string) {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }]

  for (const message of requestHistory(history)) {
    if (message.role === "user") {
      // MiMo's parts: media the model reads go natively, anything else as text or a note.
      const parts = attachmentParts(message.attachments ?? [], inputs, "chat")
      const media = parts.filter((part) => part.kind !== "text")
      const text = [...parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])), userText(message)].filter(Boolean).join("\n\n")

      /*
       * A plain string while there is no media: the multipart form is
       * understood by far fewer of the servers that speak this format,
       * and there is no reason to reach for it when there is only text.
       */
      if (media.length) {
        out.push({
          role: "user",
          content: [
            ...(text ? [{ type: "text", text }] : []),
            ...media.map(chatMedia),
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

    // MiMo's interleaved reasoning: a model that reads its reasoning back gets it in its own field.
    const reasoning = interleaved
      ? message.parts
          .filter((part) => part.type === "reasoning")
          .map((part) => (part.type === "reasoning" ? part.text : ""))
          .join("")
          .trim()
      : ""

    if (text || calls.length) {
      out.push({
        role: "assistant",
        ...(interleaved && reasoning ? { [interleaved]: reasoning } : {}),
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
      /*
       * MiMo's tool media. A tool message on this wire takes text and nothing
       * else, so the result keeps the words - the notes for anything the model
       * cannot read among them - and what it can read follows as a message of
       * its own, which is the only place this format has for a picture.
       */
      const pieces = part.status === "error" ? [] : attachmentParts(part.attachments ?? [], inputs, "chat")
      const said = part.status === "error" ? (part.error ?? "Tool failed") : (part.output ?? "")
      const notes = pieces.flatMap((piece) => (piece.kind === "text" ? [piece.text] : []))
      out.push({ role: "tool", tool_call_id: part.callID, content: [said, ...notes].filter(Boolean).join("\n\n") })
      const carried = pieces.filter((piece) => piece.kind !== "text")
      if (carried.length) out.push({ role: "user", content: [{ type: "text", text: TOOL_MEDIA_NOTE }, ...carried.map(chatMedia)] })
    }
  }

  return out
}

const MAX_TOKENS = 32_000

/** Whether MiMo puts cache marks on a chat-completions request: Claude reached through OpenRouter or Alibaba. */
export function cacheMarked(provider: string, modelID: string): boolean {
  return (provider === "openrouter" || provider === "dashscope") && /claude|anthropic/i.test(modelID)
}

/**
 * MiMo's marks on such a request: the last part of each of the last two
 * messages after the system prompt, where that message is made of parts - a
 * plain string carries none, as in MiMo - and the last tool definition.
 */
export function withCacheMarks(messages: Record<string, unknown>[], tools: Record<string, unknown>[]): void {
  const mark = { type: "ephemeral" }
  for (const message of messages.filter((entry) => entry.role !== "system").slice(-2)) {
    const content = message.content
    if (!Array.isArray(content) || content.length === 0) continue
    content[content.length - 1] = { ...(content[content.length - 1] as Record<string, unknown>), cache_control: mark }
  }
  if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: mark }
}

export const OpenAICompatible: ProviderAdapter = {
  async stream(request: TurnRequest, emit: Emit): Promise<TurnOutcome> {
    const root = (request.baseURL ?? "").replace(/\/+$/, "")
    if (!root) throw new Error("This provider has no base URL configured")

    const messages = toMessages(systemText(request), request.history, request.inputs, request.interleaved)
    const tools: Record<string, unknown>[] = toolSchemas(request.tools)
    if (cacheMarked(request.model.provider, request.model.model)) withCacheMarks(messages, tools)

    // MiMo's stall timeout: a stream that goes quiet for 480s is cut off and retried.
    const guard = stallGuard(request.signal, false)
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
        // MiMo keeps a conversation's requests together with this header.
        ...(request.sessionID ? { "x-session-affinity": request.sessionID } : {}),
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
      signal: guard.signal,
      body: JSON.stringify({
        model: request.model.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.maxOutput ?? MAX_TOKENS,
        messages,
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
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
        // MiMo's family sampling; top-k is not a chat-completions field, so it stays off this wire.
        ...(request.sampling?.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
        ...(request.sampling?.topP !== undefined ? { top_p: request.sampling.topP } : {}),
        ...request.extra,
      }),
    }).catch((err: unknown) => {
      guard.dispose()
      throw guard.failure(err)
    })

    if (!response.ok || !response.body) {
      guard.dispose()
      const detail = await response.text().catch(() => "")
      // The status and headers travel with the failure: a rate limit's retry-after decides the wait.
      throw new ProviderHttpError(describeHttp(response.status, detail), response.status, headersOf(response), wireOfBody(detail))
    }
    guard.alive()

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
    let usage: Omit<Usage, "cost"> = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

    for await (const data of guarded(sse(response.body, request.signal), guard)) {
      if (data === "[DONE]") break
      let chunk: Chunk
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }

      if (chunk.usage) usage = usageOf(chunk.usage, request.model.provider)

      if (chunk.error) throw describeStreamError(chunk.error)

      const choice = chunk.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finish = choice.finish_reason

      const delta = choice.delta
      if (!delta) continue

      const reasoning = delta.reasoning_content ?? delta.reasoning
      // Kept when it is shown, or when the model reads it back later (interleaved).
      if (reasoning && (request.showReasoning || request.interleaved)) {
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
        // taking down the turn, with the reason kept so the call can be refused.
        ...parseArguments(slot.args),
      }))

    return {
      // A content filter ending the reply is a refusal, as MiMo's ContentFilterError is.
      stop: toolCalls.length ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn",
      toolCalls,
      usage: { ...usage, cost: 0 },
      ...(finish ? { finishReason: finish } : {}),
    }
  },
}

function parseArguments(raw: string): { input: Record<string, unknown>; inputError?: string } {
  if (!raw.trim()) return { input: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { input: parsed as Record<string, unknown> }
      : { input: {}, inputError: "the arguments were not a JSON object" }
  } catch (err) {
    return { input: {}, inputError: `the arguments were not valid JSON (${(err as Error).message})` }
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
function describeStreamError(error: { message?: string; code?: unknown; type?: unknown } | string): ProviderError {
  const wire =
    typeof error === "object" && error
      ? {
          ...(typeof error.code === "string" || typeof error.code === "number" ? { code: String(error.code) } : {}),
          ...(typeof error.type === "string" ? { type: error.type } : {}),
        }
      : {}
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
    return new ProviderError(message, "error.contextExceeded", { detail: message }, wire)
  }
  return new ProviderError(message || "The provider reported an error but gave no detail.", undefined, undefined, wire)
}

export function describeHttp(status: number, detail: string): string {
  const html = isHtmlBody(detail)
  const trimmed = html ? "" : detail.slice(0, 300)
  // MiMo's own answer for a page served in place of an answer on these two.
  if (html && (status === 401 || status === 403)) return "A gateway or proxy blocked this request."
  if (status === 401 || status === 403) return "Authentication failed - check the API key in Settings."
  if (status === 404) return `The provider does not recognise this model (404).${trimmed ? ` ${trimmed}` : ""}`
  if (status === 429) return "Rate limited by the provider. Wait a moment and try again."
  if (status >= 500) return `The provider returned ${status}. This is usually transient.`
  if (html) return `A gateway or proxy answered this request with a web page (${status}) rather than a reply.`
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
