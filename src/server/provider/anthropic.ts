import Anthropic from "@anthropic-ai/sdk"
import type { Message, ModelModalities, ModelRef, Usage } from "@shared/protocol"
import { attachmentParts } from "./attachment-parts"
import { userText } from "@shared/annotations"
import type { ToolDefinition } from "../tool/types"
import type { Emit, ProviderAdapter, ToolCall, TurnOutcome, TurnRequest } from "./types"
import { anthropicAdaptive, anthropicOpus45 } from "./variants"
import { guarded, stallGuard } from "./stall"
import { costOf } from "../session/usage"
import { requestHistory } from "./history"
import { schemaFor } from "./tool-schema"

/**
 * A Messages client, for Anthropic itself or a gateway that speaks its API.
 *
 * A gateway's address is written as MiMo's form takes it, ending in `/v1`; the
 * SDK adds its own `/v1/messages`, so that ending is taken off. With no key, a
 * gateway that authenticates by its own header is reached with that header
 * alone.
 */
export function createClient(apiKey: string, maxRetries = 2, baseURL?: string, headers?: Record<string, string>): Anthropic {
  const root = baseURL?.replace(/\/+$/, "").replace(/\/v1$/, "")
  return new Anthropic({
    apiKey: apiKey || null,
    maxRetries,
    ...(root ? { baseURL: root } : {}),
    ...(headers && Object.keys(headers).length ? { defaultHeaders: headers } : {}),
  })
}

function toolSchemas(tools: ToolDefinition[], model: ModelRef): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // A Kimi or Gemini model reached over this protocol still wants its family's schema shape.
    input_schema: schemaFor(model, tool.parameters) as Anthropic.Tool.InputSchema,
  }))
}

/**
 * Rebuilds provider history from stored messages.
 *
 * Two things matter here. Every `tool_use` block must be answered by a
 * `tool_result` with the same id in the immediately following user turn, or the
 * API rejects the request - so tool results are emitted as one batched user
 * message per assistant turn. And thinking goes back only with its signature,
 * to the model that signed it, as MiMo keeps it: an unsigned thinking block, or
 * one from another model, is worse than none.
 */
export function toProviderMessages(messages: Message[], inputs?: Partial<ModelModalities>, model?: ModelRef): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []

  for (const message of requestHistory(messages)) {
    if (message.role === "user") {
      const content: Anthropic.ContentBlockParam[] = []
      // MiMo's parts: images and PDFs the model reads go natively, anything else as text or a note.
      for (const part of attachmentParts(message.attachments ?? [], inputs, "anthropic")) {
        if (part.kind === "text") content.push({ type: "text", text: part.text })
        else if (part.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: part.mime as "image/png", data: part.data } })
        else if (part.kind === "pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: part.data }, title: part.name })
      }
      const text = userText(message)
      if (text) content.push({ type: "text", text })
      if (content.length) out.push({ role: "user", content })
      continue
    }

    const assistant: Anthropic.ContentBlockParam[] = []
    const calls: Anthropic.ContentBlockParam[] = []
    const results: Anthropic.ToolResultBlockParam[] = []
    // MiMo keeps signed thinking only for the model that wrote it.
    const sameModel = Boolean(model && message.model.provider === model.provider && message.model.model === model.model)

    for (const part of message.parts) {
      if (part.type === "reasoning") {
        if (sameModel && part.signature) assistant.push({ type: "thinking", thinking: part.text, signature: part.signature })
      } else if (part.type === "text") {
        if (part.text.trim()) assistant.push({ type: "text", text: part.text })
      } else if (part.type === "tool") {
        // A call that never finished arrives here already answered as interrupted (see history.ts).
        // Calls go after every other part, as MiMo splits a reply whose words follow its calls.
        calls.push({ type: "tool_use", id: part.callID, name: part.name, input: part.input })
        const said = part.status === "error" ? (part.error ?? "Tool failed") : (part.output ?? "")
        /*
         * MiMo's tool media: a result's pictures go inside the tool_result
         * itself, which this wire takes. Anything else the model cannot be
         * handed here arrives as the line attachmentParts wrote for it.
         */
        const pieces = part.status === "error" ? [] : attachmentParts(part.attachments ?? [], inputs, "anthropic")
        const blocks: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
        if (said) blocks.push({ type: "text", text: said })
        for (const piece of pieces) {
          if (piece.kind === "text") blocks.push({ type: "text", text: piece.text })
          else if (piece.kind === "image") blocks.push({ type: "image", source: { type: "base64", media_type: piece.mime as "image/png", data: piece.data } })
          else blocks.push({ type: "text", text: `[${piece.kind === "pdf" ? piece.name : piece.kind} cannot be put in a tool result for this provider, so it was not sent.]` })
        }
        results.push({
          type: "tool_result",
          tool_use_id: part.callID,
          content: pieces.length ? blocks : said,
          is_error: part.status === "error",
        })
      }
    }

    if (assistant.length || calls.length) out.push({ role: "assistant", content: [...assistant, ...calls] })
    if (results.length) out.push({ role: "user", content: results })
  }

  return out
}

