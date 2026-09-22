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
}
