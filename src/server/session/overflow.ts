import type { ModelRef } from "@shared/protocol"
import type { ModelEntry } from "../config"

/**
 * When a conversation has outgrown its model, and by how much a request may
 * ask for. The reference's numbers and its regexes, kept as they stand.
 *
 * Two triggers, both the reference's (`SessionCompaction.isOverflow` and
 * `ProviderError.isContextOverflow`):
 *
 *  - by count: after a step, once the tokens the provider reports have reached
 *    the context window less the room an answer needs;
 *  - by error: a provider that refuses the request with one of the phrasings
 *    below, which a model whose limits are not known (`contextWindow: 0`, as
 *    a discovered model is) can only be caught by.
 *
 * The screen this was written for showed the second: a discovered vLLM model
 * answering 400 with "maximum context length is 262144 tokens" after 230k of
 * transcript had been sent with a 32k answer requested on top, and nothing
 * catching it - the turn simply ended in red.
 */

/** MiMo's `OUTPUT_TOKEN_MAX`, for models outside its large-output rule. */
export const OUTPUT_TOKEN_MAX = 32_000

/** What MiMo asks of a Claude, GPT or MiMo model, whatever that model's own ceiling says. */
export const LARGE_OUTPUT_TOKEN_MAX = 128_000

/** The reference's `COMPACTION_BUFFER`. */
export const COMPACTION_BUFFER = 20_000

/**
 * What a summary may cost, from the reference's `SUMMARY_OUTPUT_TOKENS`.
 *
 * A summary is short, and asking for the full 32k is what stopped the first
 * attempt at this from working: a transcript of 230,145 tokens plus a 32,000
 * answer is 262,145, one token over the model that had just refused it, so
 * the summary was refused as well and the turn ended on the original error.
 * The reference asks for 4,096.
 */
export const SUMMARY_OUTPUT_TOKENS = 4_096

/** The reference's `CHARS_PER_TOKEN`. */
const CHARS_PER_TOKEN = 4

/** The reference's `Token.estimate`, over however many characters go out. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars / CHARS_PER_TOKEN))
}

/**
 * Whether a summary of this much text could be asked for at all.
 *
 * The reference's guard in `compactAfterOverflow`: it gives up rather than
 * send a request it can see will not fit. A model whose window is unknown
 * cannot be measured, so it is allowed through - the provider's own refusal
 * is then the answer, which is where this started.
 */
export function summaryWouldFit(chars: number, contextWindow: number): boolean {
  if (contextWindow <= 0) return true
  return estimateTokens(chars) <= contextWindow - SUMMARY_OUTPUT_TOKENS
}

/**
 * How many output tokens a request asks for, by MiMo's rule: 128k for a MiMo
 * provider or any model whose id names Claude, GPT or MiMo; otherwise the
 * model's own ceiling when known and under 32k, else 32k. An Anthropic request
 * is then held to the model's own ceiling by the adapter, as MiMo's SDK does
 * for a model it knows.
 */
export function maxOutputTokens(model: Pick<ModelRef, "provider" | "model">, entry: Pick<ModelEntry, "maxOutput"> | undefined): number {
  const provider = model.provider.toLowerCase()
  const id = model.model.toLowerCase()
  if (provider === "mimo" || provider === "xiaomi" || /claude|gpt|mimo/.test(id)) return LARGE_OUTPUT_TOKEN_MAX
  return Math.min(entry?.maxOutput ?? 0, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
}

/**
 * The room a conversation has before it must be compacted, or 0 when the
 * model's window is not known - the reference's `usable`, which returns 0 for
 * `limit.context === 0` and so never compacts by count for such a model.
 */
export function usableContext(entry: Pick<ModelEntry, "contextWindow" | "maxOutput"> | undefined): number {
  const context = entry?.contextWindow ?? 0
  if (context === 0) return 0
  return Math.max(0, context - (Math.min(entry?.maxOutput ?? 0, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX))
}

/** The reference's `isOverflow`: false for a model with no known window. */
export function isOverflowByCount(
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  entry: Pick<ModelEntry, "contextWindow" | "maxOutput"> | undefined,
): boolean {
  const usable = usableContext(entry)
  if (usable === 0) return false
  const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  return total >= usable
}

/** The reference's `patterns`, verbatim. */
const PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]

/** The reference's `exclusions`: a throttle that happens to mention limits is not an overflow. */
const EXCLUSIONS = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]

/**
 * Whether a provider's refusal means the conversation no longer fits. The
 * reference's `isContextOverflow`, including its reading of a bare
 * "400 (no body)" or "413 (no body)" as one.
 */
export function isContextOverflow(message: string): boolean {
  if (EXCLUSIONS.some((pattern) => pattern.test(message))) return false
  return PATTERNS.some((pattern) => pattern.test(message)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
}
