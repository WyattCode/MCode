/**
 * The settings navigation column scrolls its list, as MiMo's sn-scroll does.
 *
 * Found in round 15 (lane U3) and left open: at 1400x900, zh-CN, the default
 * font size, the column's rows measured 814 tall in a 659 column, so the last
 * group and 应用更新 were painted past its foot and cut off by the dialog. The
 * geometry is measured in the real window by the snav probe; what is read here
 * is the structure that makes it scroll, and the reveal rule run for real.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { revealScrollTop as reveal } from "../src/renderer/src/lib/scroll-reveal"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** The body of the last rule whose selector is exactly `selector` in `css`, or "" when there is none. */
function lastRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const found = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, "g"))]
  return found.length ? found[found.length - 1][1] : ""
}

export async function roundEighteenSettingsNavChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 18: the settings navigation's list scrolls inside a fixed title and search")
  {
    const dialog = await read("src/renderer/src/components/SettingsDialog.vue")
    const template = dialog.slice(dialog.indexOf("<template>"), dialog.lastIndexOf("</template>"))
    const style = dialog.slice(dialog.indexOf("<style"))
    const nav = template.slice(template.indexOf('<nav class="nav"'), template.indexOf("</nav>"))
    const topAt = nav.indexOf('class="nav-top"')
    const scrollAt = nav.search(/class="nav-scroll\b/)
    const title = nav.indexOf('class="nav-title"')
    const search = nav.indexOf('class="nav-search"')
    const firstGroup = nav.indexOf('class="nav-group"')
    const lastItem = nav.lastIndexOf('class="nav-item"')
    check(
      "the title and the search sit in a top part ahead of the list",
      topAt >= 0 && topAt < title && title < search && search < scrollAt,
      { topAt, title, search, scrollAt },
    )
    check("every group and row, 应用更新 last, sits inside the scrolling list", scrollAt >= 0 && scrollAt < firstGroup && firstGroup < lastItem, { scrollAt, firstGroup, lastItem })
    check("the list wears MiMo's thin 9px scrollbar", /class="nav-scroll u-scrollbar-thin"/.test(nav))

    const list = lastRule(style, ".nav-scroll")
    check("the list is the part that scrolls: it takes the rest of the column and may shrink below its rows", /overflow-y:\s*auto/.test(list) && /min-height:\s*0/.test(list) && /flex:\s*1\b/.test(list), list)
    check("as MiMo's: the start inset, 12 below the last row, nothing on the trailing side for the scrollbar's lane", /padding-block:\s*0 12px/.test(list) && /padding-inline:\s*10px 0/.test(list), list)
    check("it never scrolls sideways - a long label still breaks inside the row", /overflow-x:\s*hidden/.test(list), list)
    const column = lastRule(style, ".nav")
    check("the column keeps no padding of its own that the list could run past", /padding:\s*0;/.test(column), column)
    const top = lastRule(style, ".nav-top")
    check("the top part does not shrink and keeps the column's 18 above the title", /flex:\s*none/.test(top) && /padding:\s*18px 10px 0/.test(top), top)
    // R21-F2: MiMo's sn-group carries its own 12 above the label, which is the
    // whole step under the search as well as between two groups.
    check("the first group sits on its own 12 under the search, as every group does", /\.nav-group \{[^}]*padding: 12px 10px 4px/s.test(style) && !/\.nav-scroll > \.nav-group:first-child/.test(style))
  }

  section("Round 18: the selected nav row is brought into the list's view, as MiMo's")
  {
    const dialog = await read("src/renderer/src/components/SettingsDialog.vue")
    check("a row already in view, with 8 to spare, moves nothing", reveal(0, 558, 100, 36) === undefined)
    check("a row below the fold scrolls until its foot is 8 inside", reveal(0, 558, 700, 36) === 700 + 36 + 8 - 558, reveal(0, 558, 700, 36))
    check("a row above the view scrolls until its head is 8 inside", reveal(300, 558, 200, 36) === 192, reveal(300, 558, 200, 36))
    check("never past the top", reveal(20, 558, 4, 36) === 0, reveal(20, 558, 4, 36))
    check(
      "the dialog reveals the selected row on open, on a new page and on a new search",
      /onMounted\(revealSelectedNav\)/.test(dialog) && /watch\(\[currentSection, navQuery\], revealSelectedNav\)/.test(dialog) && /revealScrollTop\(/.test(dialog),
    )
    check("and does it without the smooth scroll when motion is reduced", /behavior: reducedMotion\(\) \? "auto" : "smooth"/.test(dialog))
  }
}
