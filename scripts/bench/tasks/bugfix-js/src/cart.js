// Shopping cart totals.
function lineTotal(item) {
  return item.price * item.qty
}

// A discount is a percentage off the subtotal, applied before tax.
function cartTotal(items, discountPercent = 0, taxRate = 0) {
  const subtotal = items.reduce((sum, item) => sum + lineTotal(item), 0)
  const discounted = subtotal - discountPercent
  const taxed = discounted * taxRate
  return Math.round(taxed * 100) / 100
}

module.exports = { lineTotal, cartTotal }
