/**
 * Checks the language tables against what the interface actually asks for.
 *
 * A key the components use but no table defines renders as the raw key - a
 * visible defect that no type check catches, because keys are strings. With
 * eighteen languages the reverse matters too: a table that has drifted out of
 * step with English silently falls back, and it is better to know by how much.
 */
import fs from "node:fs"
import path from "node:path"

const root = process.cwd()
const source = fs.readFileSync(path.join(root, "src/renderer/src/lib/i18n.ts"), "utf8")

/** Reads one table out of the module. */
function table(name: string): Record<string, string> {
  const start = source.indexOf(`const ${name}: Table = {`)
  if (start === -1) throw new Error(`no table named ${name}`)
  const end = source.indexOf("\n}", start)
  const out: Record<string, string> = {}
  const entry = /^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm
  const body = source.slice(start, end)
  for (const match of body.matchAll(entry)) out[match[1]] = JSON.parse(`"${match[2]}"`)
  return out
}

const names = [...source.matchAll(/^const ([A-Za-z0-9]+): Table = \{/gm)].map((m) => m[1])
const tables = Object.fromEntries(names.map((name) => [name, table(name)]))
const english = tables.en

// Every key the components reach for, however they spell the call.
const used = new Set<string>()
/** Prefixes of keys assembled at runtime, e.g. `mcp.status.` . */
const dynamic = new Set<string>()
const walk = (directory: string) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(vue|ts)$/.test(entry.name) && !full.endsWith("i18n.ts")) {
      const text = fs.readFileSync(full, "utf8")
      for (const match of text.matchAll(/\bt\(\s*["'`]([a-zA-Z][\w.]*)["'`]/g)) used.add(match[1])
      // Keys built from a value: t(`mcp.status.${entry.status}`). The literal
      // above never matches these, so seventeen call sites across nine prefixes
      // were reaching for keys nothing checked. What can be checked is the
      // prefix, and - where the values come from a list in the protocol - each
      // key the list implies.
      for (const match of text.matchAll(/\bt\(\s*`([a-zA-Z][\w.]*?)\$\{/g)) dynamic.add(match[1])
    }
  }
}
walk(path.join(root, "src/renderer/src"))

const problems: string[] = []

/*
 * A key assembled from a value cannot be read off the source, but two things
 * about it can be checked.
 *
 * First, that anything at all is defined under its prefix: renaming a family of
 * keys and missing one of these call sites leaves the interface showing the key
 * itself, and nothing else would notice.
 *
 * Second, where the values come from a list the protocol declares, that every
 * value in that list has a key. Adding a member to one of these unions without
 * adding its string is the failure this is really for.
 */
const protocolSource = fs.readFileSync(path.join(root, "src/shared/protocol.ts"), "utf8")

function members(declaration: RegExp): string[] {
  const found = declaration.exec(protocolSource)
  if (!found) return []
  return [...found[1].matchAll(/"([a-z_]+)"/g)].map((entry) => entry[1])
}

/*
 * The built-in tools, read from the registry that defines them.
 *
 * A tool card falls back to the tool's own name when there is no string for it,
 * which is right for an MCP tool - its name belongs to whichever server offers
 * it - and wrong for a tool this app ships, which then shows an identifier
 * where every other card shows a word.
 */
const toolDir = path.join(root, "src/server/tool")

/**
 * The one tool that needs no word.
 *
 * `invalid` is never offered to the model - the reference keeps it out of the
 * request with `activeTools.filter(x => x !== "invalid")` and this app keeps it
 * out of TOOLS - and it is only ever reached when a call could not be
 * dispatched, where the card carries the reference's own hardcoded "Invalid
 * Tool" rather than a localized name. The reference has no string for it in any
 * of its eighteen tables, so demanding one here could only be answered by
 * inventing eighteen, which is the thing this check exists to prevent.
 */
const UNNAMED_TOOLS = new Set(["invalid"])

const toolNames = fs
  .readdirSync(toolDir)
  .filter((name) => name.endsWith(".ts"))
  .flatMap((name) => [...fs.readFileSync(path.join(toolDir, name), "utf8").matchAll(/^ {2}name: "([a-z]+)"/gm)])
  .map((match) => match[1])
  .filter((name) => !UNNAMED_TOOLS.has(name))

const FAMILIES: { prefix: string; values: string[]; from: string }[] = [
  { prefix: "tool.", values: toolNames, from: "the tool registry" },
  { prefix: "mcp.status.", values: members(/export type McpStatus =(.+)/), from: "McpStatus" },
  { prefix: "agent.", values: members(/export const AGENT_NAMES = \[([^\]]+)\]/), from: "AGENT_NAMES" },
  { prefix: "tool.desc.", values: members(/export const PERMISSION_KINDS = \[([^\]]+)\]/), from: "PERMISSION_KINDS" },
]

/*
 * The families are checked whatever the call site looks like.
 *
 * They used to be checked only for prefixes found by scanning for
 * t(`prefix.${...}`), which tied the check to how the call happened to be
 * written: a component that built its key into a variable first dropped out of
 * the scan, and its whole family stopped being checked without anything saying
 * so. What is being checked here is the data, not the spelling of one call.
 */
for (const family of FAMILIES) {
  if (!family.values.length) {
    problems.push(`${family.from} could not be read, so ${family.prefix} is unchecked`)
    continue
  }
  const absent = family.values.filter((value) => !(family.prefix + value in english))
  if (absent.length) {
    problems.push(
      `${family.from} has ${absent.length} value(s) with no string: ${absent.map((v) => family.prefix + v).join(", ")}`,
    )
  }
}

/*
 * Permission row titles, and the two that must stay absent.
 *
 * Eight of the nine buckets map onto a bucket the reference names, so those
 * eight rows carry its word instead of a lowercase identifier. `mcp` has no
 * counterpart at all - the reference has no notion of an MCP server - so there
 * is no string to adopt for it, and inventing one would look harmless and be
 * exactly the thing this project does not do. Both halves are asserted: a
 * missing title shows a raw id where every other row shows a word, and a title
 * appearing for `mcp` is a hand-written string that came from nowhere.
 *
 * `write` is checked alongside it, and for the same reason it always was: the
 * reference judges every file change as one `edit`, and since R16-C6 so does
 * this app, so no row is drawn for it and no title may appear.
 */
const TITLED_BUCKETS = ["read", "edit", "glob", "grep", "list", "bash", "webfetch", "outside"]
const UNTITLED_BUCKETS = ["write", "mcp"]

for (const bucket of TITLED_BUCKETS) {
  const key = `tool.title.${bucket}`
  const absent = Object.entries(tables)
    .filter(([, entries]) => !(key in entries))
    .map(([name]) => name)
  if (absent.length) problems.push(`${key} is missing from ${absent.join(", ")}`)
}
for (const bucket of UNTITLED_BUCKETS) {
  const key = `tool.title.${bucket}`
  const present = Object.entries(tables)
    .filter(([, entries]) => key in entries)
    .map(([name]) => name)
  if (present.length) {
    problems.push(`${key} exists in ${present.join(", ")}, but the reference has no title for that bucket`)
  }
}

/*
 * The families landed ahead of the screens that will use them.
 *
 * Three sets of strings were copied out of the reference before anything reads
 * them: the question tool's, and the badges and headings the slash menu needs
 * to tell a project command from an MCP prompt from a skill. Nothing here calls `t` with any of them
 * yet, so every other rule in this file is silent about them - the used-but-
 * undefined scan cannot see a call that does not exist, and the per-table
 * comparison only asks that the seventeen match English, which they would
 * still do if all eighteen lost the key together.
 *
 * So they are named. Deleting one, or renaming the family without renaming it
 * here, fails; and because the reference-strings fixture below carries the same
 * keys in all eighteen languages, changing one's wording fails too.
 */
const LANDED_KEYS = [
  // The question tool: node-BBwF64dM.js @19448800 for the tool, and the
  // renderer's own strings at main-8t-QUXax.js @348300 / @352300 / @1858300.
  "ui.tool.questions",
  "ui.tool.questions.numbered",
  "ui.question.singleHint",
  "ui.question.multiHint",
  "ui.question.subtitle.answered",
  "ui.question.answer.none",
  "ui.question.review.notAnswered",
  "ui.question.custom.placeholder",
  "ui.messagePart.option.typeOwnAnswer",
  "ui.messagePart.review.title",
  "ui.messagePart.questions.dismissed",
  "session.question.progress",
  "session.question.minimize",
  "session.question.restore",
  "session.question.pending.one",
  "session.question.pending.other",
  "notification.question.title",
  "notification.question.description",
  // Slash sources: the badge trio the reference draws for a command whose
  // source is not "command" (@4486037), and the menu around them.
  "prompt.slash.badge.custom",
  "prompt.slash.badge.mcp",
  "prompt.slash.badge.skill",
  "prompt.menu.commands",
  "prompt.popover.emptyCommands",
  "ui.promptInput.commands",
  "ui.promptInput.noMatchingItems",
  /*
   * The five transcript-paging keys that used to be listed here are gone.
   *
   * They were landed for a builder who never arrived, and it turns out none
   * could have used them: measured against the reference, `loading`,
   * `loadEarlier`, `loadingEarlier` and `renderEarlier` are consumed ZERO times
   * in its own renderer - it virtualises the transcript rather than paging it,
   * so the strings are dead there too. `jumpToLatest` it does use, but this app
   * already draws that button under its own key `stream.jump`, whose eighteen
   * values are byte-for-byte the reference's jumpToLatest.
   *
   * Removed rather than kept, by the rule that put them under scrutiny in the
   * first place: a key with no consumer is a claim that a feature exists.
   */
]

for (const key of LANDED_KEYS) {
  const absent = Object.entries(tables)
    .filter(([, entries]) => !(key in entries))
    .map(([name]) => name)
  if (absent.length) problems.push(`${key} is missing from ${absent.join(", ")}`)
}

/*
 * And the row the question tool does not get.
 *
 * The reference gates its question tool behind a permission - it asserts
 * `action: "question"` before asking, and its build and plan agents allow it
 * over a ruleset that denies it by default (@11798370) - but there is no
 * `settings.permissions.tool.question.title` or `.description` anywhere in the
 * archive, in any of the eighteen languages. Every other bucket its Settings
 * screen draws has both. So that row is not one a reader ever sees, and a
 * string for it could only have been invented. Same shape of assertion as the
 * `write` and `mcp` buckets above, and for the same reason.
 */
const ABSENT_KEYS = [
  "settings.permissions.tool.question.title",
  "settings.permissions.tool.question.description",
]

for (const key of ABSENT_KEYS) {
  const present = Object.entries(tables)
    .filter(([, entries]) => key in entries)
    .map(([name]) => name)
  if (present.length) {
    problems.push(`${key} exists in ${present.join(", ")}, but the reference has no such string`)
  }
}

// And any other prefix assembled at a call site has to lead somewhere.
for (const prefix of dynamic) {
  if (FAMILIES.some((entry) => entry.prefix === prefix)) continue
  if (!Object.keys(english).some((key) => key.startsWith(prefix))) {
    problems.push(`no key is defined under the built prefix "${prefix}"`)
  }
}

const missing = [...used].filter((key) => !(key in english)).sort()
if (missing.length) {
  problems.push(`${missing.length} key(s) used but not defined: ${missing.slice(0, 12).join(", ")}`)
}

// A table with keys English does not have is dead weight, and usually a typo.
for (const [name, entries] of Object.entries(tables)) {
  if (name === "en") continue
  const strays = Object.keys(entries).filter((key) => !(key in english))
  if (strays.length) problems.push(`${name}: ${strays.length} key(s) not in English: ${strays.slice(0, 6).join(", ")}`)
  const absent = Object.keys(english).filter((key) => !(key in entries))
  if (absent.length) problems.push(`${name}: ${absent.length} key(s) missing`)
}

// t() fills single-brace {name} only. A double-brace value copied from an
// i18next table renders its braces, so "Retrying in {{time}}" shows as
// "Retrying in {12s}".
for (const [name, entries] of Object.entries(tables)) {
  const doubled = Object.keys(entries).filter((key) => entries[key].includes("{{"))
  if (doubled.length) problems.push(`${name}: ${doubled.length} value(s) use {{...}}, which t() never fills: ${doubled.slice(0, 6).join(", ")}`)
}

console.log(`keys used by the interface: ${used.size}`)
console.log(`keys defined in English:    ${Object.keys(english).length}`)
for (const name of names) {
  if (name === "en") continue
  const entries = tables[name]
  const same = Object.keys(english).filter((key) => entries[key] === english[key]).length
  console.log(`  ${name.padEnd(6)} ${Object.keys(entries).length} keys, ${same} still reading as English`)
}

/*
 * Against the reference's own strings.
 *
 * 219 of these keys have a known counterpart in OpenCode's shipped locale
 * tables. Where the two disagree the reference is right by definition - this is
 * a replica - so a disagreement is a defect worth failing on. Placeholders are
 * normalised because the two apps spell them differently ({{x}} against {name})
 * while meaning the same thing.
 *
 * A key the 2.0 design deliberately rewrites is taken out of the fixture rather
 * than excused in code here: 2.0 lays its interface out from Xiaomi MiMo, so
 * for those strings OpenCode is no longer the authority. Everything still in
 * the fixture is compared as strictly as before, and removing a key is a
 * visible edit to a checked-in file rather than a condition in this script.
 */
const fixture = path.join(root, "scripts/fixtures/reference-strings.json")
if (fixture && fs.existsSync(fixture)) {
  const expected: Record<string, Record<string, string>> = JSON.parse(fs.readFileSync(fixture, "utf8"))
  const plain = (value: string) => value.replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, "{}").trim()
  const drift: string[] = []
  let compared = 0
  for (const [key, byLanguage] of Object.entries(expected)) {
    for (const [name, want] of Object.entries(byLanguage)) {
      const have = tables[name]?.[key]
      if (have === undefined) continue
      compared += 1
      if (plain(have) !== plain(want)) drift.push(`${name} ${key}: ${JSON.stringify(have)} vs reference ${JSON.stringify(want)}`)
    }
  }
  console.log(`
compared with the reference: ${compared} string(s), ${drift.length} differing`)
  for (const line of drift.slice(0, 12)) problems.push(line)
  if (drift.length > 12) problems.push(`...and ${drift.length - 12} more differing from the reference`)
}

/*
 * Interpolation, which the rest of this file cannot see.
 *
 * Every key being defined says nothing about whether the arguments a call site
 * passes are the ones its string asks for. A placeholder nobody supplies is
 * rendered to the reader as literal braces, in one language while the others
 * read correctly - so it survives both the missing-key check above and a glance
 * at the app in English.
 */
const CALL = new RegExp(
  '\\bt\\(\\s*"([^"]+)"\\s*,\\s*\\{([^{}]*)\\}',
  "g",
)
const NAMED = /(\w+)\s*:/g
const PLACEHOLDER = /\{(\w+)\}/g

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/[.](vue|ts)$/.test(entry.name) && entry.name !== "i18n.ts") out.push(full)
  }
  return out
}

for (const file of sourceFiles(path.join(root, "src"))) {
  const text = fs.readFileSync(file, "utf8")
  for (const call of text.matchAll(CALL)) {
    const [, key, body] = call
    const supplied = new Set<string>()
    for (const named of body.matchAll(NAMED)) supplied.add(named[1])
    // ES6 shorthand: { url } supplies url just as { url: url } would.
    for (const piece of body.split(",")) {
      const bare = piece.trim()
      if (/^\w+$/.test(bare)) supplied.add(bare)
    }
    for (const [name, entries] of Object.entries(tables)) {
      const value = entries[key]
      if (value === undefined) continue
      for (const found of value.matchAll(PLACEHOLDER)) {
        if (!supplied.has(found[1])) {
          problems.push(
            `${path.basename(file)} calls t("${key}") without {${found[1]}}, which ${name} needs`,
          )
        }
      }
    }
  }
}

/*
 * First-run language detection.
 *
 * The default is deliberately empty so the window can ask the machine, and that
 * path runs exactly once per profile - on a machine which, here, answers
 * Chinese either way. So the mapping is exercised directly instead, through
 * the window's own entry point.
 */
const CASES: [string, string][] = [
  ["de-AT", "de"],
  ["fr-CA", "fr"],
  ["pt-PT", "pt-BR"],
  ["zh-TW", "zh-TW"],
  ["zh-HK", "zh-TW"],
  ["zh-MO", "zh-TW"],
  ["zh-Hant-SG", "zh-TW"],
  ["zh_Hant", "zh-TW"],
  ["zh-CN", "zh-CN"],
  ["zh-SG", "zh-CN"],
  ["ar-EG", "ar"],
  ["en-GB", "en"],
  ["ko", "ko"],
  ["no", "nb"],
  ["nn-NO", "nb"],
  ["nb-NO", "nb"],
  ["is-IS", "en"],
  ["", "en"],
]

const { detectLanguage } = await import("../src/renderer/src/lib/i18n")
for (const [tag, expected] of CASES) {
  const got = detectLanguage(tag)
  if (got !== expected) problems.push(`a machine set to "${tag}" would start in ${got}, not ${expected}`)
}
console.log(`first-run language cases: ${CASES.length}`)

if (problems.length) {
  console.error("\nFAILED:")
  for (const problem of problems) console.error("  " + problem)
  process.exit(1)
}
console.log("\nEvery key the interface uses is defined, in every language.")
