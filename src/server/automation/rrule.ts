/**
 * automation: the RFC 5545 recurrence subset MiMo's scheduled tasks accept,
 * read on the device's own wall clock.
 *
 * One `RRULE:` line, at most one `DTSTART:YYYYMMDDTHHMM[00]` line and any
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

/**
 * DTSTART as MiMo reads it: `YYYYMMDDTHHMM`, seconds only as `00`, on the
 * device's clock (no `Z`) - and a real moment, not the 30th of February.
 */
function startStamp(value: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(00)?$/.exec(value)
  if (!match) return undefined
  const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((at) => Number(match[at]))
  const date = new Date(year!, month! - 1, day!, hour!, minute!, 0, 0)
  const read = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()]
  return read.every((part, at) => part === [year, month, day, hour, minute][at]) ? date : undefined
}

/**
 * UNTIL as MiMo reads it: a time is required (`YYYYMMDDTHHMM[SS]`), on the
 * device's clock or in UTC with `Z`, and lasts to the end of that second (the
 * end of the minute when no seconds are given).
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
/** Days, weeks and months in the 400-year cycle the calendar repeats on, and hours in it. */
const CYCLE_DAYS = 146_097
const CYCLE_WEEKS = CYCLE_DAYS / 7
const CYCLE_MONTHS = 4_800
const CYCLE_YEARS = 400
const CYCLE_HOURS = CYCLE_DAYS * 24

/** Wall-clock day and hour numbers, counted as if every day had 24 hours - the rule's own arithmetic. */
const dayOf = (year: number, month: number, date: number) => Math.floor(Date.UTC(year, month, date) / DAY_MS)
const hourOf = (year: number, month: number, date: number, hour: number) => Math.floor(Date.UTC(year, month, date, hour) / HOUR_MS)
const fromDay = (day: number) => {
  const date = new Date(day * DAY_MS)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), date: date.getUTCDate() }
}
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
/** How many interval steps it takes before the calendar comes round again. */
const stepsIn = (cycle: number, interval: number) => cycle / gcd(cycle, interval) + 1

/** A wall-clock time that really exists that day (a clock change can skip one), or nothing. */
function wallClock(year: number, month: number, date: number, hour: number, minute: number): Date | undefined {
  const at = new Date(year, month, date, hour, minute, 0, 0)
  return at.getFullYear() === year && at.getMonth() === month && at.getDate() === date && at.getHours() === hour && at.getMinutes() === minute ? at : undefined
}

/**
 * Where a rule's intervals are counted from: DTSTART, or - as MiMo counts them
 * - the start of 1970, so an every-second-day rule runs on the same days
 * whenever it was made (the user's T10-51 decision).
 */
function originOf(rule: RRule) {
  const start = rule.start
  return start
    ? { year: start.getFullYear(), month: start.getMonth(), date: start.getDate(), hour: start.getHours(), minute: start.getMinutes(), weekday: start.getDay() }
    : { year: 1970, month: 0, date: 1, hour: 0, minute: 0, weekday: 4 }
}

type Slot = { year: number; month: number; date: number; hour: number; minute: number }

/** Whether a wall-clock slot is one the rule runs at: its lists, and its interval from the origin. */
function inRule(rule: RRule, slot: Slot, weekday: number): boolean {
  const origin = originOf(rule)
  const minutes = (value: Slot) => Date.UTC(value.year, value.month, value.date, value.hour, value.minute)
  if (minutes(slot) < minutes(origin)) return false
  if (rule.byWeekdays.length && !rule.byWeekdays.includes(weekday)) return false
  if (rule.byMonths.length && !rule.byMonths.includes(slot.month + 1)) return false
  if (rule.byMonthDays.length && !rule.byMonthDays.includes(slot.date)) return false
  const every = (steps: number) => steps >= 0 && steps % rule.interval === 0
  switch (rule.frequency) {
    case "HOURLY":
      return every(hourOf(slot.year, slot.month, slot.date, slot.hour) - hourOf(origin.year, origin.month, origin.date, origin.hour))
    case "DAILY":
      return every(dayOf(slot.year, slot.month, slot.date) - dayOf(origin.year, origin.month, origin.date))
    case "WEEKLY": {
      const weekOf = (day: number, dow: number) => Math.floor((day - ((dow - rule.weekStart + 7) % 7)) / 7)
      return every(weekOf(dayOf(slot.year, slot.month, slot.date), weekday) - weekOf(dayOf(origin.year, origin.month, origin.date), origin.weekday))
    }
    case "MONTHLY":
      return every((slot.year - origin.year) * 12 + slot.month - origin.month)
    case "YEARLY":
      return every(slot.year - origin.year)
  }
}

