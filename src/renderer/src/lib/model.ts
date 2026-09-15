import type { Effort, ModelInfo, ModelRef, ProviderStatus } from "@shared/protocol"

/**
 * Reading the model record the server sends, and the reasoning steps on it.
 *
 * All of it is transcribed from the reference's own model store rather than
 * decided here, because every one of these rules is a rule about a specific
 * model and getting one wrong shows up as a control that does nothing.
 */

/** The record for a session's model, or nothing while the list is still loading. */
export function findModel(providers: readonly ProviderStatus[], ref?: ModelRef): ModelInfo | undefined {
  if (!ref) return undefined
  const provider = providers.find((entry) => entry.id === ref.provider)
  return provider?.models.find((entry) => entry.id === ref.model)
}

/**
 * The next step along, with "follow the default" between the last and the first.
 *
 * `cycleModelVariant` (@2829562), minus the same `configured` arm: an empty
 * list changes nothing at all, a step the model does not take starts again at
 * the first, and walking off the end returns to no setting rather than wrapping
 * - unset is not a sixth level, it is the session deferring to the app default,
 * and this is the only way back to it from the keyboard.
 */
export function cycleVariant(variants: readonly Effort[], selected?: Effort): Effort | undefined {
  if (!variants.length) return undefined
  const at = selected ? variants.indexOf(selected) : -1
  if (at === -1) return variants[0]
  return at + 1 >= variants.length ? undefined : variants[at + 1]
}

/**
 * The level a model runs at once it is chosen, as MiMo clamps it: the level
 * already set if this model offers it, else medium, else the model's first.
 * A model without levels has none. The menu no longer has a "follow the
 * default" row, so a model with levels always has one named.
 */
export function clampEffort(variants: readonly Effort[], level?: Effort): Effort | undefined {
  if (!variants.length) return undefined
  if (level && variants.includes(level)) return level
  return variants.includes("medium") ? "medium" : variants[0]
}

/** The families MiMo draws a round vendor badge for in the model menu. */
export type ModelFamily = "claude" | "openai" | "gemini" | "deepseek" | "kimi" | "glm" | "minimax" | "qwen" | "hunyuan"

/*
 * MCode's own ordered table: the first entry found in the model's id or name
 * wins. It reads the model, not the provider serving it, so a Claude model
 * behind an OpenAI-compatible gateway still wears Claude's mark.
 */
const FAMILY_MATCH: [RegExp, ModelFamily][] = [
  [/claude|opus|sonnet|haiku/, "claude"],
  [/gemini/, "gemini"],
  [/deepseek/, "deepseek"],
  [/kimi|moonshot/, "kimi"],
  [/glm|chatglm|zhipu/, "glm"],
  [/minimax|abab/, "minimax"],
  [/qwen|qwq/, "qwen"],
  [/hunyuan/, "hunyuan"],
  [/gpt|codex|(^|[^a-z0-9])o[1-9]([^a-z0-9]|$)/, "openai"],
]

export function modelFamily(id: string, name = ""): ModelFamily | undefined {
  const text = `${id} ${name}`.toLowerCase()
  return FAMILY_MATCH.find(([pattern]) => pattern.test(text))?.[1]
}

/** Which of MiMo's two sets of level names a model's levels are read with. */
export function effortFamily(id: string, name = ""): "claude" | "gpt" {
  return modelFamily(id, name) === "claude" ? "claude" : "gpt"
}

const CLAUDE_LEVELS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]

/*
 * The string key naming a level for a model. Claude's set has no none or
 * minimal, so those (never offered to a Claude model) fall back to the other.
 */
export function effortLabelKey(id: string, name: string, level: Effort): string {
  const family = effortFamily(id, name) === "claude" && CLAUDE_LEVELS.includes(level) ? "claude" : "gpt"
  return `effort.${family}.${level}`
}

/**
 * The reference strips "(latest)" out of a model's name and shows it as a tag.
 *
 * `list()` in its model store (@2779029) is
 * `name: m.name.replace("(latest)", "").trim(), latest: m.name.includes("(latest)")`.
 * It is a property of the name the provider gives, not of anything on the wire,
 * so nothing had to be added to the protocol to show it.
 */
export function withoutLatest(name: string): string {
  return name.replace("(latest)", "").trim()
}

export function isLatest(name: string): boolean {
  return name.includes("(latest)")
}
