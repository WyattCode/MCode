/**
 * Round 16, lane D: the diff and the code step rows, read against MiMo.
 *
 * What MiMo does inside a changed line - cut the pair into tokens, mark the
 * ones only one side has - is arithmetic, so it runs here against the real
 * code: the tokens, the pairing between a run of removals and the run of
 * additions after it, the length past which a line is left plain, and the
 * braced name a rename is written with. The rest is markup and words: the file
 * list drawn only where the diff fills the panel, the status mark, the label
 * and the tick in a file's header, the launcher's description line, and a
 * command run through `exec_command` reading as a command row. Those are read
 * from the source here and measured in the lane's Electron probe
 * (r16d-probe.cjs), whose numbers are in the report.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { displayName, markWords, parseDiffFiles, splitRows, type DiffLine } from "../src/renderer/src/lib/diff-view"
import { WORD_MARK_MAX, markPair, wordTokens } from "../src/renderer/src/lib/diff-words"
import { LANGUAGES } from "../src/renderer/src/lib/i18n"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** A marked line written out, the pieces only this side has in brackets. */
const shown = (marks: readonly { text: string; changed: boolean }[] | undefined) =>
  marks === undefined ? undefined : marks.map((mark) => (mark.changed ? `[${mark.text}]` : mark.text)).join("")

const line = (kind: DiffLine["kind"], text: string): DiffLine => ({ kind, text })

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

