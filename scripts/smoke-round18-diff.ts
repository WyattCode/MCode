/**
 * Round 18, lane D: the diff, measured on the running MiMo 26.920.
 *
 * The pairing that decides a line's colour is arithmetic and runs here against
 * the real code; the colours, the gutter and the markup are read from the
 * source. The computed colours in the window, in both themes, are in the
 * lane's Electron probe (r18d-probe.cjs), whose table is in the report.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { LANGUAGES } from "../src/renderer/src/lib/i18n"
import { absoluteName, markWords, splitRows, type DiffLine } from "../src/renderer/src/lib/diff-view"
import { WORD_MARK_MAX } from "../src/renderer/src/lib/diff-words"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** Every language table in i18n.ts, as key -> value. */
async function tables(): Promise<Record<string, Record<string, string>>> {
  const source = await read("src/renderer/src/lib/i18n.ts")
  const out: Record<string, Record<string, string>> = {}
  for (const found of source.matchAll(/^const ([A-Za-z0-9]+): Table = \{/gm)) {
    const start = found.index!
    const body = source.slice(start, source.indexOf("\n}", start))
    const entries: Record<string, string> = {}
    for (const entry of body.matchAll(/^ {2}"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) entries[entry[1]!] = JSON.parse(`"${entry[2]}"`) as string
    out[found[1]!] = entries
  }
  return out
}

export async function roundEighteenDiffChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ----------------------------------------------------------------- R18-D1
  section("Round 18 (R18-D1): a file's header has no tick, as MiMo's has none")
  {
    const body = await read("src/renderer/src/components/parts/DiffBody.vue")
    check("the header draws no checkbox", !/type="checkbox"/.test(body) && !/data-diff-viewed|db-viewed/.test(body))
    check("and nothing is kept for one", !/\bviewed\b/.test(body) && !/markViewed/.test(body))
    const strings = await tables()
    const names = Object.keys(strings)
    check(`all ${LANGUAGES.length} language tables were read`, names.length === LANGUAGES.length, names)
    const still = names.filter((name) => "rp.diff.viewed" in strings[name]!)
    check("its word is gone from every language table", still.length === 0, still)
  }

  // ----------------------------------------------------------------- R18-D2
  section("Round 18 (R18-D2): the gutter is diff2html's one cell, which stacks its numbers when the code needs the room")
  {
    const body = await read("src/renderer/src/components/parts/DiffBody.vue")
    const style = body.slice(body.indexOf("<style"))
    const rule = (selector: string) => {
      const at = style.indexOf(`\n${selector} {`)
      return at < 0 ? "" : style.slice(at, style.indexOf("}", at))
    }
    check(
      "a merged line's two numbers share one cell, as diff2html's line-num1 and line-num2 do",
      /<span class="db-ln"><span class="db-num">\{\{ line\.old \?\? "" \}\}<\/span><span class="db-num">\{\{ line\.new \?\? "" \}\}<\/span><\/span>/.test(body),
    )
    check("and a hunk's header row has the one cell beside it", /<div class="db-row info">\s*<span class="db-ln" \/>\s*<span class="db-code">\{\{ hunk\.header \}\}/.test(body))
    check("the cell is 7.5em when there is room and gives way to its least - one number - when there is not", /grid-template-columns: minmax\(min-content, 7\.5em\) minmax\(max-content, 1fr\)/.test(rule(".db-table")))
    check("every row lays out on the same columns, so the gutter is one width down the whole file", /display: grid/.test(rule(".db-row")) && /grid-template-columns: subgrid/.test(rule(".db-row")) && /grid-column: 1 \/ -1/.test(rule(".db-row")))
    check("each number is 3.5em, floated to its own side, so two that do not fit drop one under the other", /float: inline-start/.test(rule(".db-num")) && /width: 3\.5em/.test(rule(".db-num")) && /float: inline-end/.test(rule(".db-num + .db-num")))
    check("the gutter scrolls with the code, as diff2html's static cell does", !/position: sticky/.test(rule(".db-ln")))
    check("with a line on both sides of it, as diff2html draws it", /border-width: 0 1px/.test(rule(".db-ln")))
    check("the side-by-side gutter keeps diff2html's 4em", /grid-template-columns: 4em minmax\(max-content, 1fr\)/.test(rule(".db-side .db-table")))
  }

  // ----------------------------------------------------------------- R18-D3
  section("Round 18 (R18-D3): a pair is coloured apart from a lone removal or addition, in MiMo's measured colours")
  {
    const line = (kind: DiffLine["kind"], text: string): DiffLine => ({ kind, text })
    const hunk = markWords([
      line("ctx", "export function greet(name) {"),
      line("del", '  const message = "Hello, " + name'),
      line("add", '  const message = "Hi, " + name'),
      line("ctx", "}"),
      line("del", ""),
      line("del", "export function total(items) {"),
      line("ctx", "# demo"),
      line("add", "## Usage"),
    ])
    check("a removal with an addition after it is a pair, both sides", hunk[1]!.paired === true && hunk[2]!.paired === true, hunk.map((l) => l.paired))
    check("a run of removals with nothing after it is not", hunk[4]!.paired === undefined && hunk[5]!.paired === undefined)
    check("nor is an addition that follows no removal", hunk[7]!.paired === undefined && hunk[0]!.paired === undefined)
    const long = "x".repeat(WORD_MARK_MAX + 5)
    const tooLong = markWords([line("del", long), line("add", `${long}y`)])
    check("a pair too long to mark word by word is still a pair, as diff2html still calls it a change", tooLong[0]!.paired === true && tooLong[1]!.paired === true && tooLong[0]!.marks === undefined)
    const uneven = markWords([line("del", "a"), line("del", "b"), line("add", "c")])
    check("of two removals against one addition only the first is paired", uneven[0]!.paired === true && uneven[1]!.paired === undefined && uneven[2]!.paired === true)
    check("side by side keeps the flag, because it draws the same lines", splitRows(hunk)[1]?.left?.paired === true && splitRows(hunk)[1]?.right?.paired === true)

    const body = await read("src/renderer/src/components/parts/DiffBody.vue")
    const style = body.slice(body.indexOf("<style"))
    /** The declarations of one rule, found by its exact selector. */
    const rule = (selector: string) => {
      const at = style.indexOf(`${selector} {`)
      return at < 0 ? "" : style.slice(at, style.indexOf("}", at))
    }
    check("a merged row carries the pair's class", /class="db-row" :class="\[line\.kind, \{ paired: line\.paired \}\]"/.test(body))
    check("and so does a side-by-side row", /\{ paired: pair\[side\]\?\.paired \}/.test(body))

    // The measured table: diff2html's light values, and its dark ones over the panel.
    const light = { pairDel: "#fdf2d0", pairIns: "#ded", wordDel: "#ffb6ba", wordIns: "#97f295", pureDel: "#fee8e9", pureIns: "#dfd", info: "#f8fafd", head: "#f7f7f7", gutter: "#fff" }
    const dark = { pairDel: "#d2992233", pairIns: "#2ea04340", wordDel: "#f8514966", wordIns: "#2ea04366", pureDel: "#f851491a", pureIns: "#2ea04326", info: "#388bfd1a", head: "#161b22", gutter: "#0d1117" }
    for (const [scheme, prefix, want] of [
      ["light", "\n.db-scroll", light],
      ["dark", '\n:root[data-theme="dark"] .db-scroll', dark],
      ["system dark", '  :root:not([data-theme="light"]) .db-scroll', dark],
    ] as const) {
      const pair = rule(`${prefix} .paired`)
      const word = rule(`${prefix} .db-mark`)
      const base = rule(prefix)
      check(`${scheme}: a pair's removal and addition take diff2html's change colours`, pair.includes(`--d2h-del-bg: ${want.pairDel};`) && pair.includes(`--d2h-ins-bg: ${want.pairIns};`), pair)
      check(`${scheme}: a marked word takes diff2html's highlight colours`, word.includes(`--d2h-del-bg: ${want.wordDel};`) && word.includes(`--d2h-ins-bg: ${want.wordIns};`), word)
      check(
        `${scheme}: a lone line, the hunk header, the file header and the gutter keep diff2html's own`,
        [`--d2h-del-bg: ${want.pureDel};`, `--d2h-ins-bg: ${want.pureIns};`, `--d2h-info-bg: ${want.info};`, `--d2h-head-bg: ${want.head};`, `--d2h-bg: ${want.gutter};`].every((one) => base.includes(one)),
        base,
      )
    }
    check("dark code is drawn in the measured #f4f4f5", (rule('\n:root[data-theme="dark"] .db-scroll').match(/--d2h-color: #f4f4f5;/g) ?? []).length === 1 && /--d2h-color: #f4f4f5;/.test(rule('  :root:not([data-theme="light"]) .db-scroll')))
    check("the lines sit on the panel's own surface, #181818 in the dark as MiMo's do", /background: var\(--surface-raised\)/.test(rule("\n.db-scroll")))
    check("a coloured row's gutter lets the row's colour through, so it is coloured once", /background: transparent/.test(rule(".db-row:is(.add, .del, .info, .empty) .db-ln")))
    check("while a context line's gutter keeps the near-black", /background: var\(--d2h-bg\)/.test(rule("\n.db-ln")))
    check("a word's background is the line colour named again inside it", /background: var\(--d2h-del-bg\)/.test(rule(".db-row.del .db-mark")) && /background: var\(--d2h-ins-bg\)/.test(rule(".db-row.add .db-mark")))
    const names = new Set([...style.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]))
    const allowed = ["--d2h-bg", "--d2h-color", "--d2h-dim", "--d2h-border", "--d2h-line-border", "--d2h-head-bg", "--d2h-head-border", "--d2h-ins-bg", "--d2h-ins-border", "--d2h-ins-label", "--d2h-del-bg", "--d2h-del-border", "--d2h-del-label", "--d2h-info-bg", "--d2h-info-border", "--d2h-empty-bg"]
    const extra = [...names].filter((name) => !allowed.includes(name!))
    check("no colour gets a name the component did not already have", extra.length === 0, extra)
    check(
      "signs alone still means plain lines with the colour kept in the gutter",
      /html\[data-diff-marks="signs"\] \.db-row\.add,\s*html\[data-diff-marks="signs"\] \.db-row\.del,\s*html\[data-diff-marks="signs"\] \.db-mark \{\s*background: transparent/.test(style) &&
        /background: var\(--d2h-del-bg\)/.test(rule('html[data-diff-marks="signs"] .db-row.del .db-ln')),
    )
  }

  // ----------------------------------------------------------------- R18-D4
  section("Round 18 (R18-D4): the review tab counts its files, and marks and colours each one by what happened to it")
  {
    const body = await read("src/renderer/src/components/parts/DiffBody.vue")
    const style = body.slice(body.indexOf("<style"))
    const rule = (selector: string) => {
      const at = style.indexOf(`${selector} {`)
      return at < 0 ? "" : style.slice(at, style.indexOf("}", at))
    }
    check(
      "the filled diff has a heading over its list, counting the files through the tables",
      /<div v-if="fill" class="db-list-title" data-diff-files-heading>\{\{ t\("rp\.diff\.filesChanged", \{ n: files\.length \}\) \}\}<\/div>\s*<ol v-if="fill" class="db-list"/.test(body),
    )
    check("in bold, as diff2html's title is", /font-weight: 700/.test(rule(".db-list-title")))
    const strings = await tables()
    const names = Object.keys(strings)
    const missing = names.filter((name) => !strings[name]!["rp.diff.filesChanged"]?.includes("{n}"))
    check(`the heading is written in all ${LANGUAGES.length} languages, each with the count in it`, names.length === LANGUAGES.length && missing.length === 0, missing)
    check("in its own words in each, not the English copied round", new Set(names.map((name) => strings[name]!["rp.diff.filesChanged"])).size >= 16)

    check("each file in the list has a square marked for its status", /<svg class="db-list-icon" :class="file\.status"[^>]*:data-diff-list-icon="file\.status"/.test(body) && /<rect [^>]*stroke="currentColor"/.test(body))
    check("a changed file's square holds a dot, the others a plus, a minus or an arrow", /<circle v-else cx="7" cy="8" r="2" fill="currentColor" \/>/.test(body) && /const LIST_MARK[^}]*added:[^}]*deleted:[^}]*renamed:/.test(body) && !/changed:/.test(body.slice(body.indexOf("const LIST_MARK"), body.indexOf("}", body.indexOf("const LIST_MARK")))))
    check("a name in the list is diff2html's link blue, in both themes", /--d2h-color: #3572b0;[\s\S]*color: var\(--d2h-color\)/.test(rule(".db-list .db-name")) && !/:root\[data-theme="dark"\] \.db-list \.db-name/.test(style))
    check("with its folders dimmed, as before", /opacity: 0\.6/.test(rule(".db-dir")))
    check("a change is diff2html's yellow, #d0b44c", /--d2h-color: #d0b44c;/.test(rule(".db-scroll :is(.db-tag, .db-list-icon).changed")))
    check("in the dark too, which MiMo's dark set leaves as it is (measured #d0b44c on 26.920)", !/#d29922;/.test(style) && !/data-theme[^{]*\.changed/.test(style))
    check("a move is diff2html's blue", /--d2h-color: #3572b0;/.test(rule(".db-scroll :is(.db-tag, .db-list-icon).renamed")))
    check("an addition green and a removal red, from the labels already named", /color: var\(--d2h-ins-label\)/.test(rule(":is(.db-tag, .db-list-icon).added")) && /color: var\(--d2h-del-label\)/.test(rule(":is(.db-tag, .db-list-icon).deleted")))
    check("the tag and the square draw in the colour named on them", /color: var\(--d2h-color\)/.test(rule("\n.db-tag")) && /color: var\(--d2h-color\)/.test(rule("\n.db-list-icon")))
    check("and the tag is not dimmed, so its colour is the one measured", !/opacity/.test(rule("\n.db-tag")))
  }

  // ----------------------------------------------------------------- R18-D5
  section("Round 18 (R18-D5): a step's diff names each file in full, with forward slashes; the review tab keeps the project's path")
  {
    const root = "C:\\Users\\me\\mimo-diff-demo"
    check("a project path is joined to the project, forward slashes throughout", absoluteName("src/greet.js", root) === "C:/Users/me/mimo-diff-demo/src/greet.js", absoluteName("src/greet.js", root))
    check("a name the model wrote with backslashes reads the same", absoluteName("src\\greet.js", root) === "C:/Users/me/mimo-diff-demo/src/greet.js", absoluteName("src\\greet.js", root))
    check("an absolute name keeps its place, only its slashes turned", absoluteName("D:\\other\\a.ts", root) === "D:/other/a.ts" && absoluteName("/etc/hosts", "/home/me") === "/etc/hosts")
    check("a name that climbs out of the project is walked up", absoluteName("../notes.md", root) === "C:/Users/me/notes.md" && absoluteName("./a/../b.ts", "/home/me/") === "/home/me/b.ts", absoluteName("../notes.md", root))
    check("with no project there is nothing to join, and the name stays as the patch wrote it", absoluteName("src/a.ts") === "src/a.ts")
    check("a new file's /dev/null is left alone", absoluteName("/dev/null", root) === "/dev/null")

    const body = await read("src/renderer/src/components/parts/DiffBody.vue")
    check("the diff joins its names to the project only when it is handed one", /props\.root === undefined \? file : \{ name: absoluteName\(file\.name, props\.root\), oldName: file\.oldName && absoluteName\(file\.oldName, props\.root\) \}/.test(body))
    const view = await read("src/renderer/src/components/parts/DiffView.vue")
    check("the step's view passes the project through", /defineProps<\{ diff: string; root\?: string \}>\(\)/.test(view) && /<DiffBody :diff="diff" :root="root" \/>/.test(view))
    const part = await read("src/renderer/src/components/parts/ToolPart.vue")
    check("and a step hands over its conversation's project", /<DiffView :diff="diffText" :root="app\.current\?\.directory" \/>/.test(part))
    const tab = await read("src/renderer/src/components/right/RpDiffTab.vue")
    check("while the review tab hands over none, so it keeps the project's own path", /<DiffBody :diff="diff" :layout="layout" fill \/>/.test(tab))
  }
}
