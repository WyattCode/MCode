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
}
