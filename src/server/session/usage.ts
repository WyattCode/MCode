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
  entry: Pick<ModelEntry, "input" | "output" | "cacheRead" | "cacheWrite" | "over200K"> | undefined,
): number {
  if (!entry) return 0
  /*
   * MiMo's `getUsage`: once the prompt this step was billed for - fresh input
   * plus what was read from the cache - is past 200k, the whole step is priced
   * at the model's long-context rates. A model whose catalog entry has no such
   * tier keeps one set of prices, as it always did.
   */
  const rates = entry.over200K && usage.input + usage.cacheRead > OVER_200K ? entry.over200K : entry
  const spent =
    usage.input * rates.input +
    usage.output * rates.output +
    usage.cacheRead * (rates.cacheRead ?? 0) +
    usage.cacheWrite * (rates.cacheWrite ?? 0) +
    usage.reasoning * rates.output
  return spent / 1_000_000
}

/** Where MiMo switches to the long-context prices. */
const OVER_200K = 200_000
