/**
 * Round 21, lane F1: the colour system and the shared controls against MiMo
 * 26.920.
 *
 * Every value asserted here was read out of MiMo's own stylesheet
 * (renderer/assets/index-BcVtFvOi.css) or the chunks beside it, and every one
 * of them fails against the code this round started from - the hover wash was
 * the automations page's neutral #f1f1f2, the sunken fill was derived rather
 * than measured, --text-weaker was a background step used as text, the focus
 * ring was blue where MiMo's is the ink, and the menu, the button, the field,
 * the kbd cap and the dialog each differed from MiMo in several values at once.
 *
 * The stylesheet is read as text rather than measured in a window: tokens.css
 * is generated whole from the palette (themecheck), so what needs guarding is
 * that the numbers written in it stay MiMo's.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { themeTokens } from "../src/renderer/src/lib/theme-engine"
import { MCODE_THEME } from "../src/renderer/src/lib/theme-palettes"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** A stylesheet without its comments, so a check reads what the browser reads. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "")

/**
 * One rule's body, by the selector that opens it.
 *
 * Not simply the first `\n<selector> {`: a selector is also the last line of
 * any group that ends with it, and `.app-tip` is - the app-region rule lists
 * five layers and closes on it, which is the body the first attempt read.
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

/** What a token is worth in one of tokens.css's three blocks. */
function tokenIn(css: string, selector: string, name: string): string {
  const start = css.indexOf(selector)
  if (start === -1) return ""
  const open = css.indexOf("{", start)
  let depth = 0
  let end = open
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1
    else if (css[i] === "}") {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const found = new RegExp(`^\\s*${name}:\\s*(.+);\\s*$`, "m").exec(css.slice(open, end))
  return found ? found[1].trim() : ""
}

export async function roundTwentyOneLaneF1Checks(check: Check, section: (name: string) => void): Promise<void> {
  const tokens = code(await read("src/renderer/src/styles/tokens.css"))
  const base = code(await read("src/renderer/src/styles/base.css"))
  const light = (name: string) => tokenIn(tokens, ":root {", name)
  const dark = (name: string) => tokenIn(tokens, ':root[data-theme="dark"]', name)
  const systemDark = (name: string) => tokenIn(tokens, ':root:not([data-theme="light"])', name)

  // ----------------------------------------------------------------- R21-F1-1
  section("Round 21 (F1-1): the generated tokens carry MiMo's measured colours")
  {
    const generated = { light: themeTokens(MCODE_THEME, false), dark: themeTokens(MCODE_THEME, true) }
    // --color-menu-hover / --color-side-sel, not the automations page's #f1f1f2.
    check("the hover wash is MiMo's #f1f0ec in light", generated.light["--surface-hover"] === "#f1f0ec", generated.light["--surface-hover"])
    check("and the selected wash #eeedec", generated.light["--surface-selected"] === "#eeedec", generated.light["--surface-selected"])
    // --color-line, both schemes.
    check("the line is #f1f1f1 in light and #2e2e2e in dark", generated.light["--border-weak"] === "#f1f1f1" && generated.dark["--border-weak"] === "#2e2e2e", [generated.light["--border-weak"], generated.dark["--border-weak"]])
    // --color-line-soft.
    check("the soft line is #0000000d / #ffffff12", generated.light["--border-weaker"] === "#0000000d" && generated.dark["--border-weaker"] === "#ffffff12", [generated.light["--border-weaker"], generated.dark["--border-weaker"]])
    // --color-sunken, which used to be black at 35% over bg-deep (#0d0d0d).
    check("the sunken fill is measured: #f8f7f5 / #2e2e2e", generated.light["--surface-sunken"] === "#f8f7f5" && generated.dark["--surface-sunken"] === "#2e2e2e", [generated.light["--surface-sunken"], generated.dark["--surface-sunken"]])
    // --color-icon.
    check("icons are --color-icon, #5c5c57 / #d0d0d0", generated.light["--icon-base"] === "#5c5c57" && generated.dark["--icon-base"] === "#d0d0d0", [generated.light["--icon-base"], generated.dark["--icon-base"]])
    // --color-send-empty: --text-weaker was background-bg-layer-04 (#dbdbdb), invisible on white.
    check("--text-weaker is a text colour, not a background step", generated.light["--text-weaker"] === "#bbbbb6" && generated.dark["--text-weaker"] === "#5a5a5a", [generated.light["--text-weaker"], generated.dark["--text-weaker"]])
    // --color-link, which MiMo never turns over with the scheme.
    check("the link blue is #3295fb in both schemes", generated.light["--text-accent"] === "#3295fb" && generated.dark["--text-accent"] === "#3295fb", [generated.light["--text-accent"], generated.dark["--text-accent"]])
    // --color-scrim.
    check("the scrim is #00000061 / #00000099", generated.light["--scrim"] === "#00000061" && generated.dark["--scrim"] === "#00000099", [generated.light["--scrim"], generated.dark["--scrim"]])
  }

  // ----------------------------------------------------------------- R21-F1-2
  section("Round 21 (F1-2): the names MiMo has that this window lacked")
  {
    const both = (name: string, lightValue: string, darkValue: string) => {
      check(
        `${name} is ${lightValue} / ${darkValue}, in all three blocks`,
        light(name) === lightValue && dark(name) === darkValue && systemDark(name) === darkValue,
        [light(name), dark(name), systemDark(name)],
      )
    }
    // --color-bg: neither --surface-raised (#ffffff/#181818) nor --surface-base
    // (#fffefd/#141414) is this pair, which is why it needed a name.
    both("--surface-page", "#fffefd", "#181818")
    both("--surface-glass", "#ffffffc7", "#161616b8")
    both("--text-body", "#151c13cc", "#f4f4f5")
    // --color-err, referenced in twenty rules across six components and defined nowhere.
    both("--text-critical", "#d23f3f", "#d23f3f")
    // --color-del, the red of a row that destroys something.
    both("--text-destructive", "#e5484d", "#e5484d")
    both("--border-input", "#151c130f", "#2e2e2e")
    both("--border-button", "#e3e3e0", "#3a3a3a")
    both("--ring", "#151c13", "#ffffff")
    // --color-send / --color-send-fg, which were #111111/#fafafa and #ffffff/#161616.
    both("--button-primary", "#151c13", "#ececec")
    both("--button-primary-text", "#ffffff", "#0d0d0d")
    both("--shadow-menu", "0 8px 30px #0000002e, 0 1px 3px #0000001a", "0 8px 30px #0009, 0 1px 3px #0006")
    both("--shadow-pop", "0 12px 40px #00000024", "0 12px 40px #00000080")
    both("--shadow-tip", "0 2px 8px #0000000d, 0 1px 2px #0000000a", "0 2px 8px #0000004d, 0 1px 2px #00000040")
    both("--shadow-composer", "0 1px 2px #0000000d, 0 6px 18px #0000001b", "0 1px 3px #0006")
    check("--motion-fast is MiMo's .12s, which three components read and nothing defined", light("--motion-fast") === "0.12s", light("--motion-fast"))
    check("--overlay-hover is defined, which TerminalDrawer's tab close reads", light("--overlay-hover") === "#00000014", light("--overlay-hover"))
  }

  // ----------------------------------------------------------------- R21-F1-3
  section("Round 21 (F1-3): the shared controls are MiMo's")
  {
    check(
      "the focus ring is --color-ring, the ink, and never the interactive blue",
      /outline: 2px solid var\(--ring\);\s*outline-offset: -2px;/.test(base) && !/outline: 2px solid var\(--interactive\)/.test(base),
      base.match(/outline: 2px solid var\([^)]*\)/g),
    )

    // MiMo's kbd: font-family inherit, 11px dim, 1px line, radius 5, 1px 5px.
    const kbd = rule(base, ".kbd")
    check("kbd takes the interface face, not the terminal's", /font-family: inherit;/.test(kbd), kbd)
    check("kbd is an 11px cap on a 5px corner with 1px 5px of padding", /font-size: calc\(11px/.test(kbd) && /border-radius: 5px;/.test(kbd) && /padding: 1px 5px;/.test(kbd), kbd)
    check("kbd carries no fill and no thickened bottom edge", !/background:/.test(kbd) && !/border-bottom-width:/.test(kbd), kbd)

    // MiMo's .icon-btn: 30 square, radius 7, mut, hover menu-hover + txt.
    const iconBtn = rule(base, ".icon-btn")
    check("the icon button is 30 square on a 7px corner", /width: 30px;/.test(iconBtn) && /height: 30px;/.test(iconBtn) && /border-radius: 7px;/.test(iconBtn), iconBtn)
    check("it hovers to menu-hover and --color-txt", /background: var\(--surface-hover\);/.test(rule(base, ".icon-btn:hover")) && /color: var\(--text-body\);/.test(rule(base, ".icon-btn:hover")), rule(base, ".icon-btn:hover"))

    // MiMo's shadcn button: rounded-[8px], font-medium, border, shadow-xs, active:scale-[0.97].
    const btn = rule(base, ".btn")
    check("the button is an 8px corner at 500, not a 4px one at 530", /border-radius: 8px;/.test(btn) && /font-weight: 500;/.test(btn), btn)
    check("its edge is a real border on --color-line over --color-bg", /border: 1px solid var\(--border-weak\);/.test(btn) && /background: var\(--surface-page\);/.test(btn), btn)
    check("it carries tailwind's shadow-xs", /box-shadow: var\(--shadow-xs\);/.test(btn), btn)
    check("it scales to .97 while pressed, as every shadcn button does", /scale: 0\.97;/.test(rule(base, ".btn:active:not(:disabled)")), rule(base, ".btn:active:not(:disabled)"))
    check("the filled variant takes its fill to 90% on hover rather than brightening the control", /color-mix\(in srgb, var\(--button-primary\) 90%, transparent\)/.test(rule(base, ".btn.primary:hover")), rule(base, ".btn.primary:hover"))

    // MiMo's shadcn Input: border-input, bg-transparent, focus-visible:border --color-dim.
    const field = rule(base, ".field")
    check("the field has a real --color-btn-border edge and no fill of its own", /border: 1px solid var\(--border-button\);/.test(field) && /background: transparent;/.test(field), field)
    check("it no longer carries the white-gradient fill", !/linear-gradient/.test(field), field)
    check("focus darkens the border to --color-dim instead of drawing a blue ring", /border-color: var\(--text-weak\);/.test(rule(base, ".field:focus")) && !/outline-color: var\(--interactive\)/.test(base), rule(base, ".field:focus"))
    check("the placeholder is --color-mut", /color: var\(--text-base\);/.test(rule(base, ".field::placeholder")), rule(base, ".field::placeholder"))

    // MiMo's own modal, not shadcn's: radius 16, 1px line, bg, shadow-pop.
    const dialog = rule(base, ".dialog")
    check("a dialog is a 16px card on a 1px line over --color-bg", /border-radius: 16px;/.test(dialog) && /border: 1px solid var\(--border-weak\);/.test(dialog) && /background: var\(--surface-page\);/.test(dialog), dialog)
    check("its lift is --shadow-pop", /box-shadow: var\(--shadow-pop\);/.test(dialog), dialog)

    // MiMo's .u-modal-close.
    const close = rule(base, ".dialog-close")
    check("the close is 28 square on an 8px corner in --color-mut", /width: 28px;/.test(close) && /border-radius: 8px;/.test(close) && /color: var\(--text-base\);/.test(close), close)
    check("its glyph is 16", /width: 16px;/.test(rule(base, ".dialog-close > svg")), rule(base, ".dialog-close > svg"))
    check("it scales to .96 while pressed", /scale: 0\.96;/.test(rule(base, ".dialog-close:active:not(:disabled)")), rule(base, ".dialog-close:active:not(:disabled)"))

    // The tooltip was already MiMo's, written as literals in two schemes.
    const tip = rule(base, ".app-tip")
    check("the tooltip reads the tokens rather than repeating MiMo's hexes per scheme", /background: var\(--surface-page\);/.test(tip) && /box-shadow: var\(--shadow-tip\);/.test(tip), tip)
    check("and its dark duplicates are gone", !/\[data-theme="dark"\] \.app-tip \{/.test(base), true)
  }

  // ----------------------------------------------------------------- R21-F1-4
  section("Round 21 (F1-4): the menu and the select")
  {
    const menu = code(await read("src/renderer/src/components/ContextMenu.vue"))
    const styles = menu.slice(menu.indexOf("<style"))
    check("the menu is filled with --color-bg, not this window's own menu step", /background: var\(--surface-page\);/.test(rule(styles, ".menu")) && !/background: var\(--surface-menu\)/.test(styles), rule(styles, ".menu"))
    check("its lift is the --shadow-menu token rather than a literal per scheme", /box-shadow: var\(--shadow-menu\);/.test(rule(styles, ".menu")) && !/0 8px 30px #0009/.test(styles), rule(styles, ".menu"))
    check("a row is written in --color-txt", /color: var\(--text-body\);/.test(rule(styles, ".item")), rule(styles, ".item"))
    check("a glyph is --color-icon and is not brightened under the pointer", /color: var\(--icon-base\);/.test(rule(styles, ".glyph")) && !/\.item:hover:not\(:disabled\) \.glyph/.test(styles), rule(styles, ".glyph"))
    check("a shortcut is MiMo's key cap", /border: 1px solid var\(--border-weak\);/.test(rule(styles, ".hint")) && /border-radius: 5px;/.test(rule(styles, ".hint")) && /padding: 1px 5px;/.test(rule(styles, ".hint")), rule(styles, ".hint"))
    check("the delete row is --color-del, with the menu's own hover under it", /color: var\(--text-destructive\);/.test(rule(styles, ".item.danger,\n.item.danger .glyph")) && !/color-mix\(in srgb, var\(--error\)/.test(styles), rule(styles, ".item.danger,\n.item.danger .glyph"))
    check("the tick is --color-send", /color: var\(--button-primary\);/.test(rule(styles, ".tick-end")) && /color: var\(--button-primary\);/.test(rule(styles, ".tick")), [rule(styles, ".tick"), rule(styles, ".tick-end")])
    check("an app tile is 20 on a 6px corner", /width: 20px;/.test(rule(styles, ".app-icon,\n.app-letter")) && /border-radius: 6px;/.test(rule(styles, ".app-icon,\n.app-letter")), rule(styles, ".app-icon,\n.app-letter"))
    check("the tool dropdown is MiMo's own recipe, glass on a half-pixel edge under --shadow-composer", /background: var\(--surface-glass\);/.test(rule(styles, ".menu.tool")) && /border: 0\.5px solid var\(--border-input\);/.test(rule(styles, ".menu.tool")) && /box-shadow: var\(--shadow-composer\);/.test(rule(styles, ".menu.tool")), rule(styles, ".menu.tool"))

    const select = code(await read("src/renderer/src/components/SelectMenu.vue"))
    const pop = rule(select.slice(select.indexOf("<style")), ".select-pop")
    check("the select popup is the menu glass under --shadow-menu, as MiMo's settings select is", /background: var\(--surface-glass\);/.test(pop) && /box-shadow: var\(--shadow-menu\);/.test(pop), pop)
    check("its rows are written in --color-txt", /color: var\(--text-body\);/.test(rule(select.slice(select.indexOf("<style")), ".select-pop .item")), rule(select.slice(select.indexOf("<style")), ".select-pop .item"))
  }
}
