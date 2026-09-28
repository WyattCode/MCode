const math = require("./math")

// calcTotal sums the lines of an invoice.
function invoiceTotal(lines) {
  return math.calcTotal(lines)
}

module.exports = { invoiceTotal }
