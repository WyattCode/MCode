const { calcTotal } = require("./math")

function report(rows) {
  const total = calcTotal(rows.map((row) => row.amount))
  return `total: ${total}`
}

module.exports = { report }
