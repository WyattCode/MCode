/**
 * Round 5: the turn loop, the providers, the context and the prompt, measured
 * against MiMo's engine. Kept apart from smoke.ts so the sections read as one
 * account; smoke.ts calls `roundFiveChecks` with its own check and section.
 *
 * Every request a provider would receive is inspected on the wire or through
 * the pure function that builds it. No model is called.
 */
import { LARGE_OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX, isOverflowByCount, maxOutputTokens, usableContext } from "../src/server/session/overflow"
import { reasoningRequest as anthropicReasoning } from "../src/server/provider/anthropic"
import { costOf } from "../src/server/session/usage"
import { usageOf } from "../src/server/provider/openai"

export type Check = (name: string, condition: boolean, detail?: unknown) => void

export async function roundFiveChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 5: max output tokens (E15)")
  {
    check("a Claude model is asked for 128k whatever its ceiling", maxOutputTokens({ provider: "anthropic", model: "claude-haiku-4-5" }, { maxOutput: 64_000 }) === LARGE_OUTPUT_TOKEN_MAX)
    check("so is a GPT model on any provider", maxOutputTokens({ provider: "openrouter", model: "openai/gpt-5.5" }, undefined) === LARGE_OUTPUT_TOKEN_MAX)
    check("and anything on a MiMo provider", maxOutputTokens({ provider: "xiaomi", model: "anything" }, { maxOutput: 8_000 }) === LARGE_OUTPUT_TOKEN_MAX)
    check("another model keeps a smaller ceiling of its own", maxOutputTokens({ provider: "lmstudio", model: "qwen3" }, { maxOutput: 16_000 }) === 16_000)
    check("but no more than 32k", maxOutputTokens({ provider: "lmstudio", model: "qwen3" }, { maxOutput: 100_000 }) === OUTPUT_TOKEN_MAX)
    check("and 32k when its ceiling is unknown", maxOutputTokens({ provider: "lmstudio", model: "qwen3" }, { maxOutput: 0 }) === OUTPUT_TOKEN_MAX)
    const budgeted = anthropicReasoning("claude-haiku-4-5", "max", ["high", "max"], false, 20_000, 64_000)
    check(
      "a thinking budget is cut from the model's own limit and kept under max_tokens",
      budgeted.thinking?.type === "enabled" && budgeted.thinking.budget_tokens === 19_999,
      budgeted,
    )
    const high = anthropicReasoning("claude-haiku-4-5", "high", ["high", "max"], false, 64_000, 64_000)
    check("high is min(16000, limit / 2 - 1)", high.thinking?.type === "enabled" && high.thinking.budget_tokens === 16_000, high)
  }

  section("Round 5: the compaction trigger (E9)")
  {
    check("a 200k model compacts at 180k, not 168k", usableContext({ contextWindow: 200_000 }) === 180_000, usableContext({ contextWindow: 200_000 }))
    check("an unknown window never compacts by count", usableContext({ contextWindow: 0 }) === 0)
    const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    check("179,999 tokens is under the line", !isOverflowByCount({ ...zero, input: 100_000, cacheRead: 79_999 }, { contextWindow: 200_000 }))
    check("180,000 reaches it, reasoning and cache writes counted", isOverflowByCount({ ...zero, input: 100_000, reasoning: 30_000, cacheWrite: 50_000 }, { contextWindow: 200_000 }))
  }

  section("Round 5: usage and cost for cached and reasoning tokens (E11)")
  {
    const million = { input: 1_000_000, output: 1_000_000, reasoning: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }
    const priced = costOf(million, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    check("cache reads and writes have their own prices and reasoning is billed as output", Math.abs(priced - 61.75) < 1e-9, priced)
    check("a missing cache price counts as nothing", Math.abs(costOf(million, { input: 5, output: 25 }) - 55) < 1e-9)
    check("a model with no pricing costs nothing", costOf(million, undefined) === 0)
    const local = usageOf({ prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400 } }, "lmstudio")
    check(
      "a chat-completions prompt count no longer bills its cached tokens as fresh input",
      local.input === 600 && local.cacheRead === 400 && local.output === 300 && local.reasoning === 0,
      local,
    )
    const routed = usageOf(
      { prompt_tokens: 1000, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 50 } },
      "openrouter",
    )
    check(
      "OpenRouter's cache writes and reasoning are split out as well",
      routed.input === 500 && routed.cacheWrite === 100 && routed.output === 250 && routed.reasoning === 50,
      routed,
    )
  }
}
