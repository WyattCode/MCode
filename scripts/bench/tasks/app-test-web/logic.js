// What the buttons compute. Loaded by the page as a plain script; check.cjs loads it too.
var Logic = {
  plus: function (count) {
    return count + 1
  },
  minus: function (count) {
    return count - 2
  },
  reset: function () {
    return 0
  },
  savedText: function (nick, lang, dark) {
    return "已保存：" + (nick || "（未填昵称）") + "，" + lang + "，" + (dark ? "浅色" : "深色")
  },
}
if (typeof module !== "undefined") module.exports = Logic
