/**
 * Round 20, visual lane 5: the side column against MiMo 26.920 - search and
 * the bell in the brand row, the brand row at 52, one account-shaped row at
 * the bottom, the 新建任务 and folder glyphs, and the list's edge lines. Each
 * check fails on the code before its fix.
 *
 * These live in markup and CSS, so they are read from the source; the lane's
 * Electron probe measured the result in a real window. smoke.ts calls
 * `roundTwentyVisualFiveChecks` with its own check and section. `root` is the
 * checkout to read, the working directory unless given.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

/** Code without its comments, so a check reads what runs. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** The bodies of every rule whose selector (or last selector of a list) is exactly `selector`, in order. */
function rule(css: string, selector: string): string {
  const bodies: string[] = []
  for (let at = css.indexOf(`\n${selector} {`); at >= 0; at = css.indexOf(`\n${selector} {`, at + 1)) {
    const open = css.indexOf("{", at)
    bodies.push(css.slice(open + 1, css.indexOf("}", open)))
  }
  return bodies.join("\n")
}

/** The markup of the first element opened by `open`, up to its matching close tag. */
function element(markup: string, open: string, tag: string): string {
  const at = markup.indexOf(open)
  if (at === -1) return ""
  let depth = 0
  const pattern = new RegExp(`<${tag}\\b|</${tag}>`, "g")
  pattern.lastIndex = at
  for (let match = pattern.exec(markup); match; match = pattern.exec(markup)) {
    depth += match[0].startsWith("</") ? -1 : 1
    if (depth === 0) return markup.slice(at, match.index + match[0].length)
  }
  return ""
}

export async function roundTwentyVisualFiveChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")
  const side = code(await read("src/renderer/src/components/Sidebar.vue"))
  const template = side.slice(side.indexOf("<template>"), side.lastIndexOf("</template>"))
  const style = side.slice(side.indexOf("<style"))

  // ------------------------------------------------------------------ R20-V5-1
  section("Round 20 (V5-1): search and the bell sit at the brand row's end, as MiMo 26.920 has them")
  {
    const top = element(template, '<div class="top"', "div")
    const brand = element(template, '<div class="brand">', "div")
    const actions = element(brand, '<span class="brand-actions" data-brand-actions>', "span")
    check("the title-bar row keeps only the toggle, back and forward", (top.match(/<button\b/g) ?? []).length === 3 && !/side\.search|bell/.test(top), top.length)
    check("search and the bell are the brand row's actions, in that order", /data-search[\s\S]*class="ico bell"/.test(actions) && (actions.match(/<button\b/g) ?? []).length === 2, actions.length)
    check("they keep their shortcuts and tips", /hint: 'Ctrl\+K'/.test(actions) && /shownChord\('Ctrl\+Alt\+U'\)/.test(actions))
    check("search lets a preview go before it opens, as MiMo's does", /@click="closePreview\(\), emit\('search'\)"/.test(actions))
    const box = rule(style, ".brand-actions")
    check("MiMo's box: 24 tall, 8 apart, ending 8 in from the brand row (16 from the column)", /height: 24px;/.test(box) && /gap: 8px;/.test(box) && /margin-inline: auto 8px;/.test(box), box)
    check("the bell is 6 round, search 7", /border-radius: 6px;/.test(rule(style, ".ico.bell")))
    check("they take the title-bar icon colour and its 12px Windows glyphs", /\.brand-actions \.ico,\n\.rail-tools \.ico \{\s*color: color-mix/.test(style) && /\.app\[data-platform="win32"\] \.brand-actions \.ico svg,/.test(style) && /:root\[data-theme="dark"\] \.brand-actions \.ico,/.test(style))
    check("the lit bell outranks the dark icon colour from its new place", /:root \.brand-actions \.ico\.bell\.on \{\s*color: var\(--text-accent\);/.test(style))
    check("the preview no longer pushes a row of search and bell to the end", !/\.side-shell\.preview \.top \{[^}]*justify-content: flex-end/.test(style))
  }

  // ------------------------------------------------------------------ R20-V5-2
  section("Round 20 (V5-2): the bottom is one MiMo-shaped row, the theme row gone")
  {
    const foot = element(template, '<div class="foot">', "div")
    const script = side.slice(0, side.indexOf("<template>"))
    check("one row, then the update capsule beside it", (foot.match(/<button\b/g) ?? []).length === 1 && /data-account-menu/.test(foot) && /<\/button>\s*<UpdatePill \/>\s*<\/div>$/.test(foot), foot.length)
    check("the row is a 46px cell with a 28px avatar, then the label", /<span class="account-cell">\s*<span class="avatar" aria-hidden="true">\s*<svg width="15" height="15"/.test(foot) && /<span class="account-label">\{\{ t\("side\.thisDevice"\) \}\}<\/span>/.test(foot))
    check("the row itself opens the menu, as a menu", /class="account"\s*data-account-menu\s*:aria-expanded="Boolean\(footMenu\)"\s*aria-haspopup="menu"\s*@click="openFootMenu"/.test(foot))
    check("the 深色 / theme-cycle row and its code are gone", !/cycleTheme|themeLabel|SCHEMES|class="row theme"/.test(side))
    check("the menu keeps what MCode can honour: 设置 with its shortcut, MiMo's 248 wide", /key: "settings",[\s\S]{0,80}hint: "Ctrl\+,"/.test(script) && /:items="footMenuItems"\s*above\s*:end="footMenu\.end"\s*:min-width="248"/.test(template))
    const menu = code(await read("src/renderer/src/components/ContextMenu.vue"))
    check("a menu placed by its end or bottom measures its layout size, not the 96% it opens at", /const rect = \{ width: panel\.offsetWidth, height: panel\.offsetHeight \}/.test(menu))
    check("the menu lines up with the row's start, its right edge right to left", /const end = getComputedStyle\(row\)\.direction === "rtl"/.test(script) && /x: Math\.round\(end \? from\.right : from\.left\)/.test(script))
    const foot$ = rule(style, ".foot")
    check("MiMo's side-bottom: a flex row 8 apart, 10 above and below", /display: flex;/.test(foot$) && /gap: 8px;/.test(foot$) && /margin: 10px 8px;/.test(foot$), foot$)
    const row = rule(style, ".account")
    check("the row: 38 tall, 8 round, 14px regular, growing to fill", /height: 38px;/.test(row) && /border-radius: 8px;/.test(row) && /font-size: calc\(14px \* var\(--ui-font-scale, 1\)\);/.test(row) && /font-weight: 400;/.test(row) && /flex: 1;/.test(row), row)
    check("its cell 46 by 38, its label on a 20px line", /width: 46px;/.test(rule(style, ".account-cell")) && /height: 38px;/.test(rule(style, ".account-cell")) && /line-height: calc\(20px \* var\(--ui-font-scale, 1\)\);/.test(rule(style, ".account-label")))
    const avatar = rule(style, ".avatar")
    check("the avatar 28 round on MiMo's input-border line, in both schemes", /width: 28px;/.test(avatar) && /height: 28px;/.test(avatar) && /border: 1px solid #151c130f;/.test(avatar) && /border-radius: 50%;/.test(avatar) && /:root\[data-theme="dark"\] \.avatar \{\s*border-color: #2e2e2e;/.test(style), avatar)
    const pill = code(await read("src/renderer/src/components/UpdatePill.vue"))
    check("the capsule carries no box of its own beside the row", /\.update-pill-row \{\s*display: flex;\s*flex: none;\s*\}/.test(pill))
    const i18n = await read("src/renderer/src/lib/i18n.ts")
    check("side.thisDevice is in all 18 tables, 本机 in zh-CN", i18n.split("\n").filter((line) => line.startsWith('  "side.thisDevice": ')).length === 18 && i18n.includes('"side.thisDevice": "本机"'))
  }

  // ------------------------------------------------------------------ R20-V5-3
  section("Round 20 (V5-3): the brand row starts 52 down, MiMo 26.920's --sidebar-brand-top")
  {
    const top = rule(style, ".top")
    const brand = rule(style, ".brand")
    check("the controls row is 52 tall, its buttons still 13 down and 18 in (65 on macOS)", /height: 52px;/.test(top) && /padding-block: 13px 0;/.test(top) && /padding-inline: 18px 8px;/.test(top) && /\.top\.mac \{\s*padding-inline-start: 65px;/.test(style), top)
    check("the brand row follows it with no gap of its own", /margin: 0 8px;/.test(brand) && /height: 28px;/.test(brand) && /padding-inline-start: 14px;/.test(brand), brand)
    check("in the preview the row is 43, MiMo's inside the card", /\.side-shell\.preview \.top \{\s*height: 43px;/.test(style))
  }

  // ------------------------------------------------------------------ R20-V5-4
  section("Round 20 (V5-4): 新建任务 is a speech bubble with a plus, as MiMo draws it")
  {
    const bubble = /<path d="M20\.3 15\.4A9 9 0 1 0 16\.5 19\.8L21 21z" \/>\s*<path d="M12 9\.5v5M9\.5 12h5" \/>/
    const row = element(template, `<button class="row" data-new-task`, "button")
    check("the column's row: a 24-grid bubble and plus on a 2 line at 18px", /<svg class="row-ico" width="18" height="18" viewBox="0 0 24 24"[^>]*stroke-width="2"/.test(row) && bubble.test(row), row.length)
    const folded = element(template, `<button class="ico" data-collapsed-new-task`, "button")
    check("the folded control: the same glyph on MiMo's 1.75 line", /stroke-width="1\.75"/.test(folded) && bubble.test(folded), folded.length)
  }

  // ------------------------------------------------------------------ R20-V5-5
  section("Round 20 (V5-5): a project's folder is 16px, centred in its 46px cell")
  {
    for (const state of ["open", "closed"]) {
      const svg = new RegExp(`class="row-ico"\\s*data-folder="${state}"\\s*width="16"\\s*height="16"\\s*viewBox="0 0 24 24"[^>]*stroke-width="2"`)
      check(`the ${state} folder: 16px, 24 grid, a 2 line`, svg.test(template))
    }
    check("its cell stays 46: 15 either side", /\.row\.project > \.project-toggle > \.row-ico \{\s*margin-inline: 15px;/.test(style))
  }

  // ------------------------------------------------------------------ R20-V5-6
  section("Round 20 (V5-6): the list has MiMo's edge lines, each shown only while rows hide past it")
  {
    const script = side.slice(0, side.indexOf("<template>"))
    const lists = rule(style, ".lists")
    check("MiMo's box: 18 down, 8 to 2 across with 6 kept clear, 8 of room below", /margin-block-start: 18px;/.test(lists) && /margin-inline: 8px 2px;/.test(lists) && /padding-inline-end: 6px;/.test(lists) && /padding-block-end: 8px;/.test(lists), lists)
    check("rows keep their height and the list scrolls rather than squeezing them", /\.lists > \* \{\s*flex-shrink: 0;/.test(style))
    check("two 1px hairlines, clear by default", /border-block: 1px solid transparent;/.test(lists))
    check("line-soft where rows hide past them: #0000000d light, #ffffff12 dark", /\.lists:not\(\.at-top\) \{\s*border-block-start-color: #0000000d;/.test(style) && /\.lists:not\(\.at-end\) \{\s*border-block-end-color: #0000000d;/.test(style) && /:root\[data-theme="dark"\] \.lists:not\(\.at-top\) \{\s*border-block-start-color: #ffffff12;/.test(style) && /:root:not\(\[data-theme="light"\]\) \.lists:not\(\.at-end\) \{\s*border-block-end-color: #ffffff12;/.test(style))
    check("the list's scroll decides them, as MiMo's does", /:class="\{ 'at-top': atTop, 'at-end': atEnd \}"/.test(template) && /@scroll="measureEdges"/.test(template) && /atTop\.value = root\.scrollTop <= 0/.test(script) && /atEnd\.value = root\.scrollTop \+ root\.clientHeight >= root\.scrollHeight - 1/.test(script))
    check("and are measured again when the list resizes or re-renders", /new ResizeObserver\(measureEdges\)/.test(script) && /onUpdated\(measureEdges\)/.test(script) && /edgeWatch\?\.disconnect\(\)/.test(script))
    check("the first heading keeps its place (17 + 18 + 1 = the old 36)", /\.lists > \.section:first-child,\n\.lists > \.folder-ring \+ \.section \{\s*margin-top: 17px;/.test(style))
    check("a dropped folder's ring measures past the top hairline and keeps off the 6px end", /top - base\.top - root\.clientTop \+ root\.scrollTop/.test(script) && /\.folder-ring \{\s*position: absolute;\s*inset-inline: 0 6px;/.test(style))
  }
}
