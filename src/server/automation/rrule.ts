/**
 * automation: the RFC 5545 recurrence subset MiMo's scheduled tasks accept,
 * read on the device's own wall clock.
 *
 * One `RRULE:` line, at most one `DTSTART:YYYYMMDDTHHMM[00]` line (local time:
 * no `Z`, and seconds, when given, are 00) and any `X-` lines. FREQ is HOURLY,
 * DAILY, WEEKLY, MONTHLY or YEARLY; the other keys are INTERVAL, BYHOUR,
 * BYMINUTE, BYDAY, BYMONTH, BYMONTHDAY, WKST, COUNT and UNTIL
 * (`YYYYMMDDTHHMM[SS][Z]`, a time always included). WEEKLY needs BYDAY,
 * MONTHLY needs BYMONTHDAY, YEARLY needs both BYMONTH and BYMONTHDAY; COUNT
 * needs DTSTART and cannot go with UNTIL. Without BYHOUR or BYMINUTE a rule
 * runs at DTSTART's time, or 09:00; HOURLY runs every hour.
 *
 * An INTERVAL counts its periods from DTSTART, or - as MiMo counts them - from
 * the start of 1970 when there is none.
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

/** DTSTART's `YYYYMMDDTHHMM[00]`, local time only, as a Date - or nothing when it is not a real local moment. */
function startStamp(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})([0-5]\d)?$/.exec(value)
  if (!match || (match[6] !== undefined && Number(match[6]) !== 0)) return undefined
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((at) => Number(match[at]))
  const date = new Date(year!, month! - 1, day!, hour!, minute!, 0, 0)
  const read = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
  return read.every((part, at) => part === [year, month, day, hour, minute][at]) ? date : undefined
}

/**
 * UNTIL's `YYYYMMDDTHHMM[SS][Z]` as the last millisecond it allows: a time
 * without seconds lasts to the end of that minute. A date alone is refused.
 */
function untilStamp(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})([0-5]\d)?(Z)?$/.exec(value)
  if (!match) return undefined
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((at) => Number(match[at]))
  const second = match[6] === undefined ? 59 : Number(match[6])
  const utc = match[7] === "Z"
  const date = utc ? new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second, 999)) : new Date(year!, month! - 1, day!, hour!, minute!, second, 999)
  const read = utc
    ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
  return read.every((part, at) => part === [year, month, day, hour, minute, second][at]) ? date.getTime() : undefined
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
  const start = startLine !== undefined ? startStamp(startLine.slice(startLine.indexOf(":") + 1)) : undefined
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
  const until = untilText !== undefined ? untilStamp(untilText) : undefined
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
    ...(until !== undefined ? { until } : {}),
    keys: [...fields.keys()],
    hasStart: startLine !== undefined,
    extraLines: lines.length > (startLine === undefined ? 1 : 2),
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
/** Days in 400 Gregorian years, after which the calendar repeats itself. */
const CYCLE_DAYS = 146_097

/** A wall-clock moment, as its parts. */
interface Moment {
  year: number
  month: number
  date: number
  hour: number
  minute: number
}

/** Where a rule's periods are counted from: DTSTART, or the start of 1970. */
function origin(rule: RRule): Moment {
  const start = rule.start
  return start
    ? { year: start.getFullYear(), month: start.getMonth(), date: start.getDate(), hour: start.getHours(), minute: start.getMinutes() }
    : { year: 1970, month: 0, date: 1, hour: 0, minute: 0 }
}

/** Calendar arithmetic on the wall clock's parts, whatever the time zone does. */
const dayIndex = (year: number, month: number, date: number) => Math.floor(Date.UTC(year, month, date) / DAY_MS)
const hourIndex = (year: number, month: number, date: number, hour: number) => Math.floor(Date.UTC(year, month, date, hour) / HOUR_MS)
const minuteIndex = (moment: Moment) => Math.floor(Date.UTC(moment.year, moment.month, moment.date, moment.hour, moment.minute) / 60_000)
const weekday = (day: number) => new Date(day * DAY_MS).getUTCDay()
const partsOfDay = (day: number) => {
  const at = new Date(day * DAY_MS)
  return { year: at.getUTCFullYear(), month: at.getUTCMonth(), date: at.getUTCDate() }
}
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a))
/** How many periods of `interval` it takes for a cycle of `length` to come round again, plus one. */
const rounds = (length: number, interval: number) => length / gcd(length, interval) + 1

/** The local time for these parts, or nothing when the clock skips it (or the date does not exist). */
function local(moment: Moment): Date | undefined {
  const at = new Date(moment.year, moment.month, moment.date, moment.hour, moment.minute, 0, 0)
  const same = at.getFullYear() === moment.year && at.getMonth() === moment.month && at.getDate() === moment.date && at.getHours() === moment.hour && at.getMinutes() === moment.minute
  return same ? at : undefined
}

