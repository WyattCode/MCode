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
 * `rows` are whole days already inside the window, counted as they are.
 */
export function summarizeUsage(records: readonly UsageRecord[], days: number, now = Date.now(), rows: readonly UsageRow[] = []): UsageSummary {
  const since = usageSince(days, now)
  const total = empty()
  const tally = { turns: 0, priced: 0, unpriced: 0 }
  const byDay = new Map<string, UsageBucket>()
  const byModel = new Map<string, UsageBucket>()
  const bucket = (map: Map<string, UsageBucket>, key: string) => {
    let found = map.get(key)
    if (!found) map.set(key, (found = { key, usage: empty(), turns: 0, priced: 0, unpriced: 0 }))
    return found
  }
  const fold = (row: UsageRow) => {
    for (const into of [bucket(byDay, row.day), bucket(byModel, row.model)]) {
      add(into.usage, row.usage)
      into.turns += row.turns
      into.priced += row.priced
      into.unpriced += row.unpriced
    }
    add(total, row.usage)
    tally.turns += row.turns
    tally.priced += row.priced
    tally.unpriced += row.unpriced
  }
  for (const record of records) if (record.at >= since) fold(rowOf(record))
  for (const row of rows) fold(row)
  return {
    total,
    ...tally,
    days,
    byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
    // By name last, so models that tie read in the same order however their spend was gathered.
    byModel: [...byModel.values()].sort((a, b) => b.usage.cost - a.usage.cost || b.turns - a.turns || a.key.localeCompare(b.key)),
  }
}

/** The moment the usage page's window of `days` starts. */
export function usageSince(days: number, now = Date.now()): number {
  return now - days * 24 * 60 * 60 * 1000
}

/** Spend already gathered into one local day and one model ("provider/model"), as the daily totals keep it. */
export interface UsageRow {
  day: string
  model: string
  usage: Usage
  turns: number
  priced: number
  unpriced: number
}

/** One request as a row of its own. */
export function rowOf(record: UsageRecord): UsageRow {
  const spent = record.usage.input + record.usage.output + record.usage.reasoning + record.usage.cacheRead + record.usage.cacheWrite
  const priced = record.usage.cost > 0 ? 1 : 0
  return {
    day: localDay(record.at),
    model: `${record.model.provider}/${record.model.model}`,
    usage: { ...record.usage },
    turns: record.turn ? 1 : 0,
    priced,
    unpriced: !priced && spent > 0 ? 1 : 0,
  }
}

/** Adds one row into another of the same day and model. */
export function addRow(into: UsageRow, from: UsageRow): void {
  add(into.usage, from.usage)
  into.turns += from.turns
  into.priced += from.priced
  into.unpriced += from.unpriced
}
