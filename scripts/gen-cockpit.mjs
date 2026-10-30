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

/*
 * `--check` answers "is the generated file current?" without writing.
 *
 * This step is manual, and nothing failed when it was skipped: the gateway kept
 * serving an older page, every check that reads the source kept passing, and the
 * only symptom was a phone offering a button it should not have. A check mode
 * lets the build fail on a stale file instead.
 */
const checkOnly = process.argv.includes("--check")

const html = fs.readFileSync(source, "utf8")
const header = "// Generated from cockpit.html - edit that file and re-run the generator.\n"
const expected = `${header}export const cockpitHtml =\n  ${JSON.stringify(html)}\n`

if (checkOnly) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : ""
  if (current === expected) {
    console.log(`${target} is current (${html.length} chars)`)
    process.exit(0)
  }
  console.log(`${target} is STALE - run: node scripts/gen-cockpit.mjs`)
  console.log(`  source ${html.length} chars, generated ${current.length} chars`)
  process.exit(1)
}

fs.writeFileSync(target, expected)

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