const assert = require("node:assert")
const { parseCSV, toCSV } = require("./src/csv")

const cases = [
  ["a,b,c", [["a", "b", "c"]]],
  ["a,b\nc,d", [["a", "b"], ["c", "d"]]],
  ["a,b\r\nc,d\r\n", [["a", "b"], ["c", "d"]]],
  ["a,b\n", [["a", "b"]]],
  ["", []],
  ["a,,c", [["a", "", "c"]]],
  [",", [["", ""]]],
  ['"x,y",z', [["x,y", "z"]]],
  ['"say ""hi""",2', [['say "hi"', "2"]]],
  ['"line1\nline2",end', [["line1\nline2", "end"]]],
  ['"a\r\nb"\r\nc', [["a\r\nb"], ["c"]]],
  ['""', [[""]]],
  ['a,""\n', [["a", ""]]],
  ["a\n\nb", [["a"], [""], ["b"]]],
  [' spaced , x', [[" spaced ", " x"]]],
]
for (const [text, rows] of cases) assert.deepStrictEqual(parseCSV(text), rows, JSON.stringify(text))

assert.strictEqual(toCSV([["a", "b"], ["c", "d"]]), "a,b\nc,d")
assert.strictEqual(toCSV([["x,y", 'say "hi"', "two\nlines"]]), '"x,y","say ""hi""","two\nlines"')
assert.strictEqual(toCSV([[" pad", "ok", ""]]), '" pad",ok,')
assert.strictEqual(toCSV([]), "")

const tricky = [["id", "note"], ["1", 'He said "no, thanks"'], ["2", "multi\r\nline"], ["3", ""], ["4", " lead"]]
assert.deepStrictEqual(parseCSV(toCSV(tricky)), tricky)
console.log("all tests passed")
