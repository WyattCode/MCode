import type { CustomThinking, Effort } from "./protocol"

/**
 * The reasoning levels the model menu offers for a model, as MiMo's desktop
 * decides them: by the model's id and display name alone, never by the
 * provider serving it or by whether a catalog says it reasons.
 *
 * Only two families get a submenu. A Claude model does when it is one of the
 * lines that take an effort (3.7, 4.x, Sonnet 5, Fable, Mythos): the newest
 * take five levels, 4.6 and Mythos preview four (no xhigh), the rest three. A
 * GPT-5 or Codex model does unless it is a chat or GPT-5 Pro model: three
 * levels, xhigh from 5.2 on and max on 5.6. Everything else - MiMo's own
 * models, DeepSeek, Gemini, GLM, Kimi, Qwen - gets none, and then no level is
 * sent at all. `none` and `minimal` are never offered.
 *
 * What a chosen level becomes on the wire is the provider layer's business
 * (server/provider/variants.ts); this only decides what is offered.
 */
export function menuEfforts(id: string, name = ""): Effort[] {
  const text = [id, name].filter(Boolean).join(" ").toLowerCase()
  const family = text.replace(/[\s_]+/g, "-")
  if (family.includes("claude")) return claudeLevels(text)
  if (!family.includes("gpt")) return []
  if (text.includes("chat") || text.includes("gpt-5-pro")) return []
  if (!text.includes("gpt-5") && !text.includes("codex")) return []
  const levels: Effort[] = ["low", "medium", "high"]
  if (["5.2", "5.3", "5.4", "5.5", "5.6"].some((version) => text.includes(version))) levels.push("xhigh")
  if (text.includes("5.6")) levels.push("max")
  return levels
}

function claudeLevels(text: string): Effort[] {
  const dashed = text.replace(/\./g, "-")
  const lines = ["claude-3-7", "claude-4", "opus-4", "sonnet-4", "sonnet-5", "haiku-4", "fable", "mythos"]
  if (!lines.some((line) => dashed.includes(line))) return []
  const both = (a: string, b: string) => dashed.includes(a) && dashed.includes(b)
  if (dashed.includes("fable") || dashed.includes("mythos-5") || dashed.includes("sonnet-5") || both("opus", "4-8") || both("opus", "4-7")) {
    return ["low", "medium", "high", "xhigh", "max"]
  }
  if (dashed.includes("mythos-preview") || both("opus", "4-6") || both("sonnet", "4-6")) return ["low", "medium", "high", "max"]
  return ["low", "medium", "high"]
}

/** The levels a custom model may name, weakest first; `none` is the separate "can be turned off". */
export const THINKING_LEVELS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"]

/**
 * A custom model's `thinking` as it may be stored: only the levels above, once
 * each and in their own order, a default that is one of them, and `canOff`
 * only when true. Anything that is not an object is no thinking at all.
 */
export function thinkingOf(value: unknown): CustomThinking | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as { efforts?: unknown; canOff?: unknown; default?: unknown }
  const named = new Set(Array.isArray(raw.efforts) ? raw.efforts : [])
  const efforts = THINKING_LEVELS.filter((level) => named.has(level))
  return {
    efforts: [...efforts],
    ...(raw.canOff === true ? { canOff: true } : {}),
    ...(typeof raw.default === "string" && efforts.includes(raw.default as Effort) ? { default: raw.default as Effort } : {}),
  }
}

/**
 * The menu a custom model's own word gives it: `none` first when it can be
 * turned off, then the levels. A model that thinks but names no level has no
 * control to draw, so `none` alone is not a menu either.
 */
export function thinkingMenu(thinking: CustomThinking): Effort[] {
  return thinking.efforts.length ? [...(thinking.canOff ? (["none"] as const) : []), ...thinking.efforts] : []
}

/**
 * The level a turn sends: the app-wide choice if the menu offers it, else the
 * model's own default, else medium, else the menu's first; nothing when the
 * menu is empty.
 */
export function effortToSend(menu: readonly Effort[], chosen?: Effort, preferred?: Effort): Effort | undefined {
  if (!menu.length) return undefined
  if (chosen && menu.includes(chosen)) return chosen
  if (preferred && menu.includes(preferred)) return preferred
  return menu.includes("medium") ? "medium" : menu[0]
}