/*
 * Anthropic's `input_tokens` already leaves out cache reads and writes, which
 * is how MiMo counts input; reasoning is not reported apart from output.
 */
export function usageFrom(
  usage: Anthropic.Usage | undefined,
  entry?: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): Usage {
  const input = usage?.input_tokens ?? 0
  const output = usage?.output_tokens ?? 0
  const cacheRead = usage?.cache_read_input_tokens ?? 0
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0
  const counted = { input, output, reasoning: 0, cacheRead, cacheWrite }
  return { ...counted, cost: costOf(counted, entry) }
}

/** What a request asks for when the caller named no cap. */
const MAX_TOKENS = 32_000

/**
 * The levels Anthropic's `output_config.effort` will take.
 *
 * Not this app's `Effort` union: `none` and `minimal` belong to OpenAI's
 * vocabulary and the Messages API has no word for them. The SDK's own
 * `OutputConfig.effort` is typed `'low'|'medium'|'high'|'xhigh'|'max'`, and
 * every list `modelVariants` produces for an Anthropic model is a subset of
 * these five, so the two cannot disagree - this exists so that fact is checked
 * rather than asserted with a cast.
 */
const OUTPUT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

type OutputEffort = (typeof OUTPUT_EFFORTS)[number]

/** The reasoning half of a Messages request: both fields, either, or neither. */
export interface AnthropicReasoning {
  thinking?: Anthropic.ThinkingConfigParam
  output_config?: { effort: OutputEffort }
}

/**
 * MiMo's thinking budgets, cut from the model's own output limit: high is
 * min(16000, limit / 2 - 1) and max is min(31999, limit - 1). The API also
 * wants the budget under `max_tokens`, so it is kept below that too.
 */
function budget(level: "high" | "max", outputLimit: number, maxTokens: number): number {
  const wanted = level === "max" ? Math.min(31_999, outputLimit - 1) : Math.min(16_000, Math.floor(outputLimit / 2 - 1))
  return Math.max(1_024, Math.min(wanted, maxTokens - 1))
}

/**
 * How one chosen effort reaches an Anthropic request - or why it does not.
 *
 * This is the reference's `anthropicEffort` (node-BBwF64dM.js @22215853) and
 * the `@ai-sdk/anthropic` arm of its `variants` table (@22192900), which
 * between them give three shapes and a silence:
 *
 *   - a model on adaptive thinking (Claude 4.6, and 4.7 and later) gets
 *     `thinking: {type:"adaptive"}` with the level in `output_config.effort`;
 *   - Opus 4.5 gets a thinking budget AND the level;
 *   - anything older gets a budget alone, `high` and `max` being the only two
 *     levels it offers because they are the only two budgets computed;
 *   - and a level the model does not accept - including every level, for a
 *     model that takes no effort parameter - is not sent at all. The
 *     reference's `anthropicEffort` returns undefined there and its `variants`
 *     map simply has no entry to spread.
 *
 * That last case is the whole point. Until now this adapter sent adaptive
 * thinking and an effort on every Anthropic turn, for every model, whatever
 * the effort pill was showing - so a model with no effort control still had
 * one applied, and a level the model does not accept still went out.
 *
 * `variants` being absent means nobody worked the list out, and then the level
 * is sent: that is what the control has always claimed to do, and it is the
 * same rule the OpenAI-compatible adapter follows.
 */
