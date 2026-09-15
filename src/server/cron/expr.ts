/**
 * cron: five-field cron expressions and when they next match, as MiMo's
 * scheduled prompts read them - minute, hour, day of month, month, day of week,
 * all in UTC, each field a list of values, ranges and steps.
 *
 * Day of month and day of week follow the usual cron rule: when either is left
 * as `*` both must match, and when both are restricted either may.
 */

interface Fields {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
  domStar: boolean
  dowStar: boolean
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
]

const unrestricted = (token: string) => token === "*" || token === "*/1"

function field(token: string, [low, high]: [number, number]): number[] | undefined {
  const values = new Set<number>()
  for (const piece of token.split(",")) {
    const [range, stepText] = piece.split("/")
    if (range === undefined || (stepText !== undefined && !/^\d+$/.test(stepText))) return undefined
    const step = stepText === undefined ? 1 : Number(stepText)
    if (step < 1) return undefined
    let start: number
    let end: number
    if (range === "*") {
      start = low
      end = high
    } else {
      const bounds = range.split("-")
      if (bounds.length > 2 || bounds.some((bound) => !/^\d+$/.test(bound))) return undefined
      start = Number(bounds[0])
      // `5/15` runs from 5 to the end of the field; a bare `5` is just 5.
      end = bounds[1] !== undefined ? Number(bounds[1]) : stepText !== undefined ? high : start
    }
    if (start < low || end > high || start > end) return undefined
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

export function parseCron(expression: string): Fields | undefined {
  const tokens = expression.trim().split(/\s+/)
  if (tokens.length !== 5) return undefined
  const parsed = tokens.map((token, at) => field(token, RANGES[at]!))
  if (parsed.some((values) => !values)) return undefined
  const [minute, hour, dom, month, dow] = parsed as number[][]
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow!, domStar: unrestricted(tokens[2]!), dowStar: unrestricted(tokens[4]!) }
}

/** The first matching minute strictly after `from`, looking a year ahead; nothing when none comes. */
export function nextCronRun(expression: string, from: number): number | undefined {
  const fields = parseCron(expression)
  if (!fields) return undefined
  const limit = from + 366 * 24 * 60 * 60 * 1000
  const at = new Date(from)
  at.setUTCSeconds(0, 0)
  at.setUTCMinutes(at.getUTCMinutes() + 1)
  while (at.getTime() <= limit) {
    const domHit = fields.dom.includes(at.getUTCDate())
    const dowHit = fields.dow.includes(at.getUTCDay())
    const day = fields.domStar || fields.dowStar ? domHit && dowHit : domHit || dowHit
    if (!fields.month.includes(at.getUTCMonth() + 1) || !day) {
      // A day that cannot match is skipped whole.
      at.setUTCHours(24, 0, 0, 0)
      continue
    }
    if (!fields.hour.includes(at.getUTCHours())) {
      at.setUTCHours(at.getUTCHours() + 1, 0, 0, 0)
      continue
    }
    if (fields.minute.includes(at.getUTCMinutes())) return at.getTime()
    at.setUTCMinutes(at.getUTCMinutes() + 1)
  }
  return undefined
}

/**
 * MiMo's spread, so jobs asked for at the same moment do not all fire at once:
 * a recurring job is late by up to half its period, at most 30 minutes; a
 * `*\/N` job that lands on a five-minute mark is instead up to 15 seconds early;
 * a one-shot on the hour or half hour is up to 90 seconds early, never before
 * it was made. Each job's share comes from its id, so it is the same every time.
 */
export const JITTER = {
  recurringShare: 0.5,
  recurringCapMs: 30 * 60 * 1000,
  cliffLeadMs: 15_000,
  oneShotLeadMs: 90_000,
  oneShotMinuteMod: 30,
  /** A recurring job that is not permanent ends after a week. */
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
}

const EVERY_N_MINUTES = /^\*\/\d+ \* \* \* \*$/

/** A stable number in [0, 1) for a job id. */
export function idShare(id: string): number {
  let hash = 0
  for (let at = 0; at < id.length; at++) hash = (hash * 31 + id.charCodeAt(at)) >>> 0
  return (hash % 1_000_000) / 1_000_000
}

export function recurringFireAt(expression: string, from: number, id: string): number | undefined {
  const first = nextCronRun(expression, from)
  if (first === undefined) return undefined
  if (EVERY_N_MINUTES.test(expression.trim()) && new Date(first).getUTCMinutes() % 5 === 0) {
    const target = first - JITTER.cliffLeadMs >= from ? first : nextCronRun(expression, first)
    return target === undefined ? first : target - idShare(id) * JITTER.cliffLeadMs
  }
  const following = nextCronRun(expression, first)
  if (following === undefined) return first
  return first + Math.min(idShare(id) * JITTER.recurringShare * (following - first), JITTER.recurringCapMs)
}

export function oneShotFireAt(expression: string, created: number, id: string): number | undefined {
  const next = nextCronRun(expression, created)
  if (next === undefined) return undefined
  if (new Date(next).getUTCMinutes() % JITTER.oneShotMinuteMod !== 0) return next
  return Math.max(next - idShare(id) * JITTER.oneShotLeadMs, created)
}

/** MiMo's clamp on a loop's delay, in seconds. */
export const LOOP_MIN_SECONDS = 60
export const LOOP_MAX_SECONDS = 3600

export function clampLoopDelay(seconds: number): number {
  return Math.max(LOOP_MIN_SECONDS, Math.min(LOOP_MAX_SECONDS, seconds))
}
