/**
 * automation: the RFC 5545 recurrence subset MiMo's scheduled tasks accept,
 * read on the device's own wall clock.
 *
 * One `RRULE:` line, at most one `DTSTART:YYYYMMDDTHHMM[SS]` line and any
 * `X-` lines. FREQ is HOURLY, DAILY, WEEKLY, MONTHLY or YEARLY; the other keys
 * are INTERVAL, BYHOUR, BYMINUTE, BYDAY, BYMONTH, BYMONTHDAY, WKST, COUNT and
 * UNTIL. WEEKLY needs BYDAY, MONTHLY needs BYMONTHDAY, YEARLY needs both BYMONTH
 * and BYMONTHDAY; COUNT needs DTSTART and cannot go with UNTIL. Without BYHOUR
 * or BYMINUTE a rule runs at DTSTART's time, or 09:00; HOURLY runs every hour.
 */

export type Frequency = "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"

export interface RRule {
  frequency: Frequency
  interval: number
  byHours: number[]
  byMinutes: number[]
  byWeekdays: number[]
  byMonths: number[]
  byMonthDays: number[]
  weekStart: number
  /** DTSTART, in local time. */
  start?: Date
  count?: number
  until?: number
  keys: string[]
  hasStart: boolean
  extraLines: boolean
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
const KEYS = new Set(["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE", "BYDAY", "BYMONTH", "BYMONTHDAY", "WKST", "COUNT", "UNTIL"])
const FREQUENCIES: Frequency[] = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"]
/** The most occurrences a COUNT may ask for. */
const COUNT_MAX = 10_000

function numbers(value: string | undefined, low: number, high: number): number[] | undefined {
  if (value === undefined) return []
  const parts = value.split(",")
  if (parts.some((part) => !/^\d+$/.test(part))) return undefined
  const list = parts.map(Number)
  if (list.some((entry) => entry < low || entry > high)) return undefined
  return [...new Set(list)].sort((a, b) => a - b)
}

/** `YYYYMMDDTHHMM[SS][Z]` or, for UNTIL, `YYYYMMDD` - as a Date, or nothing when it is not a real moment. */
function stamp(value: string, dateOnly = false): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value)
  if (!match || (!dateOnly && match[4] === undefined)) return undefined
  // A date alone (UNTIL) lasts to the end of that day; a time without seconds is on the minute.
  const missing = [0, 0, 0, dateOnly ? 23 : 0, dateOnly ? 59 : 0, dateOnly && match[4] === undefined ? 59 : 0]
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((at) => Number(match[at] ?? missing[at - 1]))
  const utc = match[7] === "Z"
  const date = utc ? new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!)) : new Date(year!, month! - 1, day!, hour!, minute!, second!)
  const read = utc
    ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()]
    : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
  return read.every((part, at) => part === [year, month, day, hour, minute][at]) ? date : undefined
}

const daysIn = (month: number) => new Date(2024, month, 0).getDate()