export function reasoningRequest(
  model: string,
  effort: string,
  variants: readonly string[] | undefined,
  showReasoning: boolean,
  maxTokens: number,
  outputLimit = maxTokens,
): AnthropicReasoning {
  const id = model.toLowerCase()
  if (variants && !variants.includes(effort)) {
    /*
     * Kimi K2.5 takes no effort level, but MiMo turns its thinking on over this
     * protocol anyway, with the high budget (`transform.options`). The field
     * is the API's own shape; `display` is Anthropic's and is left off.
     */
    const kimi = ["k2p5", "kimi-k2.5", "kimi-k2p5"].some((mark) => id.includes(mark))
    return kimi ? { thinking: { type: "enabled", budget_tokens: budget("high", outputLimit, maxTokens) } } : {}
  }
  /*
   * The reference sets `display: "summarized"` on 4.7-and-later and leaves the
   * field off 4.6, where the API's own default is summarized anyway. Setting it
   * on both is a deliberate difference: this app has a "Show reasoning"
   * setting, `omitted` is the value the API offers for turning it off, and
   * leaving the field unset on 4.6 would quietly make that setting do nothing
   * for two of the models in the catalog.
   */
  const display = showReasoning ? "summarized" : "omitted"

  if (anthropicAdaptive(id)) {
    const level = OUTPUT_EFFORTS.find((entry) => entry === effort)
    return {
      thinking: { type: "adaptive", display },
      ...(level ? { output_config: { effort: level } } : {}),
    }
  }

  if (anthropicOpus45(id)) {
    const level = OUTPUT_EFFORTS.find((entry) => entry === effort)
    return {
      thinking: { type: "enabled", budget_tokens: budget("high", outputLimit, maxTokens), display },
      ...(level ? { output_config: { effort: level } } : {}),
    }
  }

  return {
    thinking: {
      type: "enabled",
      budget_tokens: budget(effort === "max" ? "max" : "high", outputLimit, maxTokens),
      display,
    },
  }
}

type MessagesBody = Parameters<Anthropic["messages"]["stream"]>[0]
type CacheMark = { type: "ephemeral"; ttl?: "5m" | "1h" }

/** Puts a cache mark on a message's last block, turning plain text into a block to carry it. */
function markLast(message: Anthropic.MessageParam, mark: CacheMark): void {
  if (typeof message.content === "string") {
    message.content = [{ type: "text", text: message.content, cache_control: mark }]
    return
  }
  const last = message.content[message.content.length - 1]
  if (last && last.type !== "thinking" && last.type !== "redacted_thinking") (last as { cache_control?: CacheMark }).cache_control = mark
}

/**
 * The Messages request, with MiMo's cache marks: the system prompt, the last
 * tool definition and the last two messages, so each step reads back what the
 * one before it wrote. The cap is MiMo's, held to the model's own ceiling when
 * the catalog knows it - what MiMo's Anthropic SDK does for a model it
 * recognises - and the thinking budgets are cut from that ceiling.
 */
