/**
 * Which reasoning efforts a given model actually accepts.
 *
 * The reference decides this in one function - `exports_transform.variants` in
 * out/main/chunks/node-BBwF64dM.js @22185521 - and the whole point of it is
 * that the answer is per model, not global. GPT-5-Pro takes exactly one level;
 * Claude 4.6 takes four and has no `xhigh`; a plain chat model takes none, and
 * the reference then draws no effort control at all rather than one whose every
 * setting the provider ignores.
 *
 * What is transcribed here is that function and the named constants it reads,
 * scoped to the three provider kinds this app has. Everything else in the
 * reference's switch is about SDKs this app does not speak (Bedrock, Vertex,
 * the Copilot and Gateway resellers) and copying it would be fiction.
 *
 * The one thing `narrow` at the end still drops is `thinking`, the key the
 * MiniMax-M3 arm produces. Nothing here can reach it - the same function
 * excludes every `minimax` id a few lines later - so it is a guard rather than
 * a narrowing. `none` and `minimal` used to be dropped here as well, on the
 * grounds that `Effort` could not hold them; `Effort` now holds all seven of
 * the reference's ids, so every level a model accepts survives to the picker.
 */
import { EFFORTS, type Effort } from "@shared/protocol"
import type { ModelEntry, ProviderKind } from "./catalog"

/** node-BBwF64dM.js @22219232, verbatim. */
const WIDELY_SUPPORTED = ["low", "medium", "high"]
const OPENAI = ["none", "minimal", ...WIDELY_SUPPORTED, "xhigh"]
const OPENAI_GPT5_1 = ["none", ...WIDELY_SUPPORTED]
const OPENAI_GPT5_2_PLUS = [...OPENAI_GPT5_1, "xhigh"]
const OPENAI_GPT5_PRO = ["high"]
const OPENAI_GPT5_PRO_2_PLUS = ["medium", "high", "xhigh"]
const OPENAI_GPT5_CHAT = ["medium"]
const OPENAI_GPT5_CODEX_XHIGH = [...WIDELY_SUPPORTED, "xhigh"]
const OPENAI_GPT5_CODEX_3_PLUS = ["none", ...OPENAI_GPT5_CODEX_XHIGH]

const GPT5_FAMILY = /(?:^|\/)gpt-5(?:[.-]|$)/
const GPT5_VERSION = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/
const GPT5_PRO = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/
const GPT5_VERSIONED_PRO = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/

function gpt5Version(id: string): number | undefined {
  const found = GPT5_VERSION.exec(id)
  return found ? Number(found[1]) : undefined
}

/** @22181959 */
function gpt5Chat(id: string): string[] | undefined {
  if (!GPT5_FAMILY.test(id) || !id.includes("-chat")) return undefined
  return gpt5Version(id) === undefined ? [] : OPENAI_GPT5_CHAT
}

/** @22181551 */
function gpt5Codex(id: string): string[] | undefined {
  if (!GPT5_FAMILY.test(id) || !id.includes("codex")) return undefined
  const version = gpt5Version(id)
  if (version !== undefined && version >= 3) return OPENAI_GPT5_CODEX_3_PLUS
  if (id.includes("codex-max") || (version !== undefined && version >= 2)) return OPENAI_GPT5_CODEX_XHIGH
  return WIDELY_SUPPORTED
}

/** @22181243 */
function versionedGpt5(id: string): string[] | undefined {
  if (GPT5_VERSIONED_PRO.test(id)) return OPENAI_GPT5_PRO_2_PLUS
  const version = gpt5Version(id)
  if (version === undefined) return undefined
  if (version === 1) return OPENAI_GPT5_1
  return OPENAI_GPT5_2_PLUS
}

/**
 * @22182982. The date-free sibling of `openaiReasoningEfforts`, and the right
 * one here: this app keeps no release date for a model, and the reference
 * itself falls back to this function wherever it has none either.
 */
function openaiCompatibleEfforts(id: string): string[] {
  const lower = id.toLowerCase()
  const chat = gpt5Chat(lower)
  if (chat) return chat
  if (GPT5_PRO.test(lower)) return OPENAI_GPT5_PRO
  return gpt5Codex(lower) ?? versionedGpt5(lower) ?? OPENAI
}