/** Whether a moment belongs to the rule: its filters, and a whole number of periods from the origin. */
function belongs(rule: RRule, moment: Moment, day: number): boolean {
  const from = origin(rule)
  if (rule.start && minuteIndex(moment) < minuteIndex(from)) return false
  if (rule.byWeekdays.length && !rule.byWeekdays.includes(weekday(day))) return false
  if (rule.byMonths.length && !rule.byMonths.includes(moment.month + 1)) return false
  if (rule.byMonthDays.length && !rule.byMonthDays.includes(moment.date)) return false
  const whole = (periods: number) => periods >= 0 && periods % rule.interval === 0
  switch (rule.frequency) {
    case "HOURLY":
      return whole(hourIndex(moment.year, moment.month, moment.date, moment.hour) - hourIndex(from.year, from.month, from.date, from.hour))
    case "DAILY":
      return whole(day - dayIndex(from.year, from.month, from.date))
    case "WEEKLY": {
      const weekOf = (at: number) => Math.floor((at - ((weekday(at) - rule.weekStart + 7) % 7)) / 7)
      return whole(weekOf(day) - weekOf(dayIndex(from.year, from.month, from.date)))
    }
    case "MONTHLY":
      return whole((moment.year - from.year) * 12 + moment.month - from.month)
    case "YEARLY":
      return whole(moment.year - from.year)
  }
}

/**
 * The first of a day's times that belongs to the rule and comes after
 * `after`: `undefined` to keep looking, `null` when UNTIL has passed.
 */
function onDay(rule: RRule, day: number, hours: readonly number[], after: number): number | null | undefined {
  const parts = partsOfDay(day)
  for (const hour of hours) {
    for (const minute of rule.byMinutes) {
      const moment = { ...parts, hour, minute }
      if (!belongs(rule, moment, day)) continue
      const at = local(moment)
      if (!at || at.getTime() <= after) continue
      return rule.until !== undefined && at.getTime() > rule.until ? null : at.getTime()
    }
  }
  return undefined
}

/**
 * The first occurrence strictly after `after`. Each frequency starts at the
 * period `after` falls in and walks forward whole periods until the calendar
 * has come round (400 years), so a rule that runs rarely - every ten years -
 * is still found, and one that never matches ends the search.
 */
function firstAfter(rule: RRule, after: number): number | undefined {
  const from = origin(rule)
  const now = new Date(after)
  const today = dayIndex(now.getFullYear(), now.getMonth(), now.getDate())
  const found = (value: number | null | undefined) => value !== undefined
  const result = (value: number | null | undefined) => value ?? undefined
  const { interval } = rule

  if (rule.frequency === "DAILY") {
    const base = dayIndex(from.year, from.month, from.date)
    let period = Math.floor(Math.max(0, today - base) / interval)
    for (let round = 0; round < rounds(CYCLE_DAYS, interval); round++, period++) {
      const hit = onDay(rule, base + period * interval, rule.byHours, after)
      if (found(hit)) return result(hit)
    }
    return undefined
  }

  if (rule.frequency === "WEEKLY") {
    const weekStartOf = (day: number) => day - ((weekday(day) - rule.weekStart + 7) % 7)
    const base = weekStartOf(dayIndex(from.year, from.month, from.date))
    let period = Math.floor(Math.max(0, Math.floor((weekStartOf(today) - base) / 7)) / interval)
    for (let round = 0; round < rounds(CYCLE_DAYS / 7, interval); round++, period++) {
      const first = base + period * interval * 7
      for (let offset = 0; offset < 7; offset++) {
        const hit = onDay(rule, first + offset, rule.byHours, after)
        if (found(hit)) return result(hit)
      }
    }
    return undefined
  }

  if (rule.frequency === "MONTHLY") {
    const base = from.year * 12 + from.month
    let period = Math.floor(Math.max(0, now.getFullYear() * 12 + now.getMonth() - base) / interval)
    for (let round = 0; round < rounds(4800, interval); round++, period++) {
      const count = base + period * interval
      const year = Math.floor(count / 12)
      const month = count - year * 12
      for (const date of rule.byMonthDays) {
        // A day the month does not have (the 31st of April) is not there to run on.
        if (date > new Date(year, month + 1, 0).getDate()) continue
        const hit = onDay(rule, dayIndex(year, month, date), rule.byHours, after)
        if (found(hit)) return result(hit)
      }
    }
    return undefined
  }

  if (rule.frequency === "YEARLY") {
    let year = Math.max(now.getFullYear(), from.year)
    const offset = (year - from.year) % interval
    if (offset) year += interval - offset
    for (let round = 0; round <= 400; round++, year += interval) {
      for (const month of rule.byMonths) {
        for (const date of rule.byMonthDays) {
          if (date > new Date(year, month, 0).getDate()) continue
          const hit = onDay(rule, dayIndex(year, month - 1, date), rule.byHours, after)
          if (found(hit)) return result(hit)
        }
      }
    }
    return undefined
  }

  // HOURLY: whole hours, each tried at the rule's minutes.
  const base = hourIndex(from.year, from.month, from.date, from.hour)
  let period = Math.floor(Math.max(0, hourIndex(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()) - base) / interval)
  for (let round = 0; round < rounds(CYCLE_DAYS * 24, interval); round++, period++) {
    const hours = base + period * interval
    const hour = ((hours % 24) + 24) % 24
    if (!rule.byHours.includes(hour)) continue
    const hit = onDay(rule, Math.floor(hours / 24), [hour], after)
    if (found(hit)) return result(hit)
  }
  return undefined
}

