import type { AssistantPart, Message, ToolPart, Usage } from "@shared/protocol"
import { estimateTokens } from "./estimate"
import { contextCount, usableContext } from "./overflow"
import type { ModelEntry } from "../config"

/**
 * Trimming what a turn re-sends, as MiMo's `src/session/prune.ts` does.
 *
 * Every step of a turn re-sends the whole conversation, so a turn that read
 * three large files pays for them again on every step after. MiMo answers that
 * by shrinking the *old* tool output in the request while leaving the recent
 * work untouched, and MCode did none of it - which is why it reached its
 * compaction trigger far sooner than MiMo on identical work, and then compacted
 * (losing everything) where MiMo would only have trimmed.
 *
 * Two rules keep this from costing more than it saves:
 *
 *  - it runs only while the prompt cache is **cold**. Rewriting history throws
 *    the provider's cached prefix away, so doing it to a warm cache would pay
 *    full price for the privilege of sending less. Once the cache has expired
 *    there is nothing left to lose.
 *  - it never touches the newest turn, and never the last `PRUNE_PROTECT`
 *    tokens of tool output, so what the model is actually working on is always
 *    there in full.
 *
 * Unlike MiMo this is **request-only**: the stored transcript keeps every tool
 * result whole and the window still shows it, and only the copy handed to the
 * provider is trimmed. MiMo rewrites its stored parts instead. Request-only is
 * the same saving without making the user's record lossy, and it stays honest
 * because the level is decided once per turn (see the runner) rather than being
 * recomputed per step - so the request does not flip between trimmed and whole
 * while a turn is running.
 */

/** MiMo's `SOFT_TRIM_THRESHOLD`: output longer than this is worth trimming at all. */
export const SOFT_TRIM_THRESHOLD = 4_096
/** MiMo's `SOFT_TRIM_KEEP_HEAD` / `SOFT_TRIM_KEEP_TAIL`. */
export const SOFT_TRIM_KEEP_HEAD = 1_536
export const SOFT_TRIM_KEEP_TAIL = 1_536
/** MiMo's `PRUNE_PROTECT`: the newest tool output, in estimated tokens, that is never touched. */
export const PRUNE_PROTECT = 40_000
/** MiMo's `PRUNE_MINIMUM`: below this there is not enough to reclaim to be worth clearing anything. */
export const PRUNE_MINIMUM = 20_000
/** MiMo's `PRUNE_PROTECTED_TOOLS`: a loaded skill is instructions, not output, so it is never pruned. */
export const PRUNE_PROTECTED_TOOLS = new Set(["skill"])
/** MiMo's `DEFAULT_CACHE_TTL`, in milliseconds. */
export const DEFAULT_CACHE_TTL_MS = 300_000
/** MiMo's `stripNonEssential` boundary: media and reasoning survive in this many newest turns. */
export const STRIP_KEEP_TURNS = 3

/** How long the provider holds a cached prefix for this model. */
function cacheTTLms(cacheTTL: "5m" | "1h" | undefined): number {
  return cacheTTL === "1h" ? 60 * 60 * 1000 : DEFAULT_CACHE_TTL_MS
}

/**
 * MiMo's `isCacheCold`: nothing has been written for longer than the cache
 * lives, so the prefix the provider had is gone and rewriting history is free.
 * A conversation with no reply yet counts as cold.
 */
export function isCacheCold(lastAssistantAt: number | undefined, cacheTTL: "5m" | "1h" | undefined, now = Date.now()): boolean {
  if (!lastAssistantAt) return true
  return now - lastAssistantAt > cacheTTLms(cacheTTL)
}

/**
 * MiMo's graded `pressureLevel`, against the same usable window the compaction
 * trigger uses: 0 below half, 1 below 0.7, 2 below 0.85, 3 above it. 0 for a
 * model whose window is not known, which is the same silence the count trigger
 * keeps for a discovered model.
 */
export function pressureLevel(tokens: Pick<Usage, "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite"> | undefined, entry: Pick<ModelEntry, "contextWindow"> | undefined): 0 | 1 | 2 | 3 {
  const usable = usableContext(entry)
  if (usable === 0 || !tokens) return 0
  const ratio = contextCount(tokens) / usable
  if (ratio < 0.5) return 0
  if (ratio < 0.7) return 1
  if (ratio < 0.85) return 2
  return 3
}

/** What a turn does to its own history, decided once before its first step. */
export type PruneLevel = 0 | 1 | 2

/**
 * The level this turn prunes at: MiMo's `pressure >= 2 ? 2 : 1`, and nothing at
 * all while the cache is still warm or the conversation is under half full.
 */
export function pruneLevelFor(input: {
  tokens: Pick<Usage, "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite"> | undefined
  entry: Pick<ModelEntry, "contextWindow"> | undefined
  lastAssistantAt: number | undefined
  cacheTTL?: "5m" | "1h"
  now?: number
}): PruneLevel {
  if (!isCacheCold(input.lastAssistantAt, input.cacheTTL, input.now)) return 0
  const pressure = pressureLevel(input.tokens, input.entry)
  if (pressure === 0) return 0
  return pressure >= 2 ? 2 : 1
}

