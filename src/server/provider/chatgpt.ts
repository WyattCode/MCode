import { transformTool } from "./transform"
import { refuseRedirect } from "./redirect"
import type { Message, ModelModalities, ModelRef } from "@shared/protocol"
import { TOOL_MEDIA_NOTE, attachmentParts, type WirePart } from "./attachment-parts"
import { userText } from "@shared/annotations"
import type { ToolDefinition } from "../tool/types"
import type { Emit, ProviderAdapter, ToolCall, TurnOutcome, TurnRequest } from "./types"
import { ProviderError, ProviderHttpError, headersOf, isHtmlBody, systemText, wireOfBody } from "./types"
import { requestHistory } from "./history"
import { USER_AGENT } from "../auth/oauth"
import { guarded, stallGuard } from "./stall"
import { readData } from "./sse"
import { parseToolArguments } from "../tool/repair"

/**
 * Adapter for a ChatGPT subscription, served by the Codex backend.
 *
 * This is not the metered API with a different key. The endpoint speaks the
 * Responses shape - a flat `input` list of items rather than chat messages,
 * tool results posted back as `function_call_output` items, and named SSE
 * events instead of choice deltas - so it needs its own adapter rather than a
 * base URL swap on the chat-completions one.
 *
 * Authorisation is the OAuth access token plus the workspace id taken from the
 * id_token, which the backend rejects the request without.
 */

interface StreamEvent {
  type?: string
  delta?: string
  item?: {
    type?: string
    name?: string
    call_id?: string
    arguments?: string
    /** A reasoning item's own id, and the ciphertext `include` asked for. */
    id?: string
    encrypted_content?: string
  }
  /** Present on `error` frames; `response.failed` nests it under `response`. */
  message?: string
  code?: string
  error?: { message?: string; code?: string; type?: string }
  response?: {
    error?: { message?: string }
    /** Why a response came back incomplete: the output ceiling, or the content filter. */
    incomplete_details?: { reason?: string }
    usage?: {
      input_tokens?: number
      output_tokens?: number
      /** Reasoning is billed inside output_tokens but reported separately. */
      output_tokens_details?: { reasoning_tokens?: number }
      input_tokens_details?: { cached_tokens?: number }
    }
    status?: string
  }
}

function toolSchemas(tools: ToolDefinition[], model: ModelRef) {
  return tools.map((tool) => ({
    type: "function" as const,
    ...transformTool(tool, model, "responses"),
  }))
}

/**
 * Flattens the stored transcript into Responses input items.
 *
 * Assistant tool calls and their results have to stay paired and in order, or
 * the backend rejects the turn - the same constraint as the other adapters,
 * expressed with different item types.
 */
/** One piece of media as this wire carries it; it takes pictures and PDFs and nothing else. */
function responsesMedia(part: WirePart): Record<string, unknown>[] {
  return part.kind === "image"
    ? [{ type: "input_image", image_url: `data:${part.mime};base64,${part.data}` }]
    : part.kind === "pdf"
      ? [{ type: "input_file", filename: part.name, file_data: `data:application/pdf;base64,${part.data}` }]
      : []
}