export function parseRRule(text: string): RRule | undefined {
  if (!text.trim() || text.length > 4096) return undefined
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const rules = lines.filter((line) => line.toUpperCase().startsWith("RRULE:"))
  const starts = lines.filter((line) => line.toUpperCase().startsWith("DTSTART"))
  if (rules.length !== 1 || starts.length > 1) return undefined
  const [rule] = rules as [string]
  const startLine = starts[0]
  if (startLine !== undefined && !startLine.toUpperCase().startsWith("DTSTART:")) return undefined
  if (lines.some((line) => line !== rule && line !== startLine && !/^X-[A-Z0-9-]+:/i.test(line))) return undefined
  const start = startLine !== undefined ? stamp(startLine.slice(startLine.indexOf(":") + 1)) : undefined
  if (startLine !== undefined && !start) return undefined

  const fields = new Map<string, string>()
  for (const piece of rule.slice(rule.indexOf(":") + 1).split(";")) {
    const at = piece.indexOf("=")
    if (at <= 0) return undefined
    const key = piece.slice(0, at).toUpperCase()
    const value = piece.slice(at + 1).toUpperCase()
    if (fields.has(key) || !value || !KEYS.has(key)) return undefined
    fields.set(key, value)
  }
  const frequency = fields.get("FREQ") as Frequency | undefined
  if (!frequency || !FREQUENCIES.includes(frequency)) return undefined
  const intervalText = fields.get("INTERVAL") ?? "1"
  if (!/^\d+$/.test(intervalText) || Number(intervalText) < 1 || Number(intervalText) > 10_000) return undefined
  const byHours = numbers(fields.get("BYHOUR"), 0, 23)
  const byMinutes = numbers(fields.get("BYMINUTE"), 0, 59)
  const byMonths = numbers(fields.get("BYMONTH"), 1, 12)
  const byMonthDays = numbers(fields.get("BYMONTHDAY"), 1, 31)
  if (!byHours || !byMinutes || !byMonths || !byMonthDays) return undefined
  // A month and a day that never meet (the 30th of February) cannot run.
  if (byMonths.length && byMonthDays.length && !byMonths.some((month) => byMonthDays.some((day) => day <= daysIn(month)))) return undefined
  if (frequency === "MONTHLY" && !byMonthDays.length) return undefined
  if (frequency === "YEARLY" && (!byMonths.length || !byMonthDays.length)) return undefined
  const dayNames = fields.get("BYDAY")?.split(",").filter(Boolean) ?? []
  if (dayNames.some((name) => !(name in WEEKDAYS))) return undefined
  const byWeekdays = [...new Set(dayNames.map((name) => WEEKDAYS[name]!))].sort((a, b) => a - b)
  if (frequency === "WEEKLY" && !byWeekdays.length) return undefined
  const weekStartName = fields.get("WKST") ?? "MO"
  if (!(weekStartName in WEEKDAYS)) return undefined
  const countText = fields.get("COUNT")
  if (countText !== undefined && (!/^\d+$/.test(countText) || Number(countText) < 1 || Number(countText) > COUNT_MAX || !start)) return undefined
  const untilText = fields.get("UNTIL")
  const until = untilText !== undefined ? stamp(untilText, true) : undefined
  if (untilText !== undefined && !until) return undefined
  if (countText !== undefined && untilText !== undefined) return undefined

  return {
    frequency,
    interval: Number(intervalText),
    byHours: byHours.length ? byHours : frequency === "HOURLY" ? Array.from({ length: 24 }, (_, hour) => hour) : [start?.getHours() ?? 9],
    byMinutes: byMinutes.length ? byMinutes : [start?.getMinutes() ?? 0],
    byWeekdays,
    byMonths,
    byMonthDays,
    weekStart: WEEKDAYS[weekStartName]!,
    ...(start ? { start } : {}),
    ...(countText !== undefined ? { count: Number(countText) } : {}),
    ...(until ? { until: until.getTime() } : {}),
    keys: [...fields.keys()],
    hasStart: startLine !== undefined,
    extraLines: lines.length > (startLine === undefined ? 1 : 2),
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const dayNumber = (date: Date) => Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
const fits = (difference: number, interval: number) => ((difference % interval) + interval) % interval === 0

function dayMatches(rule: RRule, day: Date, anchor: Date): boolean {
  if (rule.byMonths.length && !rule.byMonths.includes(day.getMonth() + 1)) return false
  if (rule.byMonthDays.length && !rule.byMonthDays.includes(day.getDate())) return false
  if (rule.byWeekdays.length && !rule.byWeekdays.includes(day.getDay())) return false
  switch (rule.frequency) {
    case "DAILY":
      return fits(dayNumber(day) - dayNumber(anchor), rule.interval)
    case "WEEKLY": {
      const weekOf = (date: Date) => dayNumber(date) - ((date.getDay() - rule.weekStart + 7) % 7)
      return fits((weekOf(day) - weekOf(anchor)) / 7, rule.interval)
    }
    case "MONTHLY":
      return fits((day.getFullYear() - anchor.getFullYear()) * 12 + day.getMonth() - anchor.getMonth(), rule.interval)
    case "YEARLY":
      return fits(day.getFullYear() - anchor.getFullYear(), rule.interval)
    default:
      return true
  }
}

/** How far ahead a rule is searched, in days: past this a rule is treated as never running again. */
const HORIZON_DAYS = 366 * 5

/** The first occurrence strictly after `after`, counting intervals from DTSTART or from `anchor`. */
function firstAfter(rule: RRule, after: number, anchorMs: number): number | undefined {
  const anchor = rule.start ?? new Date(anchorMs)
  const from = new Date(Math.max(after, rule.start ? rule.start.getTime() - 1 : after))
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  for (let step = 0; step < HORIZON_DAYS; step++, day.setDate(day.getDate() + 1)) {
    if (!dayMatches(rule, day, anchor)) continue
    for (const hour of rule.byHours) {
      for (const minute of rule.byMinutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0)
        // A wall-clock time a clock change skips does not happen that day.
        if (at.getHours() !== hour || at.getTime() <= after) continue
        if (rule.frequency === "HOURLY") {
          const anchorHour = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), anchor.getHours())
          // Whole hours from the anchor's hour, so any minute within a matching hour counts.
          if (!fits(Math.floor((at.getTime() - anchorHour.getTime()) / 3_600_000), rule.interval)) continue
        }
        if (rule.until !== undefined && at.getTime() > rule.until) return undefined
        return at.getTime()
      }
    }
  }
  return undefined
}

