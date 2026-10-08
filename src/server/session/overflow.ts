import Anthropic from "@anthropic-ai/sdk"
import type { ModelRef } from "@shared/protocol"
import type { ModelEntry } from "../config"
import { ProviderError, ProviderHttpError } from "../provider/types"

/**
 * When a conversation has outgrown its model, and by how much a request may
 * ask for. MiMo's trigger and output rule; the overflow phrasings are the ones
 * its engine inherits from OpenCode.
 *
 * Two triggers (MiMo's `isOverflow` and `isContextOverflow`):
 *
 *  - by count: after a step, once the tokens the provider reports have reached
 *    90% of the context window;
 *  - by error: a provider that refuses the request with one of the phrasings
 *    below, which a model whose limits are not known (`contextWindow: 0`, as
 *    a discovered model is) can only be caught by.
 *
 * The screen this was written for showed the second: a discovered vLLM model
 * answering 400 with "maximum context length is 262144 tokens" after 230k of
 * transcript had been sent with a 32k answer requested on top, and nothing
 * catching it - the turn simply ended in red.
 */

/** What a model outside the large-output rule is asked for when its own ceiling is not known (MiMo's and v2's fallback). */
export const OUTPUT_TOKEN_MAX = 32_000

/** OpenCode v2's `OUTPUT_TOKEN_MAX` (49403a55): no reply needs more, however much the model allows. */
export const OUTPUT_TOKEN_CEILING = 256_000

/** What MiMo asks of a Claude, GPT or MiMo model, whatever that model's own ceiling says. */
export const LARGE_OUTPUT_TOKEN_MAX = 128_000

/** MiMo's compaction trigger: this share of the model's window (`MIMOCODE_COMPACTION_TRIGGER_RATIO`). */
export const COMPACTION_TRIGGER_RATIO = 0.9

/**
 * How many output tokens a request asks for: 128k for a MiMo provider or any
 * model whose id names Claude, GPT or MiMo (MiMo's rule); otherwise the
 * model's own ceiling when known, up to 256k, else 32k (OpenCode v2's).
 *
 * MiMo held every other model to 32k whatever its ceiling said, so a model
 * set up with 64k still got 32k - and a thinking model that needed 39k of
 * thought for a drawing (the user's pelican on a local Qwen) was cut before
 * it wrote a line, every time. `fitOutput` then holds the figure to what the
 * window has left; an Anthropic request is held to the model's own ceiling by
 * the adapter, as MiMo's SDK does for a model it knows.
 */
export function maxOutputTokens(model: Pick<ModelRef, "provider" | "model">, entry: Pick<ModelEntry, "maxOutput"> | undefined): number {
  const provider = model.provider.toLowerCase()
  const id = model.model.toLowerCase()
  if (provider === "mimo" || provider === "xiaomi" || /claude|gpt|mimo/.test(id)) return LARGE_OUTPUT_TOKEN_MAX
  const own = entry?.maxOutput ?? 0
  return own > 0 ? Math.min(own, OUTPUT_TOKEN_CEILING) : OUTPUT_TOKEN_MAX
}

/** OpenCode v2's `SUMMARY_OUTPUT_MAX`: a summary never needs more. */
export const SUMMARY_OUTPUT_MAX = 32_000

/**
 * The least a reply is given room for once the window is nearly full. v2's is
 * 1024; MCode's is higher because a thinking budget must stay under the
 * output limit and is never below 1024 itself, and because a conversation with
 * less room than this wants compacting, which a refusal brings about, not a
 * reply cut short.
 */
export const OUTPUT_FLOOR = 4_096

/** OpenCode v2's `ESTIMATE_ERROR`: text estimated at four characters a token can run low on dense text. */
export const ESTIMATE_ERROR = 0.15

/**
 * How many output tokens to ask for, fitted to the room the window has left
 * (OpenCode v2's `outputLimit`, d9987ef9, MIT).
 *
 * A server that checks the prompt and the requested output together against
 * the window - vLLM, llama.cpp, LM Studio and the gateways in front of them -
 * refuses a request whose sum is over, however short the answer would have
 * been. Asking a 64k local model for 32k of output put every conversation past
 * half its window into that refusal, and so into compaction long before the
 * count trigger at 90%. `measured` is what the provider reported for the last
 * request, `estimated` the text sent since; with no window known, nothing is
 * fitted.
 */
export function fitOutput(requested: number, entry: Pick<ModelEntry, "contextWindow"> | undefined, prompt: { measured: number; estimated: number }): number {
  const window = entry?.contextWindow ?? 0
  if (window <= 0) return requested
  const room = window - prompt.measured - Math.ceil(prompt.estimated * (1 + ESTIMATE_ERROR))
  return Math.min(requested, Math.max(OUTPUT_FLOOR, room))
}

/**
 * A request's size from the last one a provider reported on: that report plus
 * what the estimate grew by, the growth with a margin. A history that shrank -
 * a crop, an undo, older output pruned - is the report less what went, with no
 * margin: estimating the whole request instead runs far short on Chinese text.
 * With no report for this model - none yet, another model, or one cleared by
 * a compaction - the whole request is estimated.
 */