export function toInput(history: Message[], inputs?: Partial<ModelModalities>, model?: ModelRef): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []

  for (const message of requestHistory(history, inputs, model)) {
    if (message.role === "user") {
      // MiMo's parts: a picture the model reads goes natively; every other attachment is named by path in the turn's blocks.
      const parts = attachmentParts(message.attachments ?? [], inputs, "responses", "user")
      const text = [...parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])), userText(message)].filter(Boolean).join("\n\n")
      const content = [
        ...(text ? [{ type: "input_text", text }] : []),
        ...parts.flatMap(responsesMedia),
      ]
      if (content.length) out.push({ type: "message", role: "user", content })
      continue
    }

    /*
     * The thinking, handed back before the words and the calls it led to,
     * which is the order the model produced them in.
     *
     * Two filters, both MiMo's. It only returns thinking to the model that
     * wrote it, as the Anthropic path does. And because nothing is stored
     * server-side (`store: false`), a reasoning item is only sendable with its
     * `encrypted_content`: MiMo drops every reasoning item without one rather
     * than sending a summary the backend cannot verify.
     */
    const sameModel = Boolean(model && message.model.provider === model.provider && message.model.model === model.model)
    for (const part of message.parts) {
      if (part.type !== "reasoning" || !sameModel) continue
      const encrypted = typeof part.native?.encrypted_content === "string" ? part.native.encrypted_content : part.signature
      const itemID = typeof part.native?.id === "string" ? part.native.id : part.itemID
      if (!encrypted) continue
      out.push({
        type: "reasoning",
        ...(itemID ? { id: itemID } : {}),
        encrypted_content: encrypted,
        summary: part.text.trim() ? [{ type: "summary_text", text: part.text }] : [],
      })
    }

    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim()
    if (text) {
      out.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      })
    }

    for (const part of message.parts) {
      if (part.type !== "tool") continue
      // A call that never finished arrives here already answered as interrupted (see history.ts).
      out.push({
        type: "function_call",
        call_id: part.callID,
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      })
      /*
       * MiMo's tool media: this wire's function output takes text only, so what
       * the model can read follows the result as a message of its own.
       */
      const pieces = part.status === "error" ? [] : attachmentParts(part.attachments ?? [], inputs, "responses")
      const notes = pieces.flatMap((piece) => (piece.kind === "text" ? [piece.text] : []))
      const carried = pieces.flatMap(responsesMedia)
      out.push({
        type: "function_call_output",
        call_id: part.callID,
        /*
         * A tool that failed keeps whatever it had already produced. Bash
         * streams stdout as it arrives, and the runner puts that on `output`,
         * so a command that was killed by its timeout or by Stop still carries
         * a plausible-looking transcript of a run that never finished. Sending
         * that alone tells the model the tool succeeded, and it acts on a half
         * result; sending an empty string tells it nothing at all, which is
         * what a denied permission, a refused command or a missing file used to
         * come out as.
         *
         * A non-zero exit code is not this case: bash resolves that as a
         * completed call because the exit code and the output are the answer,
         * and it keeps `output` here.
         */
        output: [part.status === "error" ? (part.error ?? "Tool failed") : (part.output ?? ""), ...notes].filter(Boolean).join("\n\n"),
      })
      if (carried.length) out.push({ type: "message", role: "user", content: [{ type: "input_text", text: TOOL_MEDIA_NOTE }, ...carried] })
    }
  }

  return out
}

/**
 * The reasoning block of a Responses request, or nothing.
 *
 * The Codex backend speaks the Responses shape, which is what the reference's
 * `@ai-sdk/openai` arm targets: `{reasoningEffort: effort, reasoningSummary:
 * "auto", include: INCLUDE_ENCRYPTED_REASONING}` (node-BBwF64dM.js @22193900),
 * written out by its SDK as `reasoning: {effort, summary}`. Note the shape is
 * nothing like the Anthropic one beside it - there is no thinking budget here,
 * and no `output_config` - which is why the two adapters need separate
 * functions rather than one shared "send the effort" helper.
 *
 * The whole block goes when the model does not accept the level, not just the
 * `effort` field, because the reference has no half-entry to spread: a model
 * with no effort control gets `{}` from `variants` and so sends neither the
 * effort nor the summary request. That also matters at the wire: the Responses
 * API rejects a `reasoning` block on a model that does not reason at all.
 *
 * `summary` is `auto`, as the reference asks for it on every such request. This
 * app draws no thinking, but it has to have the thinking to know a step
 * produced nothing else (the think-only card), and to apply the rule that a
 * GPT model's reasoning-only reply is final.
 */
export function reasoningRequest(
  effort: string,
  variants: readonly string[] | undefined,
): { reasoning?: { effort: string; summary: "auto" } } {
  if (variants && !variants.includes(effort)) return {}
  return { reasoning: { effort, summary: "auto" } }
}

/**
 * The reference's `INCLUDE_ENCRYPTED_REASONING`.
 *
 * Nothing is kept server-side here (`store: false`), so a later step of the
 * same turn can only see the earlier steps' thinking if this request asks for
 * it and the next one sends it back. Without it a multi-step tool chain forgets
 * its own reasoning between steps, which is the one case OpenAI asks for these
 * items to be returned.
 */
const INCLUDE_ENCRYPTED_REASONING = ["reasoning.encrypted_content"]

/** Whether a model keeps its default verbosity: anything but a GPT-5.x that is not codex or chat. */
export function verbose(modelID: string): boolean {
  const id = modelID.toLowerCase()
  return !/(?:^|\/)gpt-5\.\d/.test(id) || id.includes("codex") || id.includes("-chat")
}

export const ChatGPTSubscription: ProviderAdapter = {
  stream(request: TurnRequest, emit: Emit): Promise<TurnOutcome> {
    const base = (request.baseURL ?? "https://chatgpt.com/backend-api/codex").replace(/\/$/, "")
    const headers: Record<string, string> = { originator: "mcode", "User-Agent": USER_AGENT }
    if (request.accountId) headers["chatgpt-account-id"] = request.accountId
    return streamResponses(request, emit, { url: `${base}/responses`, headers, label: "ChatGPT" })
  },
}

/**
 * A custom provider that speaks the Responses API: MiMo 26.920's `/responses`
 * protocol, which its config writes as `npm: @ai-sdk/openai`. The same wire as
 * the subscription's, at the address the user typed, with their key and their
 * headers (underneath the adapter's own, so an `Authorization` header there
 * cannot displace the key).
 */
