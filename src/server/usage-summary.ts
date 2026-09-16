import type { ModelRef, Usage, UsageBucket, UsageSummary } from "@shared/protocol"

/** One request's spend: an assistant turn, or a request made on a conversation's behalf in the background. */
export interface UsageRecord {
  at: number
  model: ModelRef
  usage: Usage
  /** False for a background request (a title, Smart's routing, a compaction summary): it is spend, not a turn. */
  turn: boolean
}

const empty = (): Usage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })

function add(into: Usage, from: Usage): void {
  into.input += from.input
  into.output += from.output
  into.reasoning += from.reasoning
  into.cacheRead += from.cacheRead
  into.cacheWrite += from.cacheWrite
  into.cost += from.cost
}

/** A calendar day on this machine's clock, as YYYY-MM-DD. */
export function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * The usage page's figures, all over the same window of days: the totals,
 * each day (on this machine's calendar, not UTC's) and each model. A request
 * that used tokens but cost nothing is counted as unpriced - the catalog had
 * no price for its model - so the page can say so rather than show $0.00.
 */
export function summarizeUsage(records: readonly UsageRecord[], days: number, now = Date.now()): UsageSummary {
  const since = now - days * 24 * 60 * 60 * 1000
  const total = empty()
  const tally = { turns: 0, priced: 0, unpriced: 0 }
  const byDay = new Map<string, UsageBucket>()
  const byModel = new Map<string, UsageBucket>()
  const bucket = (map: Map<string, UsageBucket>, key: string) => {
    let found = map.get(key)
    if (!found) map.set(key, (found = { key, usage: empty(), turns: 0, priced: 0, unpriced: 0 }))
    return found
  }
  for (const record of records) {
    if (record.at < since) continue
    const spent = record.usage.input + record.usage.output + record.usage.reasoning + record.usage.cacheRead + record.usage.cacheWrite
    const priced = record.usage.cost > 0 ? 1 : 0
    const unpriced = !priced && spent > 0 ? 1 : 0
    const turns = record.turn ? 1 : 0
    for (const into of [bucket(byDay, localDay(record.at)), bucket(byModel, `${record.model.provider}/${record.model.model}`)]) {
      add(into.usage, record.usage)
      into.turns += turns
      into.priced += priced
      into.unpriced += unpriced
    }
    add(total, record.usage)
    tally.turns += turns
    tally.priced += priced
    tally.unpriced += unpriced
  }
  return {
    total,
    ...tally,
    days,
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byModel: [...byModel.values()].sort((a, b) => b.usage.cost - a.usage.cost || b.turns - a.turns),
  }
}
