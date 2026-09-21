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
}
