const assert = require("node:assert")
const { lineTotal, cartTotal } = require("./src/cart")

assert.strictEqual(lineTotal({ price: 2.5, qty: 4 }), 10)
assert.strictEqual(cartTotal([{ price: 10, qty: 2 }, { price: 5, qty: 1 }]), 25)
assert.strictEqual(cartTotal([{ price: 100, qty: 1 }], 10), 90)
assert.strictEqual(cartTotal([{ price: 100, qty: 1 }], 10, 0.2), 108)
assert.strictEqual(cartTotal([], 50, 0.1), 0)
console.log("all tests passed")