/** @22182982, second half: "claude-N" where N > 4, or 4.7 and later. */
function anthropicModernAdaptive(id: string): boolean {
  if (!id.toLowerCase().includes("claude-")) return false
  const version = /claude-(?:[a-z]+-)?(\d+)(?:[.-](\d{1,2}))?(?:[.@-]|$)/i.exec(id)
  if (!version) return true
  const major = Number(version[1])
  const minor = Number(version[2] ?? 0)
  return major > 4 || (major === 4 && minor >= 7)
}

/**
 * @22183713
 *
 * Exported because the adapter needs the same answer this table does: the
 * reference's `anthropicEffort` (@22215853) branches on exactly these two
 * predicates to decide whether a chosen level is expressed as adaptive
 * thinking, as a thinking budget beside an effort, or as a budget alone.
 */
export function anthropicOpus45(id: string): boolean {
  return ["opus-4-5", "opus-4.5"].some((mark) => id.includes(mark))
}

/** Whether this model takes adaptive thinking at all. @22183825 */
export function anthropicAdaptive(id: string): boolean {
  return anthropicAdaptiveEfforts(id) !== null
}

/**
 * Whether the reference asks for a summarized display on this model.
 *
 * `anthropicOmitsThinking` (@22184191) is `anthropicUsesModernAdaptiveThinking`
 * under another name, and it is the only thing that decides whether `display`
 * appears in the adaptive block at all.
 */
export function anthropicModern(id: string): boolean {
  return anthropicModernAdaptive(id)
}

/** @22183825 */
function anthropicAdaptiveEfforts(id: string): string[] | null {
  if (anthropicModernAdaptive(id)) return ["low", "medium", "high", "xhigh", "max"]
  const four6 = ["opus-4-6", "opus-4.6", "4-6-opus", "4.6-opus", "sonnet-4-6", "sonnet-4.6", "4-6-sonnet", "4.6-sonnet"]
  if (four6.some((mark) => id.includes(mark))) return ["low", "medium", "high", "max"]
  return null
}

/**
 * The families MiMo names and then offers no effort for: they reason, but not
 * by an effort parameter, so sending one is a field the provider drops. Grok
 * is here except grok-3-mini, which has its own pair.
 */
function excluded(id: string): boolean {
  return (
    ["minimax", "glm", "mistral", "kimi", "k2p", "qwen", "big-pickle"].some((mark) => id.includes(mark)) ||
    (id.includes("grok") && !id.includes("grok-3-mini"))
  )
}

/** Only the levels the `Effort` union names, in the order they were given. */
function narrow(efforts: readonly string[]): Effort[] {
  const known = new Set<string>(EFFORTS)
  return efforts.filter((effort): effort is Effort => known.has(effort))
}

/**
 * The effort menu for one model, empty when it has none.
 *
 * `entry.efforts` is the reference's `reasoning_options` reaching us directly -
 * a table entry that states the answer, including the meaningful empty list
 * that says "reasons, but takes no effort parameter". Absent, the reference's
 * own heuristic runs instead, which is the code path it uses when models.dev
 * says nothing.
 */
export function modelVariants(kind: ProviderKind, entry: ModelEntry, provider?: string): Effort[] {
  // @22185521: `if (!model.capabilities.reasoning) return {}` is the first line
  // of the function, and it is the whole reason a chat model shows no pill.
  if (!entry.reasoning) return []
  if (entry.efforts) return narrow(entry.efforts)

  const id = entry.id.toLowerCase()
  if (excluded(id)) return []
  if (id.includes("grok-3-mini")) return narrow(["low", "high"])
  // MiMo steers DeepSeek's reasoning only on DeepSeek's own provider, with its high and max.
  if (id.includes("deepseek")) return provider === "deepseek" && kind === "openai-compatible" ? narrow(["high", "max"]) : []

  if (kind === "anthropic") {
    const adaptive = anthropicAdaptiveEfforts(id)
    if (adaptive) return narrow(adaptive)
    if (anthropicOpus45(id)) return narrow(WIDELY_SUPPORTED)
    /*
     * The budget-token branch. The reference computes two token budgets here
     * and calls them `high` and `max`; this app sends an effort word rather
     * than a budget, so what carries over is the pair of levels, not the
     * arithmetic behind them.
     */
    return narrow(["high", "max"])
  }

  // The Responses API, subscription or custom: MiMo's `@ai-sdk/openai` arm.
  if (kind === "chatgpt" || kind === "openai-responses") return narrow(openaiCompatibleEfforts(id))

  // MiMo's OpenAI-compatible arm: the three widely supported levels.
  return narrow(WIDELY_SUPPORTED)
}
