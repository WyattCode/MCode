// Regenerate src/server/remote/cockpit-html.ts from cockpit.html.
//
// The .ts is what the bundle imports; the .html is the source nobody ships.
// There was no script turning one into the other, so an edit to the .html
// silently changed nothing - and writing one naively is easy to get wrong: the
// page must reach the browser as *the HTML itself*, so the module has to hold a
// single already-decoded string. Emitting `JSON.stringify(html)` put a
// JSON-encoded string in the module, which the page server then served verbatim
// - every newline as a literal backslash-n, the whole script unparseable, and
// the cockpit dead on arrival while every check stayed green.
import fs from "node:fs"

const source = "src/server/remote/cockpit.html"
const target = "src/server/remote/cockpit-html.ts"

const html = fs.readFileSync(source, "utf8")
const header = "// Generated from cockpit.html - edit that file and re-run the generator.\n"
// One encode, not two: the module evaluates to the HTML string the server sends.
fs.writeFileSync(target, `${header}export const cockpitHtml =\n  ${JSON.stringify(html)}\n`)

// Read it back the way the bundle will, and prove it is the file it came from.
const written = fs.readFileSync(target, "utf8").slice(header.length)
const value = written.replace("export const cockpitHtml =\n  ", "").trim()
const reloaded = JSON.parse(value)
console.log(`wrote ${target} (${html.length} chars)`)
console.log("round-trips:", reloaded === html)
if (reloaded !== html) process.exit(1)
// The failure that prompted this: a served page whose script line breaks are
// still escaped is not a page, and loading it proves nothing.
if (reloaded.includes("\\n") && !html.includes("\\n")) {
  console.log("WARNING: the decoded value still carries escaped newlines")
  process.exit(1)
}