export async function roundSixteenDiffChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ----------------------------------------------------------------- R16-D1
  section("Round 16 (R16-D1): a changed line is marked word by word, the way MiMo's diff marks it")
  {
    const renamed = markPair("  const total = items.length", "  const count = items.length")
    check("a renamed name lights up that word and nothing else", shown(renamed?.old) === "  const [total] = items.length" && shown(renamed?.next) === "  const [count] = items.length", {
      old: shown(renamed?.old),
      next: shown(renamed?.next),
    })
    const grown = markPair("export function readFile(path) {", "export async function readFile(path, encoding) {")
    check("what only the new line has is marked there and nowhere on the old one", shown(grown?.old) === "export function readFile(path) {" && shown(grown?.next) === "export [async ]function readFile(path[, encoding]) {", {
      old: shown(grown?.old),
      next: shown(grown?.next),
    })
    const same = markPair("x = 1", "x = 1")
    check("two lines that read alike are marked nowhere", shown(same?.old) === "x = 1" && shown(same?.next) === "x = 1", { old: shown(same?.old) })

    check(
      "the line is cut into runs of word characters, runs of blanks, and single other characters",
      JSON.stringify(wordTokens("a_1 = foo.bar(2);")) === JSON.stringify(["a_1", " ", "=", " ", "foo", ".", "bar", "(", "2", ")", ";"]),
      wordTokens("a_1 = foo.bar(2);"),
    )
    check("a letter outside the tokenizer's ranges stands on its own, as diff2html cuts it", JSON.stringify(wordTokens("名前x")) === JSON.stringify(["名", "前", "x"]), wordTokens("名前x"))

    // The length is written out rather than taken from the constant: a test that builds its line
    // from the constant moves with it, and would pass whatever the constant said.
    check("the length a line is left plain past is diff2html's own 10000", WORD_MARK_MAX === 10_000, WORD_MARK_MAX)
    const long = "x".repeat(10_001)
    check("a line past that many characters is left plain, as diff2html leaves it", markPair(long, `${long}y`) === undefined)
    const short = "x".repeat(9_999)
    check("and one just under it is still marked", markPair(short, `${short}y`) !== undefined)
    const started = Date.now()
    const wide = Array.from({ length: 1400 }, (_, index) => `a${index}.b(${index});`).join("")
    const other = Array.from({ length: 1400 }, (_, index) => `z${(index * 7) % 991}.q(${index});`).join("")
    const marks = markPair(wide.slice(0, 9000), other.slice(0, 9000))
    check("and a pair with nothing in common gives up quickly rather than walking every edit", marks === undefined && Date.now() - started < 2000, {
      marked: marks !== undefined,
      ms: Date.now() - started,
    })
  }

  // ----------------------------------------------------------------- R16-D2
  section("Round 16 (R16-D2): the pairing the marks follow is the one both layouts draw with")
  {
    const marked = markWords([line("del", "a = 1"), line("del", "b = 2"), line("add", "a = 3"), line("add", "b = 2")])
    check("a run of removals is paired with the run of additions after it, row for row", shown(marked[0]!.marks) === "a = [1]" && shown(marked[2]!.marks) === "a = [3]", {
      first: shown(marked[0]!.marks),
      third: shown(marked[2]!.marks),
    })
    check("a pair that reads alike is still a pair, with nothing marked", shown(marked[1]!.marks) === "b = 2" && shown(marked[3]!.marks) === "b = 2", { second: shown(marked[1]!.marks) })

    const lonely = markWords([line("ctx", "kept"), line("add", "new one"), line("del", "gone")])
    check("an addition that follows no removal is left plain", lonely[1]!.marks === undefined && lonely[0]!.marks === undefined)
    check("and so is a removal with no addition against it", lonely[2]!.marks === undefined)

    const rows = splitRows(markWords([line("del", "a = 1"), line("add", "a = 2")]))
    check("side by side draws the same marks, because it pairs the same lines", shown(rows[0]?.left?.marks) === "a = [1]" && shown(rows[0]?.right?.marks) === "a = [2]", {
      left: shown(rows[0]?.left?.marks),
      right: shown(rows[0]?.right?.marks),
    })

    const body = await read("src/renderer/src/components/parts/DiffBody.vue")
    check("the component marks each hunk before it splits it, so one reading serves both layouts", /const lines = markWords\(hunk\.lines\)[\s\S]{0,120}split: splitRows\(lines\)/.test(body))
    check("a marked piece is drawn in its own element in the merged view", /class="db-code">[\s\S]{0,200}v-for="\(mark, m\) in line\.marks"[\s\S]{0,60}'db-mark': mark\.changed/.test(body))
    check("and in the side-by-side view", /v-for="\(mark, m\) in pair\[side\]!\.marks"/.test(body))
    check("the marked line steps back so the marked words are what stands out", /\.db-row\.add\.marked[\s\S]{0,140}background: color-mix/.test(body) && /\.db-row\.add \.db-mark \{[\s\S]{0,140}background: color-mix/.test(body))
    check("and the signs-only setting still paints nothing", /html\[data-diff-marks="signs"\][^{]*\.db-mark \{\s*background: transparent/.test(body))
  }

  // ----------------------------------------------------------------- R16-D3
  section("Round 16 (R16-D3): a file's header says what happened to it, and a rename says both names")
  {
    check("a file that moved is written with the part that moved in braces", displayName({ name: "src/lib/new.ts", oldName: "src/lib/old.ts" }) === "src/lib/{old.ts → new.ts}", displayName({ name: "src/lib/new.ts", oldName: "src/lib/old.ts" }))
    check("the folders above and below the move stay where they are", displayName({ name: "src/two/keep.ts", oldName: "src/one/keep.ts" }) === "src/{one → two}/keep.ts", displayName({ name: "src/two/keep.ts", oldName: "src/one/keep.ts" }))
    check("two names with nothing in common are written out in full", displayName({ name: "b.ts", oldName: "a.ts" }) === "a.ts → b.ts", displayName({ name: "b.ts", oldName: "a.ts" }))
    check("a file that did not move is its own name", displayName({ name: "src/a.ts" }) === "src/a.ts")
    check("and a file written from nothing keeps the one name it has", displayName({ name: "src/a.ts", oldName: "/dev/null" }) === "src/a.ts")

    const patch = ["diff --git a/src/old.ts b/src/new.ts", "rename from src/old.ts", "rename to src/new.ts", "--- a/src/old.ts", "+++ b/src/new.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n")
    const parsed = parseDiffFiles(patch)
    check("a renamed file parses with both names and the renamed status", parsed[0]?.status === "renamed" && parsed[0]?.oldName === "src/old.ts" && parsed[0]?.name === "src/new.ts", parsed[0])

    const body = await read("src/renderer/src/components/parts/DiffBody.vue")
    check("the header carries a mark for what the patch did to the file", /<svg class="db-status"[\s\S]{0,300}:data-diff-status="file\.status"/.test(body))
    check("and the word for it, from this app's own tables rather than diff2html's English", /class="db-tag"[\s\S]{0,80}t\(`rp\.diff\.tag\.\$\{file\.status\}`\)/.test(body))
    check("with the tick beside it, which does not fold the file it sits in", /class="db-viewed" data-diff-viewed @click\.stop @keydown\.stop/.test(body))
    check("the header is still a Tab stop that folds, which the tick did not take away", /class="db-head"\s+role="button"\s+tabindex="0"\s+:aria-expanded="!collapsed\.has\(file\.name\)"/.test(body))
    check("a tick is remembered for this drawing of this patch only: a new patch, or the other layout, clears it", /watch\(\s*\(\) => `\$\{props\.layout \?\? ""\}:\$\{capped\.value\.text\}`,\s*\(\) => \{\s*viewed\.value = new Set\(\)/.test(body))
    check("the header no longer carries the counts, which MiMo shows in the file list only", !/class="db-head"[\s\S]{0,900}db-stats/.test(body))

    const strings = await tables()
    const names = Object.keys(strings)
    check(`all ${LANGUAGES.length} language tables were read`, names.length === LANGUAGES.length, names)
    for (const key of ["rp.diff.tag.added", "rp.diff.tag.deleted", "rp.diff.tag.renamed", "rp.diff.tag.changed", "rp.diff.viewed"]) {
      const absent = names.filter((name) => !strings[name]![key])
      check(`${key} is written in every language`, absent.length === 0, absent)
    }
    const english = strings.en!
    check("and the words are the tables' own, not the identifiers", english["rp.diff.tag.renamed"] !== "renamed" && english["rp.diff.viewed"] !== "viewed")
  }

  // ----------------------------------------------------------------- R16-D4
  section("Round 16 (R16-D4): the file list belongs to the diff tab, not to a step or a permission card")
  {
    const body = await read("src/renderer/src/components/parts/DiffBody.vue")
    check("the list is drawn only where the diff fills the panel", /<ol v-if="fill" class="db-list" data-diff-file-list>/.test(body))
    const view = await read("src/renderer/src/components/parts/DiffView.vue")
    check("a step's diff and a permission card's ask for the unfilled diff, so they have no list", /<DiffBody :diff="diff" \/>/.test(view))
    const tab = await read("src/renderer/src/components/right/RpDiffTab.vue")
    check("and the tab fills it, so it has one", /<DiffBody :diff="diff" :layout="layout" fill \/>/.test(tab))
  }
}
