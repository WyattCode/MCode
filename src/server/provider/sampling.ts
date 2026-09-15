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
 * Body fields MiMo adds for two OpenAI-compatible providers: Zhipu's thinking
 * switch, and Alibaba's for a model that reasons.
 */
export function providerExtras(provider: string, reasoning: boolean): Record<string, unknown> {
  if (provider === "zhipu") return { thinking: { type: "enabled", clear_thinking: false } }
  if (provider === "dashscope" && reasoning) return { enable_thinking: true }
  return {}
}
