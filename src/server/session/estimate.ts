/**
 * How big a piece of text is before it is sent, without asking the provider.
 *
 * MiMo's `src/util/token.ts`: four characters to a token, rounded, never
 * negative. Crude, and deliberately so - everything that has to size something
 * before a request exists uses it (the pruning thresholds, the compaction tail
 * budget, the tool-result shrink), and all of those compare an estimate against
 * another estimate, so a consistent bias costs nothing.
 *
 * Until this existed MCode could only size a conversation from the usage figures
 * a provider reported *after* a step, which is why it had no way to trim
 * anything on the way out.
 */

/** MiMo's `CHARS_PER_TOKEN`. */
export const CHARS_PER_TOKEN = 4

/** MiMo's `estimate`. */
export function estimateTokens(input: string | undefined): number {
  return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
}

/**
 * MiMo's `parseQuantity`: a setting written as a plain number, a percentage of
 * something, or a count with a K or M suffix.
 *
 * `"20%"` needs `relativeTo` and is refused without it; a percentage outside
 * (0, 100] is refused. `K` is 1,000 and `M` is 1,000,000 - decimal, not binary,
 * which is what MiMo uses here (the model-limit settings elsewhere in this app
 * use 1024 and are a different reading of "K" on purpose).
 *
 * @returns the count, or undefined when the text is not a quantity.
 */
export function parseQuantity(input: string | number | undefined, relativeTo?: number): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.floor(input) : undefined
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  if (trimmed.endsWith("%")) {
    if (relativeTo === undefined) return undefined
    const percent = Number.parseFloat(trimmed.slice(0, -1))
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return undefined
    return Math.floor((relativeTo * percent) / 100)
  }
  const found = /^(\d+(?:\.\d+)?)([KkMm]?)$/.exec(trimmed)
  if (!found) return undefined
  const scale = found[2] === "" ? 1 : found[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000
  return Math.floor(Number.parseFloat(found[1]!) * scale)
}

/** MiMo's `format`, for saying a count back to the reader. */
export function formatQuantity(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return `${value}`
}