/** When a rule next runs after `after`; nothing when it has run its course. */
export function nextOccurrence(rule: RRule, after: number, anchorMs: number): number | undefined {
  if (rule.count === undefined) return firstAfter(rule, after, anchorMs)
  let cursor = (rule.start?.getTime() ?? anchorMs) - 1
  for (let seen = 0; seen < rule.count; seen++) {
    const next = firstAfter(rule, cursor, anchorMs)
    if (next === undefined) return undefined
    if (next > after) return next
    cursor = next
  }
  return undefined
}

const pad = (value: number) => String(value).padStart(2, "0")
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const UNITS: Record<Frequency, string> = { HOURLY: "hour", DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }

/** MiMo's reading of a schedule: hourly, daily, weekdays and weekly by name, anything else by its interval or its label. */
export function scheduleLabel(text: string, label?: string): string {
  const rule = parseRRule(text)
  if (!rule) return "Custom"
  const plain = !rule.hasStart && !rule.extraLines
  const only = (allowed: string[]) => plain && rule.keys.every((key) => allowed.includes(key))
  const time = `${pad(rule.byHours[0] ?? 9)}:${pad(rule.byMinutes[0] ?? 0)}`
  if (rule.interval === 1 && rule.frequency === "HOURLY" && rule.byMinutes.join() === "0" && only(["FREQ", "BYMINUTE"])) return "Hourly"
  if (rule.interval === 1 && rule.frequency === "DAILY" && rule.byHours.length === 1 && rule.byMinutes.length === 1 && !rule.byWeekdays.length && only(["FREQ", "BYHOUR", "BYMINUTE"])) return `Every day ${time}`
  if (rule.interval === 1 && rule.frequency === "WEEKLY" && rule.byHours.length === 1 && rule.byMinutes.length === 1 && only(["FREQ", "BYHOUR", "BYMINUTE", "BYDAY"])) {
    if (rule.byWeekdays.join() === "1,2,3,4,5") return `Weekdays ${time}`
    if (rule.byWeekdays.length === 1) return `${DAY_NAMES[rule.byWeekdays[0]!]} (time: ${time})`
  }
  const named = label?.trim()
  if (named && named.toLowerCase() !== "custom") return named
  return `Every ${rule.interval} ${UNITS[rule.frequency]}${rule.interval === 1 ? "" : "s"}`
}