/** The first run strictly after `after` within the days listed, earliest first. */
function firstIn(rule: RRule, days: Iterable<number>, after: number): number | undefined | null {
  for (const day of days) {
    const { year, month, date } = fromDay(day)
    const weekday = new Date(day * DAY_MS).getUTCDay()
    for (const hour of rule.byHours) {
      for (const minute of rule.byMinutes) {
        const slot = { year, month, date, hour, minute }
        if (!inRule(rule, slot, weekday)) continue
        const at = wallClock(year, month, date, hour, minute)
        if (!at || at.getTime() <= after) continue
        return rule.until !== undefined && at.getTime() > rule.until ? null : at.getTime()
      }
    }
  }
  return undefined
}

function* range(from: number, count: number) {
  for (let at = 0; at < count; at++) yield from + at
}

/**
 * The first occurrence strictly after `after`, stepping a whole period at a
 * time - day, week, month, year or hour - from the period `after` falls in,
 * for as many periods as it takes the calendar to repeat, so a rule that runs
 * once a decade is found as surely as a daily one.
 */
function firstAfter(rule: RRule, after: number): number | undefined {
  const origin = originOf(rule)
  const from = new Date(after)
  const originDay = dayOf(origin.year, origin.month, origin.date)
  const found = (value: number | undefined | null) => value !== undefined
  let result: number | undefined | null
  switch (rule.frequency) {
    case "DAILY": {
      let step = Math.floor(Math.max(0, dayOf(from.getFullYear(), from.getMonth(), from.getDate()) - originDay) / rule.interval)
      for (let n = stepsIn(CYCLE_DAYS, rule.interval); n > 0 && !found(result); n--, step++) result = firstIn(rule, [originDay + step * rule.interval], after)
      break
    }
    case "WEEKLY": {
      const weekStartDay = (day: number, dow: number) => day - ((dow - rule.weekStart + 7) % 7)
      const originWeek = weekStartDay(originDay, origin.weekday)
      const fromWeek = weekStartDay(dayOf(from.getFullYear(), from.getMonth(), from.getDate()), from.getDay())
      let step = Math.floor(Math.max(0, Math.floor((fromWeek - originWeek) / 7)) / rule.interval)
      for (let n = stepsIn(CYCLE_WEEKS, rule.interval); n > 0 && !found(result); n--, step++) result = firstIn(rule, range(originWeek + step * rule.interval * 7, 7), after)
      break
    }
    case "MONTHLY": {
      const originMonth = origin.year * 12 + origin.month
      let step = Math.floor(Math.max(0, from.getFullYear() * 12 + from.getMonth() - originMonth) / rule.interval)
      for (let n = stepsIn(CYCLE_MONTHS, rule.interval); n > 0 && !found(result); n--, step++) {
        const month = originMonth + step * rule.interval
        const year = Math.floor(month / 12)
        const days = rule.byMonthDays.filter((date) => date <= new Date(Date.UTC(year, (month % 12) + 1, 0)).getUTCDate()).map((date) => dayOf(year, month % 12, date))
        result = firstIn(rule, days, after)
      }
      break
    }
    case "YEARLY": {
      let year = Math.max(from.getFullYear(), origin.year)
      const behind = (year - origin.year) % rule.interval
      if (behind) year += rule.interval - behind
      for (let n = stepsIn(CYCLE_YEARS, rule.interval); n > 0 && !found(result); n--, year += rule.interval) {
        const days = rule.byMonths.flatMap((month) =>
          rule.byMonthDays.filter((date) => date <= new Date(Date.UTC(year, month, 0)).getUTCDate()).map((date) => dayOf(year, month - 1, date)),
        )
        result = firstIn(rule, days.sort((a, b) => a - b), after)
      }
      break
    }
    case "HOURLY": {
      const originHour = hourOf(origin.year, origin.month, origin.date, origin.hour)
      let step = Math.floor(Math.max(0, hourOf(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours()) - originHour) / rule.interval)
      for (let n = stepsIn(CYCLE_HOURS, rule.interval); n > 0 && !found(result); n--, step++) {
        const hour = originHour + step * rule.interval
        const when = new Date(hour * HOUR_MS)
        if (!rule.byHours.includes(when.getUTCHours())) continue
        const day = dayOf(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate())
        const only = { ...rule, byHours: [when.getUTCHours()] }
        result = firstIn(only, [day], after)
      }
      break
    }
  }
  return result ?? undefined
}

