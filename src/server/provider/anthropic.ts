import Anthropic from "@anthropic-ai/sdk"
import type { Message, ModelModalities, ModelRef, Usage } from "@shared/protocol"
import { attachmentParts } from "./attachment-parts"
import { userText } from "@shared/annotations"
import type { ToolDefinition } from "../tool/types"
import type { Emit, ProviderAdapter, ToolCall, TurnOutcome, TurnRequest } from "./types"
import { providerErrorMessage } from "./types"
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
  // True while the last message pushed is a tool-result user turn: a real user
  // message that follows (the loop was interrupted and the user typed) must be
  // merged into it - the API rejects consecutive same-role messages.
  let pendingResults = false

  for (const message of requestHistory(messages)) {
    if (message.role === "user") {
      const content: Anthropic.ContentBlockParam[] = []
      // MiMo's parts: a picture the model reads goes natively; every other attachment is named by path in the turn's blocks.
      for (const part of attachmentParts(message.attachments ?? [], inputs, "anthropic", "user")) {
        if (part.kind === "text") content.push({ type: "text", text: part.text })
        else if (part.kind === "image") content.push({ type: "image", source: { type: "base64", media_type: part.mime as "image/png", data: part.data } })
        else if (part.kind === "pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: part.data }, title: part.name })
      }
      const text = userText(message)
      if (text) content.push({ type: "text", text })
      if (content.length) {
        const last = out[out.length - 1]
        if (pendingResults && last?.role === "user") {
          // pendingResults is only true when the last push was a
          // tool-result turn, whose content is always the block array.
          last.content = [...(last.content as Anthropic.ContentBlockParam[]), ...content]
        } else out.push({ role: "user", content })
      }
      pendingResults = false
      continue
    }

    const assistant: Anthropic.ContentBlockParam[] = []
    const calls: Anthropic.ContentBlockParam[] = []
    const results: Anthropic.ToolResultBlockParam[] = []
    // MiMo keeps signed thinking only for the model that wrote it.
    const sameModel = Boolean(model && message.model.provider === model.provider && message.model.model === model.model)

    for (const part of message.parts) {
      if (part.type === "reasoning") {
        /*
         * And only while it still has its words. A level-2 prune empties a
         * reasoning part's text and keeps its signature, which would send a
         * signed thinking block whose contents are not what was signed - the
         * one shape that cannot be right, whatever the provider makes of it.
         * The newest turns are never pruned, so the block this model must see
         * to carry on a tool call is still whole. The text arm below guards the
         * same way.
         */
        if (sameModel && part.signature && part.text) assistant.push({ type: "thinking", thinking: part.text, signature: part.signature })
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
    if (results.length) {
      out.push({ role: "user", content: results })
      pendingResults = true
    }
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
 * wants the budget under `max_tokens`, so it is kept below that too. A limit
 * too small to hold the 1_024 floor cannot carry thinking at all, so undefined
 * is returned and the caller omits the field - a budget at or above
 * `max_tokens` is rejected outright.
 */
function budget(level: "low" | "medium" | "high" | "max", outputLimit: number, maxTokens: number): number | undefined {
  // `low` and `medium` exist for a custom model that names those levels; the reference computes only the two below them.
  if (level === "low" || level === "medium") {
    const wanted = Math.min(level === "low" ? 4_000 : 8_000, Math.floor(outputLimit / 2 - 1))
    const capped = Math.min(wanted, maxTokens - 1)
    return capped < 1_024 ? undefined : capped
  }
  const wanted = level === "max" ? Math.min(31_999, outputLimit - 1) : Math.min(16_000, Math.floor(outputLimit / 2 - 1))
  const capped = Math.min(wanted, maxTokens - 1)
  return capped < 1_024 ? undefined : capped
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
  maxTokens: number,
  outputLimit = maxTokens,
): AnthropicReasoning {
  const id = model.toLowerCase()
  // `none` is a custom model's "do not think" (its thinking setting says it can be turned off): no thinking field at all,
  // not a level that happens to be in the list.
  if (effort === "none") return {}
  if (variants && !variants.includes(effort)) {
    /*
     * Kimi K2.5 takes no effort level, but MiMo turns its thinking on over this
     * protocol anyway, with the high budget (`transform.options`). The field
     * is the API's own shape; `display` is Anthropic's and is left off.
     */
    const kimi = ["k2p5", "kimi-k2.5", "kimi-k2p5"].some((mark) => id.includes(mark))
    const kimiBudget = kimi ? budget("high", outputLimit, maxTokens) : undefined
    return kimi && kimiBudget !== undefined ? { thinking: { type: "enabled", budget_tokens: kimiBudget } } : {}
  }
  /*
   * `summarized`, as the reference asks for it (it sets the field on
   * 4.7-and-later and leaves it off 4.6, where the API's own default is
   * summarized anyway - the same request either way, said twice).
   *
   * This used to be `omitted`, because every caller passed showReasoning:
   * false - the interface draws no thinking, so it asked for none. That also
   * meant the server sent no thinking blocks at all, and a step that thought
   * and then said nothing was indistinguishable from a step that produced
   * nothing: the think-only card had nothing to recognise, and neither did the
   * rule that takes a GPT model's reasoning-only reply as final. The thinking
   * is kept now and still not drawn.
   */
  const display = "summarized" as const

  if (anthropicAdaptive(id)) {
    const level = OUTPUT_EFFORTS.find((entry) => entry === effort)
    return {
      thinking: { type: "adaptive", display },
      ...(level ? { output_config: { effort: level } } : {}),
    }
  }

  if (anthropicOpus45(id)) {
    const level = OUTPUT_EFFORTS.find((entry) => entry === effort)
    const thinkingBudget = budget("high", outputLimit, maxTokens)
    return {
      ...(thinkingBudget !== undefined ? { thinking: { type: "enabled", budget_tokens: thinkingBudget, display } } : {}),
      ...(level ? { output_config: { effort: level } } : {}),
    }
  }

  const thinkingBudget = budget(effort === "max" || effort === "xhigh" ? "max" : effort === "low" || effort === "medium" ? effort : "high", outputLimit, maxTokens)
  return thinkingBudget === undefined
    ? {}
    : { thinking: { type: "enabled", budget_tokens: thinkingBudget, display } }
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
    ...(request.toolChoice && tools.length ? { tool_choice: { type: request.toolChoice } } : {}),
    messages,
    ...(request.thinkingOff ? {} : reasoningRequest(request.model.model, request.effort, request.variants, maxTokens, limit ?? wanted)),
    // MiMo's family sampling: none for Claude, set for another family reached over this protocol.
    ...(request.sampling?.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
    ...(request.sampling?.topP !== undefined ? { top_p: request.sampling.topP } : {}),
    ...(request.sampling?.topK !== undefined ? { top_k: request.sampling.topK } : {}),
  }
}

/**
 * What a Messages `stop_reason` means for the turn, with the calls it carried.
 *
 * MiMo's `mapAnthropicStopReason` keeps the two apart: `max_tokens` and
 * `model_context_window_exceeded` both become its `length`, `tool_use` becomes
 * `tool-calls`, and neither overwrites the other, because the tool calls were
 * already announced as their own events and the finish is only this step's
 * label. Its `autoContinueOutputLength` then refuses to continue a message that
 * carries tool parts - the calls are run instead, truncated arguments and all.
 *
 * So the calls are asked about first. Written the other way round - the limit
 * before the calls - a reply that hit the ceiling while still writing a tool
 * call reported `max_tokens`, the turn loop took the "nothing to run" branch,
 * `continuationFor` declined to continue a message that has tool parts, and the
 * announced call was left `pending` for ever with a bare "output too long"
 * card: the model was never told anything it could correct. The limit is still
 * visible, because `finishReason` carries the provider's own word for it.
 *
 * `model_context_window_exceeded` is a stop reason, not an error body, so none
 * of the overflow patterns in session/overflow.ts can reach it; without this it
 * landed on `end_turn` and a reply the server had cut short for want of room
 * read as a model that had finished speaking.
 */
export function anthropicStop(reason: string | null | undefined, calls: number): TurnOutcome["stop"] {
  if (reason === "refusal") return "refusal"
  if (calls) return "tool_use"
  if (reason === "max_tokens" || reason === "model_context_window_exceeded") return "max_tokens"
  return "end_turn"
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

    let refusal: { category?: string; explanation?: string } | undefined
    for await (const event of guarded(stream, guard)) {
      if (request.signal.aborted) break

      /*
       * A reply the provider stops comes with what it stopped it for: a policy
       * area and a sentence (OpenCode v2, b03d760f). The SDK's own types do not
       * carry the field yet, so it is read off the event as sent.
       */
      if (event.type === "message_delta") {
        const details = (event.delta as { stop_details?: { category?: unknown; explanation?: unknown } | null }).stop_details
        if (details) {
          refusal = {
            ...(typeof details.category === "string" && details.category ? { category: details.category } : {}),
            ...(typeof details.explanation === "string" && details.explanation ? { explanation: details.explanation } : {}),
          }
        }
        continue
      }

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

    return {
      stop: anthropicStop(final.stop_reason, toolCalls.length),
      toolCalls,
      usage: usageFrom(final.usage),
      ...(final.stop_reason ? { finishReason: final.stop_reason } : {}),
      ...(refusal && (refusal.category || refusal.explanation) ? { refusal } : {}),
    }
  },
}

/** As `describeHttp` words it, with the provider's own explanation from the body the SDK parsed. */
export function describeAnthropicError(err: unknown): string | undefined {
  if (!(err instanceof Anthropic.APIError)) return undefined
  const said = err.error ? providerErrorMessage(JSON.stringify(err.error)) : undefined
  const after = said ? ` ${said}` : ""
  if (err.status === 401) return `Authentication failed - check the API key in Settings.${after}`
  if (err.status === 429) return said ? `Rate limited by the provider (429): ${said}` : "Rate limited by the provider. Wait a moment and try again."
  if (err.status && err.status >= 500) return `The provider returned ${err.status}. This is usually transient.${after}`
  return `${err.name}: ${err.message}`
}

export type { ModelRef }
