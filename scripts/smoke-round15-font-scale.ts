/**
 * Round 15, lane U3: the interface font size scales the type but not the boxes
 * built around it (U3-1 onwards). Kept apart from smoke.ts the way the earlier
 * rounds are; smoke.ts calls `roundFifteenFontScaleChecks` with its own check
 * and section.
 *
 * Appearance's interface font size runs 10 to 24 over a base of 14, so
 * `--ui-font-scale` reaches 24/14 and `--code-font-scale` 24/12
 * (lib/font-scale.ts). Every rule that multiplies its `font-size` by one of
 * them and then pins the `line-height` - or the `height` of the box holding
 * that line - in px stops the box growing while the glyphs keep going: the
 * line box ends up shorter than the text and an `overflow: hidden` cuts the
 * glyph tops and bottoms off. MiMo scales both
 * (`.type-body{font-size:var(--text-14);line-height:calc(22px * var(--ui-font-scale,1))}`),
 * so this checks that MCode does too.
 *
 * These are computed over the stylesheets rather than grepped for a phrase:
 * every rule in the renderer is parsed, the scaled ones are found by their
 * font-size, and each one's own line box is compared against the size its text
 * reaches at the top of the range. The same walk is what found the bug.
 *
 * What a window shows is measured instead by the lane's Electron probe
 * (`scratchpad/u3/probe.cjs` with `measure.js`), which opens the side column,
 * the home page, the composer's menus and all eleven settings pages at sizes
 * 14, 18, 21 and 24 in Chinese and German and asserts that no box clips its own
 * text, no text is drawn outside the box holding it, and no row overlaps the
 * next. Its size-14 geometry is compared element by element against the same
 * run before the change, which is how "nothing moved at the default size" is
 * established; that comparison needs two builds, so it cannot live here.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { fontScale } from "../src/renderer/src/lib/font-scale"

/** Appearance's own bounds for the two sizes (SettingsDialog's sliders). */
const UI = { base: 14, min: 10, max: 24 }
const CODE = { base: 12, min: 8, max: 24 }

type Rule = { file: string; line: number; selector: string; body: string }

/**
 * Boxes whose height was never about the text in them: a placeholder drawn
 * while a picture loads is a picture-sized hole, and its caption sits inside
 * with room to spare at any size.
 */
const NOT_TEXT_SIZED = new Set(["components/parts/LocalMedia.vue|.text .md-media-skeleton", "components/parts/SvgFileCard.vue|.text .md-svg-wait"])

/** Every declaration block in the renderer's styles, with where it came from. */
async function rules(root: string): Promise<Rule[]> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(vue|css)$/.test(entry.name)) files.push(full)
    }
  }
  await walk(path.join(root, "src/renderer/src"))
  files.sort()
  const out: Rule[] = []
  for (const file of files) {
    const source = await fs.readFile(file, "utf8")
    let from = 0
    if (file.endsWith(".vue")) {
      from = source.indexOf("<style")
      if (from < 0) continue
    }
    // Innermost blocks only: `[^{}]` cannot cross a brace, so an @media wrapper
    // never matches and the rules inside it do.
    const pattern = /([^{}]+)\{([^{}]*)\}/g
    pattern.lastIndex = from
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) {
      const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim()
      if (!selector || selector.startsWith("@")) continue
      out.push({
        file: path.relative(root, file).replace(/\\/g, "/").replace("src/renderer/src/", ""),
        line: source.slice(0, match.index).split("\n").length,
        selector: selector.replace(/\s+/g, " "),
        body: match[2],
      })
    }
  }
  return out
}

const scaledFont = (body: string) => /font-size:\s*calc\(\s*([\d.]+)px\s*\*\s*var\(--(ui|code)-font-scale,\s*1\)\s*\)/.exec(body)
const pinned = (body: string, property: string) => new RegExp(`(^|[;{\\s])${property}:\\s*([\\d.]+)px`).exec(body)
const where = (rule: Rule) => `${rule.file}:${rule.line} ${rule.selector}`