/** When a rule next runs after `after`; nothing when it has run its course. */
export function nextOccurrence(rule: RRule, after: number): number | undefined {
  if (rule.count === undefined) return firstAfter(rule, after)
  let cursor = (rule.start?.getTime() ?? 0) - 1
  for (let seen = 0; seen < rule.count; seen++) {
    const next = firstAfter(rule, cursor)
    if (next === undefined) return undefined
    if (next > after) return next
    cursor = next
  }
  return undefined
}

const pad = (value: number) => String(value).padStart(2, "0")
const DAY_NAMES = {
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  zh: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"],
}
const UNITS: Record<"en" | "zh", Record<Frequency, string>> = {
  en: { HOURLY: "hour", DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" },
  zh: { HOURLY: "小时", DAILY: "天", WEEKLY: "周", MONTHLY: "月", YEARLY: "年" },
}
const hasChinese = (text: string) => /[㐀-鿿]/u.test(text)

/**
 * MiMo's reading of a schedule: hourly, daily, weekdays and weekly by name,
 * anything else by its interval or its label - in Chinese for a Chinese
 * locale, English otherwise (T10-52). A label is used only when it is written
 * in the same language, and "custom" is no label at all. Times drop a leading
 * zero, as MiMo writes them (9:05).
 */
export function scheduleLabel(text: string, label?: string, locale = "en"): string {
  const zh = locale.toLowerCase().startsWith("zh")
  const words = zh ? "zh" : "en"
  const rule = parseRRule(text)
  if (!rule) return zh ? "自定义" : "Custom"
  const plain = !rule.hasStart && !rule.extraLines
  const only = (allowed: string[]) => plain && rule.keys.every((key) => allowed.includes(key))
  const time = `${pad(rule.byHours[0] ?? 9)}:${pad(rule.byMinutes[0] ?? 0)}`.replace(/^0/, "")
  if (rule.interval === 1 && rule.frequency === "HOURLY" && rule.byMinutes.join() === "0" && only(["FREQ", "BYMINUTE"])) return zh ? "每小时" : "Hourly"
  if (rule.interval === 1 && rule.frequency === "DAILY" && rule.byHours.length === 1 && rule.byMinutes.length === 1 && !rule.byWeekdays.length && only(["FREQ", "BYHOUR", "BYMINUTE"])) {
    return zh ? `每天 ${time}` : `Every day ${time}`
  }
  if (rule.interval === 1 && rule.frequency === "WEEKLY" && rule.byHours.length === 1 && rule.byMinutes.length === 1 && only(["FREQ", "BYHOUR", "BYMINUTE", "BYDAY"])) {
    if (rule.byWeekdays.join() === "1,2,3,4,5") return zh ? `工作日 ${time}` : `Weekdays ${time}`
    if (rule.byWeekdays.length === 1) {
      const day = DAY_NAMES[words][rule.byWeekdays[0]!]
      return zh ? `${day}（时间：${time}）` : `${day} (time: ${time})`
    }
  }
  const unit = UNITS[words][rule.frequency]
  const every = zh ? `每隔 ${rule.interval} ${unit}` : `Every ${rule.interval} ${unit}${rule.interval === 1 ? "" : "s"}`
  const named = label?.trim()
  if (!named || named === "自定义" || named.toLowerCase() === "custom") return every
  return hasChinese(named) === zh ? named : every
}
