/**
 * MiMo's sampling parameters per model family, and the few provider switches
 * it sets beside them.
 *
 * Temperature goes out only for a model known to take one - MiMo reads the
 * same capability - while top-p and top-k follow the family alone. The first
 * family that matches decides the temperature, in MiMo's order.
 */

export interface Sampling {
  temperature?: number
  topP?: number
  topK?: number
}

function familyTemperature(id: string): number | undefined {
  if (id.includes("qwen")) return 0.55
  if (id.includes("claude")) return undefined
  if (id.includes("gemini")) return 1
  if (id.includes("glm-4.6") || id.includes("glm-4.7")) return 1
  if (id.includes("minimax-m2")) return 1
  if (id.includes("mimo")) return 1
  if (id.includes("kimi-k2")) return ["thinking", "k2.", "k2p", "k2-5"].some((mark) => id.includes(mark)) ? 1 : 0.6
  return undefined
}

function familyTopP(id: string): number | undefined {
  if (id.includes("qwen")) return 1
  if (id.includes("minimax-m2") || id.includes("gemini") || ["kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((mark) => id.includes(mark))) return 0.95
  return undefined
}

function familyTopK(id: string): number | undefined {
  if (id.includes("minimax-m2")) return ["m2.", "m25", "m21"].some((mark) => id.includes(mark)) ? 40 : 20
  if (id.includes("gemini")) return 64
  return undefined
}

/** The sampling a request for this model carries; `temperature` only when the model takes one. */
export function samplingFor(modelID: string, takesTemperature: boolean): Sampling {
  const id = modelID.toLowerCase()
  const temperature = takesTemperature ? familyTemperature(id) : undefined
  const topP = familyTopP(id)
  const topK = familyTopK(id)
  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
  }
}

/**
 * Body fields MiMo adds per provider, beside the ones every request carries
 * (its `transform.options`).
 *
 * The one with a visible consequence is OpenRouter's extended usage. MCode
 * already reads `cache_write_tokens` and `reasoning_tokens` back from an
 * OpenRouter frame (`usageOf`), but never asked for them - and OpenRouter only
 * sends them when the request says `usage: {include: true}`. So both read as
 * zero and every cached write and every reasoning token was billed at nothing:
 * the cost shown for an OpenRouter conversation was simply wrong.
 *
 * `prompt_cache_key` is what lets a provider hold a cached prefix for one
 * conversation rather than matching on content alone, and `store: false` keeps
 * xAI from retaining the request, which is MiMo's default there.
 *
 * Not ported: MiMo's `thinkingConfig` for Google. MiMo reaches Gemini through
 * the native Google SDK, where that field exists; MCode reaches it through
 * Google's OpenAI-compatible endpoint, which has no such field and would ignore
 * it. Sending it would be cargo-cult parity rather than the real thing.
 *
 * @param sessionID the conversation, which is what the cache key is keyed on;
 *   omitted for a request that belongs to no conversation.
 */
export function providerExtras(provider: string, reasoning: boolean, sessionID?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (provider === "zhipu") out.thinking = { type: "enabled", clear_thinking: false }
  if (provider === "dashscope" && reasoning) out.enable_thinking = true
  // MiMo asks openrouter and llmgateway for the usage figures MCode already reads.
  if (provider === "openrouter" || provider === "llmgateway") out.usage = { include: true }
  if (provider === "xai") out.store = false
  if (sessionID && (provider === "openai" || provider === "xai" || provider === "openrouter")) out.prompt_cache_key = sessionID
  return out
}
