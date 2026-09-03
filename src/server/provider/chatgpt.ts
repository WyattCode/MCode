import type { Message } from "@shared/protocol"
import type { ToolDefinition } from "../tool/types"
import type { Emit, ProviderAdapter, ToolCall, TurnOutcome, TurnRequest } from "./types"
import { ProviderError } from "./types"
import { USER_AGENT } from "../auth/oauth"

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
  }
  /** Present on `error` frames; `response.failed` nests it under `response`. */
  message?: string
  code?: string
  error?: { message?: string }
  response?: {
    error?: { message?: string }
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

function toolSchemas(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }))
}

/**
 * Flattens the stored transcript into Responses input items.
 *
 * Assistant tool calls and their results have to stay paired and in order, or
 * the backend rejects the turn - the same constraint as the other adapters,
 * expressed with different item types.
 */
function toInput(history: Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []

  for (const message of history) {
    if (message.role === "user") {
      const attachments = message.attachments ?? []
      const images = attachments.filter((attachment) => attachment.mime.startsWith("image/"))
      const files = attachments
        .filter((attachment) => !attachment.mime.startsWith("image/"))
        .map((attachment) => `<file path="${attachment.path}">\n${attachment.data}\n</file>`)
      const text = [...files, message.text].filter(Boolean).join("\n\n")
      const content = [
        ...(text ? [{ type: "input_text", text }] : []),
        ...images.map((image) => ({
          type: "input_image",
          image_url: `data:${image.mime};base64,${image.data}`,
        })),
      ]
      if (content.length) out.push({ type: "message", role: "user", content })
      continue
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
      // A call with no result is worse than no call at all: the backend rejects
      // an unpaired function_call, so an interrupted turn would poison every
      // later request in the session. Drop the pair, not just the output.
      if (part.status === "pending" || part.status === "running") continue
      out.push({
        type: "function_call",
        call_id: part.callID,
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      })
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
        output: part.status === "error" ? (part.error ?? "Tool failed") : (part.output ?? ""),
      })
    }
  }

  return out
}

/** Arguments can arrive truncated when a turn is cut short. */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
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
 * `summary` is this app's own use of its "Show reasoning" setting; the
 * reference always asks for `auto`.
 */
export function reasoningRequest(
  effort: string,
  variants: readonly string[] | undefined,
  showReasoning: boolean,
): { reasoning?: { effort: string; summary: "auto" | "concise" } } {
  if (variants && !variants.includes(effort)) return {}
  return { reasoning: { effort, summary: showReasoning ? "auto" : "concise" } }
}

export const ChatGPTSubscription: ProviderAdapter = {
  async stream(request: TurnRequest, emit: Emit): Promise<TurnOutcome> {
    const base = (request.baseURL ?? "https://chatgpt.com/backend-api/codex").replace(/\/$/, "")

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
      Accept: "text/event-stream",
      originator: "mcode",
      "User-Agent": USER_AGENT,
    }
    if (request.accountId) headers["chatgpt-account-id"] = request.accountId

    const response = await fetch(`${base}/responses`, {
      method: "POST",
      headers,
      signal: request.signal,
      body: JSON.stringify({
        model: request.model.model,
        instructions: request.system,
        input: toInput(request.history),
        tools: toolSchemas(request.tools),
        tool_choice: "auto",
        parallel_tool_calls: false,
        // Nothing is retained server-side: the transcript lives in this app.
        store: false,
        stream: true,
        ...reasoningRequest(request.effort, request.variants, request.showReasoning),
      }),
    })

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "")
      throw new Error(`ChatGPT request failed (${response.status}) ${detail.slice(0, 300)}`)
    }

    const toolCalls: ToolCall[] = []
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    let stop: TurnOutcome["stop"] = "end_turn"
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

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const payload = line.slice(5).trim()
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
            if (!request.showReasoning) break
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
            if (event.item?.type !== "function_call") break
            const callID = event.item.call_id ?? ""
            emit({ type: "tool", callID, name: event.item.name ?? "" })
            toolCalls.push({
              callID,
              name: event.item.name ?? "",
              input: parseArguments(event.item.arguments),
            })
            stop = "tool_use"
            break
          }

          case "response.completed":
          case "response.incomplete": {
            const reported = event.response?.usage
            usage.input = reported?.input_tokens ?? 0
            usage.output = reported?.output_tokens ?? 0
            usage.reasoning = reported?.output_tokens_details?.reasoning_tokens ?? 0
            usage.cacheRead = reported?.input_tokens_details?.cached_tokens ?? 0
            if (event.type === "response.incomplete") stop = "max_tokens"
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
                "ChatGPT stream failed without saying why.",
            )
        }
      }
    }

    if (textOpen || reasoningOpen) emit({ type: "block.end", index })

    // Nothing said, and no word on why: the connection failed rather than the
    // model choosing to stay quiet. Reporting it as a finished turn hides that.
    if (!settled && !produced && !toolCalls.length) {
      throw new ProviderError("The connection closed before ChatGPT sent a reply.", "error.noReply")
    }

    return { stop, toolCalls, usage }
  },
}
