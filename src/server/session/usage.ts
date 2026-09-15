import type { Usage } from "@shared/protocol"
import type { ModelEntry } from "../provider/catalog"

/**
 * What a step cost, by MiMo's formula (`getUsage`).
 *
 * The figures it is given are already split the way MiMo splits them: `input`
 * is fresh input only, with cache reads and writes counted apart, and `output`
 * excludes reasoning, which is billed at the output price. A price the catalog
 * does not have counts as nothing, and a model with no pricing at all costs
 * nothing rather than a guessed rate.
 */
export function costOf(
  usage: Pick<Usage, "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite">,
  entry: Pick<ModelEntry, "input" | "output" | "cacheRead" | "cacheWrite"> | undefined,
): number {
  if (!entry) return 0
  const spent =
    usage.input * entry.input +
    usage.output * entry.output +
    usage.cacheRead * (entry.cacheRead ?? 0) +
    usage.cacheWrite * (entry.cacheWrite ?? 0) +
    usage.reasoning * entry.output
  return spent / 1_000_000
}
