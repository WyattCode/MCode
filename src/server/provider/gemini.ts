import type { Effort, ModelRef } from "@shared/protocol"
import type { TurnRequest } from "./types"

/** Implementation capabilities, not a claim to implement Gemini's native API. */
export interface GeminiCompatibleCapabilities {
  reasoningEfforts: readonly Effort[]
  canDisableThinking: boolean
  nativeProtocol: false
  thoughtSignatureReplay: false
}

export function isGemini(model: ModelRef): boolean {
  return model.provider.toLowerCase() === "google" || model.model.toLowerCase().includes("gemini")
}

/**
 * Conservative allowlist for the text thinking families this compatible path
 * maps. Unknown generations/modalities keep server defaults until verified.
 * https://ai.google.dev/gemini-api/docs/openai#thinking
 */
export function geminiCapabilities(model: ModelRef): GeminiCompatibleCapabilities | undefined {
  if (!isGemini(model)) return undefined
  const id = model.model.toLowerCase()
  const budget = /gemini-2[.-]5-(?:pro|flash)(?:-|$)/.test(id)
  const level = /gemini-3(?:[.-]\d+)?-(?:pro|flash)(?:-|$)/.test(id)
  const text = !/(?:image|live|tts|embedding)/.test(id)
  const canDisableThinking = budget && text && id.includes("flash")
  const pro3 = /gemini-3(?:[.-]0)?-pro(?:-|$)/.test(id)
  const reasoningEfforts: Effort[] = !text ? [] : budget
    ? [...(canDisableThinking ? ["none" as const] : []), "low", "medium", "high"]
    : level ? pro3 ? ["low", "high"] : id.includes("pro") ? ["low", "medium", "high"] : ["minimal", "low", "medium", "high"] : []
  return { reasoningEfforts, canDisableThinking, nativeProtocol: false, thoughtSignatureReplay: false }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

type OptionsRequest = Pick<TurnRequest, "model" | "effort" | "variants" | "thinkingOff" | "extra">

/** One place owns effort and extra-body precedence before JSON serialization. */
export function compatibleOptions(request: OptionsRequest): Record<string, unknown> {
  const capabilities = geminiCapabilities(request.model)
  if (!capabilities) {
    return {
      ...(request.variants && !request.variants.includes(request.effort) ? {} : { reasoning_effort: request.effort }),
      ...request.extra,
    }
  }
  const extra = { ...request.extra }
  // This field is owned here: stale generic extras must not bypass the capability check.
  delete extra.reasoning_effort
  const google = record(record(extra.extra_body)?.google)
  const thinking = record(google?.thinking_config)
  // Google rejects effort together with a native budget/level; preserve the explicit native choice.
  if (thinking && ("thinking_budget" in thinking || "thinking_level" in thinking)) return extra
  if (!request.thinkingOff && request.variants && !request.variants.includes(request.effort)) return extra
  let effort = request.thinkingOff ? "none" : request.effort
  if (effort === "xhigh" || effort === "max") effort = "high"
  if (effort === "minimal" && !capabilities.reasoningEfforts.includes("minimal")) effort = "low"
  if (effort === "medium" && capabilities.reasoningEfforts.join() === "low,high") effort = "high"
  if (!capabilities.reasoningEfforts.some((level) => level === effort)) return extra
  return { ...extra, reasoning_effort: effort }
}