/** When a rule next runs after `after`; nothing when it has run its course. */
export function nextOccurrence(rule: RRule, after: number): number | undefined {
  if (rule.count === undefined || !rule.start) return firstAfter(rule, after)
  let cursor = rule.start.getTime() - 1
  for (let seen = 0; seen < rule.count; seen++) {
    const next = firstAfter(rule, cursor)
    if (next === undefined) return undefined
    if (next > after) return next
    cursor = next
  }
  return undefined
}

const pad = (value: number) => String(value).padStart(2, "0")
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const DAY_NAMES_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
const UNITS: Record<Frequency, string> = { HOURLY: "hour", DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }
const UNITS_ZH: Record<Frequency, string> = { HOURLY: "小时", DAILY: "天", WEEKLY: "周", MONTHLY: "个月", YEARLY: "年" }
const EVERY_ZH: Record<Frequency, string> = { HOURLY: "每小时", DAILY: "每天", WEEKLY: "每周", MONTHLY: "每月", YEARLY: "每年" }

/** Whether a schedule is read out in Chinese: for a Chinese interface, as MiMo decides it. */
export function chineseSchedule(locale: string | undefined): boolean {
  return (locale ?? "").toLowerCase().startsWith("zh")
}

/** The simple schedules MiMo names on their own; anything else it treats as a custom rule. */
type SimpleSchedule = { kind: "hourly" } | { kind: "daily"; time: string } | { kind: "weekdays"; time: string } | { kind: "weekly"; weekday: number; time: string }

function simpleSchedule(rule: RRule): SimpleSchedule | undefined {
  const plain = !rule.hasStart && !rule.extraLines
  const only = (allowed: string[]) => plain && rule.keys.every((key) => allowed.includes(key))
  const time = `${pad(rule.byHours[0] ?? 9)}:${pad(rule.byMinutes[0] ?? 0)}`
  if (rule.interval === 1 && rule.frequency === "HOURLY" && rule.byMinutes.join() === "0" && only(["FREQ", "BYMINUTE"])) return { kind: "hourly" }
  if (rule.interval === 1 && rule.frequency === "DAILY" && rule.byHours.length === 1 && rule.byMinutes.length === 1 && !rule.byWeekdays.length && only(["FREQ", "BYHOUR", "BYMINUTE"])) {
    return { kind: "daily", time }
  }
  if (rule.interval === 1 && rule.frequency === "WEEKLY" && rule.byHours.length === 1 && rule.byMinutes.length === 1 && only(["FREQ", "BYHOUR", "BYMINUTE", "BYDAY"])) {
    if (rule.byWeekdays.join() === "1,2,3,4,5") return { kind: "weekdays", time }
    if (rule.byWeekdays.length === 1) return { kind: "weekly", weekday: rule.byWeekdays[0]!, time }
  }
  return undefined
}

/**
 * A schedule as two tasks are compared by, as MiMo compares them: a simple
 * one by what it means, whatever order its keys were written in and whatever
 * label it carries; a custom one by its rule's lines and its label.
 */
export function scheduleKey(text: string, label?: string): string {
  const rule = parseRRule(text)
  const simple = rule && simpleSchedule(rule)
  if (simple) return JSON.stringify(simple)
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
  return JSON.stringify({ kind: "custom", rule: lines, label: label?.trim() || null })
}

/**
 * MiMo's reading of a schedule: hourly, daily, weekdays and weekly by name,
 * anything else by its interval or its label - in Chinese for a Chinese
 * interface, in MCode's own words. A label is used only when it is in the
 * language being written (and is not just "custom"). Times drop a leading
 * zero: 9:00.
 */
export function scheduleLabel(text: string, label?: string, zh = false): string {
  const rule = parseRRule(text)
  if (!rule) return zh ? "自定义" : "Custom"
  const simple = simpleSchedule(rule)
  if (simple) {
    if (simple.kind === "hourly") return zh ? "每小时" : "Hourly"
    const time = simple.time.replace(/^0(?=\d)/, "")
    if (simple.kind === "daily") return zh ? `每天 ${time}` : `Every day ${time}`
    if (simple.kind === "weekdays") return zh ? `工作日 ${time}` : `Weekdays ${time}`
    return zh ? `每${DAY_NAMES_ZH[simple.weekday]} ${time}` : `${DAY_NAMES[simple.weekday]} (time: ${time})`
  }
  const named = label?.trim()
  const custom = !named || named === "自定义" || named.toLowerCase() === "custom"
  if (named && !custom && /[\u3400-\u9fff]/u.test(named) === zh) return named
  if (zh) return rule.interval === 1 ? EVERY_ZH[rule.frequency] : `每 ${rule.interval} ${UNITS_ZH[rule.frequency]}`
  return `Every ${rule.interval} ${UNITS[rule.frequency]}${rule.interval === 1 ? "" : "s"}`
}
