const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const files = ["src/math.js", "src/report.js", "src/invoice.js", "index.js"]
for (const file of files) {
  const text = fs.readFileSync(path.join(__dirname, file), "utf8")
  if (/calcTotal/.test(text)) throw new Error(`${file} still says calcTotal`)
}
const out = execFileSync(process.execPath, [path.join(__dirname, "index.js")], { encoding: "utf8" }).trim().split(/\r?\n/)
if (out.join("|") !== "total: 5|6|30") throw new Error("output changed: " + out.join("|"))
const math = require("./src/math")
if (typeof math.computeTotal !== "function") throw new Error("computeTotal is not exported")
console.log("check passed")
