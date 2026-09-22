/**
 * Round 21, lane F4: the home screen, the search overlay, the artifacts
 * centre, toasts and the bell, and the side column's leftovers, against MiMo
 * 26.920. Each check fails on the code before its fix.
 *
 * These live in markup and CSS, so they are read from the source; the lane's
 * Electron probe measured the result in a real window, both schemes. smoke.ts
 * calls `roundTwentyOneLaneFourChecks` with its own check and section. `root`
 * is the checkout to read, the working directory unless given.
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

export async function roundTwentyOneLaneFourChecks(check: Check, section: (name: string) => void, root = process.cwd()): Promise<void> {
  const read = (relative: string) => fs.readFile(path.join(root, relative), "utf8")
  const parts = (file: string) => (source: string) => ({
    file,
    template: source.slice(source.indexOf("<template>"), source.lastIndexOf("</template>")),
    style: source.slice(source.indexOf("<style")),
    all: source,
  })

  // ------------------------------------------------------------------ R21-F4-1
  section("Round 21 (F4-1): the home hero is MiMo's 527 x 299 block, with a drawing of MCode's own behind it")
  {
    const hero = parts("HomeHero.vue")(code(await read("src/renderer/src/components/HomeHero.vue")))
    const block = rule(hero.style, ".hero")
    check("the block is 527 wide and 299 tall and pulled 48 into the tray", /width:\s*527px/.test(block) && /height:\s*299px/.test(block) && /margin:\s*0 auto -48px/.test(block), block)
    const greet = rule(hero.style, ".slogan")
    check("the greeting is placed at 65.5% of it rather than stacked under the mark", /position:\s*absolute/.test(greet) && /top:\s*65\.5%/.test(greet) && !/margin:\s*22px/.test(greet), greet)
    check("it keeps MiMo's 18/600 and 0.4px tracking", /font-size:\s*calc\(18px/.test(greet) && /font-weight:\s*600/.test(greet) && /letter-spacing:\s*0\.4px/.test(greet))
    const slot = rule(hero.style, ".mark-slot")
    check("the mark is centred on 49.95% of the block's height, off the animated element", /top:\s*49\.95%/.test(slot) && /translate\(-50%, -50%\)/.test(slot), slot)
    const deco = element(hero.template, '<svg class="deco"', "svg")
    check("the drawing is inline SVG sized to the block, not an asset", deco.includes('viewBox="0 0 527 299"') && !/<img/.test(hero.template))
    check("it is MCode's own dashed blueprint, in MiMo's 38-49% band", /stroke-dasharray/.test(deco) && [...deco.matchAll(/opacity="0\.(\d+)"/g)].every((m) => Number(`0.${m[1]}`) >= 0.38 && Number(`0.${m[1]}`) <= 0.49), deco.length)
    check("and it halves on the dark scheme, as MiMo's does", /\.deco \{\s*opacity: 0\.5/.test(hero.style.replace(/:root[^\s]*\s+/g, "")) || /:root:not\(\[data-theme="light"\]\) \.deco \{\s*\n\s*opacity: 0\.5/.test(hero.style))
    // Item 9: the tray is an opaque plate, not a wash of the sunken surface.
    const tray = rule(hero.style, ".tray")
    check("the tray takes MiMo's --color-composer-tray-bg (#f8f7f5) rather than a 50% wash", /background:\s*#f8f7f5/.test(tray) && !/color-mix/.test(tray), tray)
    check("and #151515 on dark", /\.tray \{\s*\n\s*background: #151515;/.test(hero.style))
    // Item 12: MCode's drag strip stays - MiMo's home has none, but the window needs one.
    check("MCode's own drag strip is kept (recorded, MiMo's home has none)", /-webkit-app-region: drag/.test(hero.style))
  }

  // ------------------------------------------------------------------ R21-F4-2
  section("Round 21 (F4-2): the composer card is MiMo's white, with the home's own shadow on dark")
  {
    const composer = code(await read("src/renderer/src/components/Composer.vue"))
    const style = composer.slice(composer.indexOf("<style"))
    const box = rule(style, ".box")
    check("the card is MiMo's --color-composer-surface white, not the menu surface", /background:\s*#ffffff/.test(box) && !/background:\s*var\(--surface-menu\)/.test(box), box)
    check("and #1f1f1f on dark", /\.box \{\s*\n\s*background: #1f1f1f;/.test(style))
    check("the home box alone takes --shadow-composer-home on dark", /\.home-hero \.box:not\(\.dropping\) \{\s*\n\s*box-shadow: 0 2px 10px #00000080;/.test(style))
    check("a popover's entrance slides 8px, MiMo's two spacing steps, not two pixels", /@keyframes menu-in \{\s*\n\s*from \{\s*\n\s*opacity: 0;\s*\n\s*transform: translateY\(-8px\) scale\(0\.95\);/.test(style), style.slice(style.indexOf("@keyframes menu-in"), style.indexOf("@keyframes menu-in") + 140))
  }

  // ------------------------------------------------------------------ R21-F4-3
  section("Round 21 (F4-3): the project and branch chips and their menus")
  {
    const project = parts("ProjectPicker.vue")(code(await read("src/renderer/src/components/ProjectPicker.vue")))
    const branch = parts("BranchPicker.vue")(code(await read("src/renderer/src/components/BranchPicker.vue")))
    for (const picker of [project, branch]) {
      const chip = rule(picker.style, ".chip")
      check(`${picker.file}: the chip rests in MiMo's muted grey, not the weak one`, /color:\s*var\(--text-base\)/.test(chip), chip)
      check(`${picker.file}: and hovers to its --color-txt pair`, /\.chip:hover \{\s*\n\s*color: #151c13cc;/.test(picker.style) && /:root\[data-theme="dark"\][\s\S]*\.chip:hover/.test(picker.style))
      const caret = rule(picker.style, ".caret")
      check(`${picker.file}: the caret is the chip's 15px icon at 55%`, /width:\s*15px/.test(caret) && /opacity:\s*0\.55/.test(caret) && !/\.caret path/.test(picker.style), caret)
      const row = rule(picker.style, ".row")
      check(`${picker.file}: menu rows take --color-txt and MiMo's 11px corner`, /color:\s*#151c13cc/.test(row) && /border-radius:\s*11px/.test(row), row)
      check(`${picker.file}: row icons take MiMo's --color-icon rather than a mix of the text colour`, /\.row \.i \{[^}]*color:\s*#5c5c57/.test(picker.style) && !/color-mix\(in srgb, var\(--text-base\) 87%/.test(picker.style))
      check(`${picker.file}: the tick is MiMo's --color-send`, /\.check \{[^}]*color:\s*#151c13;/.test(picker.style) && /:root\[data-theme="dark"\] \.check \{\s*\n\s*color: #ececec;/.test(picker.style))
      check(`${picker.file}: the menu animates in, as every MiMo popover does`, /animation: menu-in 0\.15s ease-out/.test(picker.style) && /@keyframes menu-in \{[\s\S]*?translateY\(-8px\) scale\(0\.95\)/.test(picker.style))
    }
    check("the branch chip is no longer held lit while its menu is open, as MiMo never lights it", !/\.chip\.open/.test(branch.style) && !/:class="\{ open \}"/.test(branch.template), branch.template.slice(0, 200))
    const menu = rule(project.style, ".menu")
    check("the project menu's blocks sit flush, MiMo's gap being none", !/gap:\s*1px/.test(menu) && !/gap:\s*1px/.test(rule(project.style, ".list")), menu)
    check("the list's bottom fade ends on the menu's own glass, not an opaque surface", /linear-gradient\(to bottom, transparent, color-mix\(in srgb, var\(--surface-menu\) 92%, transparent\)\)/.test(project.style))
    const sub = rule(project.style, ".submenu")
    check("the add-a-project submenu is padded 4 and given no width of its own, as #newproj-submenu is", /padding:\s*4px/.test(sub) && !/min-width/.test(sub), sub)
    check("its rows keep MiMo's 13px, 5 by 12 and 6 apart", /\.submenu \.row \{[^}]*gap: 6px;[^}]*padding: 5px 12px;/.test(project.style))
    const dialog = code(await read("src/renderer/src/components/NewProjectDialog.vue"))
    check("the new-project dialog's labels, close and source hint are MiMo's muted grey", (dialog.match(/color: var\(--text-base\);/g) ?? []).length >= 3 && !/\.label \{[^}]*color: var\(--text-weak\)/.test(dialog), dialog.length)
    check("its dark name field keeps MCode's raised surface (recorded: MiMo's bg-white is white on dark)", /\.field \{[^}]*background: var\(--surface-raised\)/.test(dialog))
  }
}
