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
/**
 * MiMo's `transform.smallOptions`: the cheap profile every out-of-band request
 * runs under.
 *
 * Naming a conversation, routing one message or reviewing a command is not work
 * a reasoning budget should be spent on, but MCode asked for these at the same
 * effort as a real turn - so on a reasoning model, titling a conversation could
 * think for as long as answering it. This turns the thinking off where the
 * provider has a way of being told to, and asks for the cheapest level
 * otherwise.
 *
 * @returns the effort to ask for, and any body fields that go with it.
 */
export function smallRequest(provider: string, modelID: string): { effort: string; extra: Record<string, unknown> } {
  const id = modelID.toLowerCase()
  // Reached over a gateway, a Google model takes a switch rather than a level.
  if ((provider === "openrouter" || provider === "llmgateway") && id.includes("google")) {
    return { effort: "minimal", extra: { reasoning: { enabled: false } } }
  }
  if (provider === "openrouter" || provider === "llmgateway") return { effort: "minimal", extra: {} }
  // MiMo asks GPT-5 for its lowest level and keeps the request unstored.
  if (id.includes("gpt-5")) {
    return { effort: id.includes("5.") || id.includes("5-mini") ? "low" : "minimal", extra: { store: false } }
  }
  return { effort: "low", extra: {} }
}

/** The OpenAI-compatible presets that are local servers, which read a chat template's switches as a typed-in endpoint does. */
const LOCAL_SERVERS = new Set(["lmstudio", "vllm", "ollama"])

/**
 * The body fields that switch a model's thinking off for one request, where
 * MCode knows them; undefined where it does not.
 *
 * Used for the one step after a reply the output limit cut while it was still
 * thinking. Measured on the user's local Qwen (2026-10-02): told to act on its
 * cut thinking, it thought 31k tokens more and was cut again; with thinking
 * off it wrote the 19k-character file at once. Zhipu and DashScope have their
 * own switches. A typed-in or local OpenAI-compatible server - vLLM, SGLang,
 * llama.cpp - passes `chat_template_kwargs` to the model's chat template:
 * `enable_thinking` for Qwen and GLM, `thinking` for DeepSeek and Kimi, as
 * OpenCode v2 sends both to Workers AI. Only to a server on this machine or
 * the local network: a typed-in endpoint can as well be a cloud API - the
 * official OpenAI one, Azure - which refuses a field it does not know, and the
 * step after the cut would then fail outright.
 */
export function thinkingOffExtra(provider: string, kind: string, handEntered: boolean, baseURL?: string): Record<string, unknown> | undefined {
  if (provider === "zhipu") return { thinking: { type: "disabled" } }
  if (provider === "dashscope") return { enable_thinking: false }
  if (kind === "openai-compatible" && (LOCAL_SERVERS.has(provider) || (handEntered && onLocalNetwork(baseURL)))) return { chat_template_kwargs: { enable_thinking: false, thinking: false } }
  return undefined
}

/** Whether an address is this machine or a private network: a model server someone runs, not a cloud API. */
export function onLocalNetwork(baseURL: string | undefined): boolean {
  let host: string
  try {
    host = new URL(baseURL ?? "").hostname.toLowerCase().replace(/^\[|\]$/g, "")
  } catch {
    return false
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "host.docker.internal") return true
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host)) return true
  const octets = host.split(".").map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = octets as [number, number, number, number]
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
}

/**
 * Whether a turn against this provider is a local one: the small model on this machine or the
 * LAN, whose reach for tools is what the reduced turn is built for.
 *
 * The endpoint the provider actually resolves to decides, not where the entry came from. The
 * rule used to ask whether the person had added the provider by hand, which reads the address
 * backwards in both directions: a shipped Ollama on `127.0.0.1` is the most local model there
 * is and was handed the full turn, while a hand-added DeepSeek behind
 * `https://api.deepseek.com` is a remote frontier model and was handed the reduced one. A
 * preset with no endpoint configured keeps what the preset is known to serve, since its
 * shipped default is this machine.
 */
export function isLocalEndpoint(provider: string, baseURL: string | undefined): boolean {
  return onLocalNetwork(baseURL) || (!baseURL && LOCAL_SERVERS.has(provider))
}

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
