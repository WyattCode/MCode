function calcTotal(values) {
  return values.reduce((a, b) => a + b, 0)
}

module.exports = { calcTotal }
