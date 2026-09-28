const { report } = require("./src/report")
const { invoiceTotal } = require("./src/invoice")
const { calcTotal } = require("./src/math")

console.log(report([{ amount: 2 }, { amount: 3 }]))
console.log(invoiceTotal([1, 2, 3]))
console.log(calcTotal([10, 20]))
