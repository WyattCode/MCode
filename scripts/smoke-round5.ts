/**
 * Round 5: the turn loop, the providers, the context and the prompt, measured
 * against MiMo's engine. Kept apart from smoke.ts so the sections read as one
 * account; smoke.ts calls `roundFiveChecks` with its own check and section.
 *
 * Every request a provider would receive is inspected on the wire or through
 * the pure function that builds it. No model is called.
 */
import { LARGE_OUTPUT_TOKEN_MAX, OUTPUT_TOKEN_MAX, maxOutputTokens } from "../src/server/session/overflow"
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
}
