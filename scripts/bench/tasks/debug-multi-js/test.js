const assert = require("node:assert")
const { daysBetween, addDays } = require("./src/dates")
const { occurrences } = require("./src/recurrence")
const { roster, format } = require("./src/roster")

assert.strictEqual(daysBetween("2026-03-01", "2026-03-08"), 7)
assert.strictEqual(daysBetween("2026-01-30", "2026-02-02"), 3)
assert.strictEqual(daysBetween("2026-02-27", "2026-03-02"), 3)
assert.strictEqual(daysBetween("2026-12-31", "2027-01-01"), 1)
assert.strictEqual(addDays("2026-02-27", 3), "2026-03-02")

assert.deepStrictEqual(occurrences("2026-03-01", 3, "2026-03-07"), ["2026-03-01", "2026-03-04", "2026-03-07"])
assert.deepStrictEqual(occurrences("2026-02-26", 2, "2026-03-03"), ["2026-02-26", "2026-02-28", "2026-03-02"])
assert.deepStrictEqual(occurrences("2026-03-05", 1, "2026-03-05"), ["2026-03-05"])

const people = [
  { name: "Cleo", every: 2 },
  { name: "Ana", every: 3 },
  { name: "Ben", every: 2, from: "2026-02-28" },
]
assert.strictEqual(
  format(roster(people, "2026-02-27", "2026-03-04")),
  ["2026-02-27: Ana, Cleo", "2026-02-28: Ben", "2026-03-01: Cleo", "2026-03-02: Ana, Ben", "2026-03-03: Cleo", "2026-03-04: Ben"].join("\n"),
)
console.log("all tests passed")
