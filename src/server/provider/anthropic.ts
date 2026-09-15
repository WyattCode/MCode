import Anthropic from "@anthropic-ai/sdk"
import type { Message, ModelRef, Usage } from "@shared/protocol"
import { withAnnotations } from "@shared/annotations"
import type { ToolDefinition } from "../tool/types"
import type { Emit, ProviderAdapter, ToolCall, TurnOutcome, TurnRequest } from "./types"
import { anthropicAdaptive, anthropicOpus45 } from "./variants"
import { costOf } from "../session/usage"
import { requestHistory } from "./history"

export function createClient(apiKey: string, maxRetries = 2): Anthropic {
  return new Anthropic({ apiKey, maxRetries })
}

export function toolSchemas(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }))
}

/**
 * Rebuilds provider history from stored messages.
 *
 * Two things matter here. Every `tool_use` block must be answered by a
 * `tool_result` with the same id in the immediately following user turn, or the
 * API rejects the request - so tool results are emitted as one batched user
 * message per assistant turn. And reasoning is deliberately not replayed: only
 * the summarized text is stored, not the signed original, and sending an
 * unsigned thinking block back is worse than sending none.
 */
export function toProviderMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []

  for (const message of requestHistory(messages)) {
    if (message.role === "user") {
      const content: Anthropic.ContentBlockParam[] = []
      for (const attachment of message.attachments ?? []) {
        if (attachment.mime.startsWith("image/")) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: attachment.mime as "image/png", data: attachment.data },
          })
        } else {
          content.push({ type: "text", text: `<file path="${attachment.path}">\n${attachment.data}\n</file>` })
        }
      }
      const text = withAnnotations(message.text, message.annotations)
      if (text) content.push({ type: "text", text })
      if (content.length) out.push({ role: "user", content })
      continue
    }

    const assistant: Anthropic.ContentBlockParam[] = []
    const results: Anthropic.ToolResultBlockParam[] = []

    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text.trim()) assistant.push({ type: "text", text: part.text })
      } else if (part.type === "tool") {
        // A call that never finished arrives here already answered as interrupted (see history.ts).
        assistant.push({ type: "tool_use", id: part.callID, name: part.name, input: part.input })
        results.push({
          type: "tool_result",
          tool_use_id: part.callID,
          content: part.status === "error" ? (part.error ?? "Tool failed") : (part.output ?? ""),
          is_error: part.status === "error",
        })
      }
    }

    if (assistant.length) out.push({ role: "assistant", content: assistant })
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
  if (variants && !variants.includes(effort)) return {}
  const id = model.toLowerCase()
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

export const AnthropicAdapter: ProviderAdapter = {
  async stream(request: TurnRequest, emit: Emit): Promise<TurnOutcome> {
    const client = createClient(request.apiKey, request.retries)
    /*
     * MiMo's cap, held to the model's own ceiling when the catalog knows it -
     * what MiMo's Anthropic SDK does for a model it recognises. The thinking
     * budgets are cut from that ceiling.
     */
    const limit = request.outputLimit && request.outputLimit > 0 ? request.outputLimit : undefined
    const wanted = request.maxOutput ?? MAX_TOKENS
    const maxTokens = limit ? Math.min(wanted, limit) : wanted

    const stream = client.messages.stream(
      {
        model: request.model.model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        tools: toolSchemas(request.tools),
        messages: toProviderMessages(request.history),
        ...reasoningRequest(
          request.model.model,
          request.effort,
          request.variants,
          request.showReasoning,
          maxTokens,
          limit ?? wanted,
        ),
        // MiMo's family sampling: none for Claude, set for another family reached over this protocol.
        ...(request.sampling?.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
        ...(request.sampling?.topP !== undefined ? { top_p: request.sampling.topP } : {}),
        ...(request.sampling?.topK !== undefined ? { top_k: request.sampling.topK } : {}),
      },
      { signal: request.signal },
    )

    for await (const event of stream) {
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
