/**
 * Round 22, lane L1: the sweep R21-F1 handed over.
 *
 * Round 21 put MiMo's colour system under MCode's names and left a written list
 * of what it could not reach from inside the token file. This file guards the
 * result of working through that list, and every assertion here fails against
 * the code the round started from: the two opencode-era lifts were still on
 * thirty surfaces, seventeen half-pixel edges named the wrong grey, seventy-odd
 * declarations wrote MiMo's --color-txt as a hex pair, the card tooltip capped
 * itself 32px short, App.vue restated two washes that are already the default,
 * and the plugins switch was the wrong size in the wrong colours.
 *
 * The values come from MiMo 26.920's own bundle - renderer/assets's stylesheet
 * and the chunks beside it - and each check names what was read there.
 *
 * Read as text rather than measured in a window: what needs guarding is which
 * name each rule reaches for, and a window can only show the value behind it.
 */
import fs from "node:fs"
import path from "node:path"
import type { Check } from "./smoke-round5"

/** A stylesheet without its comments, so a check reads what the browser reads. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "")

/**
 * One rule's body, by the selector that opens it. A selector is also the last
 * line of any group that ends with it, so a match whose line before ends in a
 * comma is skipped.
 */
function rule(styles: string, selector: string): string {
  let at = styles.indexOf(`\n${selector} {`)
  while (at !== -1) {
    const before = styles.slice(0, at).trimEnd()
    if (!before.endsWith(",")) return styles.slice(at + selector.length + 3, styles.indexOf("}", at)).trim()
    at = styles.indexOf(`\n${selector} {`, at + 1)
  }
  return ""
}

