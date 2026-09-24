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
    // The user saw MCode's own blueprint drawing on 2026-09-24 and asked for a bare block, so MiMo's background drawing has no counterpart here.
    check("nothing is drawn behind the mark - no SVG, no image, no painted background (user decision 2026-09-24)", !/<svg/.test(hero.template) && !/<img/.test(hero.template) && !/\bdeco\b/.test(hero.style) && !/background(-image)?:/.test(rule(hero.style, ".hero")), hero.template.slice(0, 400))
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
      check(`${picker.file}: and hovers to its --color-txt`, /\.chip:hover \{\s*\n\s*color: var\(--text-body\);/.test(picker.style))
      const caret = rule(picker.style, ".caret")
      check(`${picker.file}: the caret is the chip's 15px icon at 55%`, /width:\s*15px/.test(caret) && /opacity:\s*0\.55/.test(caret) && !/\.caret path/.test(picker.style), caret)
      const row = rule(picker.style, ".row")
      check(`${picker.file}: menu rows take --color-txt and MiMo's 11px corner`, /color:\s*var\(--text-body\)/.test(row) && /border-radius:\s*11px/.test(row), row)
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

  // ------------------------------------------------------------------ R21-F4-4
  section("Round 21 (F4-4): the search overlay's colours, its magnifier and what its rows say")
  {
    const overlay = parts("SearchOverlay.vue")(code(await read("src/renderer/src/components/SearchOverlay.vue")))
    // Item 15: five greys were on --text-weaker, which is a background token here, and the snippet was a step too light.
    check("no part of the overlay paints text in --text-weaker, which is a background colour", !/--text-weaker/.test(overlay.style), overlay.style.match(/.*--text-weaker.*/)?.[0])
    check("the field's glyph, its placeholder, the headings and the empty line are MiMo's --color-dim", /\.search-bar \.i \{[^}]*color: var\(--text-weak\)/.test(overlay.style) && /::placeholder \{\s*\n\s*color: var\(--text-weak\)/.test(overlay.style) && /\.sr-head \{[^}]*color: var\(--text-weak\)/.test(overlay.style) && /\.sr-empty \{[^}]*color: var\(--text-weak\)/.test(overlay.style))
    check("the owner and the snippet are its --color-mut, a step darker", /\.sr-owner \{[^}]*color: var\(--text-base\)/.test(overlay.style) && /\.sr-snippet \{[^}]*color: var\(--text-base\)/.test(overlay.style))
    // Item 18: MiMo's magnifier is the 24-grid one the side column already carries.
    const glyph = element(overlay.template, '<svg class="i"', "svg")
    check("the magnifier is MiMo's 24-grid circle and handle, not a 16-grid outline", glyph.includes('viewBox="0 0 24 24"') && /<circle cx="11" cy="11" r="7"/.test(glyph) && /d="m21 21-4\.3-4\.3"/.test(glyph), glyph)
    check("drawn on a 1.7 stroke with round ends, as MiMo's .i is", /stroke-width: 1\.7/.test(overlay.style) && /stroke-linejoin: round/.test(overlay.style))
    // Item 19: one delete colour, both schemes.
    check("a failed search is MiMo's --color-del in both schemes", /\.sr-artifact-error \{[^}]*color: #e5484d/.test(overlay.style) && !/#d92e3c/.test(overlay.style) && !/\.sr-artifact-error \{\s*\n\s*color: #f17471/.test(overlay.style))
    // Item 22: MiMo's page ground under the card, and its exact scrim.
    check("the card is MiMo's --color-bg rather than the raised surface", /\.search-card \{[^}]*background: #fffefd/.test(overlay.style) && /:root\[data-theme="dark"\] \.search-card[\s\S]{0,80}background: #181818/.test(overlay.style))
    check("and the scrim is its own #00000057", /background: #00000057/.test(overlay.style))
    // Item 21: MiMo closes on the click.
    check("the overlay closes on the click, as MiMo's does, not on the press", /@click\.self="close"/.test(overlay.template) && !/@mousedown\.self/.test(overlay.template))
    // Item 20: a title match opens the conversation, it does not jump into it.
    check("only a conversation found by what was said opens at that message", /messageID: titled \? undefined : hit\?\.messageID/.test(overlay.all))
    // Item 17: projects come from the app's own list.
    check("projects are searched from app.projects, so one with no conversation is still found", /for \(const directory of app\.projects\)/.test(overlay.all) && !/latest\.set\(group/.test(overlay.all))
    check("and they carry MiMo's time of 0", (overlay.all.match(/kind: "project"[^\n]*time: 0 \}/g) ?? []).length === 2)
    // Item 16: the right of a file row is its type, not the conversation.
    check("a file row says its type badge, as MiMo's does, not the conversation's title", /meta: t\(badgeOf\(name\)\.key\)/.test(overlay.all) && /import \{ badgeOf \}/.test(overlay.all))
    // Item 23: the indexed body takes each step's own line, as MiMo's reader does.
    const search = code(await read("src/server/search.ts"))
    check("a search reads each step's line as well as its output", /part\.type === "tool" \? \[part\.title, part\.output\]/.test(search), search.slice(search.indexOf("flatMap"), search.indexOf("flatMap") + 160))
  }

  // ------------------------------------------------------------------ R21-F4-5
  section("Round 21 (F4-24): the command palette is gone, MiMo having none")
  {
    const gone = await fs
      .access(path.join(root, "src/renderer/src/components/CommandPalette.vue"))
      .then(() => false)
      .catch(() => true)
    check("the component itself is deleted", gone)
    const shell = code(await read("src/renderer/src/App.vue"))
    check("nothing in the window opens or closes it any more", !/paletteOpen|PaletteMode|openPalette|CommandPalette/.test(shell), shell.match(/.*palette.*/i)?.[0])
    check("Ctrl+K still opens the search, under MiMo's own wording for it", /id: "app\.search"[\s\S]{0,140}title: t\("key\.label\.search"\)/.test(shell) && /hint: "Ctrl\+K"/.test(shell))
    check("its two commands went with it", !/app\.searchSessions|app\.searchProjects/.test(shell))
    check("so did the batch move it was the only way into, which MiMo's batch bar has no button for", !/movingMany|movingSession|pickedProject/.test(shell) && !/action === "move"/.test(shell))
    const i18n = await read("src/renderer/src/lib/i18n.ts")
    for (const key of ["palette.empty", "palette.navigate", "palette.run", "palette.cancel", "search.in.files", "search.in.projects", "cmd.searchProjects", "key.palette"]) {
      check(`its "${key}" is out of all eighteen tables`, !i18n.includes(`"${key}":`))
    }
    const protocol = await read("src/shared/protocol.ts")
    const handlers = await read("src/server/handlers.ts")
    check("and file.list, which only the palette sent, is off the wire", !/"file\.list"/.test(protocol) && !/"file\.list"/.test(handlers) && !/listFiles/.test(handlers))
  }

  // ------------------------------------------------------------------ R21-F4-6
  section("Round 21 (F4-25..42): the artifacts centre against MiMo 26.920")
  {
    const page = parts("ArtifactsView.vue")(code(await read("src/renderer/src/components/ArtifactsView.vue")))
    // Item 25/27/28: --text-weaker is a background token and was painting five kinds of text.
    check("no part of the page paints text in --text-weaker", !/--text-weaker/.test(page.style), page.style.match(/.*--text-weaker.*/)?.[0])
    check("an unselected tab is MiMo's --color-mut, its count the dim grey, and the selected one's count the mut", /\.chip \{[^}]*color: var\(--text-base\)/.test(page.style) && /\.chip-count \{[^}]*color: var\(--text-weak\)/.test(page.style) && /\.chip\.on \.chip-count \{\s*\n\s*color: var\(--text-base\)/.test(page.style))
    check("the empty, no-match and failed notices are MiMo's --color-mut", /\.notice \{[^}]*color: var\(--text-base\)/.test(page.style) && /\.none \{[^}]*color: var\(--text-base\)/.test(page.style))
    // Item 26: the third action is an arrow, not a speech bubble.
    check("进入对话 is MiMo's arrow leaving to the top right, on the 24 grid", (page.template.match(/d="M7 7h10v10M7 17 17 7"/g) ?? []).length === 2 && !/M2\.5 3\.5h11v7h-6/.test(page.template))
    // Item 29: MiMo's hover:shadow-sm, not a ring over the border.
    check("hovering a tile, a row or an action lifts it with MiMo's shadow-sm", /box-shadow: 0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a/.test(page.style) && !/--shadow-xs-border/.test(page.style))
    // Item 31: MiMo's page ground under the view toggle; its own dark border is left alone.
    check("the view toggle sits on MiMo's --color-bg", /\.view-toggle \{[^}]*background: #fffefd/.test(page.style) && /\.view-toggle \{\s*\n\s*background: #181818/.test(page.style))
    check("but keeps MCode's border (recorded: MiMo's dark --color-set-line is near-white)", /\.view-toggle \{[^}]*border: 1px solid var\(--border-weak\)/.test(page.style))
    // Item 32: MiMo's feature-page padding, narrowing with the pane.
    check("the page is inset 40 either side, 20 once the pane is 680 or narrower", /\.column \{[^}]*padding: 54px 40px 40px/.test(page.style) && /@container \(max-width: 680px\) \{\s*\n\s*\.column \{\s*\n\s*padding-inline: 20px/.test(page.style) && /container-type: inline-size/.test(page.style))
    // Item 33: the 18 moves onto the toolbar, so every state starts where the files would.
    check("the 18 under the filter row belongs to that row, not to the grid", /\.bar \{[^}]*margin-bottom: 18px/.test(page.style) && !/\.grid \{[^}]*margin-top: 18px/.test(page.style) && !/\.list \{[^}]*margin-top: 18px/.test(page.style))
    // Item 34: MiMo's gutter.
    check("the scrollbar gutter is MiMo's stable, not both-edges", /scrollbar-gutter: stable;/.test(page.style) && !/both-edges/.test(page.style))
    // Item 37: 加载更多 needs something above it.
    check("加载更多 shows only when the page has rows", /v-if="!failed && nextCursor && visible\.length"/.test(page.template))
    // Item 40: a row clips what does not fit.
    check("a list row clips what does not fit, as MiMo's does", /\.row \{[^}]*overflow: hidden/.test(page.style))
    // Item 41: switching a tab asks with the text in the box.
    check("switching a tab asks with what is typed now, not the debounced copy", /watch\(kind, \(\) => \{\s*\n\s*if \(searchTimer\) clearTimeout\(searchTimer\)\s*\n\s*needle\.value = query\.value/.test(page.all))
    // Item 35: the store says when to read again.
    check("the page reads again when the store says its contents changed", /event\.type !== "artifact\.changed" \|\| event\.revision <= seenRevision/.test(page.all) && /offChanged = app\.client\?\.on\(/.test(page.all))
    const protocolSource = await read("src/shared/protocol.ts")
    const store = await read("src/server/artifact/store.ts")
    const server = await read("src/server/index.ts")
    check("the wire carries it, with the revision MiMo's carries", /\| \{ type: "artifact\.changed"; revision: number \}/.test(protocolSource))
    check("the store counts its writes and tells one listener, gathering a burst", /get revision\(\): number/.test(store) && /onChanged\(listener: \(revision: number\) => void\)/.test(store) && /CHANGE_NOTICE_MS/.test(store))
    check("and the backend publishes it", /artifacts\?\.onChanged\(\(revision\) => bus\.publish\(\{ type: "artifact\.changed", revision \}\)\)/.test(server))
    // Items 36/38/39: MCode's own, kept and recorded.
    check("MCode's load-ahead scroll stays (recorded: MiMo has only the button)", /const LOAD_AHEAD_PX = 240/.test(page.all))
    check("MCode's line-heights keep the font scale (recorded: MiMo scales sizes only)", /line-height: calc\(22\.4px \* var\(--ui-font-scale, 1\)\)/.test(page.style))
    check("MCode's own retry and load-more colours stay (recorded: MiMo's classes emit no CSS)", /\.page-btn \{[^}]*color: var\(--text-strong\)/.test(page.style))
    // Item 30: MiMo's PDF mark.
    const kinds = code(await read("src/renderer/src/lib/artifact-kind.ts"))
    check("the PDF badge is the corner-cut page with a letter in the notch", /const CORNER_PAGE = "M12 22h6a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v6"/.test(kinds) && /pdf: \{[^}]*glyph: \[CORNER_PAGE, FOLD, "M3 16v-2h8v2", "M7 14v8", "M6 22h2"\]/.test(kinds))
  }

  // ------------------------------------------------------------------ R21-F4-7
  section("Round 21 (F4-43..53): the notices against MiMo 26.920")
  {
    const column = parts("Toasts.vue")(code(await read("src/renderer/src/components/Toasts.vue")))
    const store = code(await read("src/renderer/src/lib/toast.ts"))
    // Item 43: MiMo centres them on the work area, and only a full scrim sends them back to the window's centre.
    check("the column stands over the middle of the work area, followed as it resizes", /document\.querySelector\("main\.main"\)/.test(column.all) && /new ResizeObserver\(measure\)/.test(column.all) && /:style="centre \? \{ left: centre \} : undefined"/.test(column.template))
    check("and goes back to the window's centre under a full scrim, as MiMo's does", /#app:has\(\.overlay, \.scrim, \.search-overlay\) \.toasts \{\s*\n\s*left: 50% !important;/.test(column.style))
    // Item 44: sonner's own 24, MiMo's 8 being scoped to its login gate.
    check("they sit 24 under the top edge, not 8", /\.toasts \{[^}]*top: 24px/.test(column.style) && !/top: 8px/.test(column.style))
    // Item 45: MiMo prepends.
    check("a new notice goes to the front of the column", /toasts\.value = \[entry, \.\.\.toasts\.value\]/.test(store))
    // Item 47: the ones past the third are kept rather than dropped.
    check("nothing past the third is thrown away; it waits its turn", !/const over = next\.length - LIMIT/.test(store) && !/doomed/.test(store) && /export const LIMIT = 3/.test(store))
    check("and the column hides it rather than unmounting it", /\{ over: at >= LIMIT \}/.test(column.template) && /\.notice\.over \{\s*\n\s*display: none;/.test(column.style))
    // Item 46: MiMo's own travel and duration.
    check("they arrive and leave over .4s, travelling their own height", /transition:\s*\n\s*opacity 0\.4s,\s*\n\s*transform 0\.4s;/.test(column.style) && /transform: translateY\(-100%\);/.test(column.style) && !/translateY\(-8px\)/.test(column.style))
    check("with the reduced-motion fallback kept", /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?transform: none;/.test(column.style))
    // Items 50/51/53.
    check("the capsule's text is MiMo's --color-txt", /\.notice \{[^}]*color: var\(--text-body\)/.test(column.style))
    check("the column is above both previews, which are 210 and 220", /z-index: 230/.test(column.style))
    check("a link sits on a line of its own height", /\.link \{[^}]*line-height: 1;/.test(column.style))
    check("Alt+T counts whatever else is held down, as MiMo's check does", /if \(!event\.altKey \|\| event\.code !== "KeyT"\) return/.test(column.all))
  }

  // ------------------------------------------------------------------ R21-F4-8
  section("Round 21 (F4-48..58): the bell, the side column's leftovers and the small cards")
  {
    const side = parts("Sidebar.vue")(code(await read("src/renderer/src/components/Sidebar.vue")))
    // Item 48: one blue in both schemes.
    check("the lit bell is MiMo's --color-priority-on in both schemes", /\.ico\.bell\.on,\s*\n:root \.brand-actions \.ico\.bell\.on \{\s*\n\s*color: #3295fb;/.test(side.style) && !/--text-accent/.test(side.style))
    // Item 49: MiMo's topbar icon colour, and its Windows pair.
    check("the title-bar glyphs are MiMo's --color-topbar-icon", /\.rail-tools \.ico \{\s*\n\s*color: #151c1399;/.test(side.style) && /:root\[data-theme="dark"\] \.rail-tools \.ico \{\s*\n\s*color: #f4f4f5;/.test(side.style))
    // The collapsed rail carries the toggle and 新建任务 and no bell, so the rule that styled one there was dead (R25-D10).
    check("the bell alone rests in its --color-mut off Windows", /\.brand-actions \.ico\.bell \{\s*\n\s*color: var\(--text-base\);/.test(side.style) && !/\.rail-tools \.ico\.bell/.test(side.style))
    check("and on Windows they are #2b2b2b / #ececec, hover included", /\.app\[data-platform="win32"\][^{]*\{\s*\n\s*color: #2b2b2b;/.test(side.style) && /color: #ececec;/.test(side.style))
    check("their hover colour is MiMo's --color-txt", /\.ico:hover \{\s*\n\s*color: var\(--text-body\);/.test(side.style))
    // Item 54.
    check("a conversation's title is MiMo's --color-side-item", /\.task-label \{\s*\n\s*color: #4a4a4a;/.test(side.style) && /:root\[data-theme="dark"\] \.task-label \{\s*\n\s*color: #cccccc;/.test(side.style))
    check("a row's pin and menu rest in the muted grey and hover to --color-txt", /\.pin \{[^}]*color: var\(--text-base\)/.test(side.style) && /\.row-menu:hover \{\s*\n\s*color: var\(--text-body\);/.test(side.style) && /\.row-pin:hover \{\s*\n\s*color: var\(--text-body\);/.test(side.style))
    check("a pinned row's pin keeps the priority blue", /\.row-pin\.on \{\s*\n\s*color: #3295fb;/.test(side.style))
    check("the show-more rows are muted, hover to --color-txt and take no fill", /\.show-more \{[^}]*color: var\(--text-base\)/.test(side.style) && /\.show-more:hover \{\s*\n\s*color: var\(--text-body\);\s*\n\}/.test(side.style) && /\.project-show-all \{[^}]*color: var\(--text-base\)/.test(side.style) && /\.projects-pages button \{[^}]*color: var\(--text-base\)/.test(side.style))
    check("the selection box is MiMo's 18 on a 5px corner, filled with --color-send", /\.tick \{[^}]*width: 18px;[^}]*border-radius: 5px/.test(side.style) && /\.tick\.on \{\s*\n\s*color: #ffffff;\s*\n\s*background: #151c13;/.test(side.style) && /:root\[data-theme="dark"\] \.tick\.on \{\s*\n\s*color: #0d0d0d;\s*\n\s*background: #ececec;/.test(side.style))
    check("and its tick is MiMo's 12px mark on the 24 grid", (side.template.match(/d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="3"/g) ?? []).length === 4 && !/M3\.5 8\.2 6\.4 11\.2 12\.5 4\.6/.test(side.template))
    check("the batch bar's neutral button takes --color-txt; its red one is MiMo's own and stays", /\.sb-btn \{[^}]*color: var\(--text-body\)/.test(side.style) && /\.sb-btn\.danger \{[^}]*color: #d93025;[^}]*background: #fdecea/.test(side.style))
    check("a finished conversation's dot is MiMo's --color-blue", /\.status-dot \{[^}]*background: var\(--interactive\)/.test(side.style))
    // Item 55.
    const find = parts("FindBar.vue")(code(await read("src/renderer/src/components/FindBar.vue")))
    check("the find bar lies on MiMo's --color-bg, its glyph and steps muted, its field --color-txt", /\.find \{[^}]*background: #fffefd/.test(find.style) && /\.glass \{[^}]*color: var\(--text-base\)/.test(find.style) && /\.step \{[^}]*color: var\(--text-base\)/.test(find.style) && /\.needle \{[^}]*color: var\(--text-body\)/.test(find.style))
    // Item 56.
    const spine = parts("SessionSpine.vue")(code(await read("src/renderer/src/components/SessionSpine.vue")))
    check("the rail's fades end on the work area's fill", /\.spine-fade\.top \{[^}]*var\(--surface-raised\) 30%/.test(spine.style) && !/--surface-base\) 30%/.test(spine.style))
    check("its preview chips are MiMo's --color-code-bg under --color-txt", /\.sp-tool \{[^}]*color: var\(--text-body\);[^}]*background: #f0f0f2/.test(spine.style) && /:root\[data-theme="dark"\] \.sp-tool \{\s*\n\s*color: #f4f4f5;\s*\n\s*background: #2e2e2e;/.test(spine.style))
    // Item 57.
    const hero = code(await read("src/renderer/src/components/SessionHero.vue"))
    const mark = code(await read("src/renderer/src/components/ModelMark.vue"))
    check("the empty conversation's foot is the muted grey", /\.foot \{[^}]*color: var\(--text-base\)/.test(hero))
    check("the model's letter is MiMo's --color-txt", /\.letter \{[^}]*color: var\(--text-body\)/.test(mark))
    // Item 58.
    const shell = code(await read("src/renderer/src/App.vue"))
    const pill = code(await read("src/renderer/src/components/LiveEditPill.vue"))
    const files = code(await read("src/renderer/src/components/EditedFilesCard.vue"))
    check("the drop card is MiMo's page ground under the composer's shadow", /\.drop-card \{[^}]*background: #fffefd;[^}]*box-shadow:\s*\n\s*0 1px 2px #0000000d,\s*\n\s*0 6px 18px #0000001b;/.test(shell) && /:root\[data-theme="dark"\] \.drop-card \{\s*\n\s*background: #181818;/.test(shell))
    check("the live-edit pill and the edited-files button take the same ground", /\.live-edit-pill \{[^}]*background: #fffefd/.test(pill) && /background: #181818;/.test(pill) && /\.fc-review \{[^}]*background: #fffefd/.test(files) && /:root\[data-theme="dark"\] \.file-card,\s*\n:root\[data-theme="dark"\] \.fc-review \{\s*\n\s*background: #181818;/.test(files))
  }
}
