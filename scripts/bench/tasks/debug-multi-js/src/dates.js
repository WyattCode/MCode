// Dates are plain "YYYY-MM-DD" strings throughout; arithmetic is done in UTC so no time zone can shift a day.

function parse(iso) {
  const [year, month, day] = iso.split("-").map(Number)
  return { year, month, day }
}

/** Whole days from a to b (negative when b is earlier). */
function daysBetween(a, b) {
  const x = parse(a)
  const y = parse(b)
  const from = Date.UTC(x.year, x.month, x.day)
  const to = Date.UTC(y.year, y.month, y.day)
  return Math.round((to - from) / 86400000)
}

/** The date n days after iso. */
function addDays(iso, n) {
  const { year, month, day } = parse(iso)
  return new Date(Date.UTC(year, month - 1, day + n)).toISOString().slice(0, 10)
}

module.exports = { daysBetween, addDays }
