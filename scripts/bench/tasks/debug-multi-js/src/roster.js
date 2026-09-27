const { occurrences } = require("./recurrence")

/**
 * The roster: every shift of every person between start and until, earliest
 * first, and people on the same day in alphabetical order.
 */
function roster(people, start, until) {
  const entries = []
  for (const person of people) {
    for (const date of occurrences(person.from ?? start, person.every, until)) entries.push({ date, name: person.name })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date))
}

/** One line per day: "2026-03-02: Ana, Ben". */
function format(entries) {
  const days = new Map()
  for (const entry of entries) days.set(entry.date, [...(days.get(entry.date) ?? []), entry.name])
  return [...days].map(([date, names]) => `${date}: ${names.join(", ")}`).join("\n")
}

module.exports = { roster, format }