export async function roundFifteenFontScaleChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = process.cwd()
  const all = await rules(root)

  section("Round 15 (U3): the interface font size carries the boxes with it")

  // ------------------------------------------------------------------ U3-1
  {
    /*
     * The size the slider reaches, and the identity at the default. A rule
     * written as `calc(Npx * var(--ui-font-scale, 1))` is exactly Npx at the
     * default size, which is what keeps the scaled rules pixel-identical to
     * what they replaced.
     */
    check("U3-1: the default interface size is the identity on both scales", fontScale(UI.base, UI.base, UI.min, UI.max) === 1 && fontScale(CODE.base, CODE.base, CODE.min, CODE.max) === 1)
    check("U3-1: the interface scale reaches 24/14 and the code scale 24/12", fontScale(30, UI.base, UI.min, UI.max) === UI.max / UI.base && fontScale(30, CODE.base, CODE.min, CODE.max) === CODE.max / CODE.base)

    const scaled = all.filter((rule) => scaledFont(rule.body))
    check("U3-1: the renderer has a body of rules that scale their font size", scaled.length > 100, scaled.length)

    /*
     * The glyph box of text of size S is about 1.2 S in the interface faces;
     * a line box shorter than that is already cutting into it. Measured at the
     * top of the slider, which is where a user can actually put it.
     */
    const short = scaled
      .map((rule) => {
        const font = scaledFont(rule.body)
        if (!font) return null
        const height = pinned(rule.body, "line-height")
        if (!height) return null
        const scale = font[2] === "ui" ? UI.max / UI.base : CODE.max / CODE.base
        return { rule, glyphs: Number(font[1]) * scale * 1.2, box: Number(height[2]) }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry.box < entry.glyphs)
    check("U3-1: no rule scales its font size onto a line box pinned in pixels", short.length === 0, short.slice(0, 8).map((entry) => `${where(entry.rule)} ${entry.box}px line under ${entry.glyphs.toFixed(1)}px of glyphs`))
  }

  // ------------------------------------------------------------------ U3-2
  {
    /*
     * The same for the box around the line: `.ctl-btn` was 28 tall with the
     * label at 14, so at the top of the slider a 38.4px line was being drawn
     * into 28px of button and `overflow: hidden` took ten pixels off it.
     */
    const pinnedBoxes = all.filter((rule) => scaledFont(rule.body) && pinned(rule.body, "height") && !NOT_TEXT_SIZED.has(`${rule.file}|${rule.selector}`))
    check("U3-2: no box sized around scaled text keeps a height pinned in pixels", pinnedBoxes.length === 0, pinnedBoxes.slice(0, 8).map(where))

    /*
     * A square badge scales in both directions, or the letter in it would be
     * round-cornered out of a box that stayed the same width.
     */
    const lopsided = all.filter((rule) => {
      const font = scaledFont(rule.body)
      if (!font) return false
      const height = /(^|[;{\s])height:\s*calc\(\s*([\d.]+)px\s*\*\s*var\(--(ui|code)-font-scale/.exec(rule.body)
      const width = /(^|[;{\s])width:\s*([\d.]+)px(?!\s*\*)/.exec(rule.body)
      return Boolean(height && width && width[2] === height[2])
    })
    check("U3-2: a square badge around scaled text scales both of its sides", lopsided.length === 0, lopsided.map(where))
  }

  // ------------------------------------------------------------------ U3-3
  {
    /*
     * The other direction: a px line-height left anywhere in the renderer is
     * only sound if the type in that rule does not scale either. Everything
     * else inherits the scaled body size and pins the line under it.
     */
    const stray = all.filter((rule) => {
      if (scaledFont(rule.body)) return false
      if (!pinned(rule.body, "line-height")) return false
      return !/font-size:\s*[\d.]+px/.test(rule.body)
    })
    check("U3-3: every line box still written in pixels belongs to type that does not scale", stray.length === 0, stray.map(where))
  }

  // ------------------------------------------------------------------ U3-4
  {
    /*
     * The rules the review named, by the shape they have to have. Each one was
     * measured clipping its own text: the navigation labels vanished under the
     * page beside them, `.ctl-btn` lost ten pixels top and bottom, and in the
     * conversation the side column's rows, the home suggestions and the
     * composer's menu items had their descenders sliced off.
     */
    const named: [string, string, string][] = [
      ["SettingsDialog.vue", ".line-title", "line-height"],
      ["SettingsDialog.vue", ".line-sub", "line-height"],
      ["SettingsDialog.vue", ".ctl-btn", "height"],
      ["SettingsDialog.vue", ".nav-item", "line-height"],
      ["SettingsDialog.vue", ".tag", "line-height"],
      ["Sidebar.vue", ".row-label", "line-height"],
      ["Sidebar.vue", ".task-label", "line-height"],
      ["HomeHero.vue", ".sug", "line-height"],
      ["Composer.vue", ".item-name", "line-height"],
      ["Composer.vue", ".staged-sub", "line-height"],
      ["SessionHero.vue", ".chip-name", "line-height"],
      ["SessionHeader.vue", ".open-with", "height"],
    ]
    const missing = named.filter(([file, selector, property]) => {
      const matches = all.filter((rule) => rule.file.endsWith(file) && rule.selector === selector)
      if (!matches.length) return true
      return !matches.some((rule) => new RegExp(`(^|[;{\\s])(min-)?${property}:\\s*calc\\([\\d.]+px \\* var\\(--(ui|code)-font-scale, 1\\)\\)`).test(rule.body))
    })
    check("U3-4: every rule the review measured clipping its text now scales the box too", missing.length === 0, missing.map((entry) => entry.join(" ")))
  }

  // ------------------------------------------------------------------ U3-5
  {
    /*
     * The settings navigation is a fixed 241 wide inside a fixed-width dialog,
     * so its labels cannot simply get longer. They wrap, a word that cannot
     * wrap breaks, the column clips whatever is still over - and a wrapped
     * label makes its row taller rather than spilling out of it.
     *
     * `overflow-x: clip` and not `hidden`: `hidden` on one axis turns a
     * `visible` other axis into `auto`, which would make the column a scroller
     * and take scrollbar width off every row at the default size.
     */
    const dialog = await fs.readFile(path.join(root, "src/renderer/src/components/SettingsDialog.vue"), "utf8")
    const nav = all.filter((rule) => rule.file.endsWith("SettingsDialog.vue") && rule.selector === ".nav")
    check("U3-5: the navigation column clips sideways without becoming a scroller", nav.some((rule) => /overflow-x:\s*clip/.test(rule.body)) && !nav.some((rule) => /overflow(-y)?:\s*(hidden|auto|scroll)/.test(rule.body)), nav.map((rule) => rule.body.match(/overflow[^;]*/g)))
    const rows = all.filter((rule) => rule.file.endsWith("SettingsDialog.vue") && [".nav-item", ".nav-group", ".nav-title"].includes(rule.selector))
    check("U3-5: every navigation row states a minimum height, never a fixed one", rows.length >= 5 && rows.every((rule) => !pinned(rule.body, "height") && !/(^|[;{\s])height:\s*calc/.test(rule.body)), rows.filter((rule) => /(^|[;{\s])height:/.test(rule.body)).map(where))
    check("U3-5: a navigation label too long for the column breaks instead of being drawn over the page", /\.nav-item \{[^}]*overflow-wrap: anywhere/s.test(dialog))
  }

  // ------------------------------------------------------------------ U3-6
  {
    /*
     * Nothing may move at the default size, so every scaled length has to be
     * written so that a scale of 1 is the identity - `calc(Npx * var(--x, 1))`
     * and not a ratio, a clamp or a min().
     */
    const forms = all.flatMap((rule) => (rule.body.match(/(?<![\w-])(?:line-height|min-height|height|width):[^;]*var\(--(?:ui|code)-font-scale[^;]*/g) ?? []).map((text) => ({ rule, text })))
    const odd = forms.filter((entry) => !/^(line-height|min-height|height|width):\s*calc\([\d.]+px \* var\(--(ui|code)-font-scale, 1\)\)$/.test(entry.text.trim()))
    check("U3-6: every scaled box length is a plain multiple, so the default size is unchanged", odd.length === 0, odd.slice(0, 6).map((entry) => `${where(entry.rule)} -> ${entry.text.trim()}`))
    check("U3-6: the change reaches the whole renderer, not one component", new Set(forms.map((entry) => entry.rule.file)).size > 25, new Set(forms.map((entry) => entry.rule.file)).size)
  }
}