export function messagesRequest(request: TurnRequest): MessagesBody {
  const limit = request.outputLimit && request.outputLimit > 0 ? request.outputLimit : undefined
  const wanted = request.maxOutput ?? MAX_TOKENS
  const maxTokens = limit ? Math.min(wanted, limit) : wanted
  const mark: CacheMark = { type: "ephemeral", ...(request.cacheTTL === "1h" ? { ttl: "1h" as const } : {}) }
  const tools = toolSchemas(request.tools, request.model)
  if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1]!, cache_control: mark }
  const messages = toProviderMessages(request.history, request.inputs, request.model)
  for (const message of messages.slice(-2)) markLast(message, mark)
  return {
    model: request.model.model,
    max_tokens: maxTokens,
    // The conversation's own tail follows the marked prefix unmarked, so the prefix reads from one cache across conversations.
    system: [{ type: "text", text: request.system, cache_control: mark }, ...(request.systemTail ? [{ type: "text" as const, text: request.systemTail }] : [])],
    tools,
    messages,
    ...reasoningRequest(request.model.model, request.effort, request.variants, request.showReasoning, maxTokens, limit ?? wanted),
    // MiMo's family sampling: none for Claude, set for another family reached over this protocol.
    ...(request.sampling?.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
    ...(request.sampling?.topP !== undefined ? { top_p: request.sampling.topP } : {}),
    ...(request.sampling?.topK !== undefined ? { top_k: request.sampling.topK } : {}),
  }
}

export const AnthropicAdapter: ProviderAdapter = {
  async stream(request: TurnRequest, emit: Emit): Promise<TurnOutcome> {
    const client = createClient(request.apiKey, request.retries, request.baseURL, request.headers)
    // MiMo's stall timeout: a stream that goes quiet for 480s is cut off and retried.
    const guard = stallGuard(request.signal, false)
    const stream = client.messages.stream(messagesRequest(request), {
      signal: guard.signal,
      // MiMo keeps a conversation's requests together with this header.
      ...(request.sessionID ? { headers: { "x-session-affinity": request.sessionID } } : {}),
    })

    for await (const event of guarded(stream, guard)) {
      if (request.signal.aborted) break

      if (event.type === "content_block_start") {
        const block = event.content_block
        if (block.type === "text") emit({ type: "text.start", index: event.index })
        else if (block.type === "thinking") emit({ type: "reasoning.start", index: event.index })
        else if (block.type === "tool_use") emit({ type: "tool", callID: block.id, name: block.name })
        continue
      }

      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          emit({ type: "text.delta", index: event.index, text: event.delta.text })
        } else if (event.delta.type === "thinking_delta") {
          emit({ type: "reasoning.delta", index: event.index, text: event.delta.thinking })
        } else if (event.delta.type === "signature_delta") {
          emit({ type: "reasoning.signature", index: event.index, signature: event.delta.signature })
        }
        continue
      }

      if (event.type === "content_block_stop") emit({ type: "block.end", index: event.index })
    }

    if (request.signal.aborted) {
      stream.abort()
      throw new DOMException("Aborted", "AbortError")
    }

    const final = await stream.finalMessage()

    // Tool inputs stream as partial JSON; take them from the assembled message
    // rather than reconstructing them from deltas.
    const toolCalls: ToolCall[] = final.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
      .map((block) => ({
        callID: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      }))

    const stop: TurnOutcome["stop"] =
      final.stop_reason === "refusal"
        ? "refusal"
        : final.stop_reason === "max_tokens"
          ? "max_tokens"
          : toolCalls.length
            ? "tool_use"
            : "end_turn"

    return { stop, toolCalls, usage: usageFrom(final.usage), ...(final.stop_reason ? { finishReason: final.stop_reason } : {}) }
  },
}

export function describeAnthropicError(err: unknown): string | undefined {
  if (!(err instanceof Anthropic.APIError)) return undefined
  if (err.status === 401) return "Authentication failed - check the API key in Settings."
  if (err.status === 429) return "Rate limited by the provider. Wait a moment and try again."
  if (err.status && err.status >= 500) return `The provider returned ${err.status}. This is usually transient.`
  return `${err.name}: ${err.message}`
}

export type { ModelRef }