/** Every renderer file a whole-tree check has to look at. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(vue|css)$/.test(entry.name)) out.push(full)
  }
  return out
}

export async function roundTwentyTwoLaneOneChecks(check: Check, section: (name: string) => void): Promise<void> {
  const renderer = path.join(process.cwd(), "src/renderer/src")
  const files = walk(renderer)
  const sources = new Map<string, string>()
  for (const file of files) sources.set(path.relative(renderer, file).replace(/\\/g, "/"), fs.readFileSync(file, "utf8"))
  const styles = (relative: string) => code(sources.get(relative) ?? "")
  /** Every file's style text at once, for the sweeps that must find nothing. */
  const everywhere = [...sources.entries()].map(([name, text]) => [name, code(text)] as const)

  // ----------------------------------------------------------------- R22-L1-1
  section("Round 22 (L1-1): the two opencode lifts are gone, replaced by purpose")
  {
    const tokens = styles("styles/tokens.css")
    check("--shadow-lg and --shadow-overlay are no longer defined", !/--shadow-lg:/.test(tokens) && !/--shadow-overlay:/.test(tokens))
    check("--shadow-xs-border, which had no callers, is gone too", !/--shadow-xs-border/.test(tokens))
    const users = everywhere.filter(([, text]) => /var\(--shadow-(lg|overlay|xs-border)\)/.test(text)).map(([name]) => name)
    check("and nothing in the renderer still asks for one", users.length === 0, users)

    // MiMo's gC: `z-[1000] rounded-[16px] border-[0.5px] border-input-border
    // menu-glass p-[5px] shadow-composer` is every popover and dropdown shell.
    const popovers: [string, string][] = [
      ["components/ProjectPicker.vue", ".menu"],
      ["components/ProjectPicker.vue", ".submenu"],
      ["components/BranchPicker.vue", ".menu"],
      ["components/ModelMenuRow.vue", ".sub"],
      ["components/LanguageMenu.vue", ".lang-pop"],
      ["components/InfoBranchMenu.vue", ".menu"],
      ["components/InfoCommitCard.vue", ".card"],
      ["components/SessionSpine.vue", ".spine-preview"],
    ]
    for (const [file, selector] of popovers) {
      const body = rule(styles(file), selector)
      check(`${file} ${selector} takes MiMo's popover lift`, /box-shadow: var\(--shadow-composer\);/.test(body), body.slice(0, 120))
    }
    // MiMo's Z0 / `.menu`: rounded-12 on a full pixel of --color-line, over
    // --color-bg, under --shadow-menu. Only the @ and slash menus use it.
    const slash = rule(styles("components/Composer.vue"), ".slash")
    check(
      "the @ / slash menu is MiMo's own .menu: 1px --border-weak on --surface-page under --shadow-menu",
      /border: 1px solid var\(--border-weak\);/.test(slash) && /background: var\(--surface-page\);/.test(slash) && /box-shadow: var\(--shadow-menu\);/.test(slash),
      slash.slice(0, 200),
    )
    // MiMo's dialogs: `rounded-[16px] border border-line bg-bg ... shadow-pop`.
    const dialogs: [string, string][] = [
      ["components/NewProjectDialog.vue", ".card"],
      ["components/RenameDialog.vue", ".dialog"],
      ["components/FullAccessDialog.vue", ".dialog"],
      ["components/ThirdPartyDialog.vue", ".dialog"],
      ["components/BranchPicker.vue", ".dialog"],
    ]
    for (const [file, selector] of dialogs) {
      const body = rule(styles(file), selector)
      check(
        `${file} ${selector} is bg-bg under shadow-pop`,
        /background: var\(--surface-page\);/.test(body) && /box-shadow: var\(--shadow-pop\);/.test(body),
        body.slice(0, 160),
      )
    }
    // MiMo hangs Tailwind's `shadow-pop` utility on its media previews, and the
    // utility bakes the light value rather than reading the token, so these two
    // keep the literal and do not turn over in dark.
    check(
      "the media previews keep MiMo's baked utility value",
      /box-shadow: 0 12px 40px #00000024;/.test(rule(styles("components/ImagePreview.vue"), ".ip-transform img")) &&
        /box-shadow: 0 12px 40px #00000024;/.test(rule(styles("components/VideoPreview.vue"), ".vp-video")),
    )
  }

  // ----------------------------------------------------------------- R22-L1-2
  section("Round 22 (L1-2): every half-pixel edge is --border-input")
  {
    // MiMo's stylesheet holds nine half-pixel rules and its markup two
    // half-pixel classes; all eleven name --color-input-border.
    const wrong: string[] = []
    for (const [name, text] of everywhere) {
      for (const match of text.matchAll(/(^|[^-])border: 0\.5px solid ([^;]+);/gm)) {
        if (match[2].trim() !== "var(--border-input)") wrong.push(`${name}: ${match[2].trim()}`)
      }
    }
    check("no half-pixel edge names anything else", wrong.length === 0, wrong)
    check(
      "the composer's card and the question dock stopped writing #151c130f out",
      !/#151c130f/.test(styles("components/Composer.vue")) &&
        /border: 0\.5px solid var\(--border-input\);/.test(rule(styles("components/QuestionDock.vue"), ".confirm-dock")),
    )
    // MiMo's settings row is a 1px --color-set-line pseudo-element inset 16
    // from either end, so it is not part of the sweep and keeps --border-weak.
    check("the settings row rule is the one exception, and still on --border-weak", /border-bottom: 0\.5px solid var\(--border-weak\);/.test(styles("components/SettingsDialog.vue")))
  }

  // ----------------------------------------------------------------- R22-L1-3
  section("Round 22 (L1-3): --color-txt is a token, not a hex pair")
  {
    const literals: string[] = []
    for (const [name, text] of everywhere) {
      if (name === "styles/tokens.css") continue
      for (const match of text.matchAll(/^[ \t]*color: (#151c13cc);[ \t]*$/gm)) literals.push(`${name}: ${match[1]}`)
    }
    check("nothing writes #151c13cc as a colour any more", literals.length === 0, literals)
    check("and the token is what a menu row, a tooltip and a card reach for", /color: var\(--text-body\);/.test(styles("components/ProjectPicker.vue")) && /color: var\(--text-body\);/.test(styles("styles/base.css")))
    // MiMo's --color-err, which --text-critical is.
    check("the MCP failure pill names --text-critical rather than #d23f3f", /color: var\(--text-critical\);/.test(rule(styles("components/SettingsDialog.vue"), ".mcp-status.err")))
    // Nothing should still point at a lane that has finished.
    const stale = everywhere.filter(([, text]) => /lane F1|Lane F1/i.test(text)).map(([name]) => name)
    check("no comment still waits on round 21's token lane", stale.length === 0, stale)
  }

  // ----------------------------------------------------------------- R22-L1-4
  section("Round 22 (L1-4): the tooltip's width, the dead glyph tint, the restated washes")
  {
    // MiMo's tooltip content: `${info ? card : plain} max-w-[420px]` - one
    // width for both variants, so the card had no business capping itself.
    const card = rule(styles("styles/base.css"), ".app-tip.card")
    check("the card tooltip no longer caps itself below the plain one", !/max-width/.test(card), card.slice(0, 160))
    check("and the plain one is MiMo's 420", /max-width: 420px;/.test(rule(styles("styles/base.css"), ".app-tip")))

    const menu = fs.readFileSync(path.join(renderer, "lib/menu.ts"), "utf8")
    check("MenuItem.iconColor is gone", !/iconColor/.test(menu))
    check("and the .tinted branch it drove with it", !/tinted/.test(sources.get("components/ContextMenu.vue") ?? ""))

    // MiMo's win32/linux block does set these two, but its root is already
    // #f1f0ec / #eeedec, so repeating them said nothing.
    const app = styles("App.vue")
    const platform = app.slice(app.indexOf(':root[data-theme="light"] .app[data-platform="win32"]'))
    const block = platform.slice(0, platform.indexOf("}"))
    check("the win32 block no longer restates the hover and selected washes", !/--surface-hover|--surface-selected/.test(block), block)
    check("and still carries the two that do differ from the root", /--surface-base: #f8f7f5;/.test(block) && /--border-weak: #f0ebe5;/.test(block))
  }

  // ----------------------------------------------------------------- R22-L1-5
  section("Round 22 (L1-5): the shared icon button and MiMo's plain switch")
  {
    const terminal = styles("components/TerminalDrawer.vue")
    const close = rule(terminal, ".tab-close:hover")
    // MiMo's `.bp-tab-x:hover{color:var(--color-txt);background:#00000014}`.
    check("the terminal tab's close mark hovers on --overlay-hover in the body ink", /background: var\(--overlay-hover\);/.test(close) && /color: var\(--text-body\);/.test(close), close)
    check("and the panel-away button leans on the shared .icon-btn", !/\.head \.icon-btn\.hide:hover/.test(terminal))
    check("as does the plugins page", !/^\.icon-btn \{/m.test(styles("components/PluginsView.vue")))

    // shadcn's default switch, which is what MiMo uses away from its settings
    // page: h-[18px] w-8 with a size-4 thumb, --color-switch-on #3295fb /
    // #2f7bf6 over --color-switch-off #bcbcb6 / #4a4a4a.
    for (const file of ["components/PluginsView.vue", "components/SkillDetailDialog.vue"]) {
      const track = rule(styles(file), ".switch")
      check(`${file}'s switch is MiMo's 32 by 18`, /width: 32px;/.test(track) && /height: 18px;/.test(track), track.slice(0, 140))
      check(`${file}'s track is --color-switch-off / --color-switch-on`, /background: #bcbcb6;/.test(track) && /background: #3295fb;/.test(rule(styles(file), ".switch.on")))
      check(`${file}'s thumb is white on light and 1 in from the end`, /background: #ffffff;/.test(rule(styles(file), ".knob")) && /inset-inline-start: 1px;/.test(rule(styles(file), ".knob")))
    }
  }

  // ----------------------------------------------------------------- R22-L1-6
  section("Round 22 (L1-6): dim and mut, by the kind of thing MiMo writes each on")
  {
    /** The ink one rule reaches for. */
    const ink = (file: string, selector: string) => /color: var\((--text-[a-z]+)\)/.exec(rule(styles(file), selector))?.[1] ?? ""

    // mut kinds: mi-section, hs-perm-*, user-time, np-sub, u-modal-close.
    const mut: [string, string][] = [
      ["components/ContextMenu.vue", ".heading"],
      ["components/PermissionDialog.vue", ".forced"],
      ["components/PermissionDialog.vue", ".diff-toggle"],
      ["components/MessageStream.vue", ".run-time"],
      ["components/RenameDialog.vue", ".subtitle"],
      ["components/SkillDetailDialog.vue", ".brief"],
      ["components/ThirdPartyDialog.vue", ".intro"],
      ["components/parts/DiffBody.vue", ".db-cap"],
      ["components/FullAccessDialog.vue", ".close"],
      ["components/ThirdPartyDialog.vue", ".close"],
    ]
    for (const [file, selector] of mut) check(`${file} ${selector} is --text-base`, ink(file, selector) === "--text-base", ink(file, selector))

    // dim kinds: *-empty, sn-group, conv-empty, confirm-queue - already right,
    // and a size-driven sweep would have got every one of them wrong.
    const dim: [string, string][] = [
      ["components/PermissionDialog.vue", ".queue"],
      ["components/SettingsDialog.vue", ".nav-group"],
      ["components/SettingsDialog.vue", ".nav-empty"],
      ["components/Sidebar.vue", ".empty"],
      ["components/Sidebar.vue", ".day-head"],
      ["components/SearchOverlay.vue", ".sr-empty"],
      ["components/LanguageMenu.vue", ".lang-pop .lang-empty"],
    ]
    for (const [file, selector] of dim) check(`${file} ${selector} stays --text-weak`, ink(file, selector) === "--text-weak", ink(file, selector))

    // MiMo's update panel: the note in --color-txt, its bullet and the install
    // hint in --color-mut.
    const update = styles("components/UpdatePill.vue")
    check("the update panel's note is the body ink", /color: var\(--text-body\);/.test(rule(update, ".update-bubble .ub-notes li")))
    check("and its bullet is muted", /color: var\(--text-base\);/.test(rule(update, ".update-bubble .ub-dot")))
  }
}
