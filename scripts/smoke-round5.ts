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
}