export function promptSince(
  anchor: { model: string; measured: number; estimated: number } | undefined,
  model: string,
  estimated: number,
): { measured: number; estimated: number } {
  if (!anchor || anchor.model !== model) return { measured: 0, estimated }
  const grown = estimated - anchor.estimated
  return grown >= 0 ? { measured: anchor.measured, estimated: grown } : { measured: Math.max(0, anchor.measured + grown), estimated: 0 }
}

/**
 * The room a conversation has before it must be compacted: MiMo's `usable`,
 * 90% of the model's window with nothing held back for the answer (180k of a
 * 200k model). 0 when the window is not known, which never compacts by count.
 */
export function usableContext(entry: Pick<ModelEntry, "contextWindow"> | undefined): number {
  const context = entry?.contextWindow ?? 0
  if (context <= 0) return 0
  return Math.floor(context * COMPACTION_TRIGGER_RATIO)
}

/**
 * How near the line a conversation is before a tool's output is halved.
 *
 * MiMo passes `pressureCaps` into its truncation and thereby halves both
 * limits; what makes it decide to is not readable from the bundle, so this
 * figure is MCode's own. Seven tenths of the usable room: far enough back that
 * halving still has something to save, and not so early that ordinary turns
 * lose half of every result.
 */
export const OUTPUT_PRESSURE_RATIO = 0.7

/** The whole count the provider reported for a step, which is what both tests read. */
function totalOf(tokens: { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number }): number {
  return tokens.input + tokens.output + (tokens.reasoning ?? 0) + tokens.cacheRead + tokens.cacheWrite
}

/** Whether this conversation is close enough to its compaction line to cap tool output at half. */
export function underPressure(
  tokens: { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number },
  entry: Pick<ModelEntry, "contextWindow"> | undefined,
): boolean {
  const usable = usableContext(entry)
  if (usable === 0) return false
  return totalOf(tokens) >= usable * OUTPUT_PRESSURE_RATIO
}

/**
 * MiMo's `isOverflow`: the step's whole count - fresh input, output, reasoning
 * and both cache figures, which together are the provider's total - has
 * reached the usable room. False for a model with no known window.
 */
export function isOverflowByCount(
  tokens: { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number },
  entry: Pick<ModelEntry, "contextWindow"> | undefined,
): boolean {
  const usable = usableContext(entry)
  if (usable === 0) return false
  return contextCount(tokens) >= usable
}

/**
 * How much of the window a step's report accounts for: fresh input, output,
 * reasoning and both cache figures, which together are the provider's total.
 *
 * One definition, used by the overflow trigger above and by the graded pressure
 * level pruning reads (session/prune.ts), so the two can never drift apart.
 * MiMo folds reasoning into output when it reads a usage frame and so does not
 * add it separately here; MCode keeps it apart and therefore counts it, which
 * makes it compact marginally sooner on a reasoning model.
 */
export function contextCount(tokens: { input: number; output: number; reasoning?: number; cacheRead: number; cacheWrite: number }): number {
  return tokens.input + tokens.output + (tokens.reasoning ?? 0) + tokens.cacheRead + tokens.cacheWrite
}

/**
 * The reference's `patterns`, brought up to OpenCode v2's `provider-error.ts`
 * at 7e42a897 (MIT): Zhipu's and Qwen's own wordings among them, which ended
 * the turn red instead of compacting it.
 */
const PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  // Cloudflare Workers AI, as HTTP 413 (v2 a80a0001).
  /exceeded this model context window limit/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  // Amazon Nova on Bedrock, mid-stream (v2 599bdc98).
  /number of input tokens exceeds maximum length/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  // Hugging Face Text Generation Inference, as Together serves it (v2 5d707f1a).
  /`inputs` tokens \+ `max_new_tokens` must be <= \d+/i,
  // DeepInfra (v2 9c4c5870).
  /requested input length \d+ exceeds maximum input length/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  // Novita leaves the counts out (v2 f0f4c94c).
  /input(?: \(\d+ tokens\))? is longer than the model'?s context length/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  // Zhipu / Z.ai code 1261, as "Prompt too long" or "Prompt 超长" (v2 a931e8a9).
  /prompt (?:too long|超长)/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  // Alibaba DashScope (Qwen): "Range of input length should be [1, 129024]".
  /range of input length should be/i,
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

/**
 * The same question asked of the failure itself, not only of its sentence.
 *
 * MiMo checks the status and the body's own code independently of the wording:
 * `isOverflow(message) || statusCode === 413 || body.error.code ===
 * "context_length_exceeded"`. Reading the sentence alone caught a bare "413 (no
 * body)" and nothing else, so a 413 that carried a JSON body - which is the
 * ordinary shape - matched none of the phrasings and the turn ended red instead
 * of being compacted and replayed. That is the exact failure the note at the top
 * of this file says this code exists to prevent.
 *
 * @param message what the failure says, which the callers have already gathered
 *   from its causes.
 */
export function isOverflowError(err: unknown, message: string): boolean {
  const status = err instanceof ProviderHttpError ? err.status : err instanceof Anthropic.APIError ? err.status : undefined
  if (status === 413) return true
  const wire = err instanceof ProviderError || err instanceof ProviderHttpError ? err.wire : undefined
  if (wire?.code === "context_length_exceeded" || wire?.type === "context_length_exceeded") return true
  return isContextOverflow(message)
}