export const OpenAIResponses: ProviderAdapter = {
  stream(request: TurnRequest, emit: Emit): Promise<TurnOutcome> {
    const base = (request.baseURL ?? "").replace(/\/+$/, "")
    return streamResponses(request, emit, { url: `${base}/responses`, headers: { ...request.headers }, label: "The provider" })
  },
}

/** One Responses request and its stream; `label` names who failed in an error. */
async function streamResponses(
  request: TurnRequest,
  emit: Emit,
  target: { url: string; headers: Record<string, string>; label: string },
): Promise<TurnOutcome> {
  const headers: Record<string, string> = {
    ...target.headers,
    "Content-Type": "application/json",
    // Header-authenticated gateways have no key; `Bearer ` must not displace
    // the authorization they carry (see openai.ts's same guard).
    ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
    Accept: "text/event-stream",
  }
  // MiMo keeps a conversation's requests together with this header.
  if (request.sessionID) headers["x-session-affinity"] = request.sessionID

  // MiMo's timeouts for this API: 300s to the response headers, then 480s of quiet at most.
  const guard = stallGuard(request.signal, true)
  const response = await fetch(target.url, {
    method: "POST",
    redirect: "manual",
    headers,
    signal: guard.signal,
    body: JSON.stringify({
      model: request.model.model,
      instructions: systemText(request),
      input: [...(request.developer ? [{ role: "developer", content: [{ type: "input_text", text: request.developer }] }] : []), ...toInput(request.history, request.inputs, request.model)],
      include: INCLUDE_ENCRYPTED_REASONING,
      tools: toolSchemas(request.tools, request.model),
      tool_choice: request.toolChoice ?? "auto",
      parallel_tool_calls: false,
      // Nothing is retained server-side: the transcript lives in this app.
      store: false,
      stream: true,
      // MiMo's prompt cache key for OpenAI: the conversation's id, so its prefix is found again.
      ...(request.sessionID ? { prompt_cache_key: request.sessionID } : {}),
      ...reasoningRequest(request.effort, request.variants),
      // MiMo asks GPT-5.x for terse text, except the codex and chat models.
      ...(verbose(request.model.model) ? {} : { text: { verbosity: "low" } }),
    }),
  }).catch((err: unknown) => {
    guard.dispose()
    throw guard.failure(err)
  })

  if (response.status >= 300 && response.status < 400) {
    // Refusing has to end this turn's guard too: a guard kept alive past a rejected request holds
    // its timer and its abort listener, and every refused retry adds another to the live set.
    guard.dispose()
    await response.body?.cancel().catch(() => undefined)
  }
  refuseRedirect(target.url, response)
  if (!response.ok || !response.body) {
    guard.dispose()
    const detail = await response.text().catch(() => "")
    // A proxy's HTML page is never joined to the message; see `isHtmlBody`.
    const said = isHtmlBody(detail)
      ? `${target.label} request failed (${response.status}): a gateway or proxy answered with a web page rather than a reply.`
      : `${target.label} request failed (${response.status}) ${detail.slice(0, 300)}`
    throw new ProviderHttpError(said, response.status, headersOf(response), wireOfBody(detail))
  }

  const toolCalls: ToolCall[] = []
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  let stop: TurnOutcome["stop"] = "end_turn"
  /** The response's own status, and why it was incomplete when it was. */
  let status: string | undefined
  let incomplete: string | undefined
  /** Whether the provider said how the response ended. */
  let settled = false
  /**
   * Whether anything reached the user.
   *
   * The open/close flags alternate as blocks hand off to each other, so
   * neither one on its own answers this, and reading them as if it did would
   * break the moment that handoff changes.
   */
  let produced = false

  // One logical block per kind; the Responses stream does not index them.
  let textOpen = false
  let reasoningOpen = false
  let index = 0

  /*
   * The shared reader (see sse.ts): an event is dispatched on its blank line
   * rather than per `data:` line, comments and keep-alives refresh the stall
   * timer through `onRead`, and a provider that omits the final newline no
   * longer loses the frame that carries its usage. `guarded` turns a stall
   * into the stall's own error and disposes the timer.
   */
  guard.alive()
  for await (const frame of guarded(readData(response.body, { signal: request.signal, onRead: guard.alive }), guard)) {
    const payload = frame.trim()
    if (!payload || payload === "[DONE]") continue

    let event: StreamEvent
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }

    switch (event.type) {
      case "response.output_text.delta": {
        if (!textOpen) {
          if (reasoningOpen) {
            emit({ type: "block.end", index })
            reasoningOpen = false
            index += 1
          }
          emit({ type: "text.start", index })
          textOpen = true
          produced = true
        }
        if (event.delta) emit({ type: "text.delta", index, text: event.delta })
        break
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (!reasoningOpen) {
          if (textOpen) {
            emit({ type: "block.end", index })
            textOpen = false
            index += 1
          }
          emit({ type: "reasoning.start", index })
          reasoningOpen = true
          produced = true
        }
        if (event.delta) emit({ type: "reasoning.delta", index, text: event.delta })
        break
      }

      case "response.output_item.done": {
        if (event.item?.type === "reasoning") {
          /*
           * The ciphertext `include` asked for, kept on the reasoning part so
           * `toInput` can hand it back on the later steps of this turn. A
           * reasoning item that carried no summary text opened no block, so
           * one is opened here to hold it: the part stays empty, which is
           * what `thinkOnly` looks at, and nothing is drawn for it either way.
           */
          if (!event.item.encrypted_content) break
          if (!reasoningOpen) {
            if (textOpen) {
              emit({ type: "block.end", index })
              textOpen = false
              index += 1
            }
            emit({ type: "reasoning.start", index })
            reasoningOpen = true
          }
          emit({ type: "reasoning.signature", index, signature: event.item.encrypted_content, native: { encrypted_content: event.item.encrypted_content, ...(event.item.id ? { id: event.item.id } : {}) }, ...(event.item.id ? { itemID: event.item.id } : {}) })
          emit({ type: "block.end", index })
          reasoningOpen = false
          index += 1
          break
        }
        if (event.item?.type !== "function_call") break
        const callID = event.item.call_id ?? ""
        emit({ type: "tool", callID, name: event.item.name ?? "" })
        toolCalls.push({
          callID,
          name: event.item.name ?? "",
          ...parseToolArguments(event.item.arguments),
        })
        stop = "tool_use"
        break
      }

      case "response.completed":
      case "response.incomplete": {
        // MiMo's split: input without the cached tokens it includes, output without the reasoning.
        const reported = event.response?.usage
        usage.cacheRead = reported?.input_tokens_details?.cached_tokens ?? 0
        usage.reasoning = reported?.output_tokens_details?.reasoning_tokens ?? 0
        usage.input = (reported?.input_tokens ?? 0) - usage.cacheRead
        usage.output = (reported?.output_tokens ?? 0) - usage.reasoning
        if (event.type === "response.incomplete") {
          /*
           * MiMo's `mapOpenAIResponseFinishReason` reads
           * `incomplete_details.reason`, not the event name: only
           * `max_output_tokens` is the output ceiling, and `content_filter`
           * is a refusal. Taking every incomplete response for the ceiling
           * put an "output too long" card on a filtered reply and then had
           * `continuationFor` ask the model to carry on from exactly the
           * passage it had been stopped on.
           */
          const why = event.response?.incomplete_details?.reason
          stop = why === "content_filter" ? "refusal" : "max_tokens"
          if (why) incomplete = why
        }
        status = event.response?.status ?? status
        settled = true
        break
      }

      case "response.failed":
      case "error":
        // The reason is the only useful part of this frame; a fixed
        // sentence in its place leaves nothing to act on.
        throw new ProviderError(
          event.response?.error?.message ??
            event.error?.message ??
            event.message ??
            `${target.label} stream failed without saying why.`,
          undefined,
          undefined,
          // The code decides the retry: GPT's overload answer is tried at once, three times at most.
          { ...(event.code ? { code: event.code } : {}), ...(event.error?.code ? { code: event.error.code } : {}), ...(event.error?.type ? { type: event.error.type } : {}) },
        )
    }
  }

  // A stream cut between reads is a cut stream, not a reply: see the same two lines in openai.ts.
  if (request.signal.aborted) throw new DOMException("Aborted", "AbortError")

  if (textOpen || reasoningOpen) emit({ type: "block.end", index })

  // Nothing said, and no word on why: the connection failed rather than the
  // model choosing to stay quiet. Reporting it as a finished turn hides that.
  if (!settled && !produced && !toolCalls.length) {
    throw new ProviderError(`The connection closed before ${target.label === "ChatGPT" ? "ChatGPT" : "the provider"} sent a reply.`, "error.noReply")
  }

  /*
   * MiMo's `mapOpenAIResponseFinishReason`, as the word the rest of the app
   * reads: the incomplete reason where there is one, `tool_calls` when the
   * response carried calls, otherwise the response's own status. Without it
   * this path returned no `finishReason` at all, so the continuation that
   * answers a tool call written out as prose (reminders.ts) could never fire
   * here, and neither could the content-filter wording on the failure card.
   */
  const finishReason = incomplete ?? (toolCalls.length ? "tool_calls" : status)

  return { stop, toolCalls, usage, ...(finishReason ? { finishReason } : {}) }
}
