const { addDays, daysBetween } = require("./dates")

/**
 * Every date of a shift that repeats every `everyDays` days from `start`, up to
 * and including `until`.
 */
function occurrences(start, everyDays, until) {
  const dates = []
  for (let date = start; daysBetween(date, until) > 0; date = addDays(date, everyDays)) dates.push(date)
  return dates
}

module.exports = { occurrences }