/**
 * What the model reads in place of the middle of a long result.
 *
 * MCode's own wording. It names the original size, because the next thing a
 * model does with a truncated result is decide whether to go and get the rest.
 */
export function softTrimNote(original: number): string {
  return `\n\n[... MCode left out the middle of this result to save room: ${original} characters in all, the first ${SOFT_TRIM_KEEP_HEAD} and last ${SOFT_TRIM_KEEP_TAIL} are kept. Run the tool again if you need what is missing. ...]\n\n`
}

/** MiMo's soft trim: the head and the tail of a long result, with a note between them. */
export function softTrim(output: string): string {
  if (output.length <= SOFT_TRIM_THRESHOLD) return output
  return output.slice(0, SOFT_TRIM_KEEP_HEAD) + softTrimNote(output.length) + output.slice(-SOFT_TRIM_KEEP_TAIL)
}

/** What a cleared result reads as, in MCode's words (MiMo's `[Old tool result content cleared]`). */
export function clearedNote(name: string): string {
  return `[MCode cleared this older ${name} result to make room. Run the tool again if you need it.]`
}

/**
 * Which completed tool results this turn may trim, newest first.
 *
 * MiMo's selection loop, rule for rule: the newest turn is skipped entirely
 * (`turns < 2`), a compaction boundary ends the walk, `skill` results are never
 * taken, and a result is only a candidate once `PRUNE_PROTECT` tokens of newer
 * output have already been counted past.
 *
 * @returns the candidate parts and how many tokens clearing all of them frees.
 */
export function pruneCandidates(history: readonly Message[]): { parts: ToolPart[]; reclaimable: number } {
  const parts: ToolPart[] = []
  let total = 0
  let reclaimable = 0
  let turns = 0
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!
    if (message.role === "user") turns++
    // The turn in progress is never touched: it is what the model is working on.
    if (turns < 2) continue
    if (message.role !== "assistant") continue
    for (let at = message.parts.length - 1; at >= 0; at--) {
      const part = message.parts[at]!
      if (part.type !== "tool" || part.status !== "completed") continue
      if (PRUNE_PROTECTED_TOOLS.has(part.name)) continue
      const size = estimateTokens(part.output)
      total += size
      if (total > PRUNE_PROTECT) {
        reclaimable += size
        parts.push(part)
      }
    }
  }
  return { parts, reclaimable }
}

/**
 * MiMo's `stripNonEssential`: past the newest `STRIP_KEEP_TURNS` turns, a
 * model's own reasoning text and any media a result carried are dropped. The
 * words of the result stay - only the parts that cost the most and are read the
 * least go.
 */
function stripped(history: readonly Message[]): Message[] {
  let turns = 0
  let boundary = history.length
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index]!.role === "user") turns++
    if (turns > STRIP_KEEP_TURNS) {
      boundary = index
      break
    }
  }
  if (boundary >= history.length) return [...history]
  return history.map((message, index) => {
    if (index >= boundary || message.role !== "assistant") return message
    const parts: AssistantPart[] = message.parts.map((part) => {
      if (part.type === "reasoning" && part.text) return { ...part, text: "" }
      if (part.type === "tool" && part.attachments?.length) return { ...part, attachments: [] }
      return part
    })
    return { ...message, parts }
  })
}

/**
 * The history as this turn should send it. Request-only: nothing here is
 * written back to the store.
 *
 * Level 1 soft-trims every candidate over the threshold. Level 2 clears them
 * outright, but - as in MiMo - only when there is more than `PRUNE_MINIMUM` to
 * reclaim, since rewriting the whole prefix to save less than that is a bad
 * trade; either way level 2 also strips old reasoning and media.
 */
export function prunedHistory(history: Message[], level: PruneLevel): Message[] {
  if (level === 0) return history
  const { parts, reclaimable } = pruneCandidates(history)
  const clear = level === 2 && reclaimable > PRUNE_MINIMUM
  const rewrite = new Map<ToolPart, string>()
  for (const part of parts) {
    if (level === 1) {
      if ((part.output ?? "").length > SOFT_TRIM_THRESHOLD) rewrite.set(part, softTrim(part.output ?? ""))
    } else if (clear) {
      rewrite.set(part, clearedNote(part.name))
    }
  }

  const swapped =
    rewrite.size === 0
      ? history
      : history.map((message) => {
          if (message.role !== "assistant" || !message.parts.some((part) => part.type === "tool" && rewrite.has(part))) return message
          return {
            ...message,
            parts: message.parts.map((part) => {
              const next = part.type === "tool" ? rewrite.get(part) : undefined
              // A cleared result carries no media either, as MiMo drops both together.
              return next === undefined ? part : { ...part, output: next, ...(clear ? { attachments: [] } : {}) }
            }),
          }
        })

  return level === 2 ? stripped(swapped) : swapped
}
