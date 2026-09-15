/**
 * Checks the theme engine against the stylesheet it was reverse-engineered from.
 *
 * The app's own colours were written out by hand before the engine existed, and
 * they were taken from the reference's OC-2 theme. So OC-2 run through the
 * engine has to land on exactly those values - any drift means the port of the
 * colour arithmetic is wrong, and every other theme is wrong with it.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { themeTokens } from "../src/renderer/src/lib/theme-engine"
import { THEMES, themeByID } from "../src/renderer/src/lib/theme-palettes"

const here = path.dirname(fileURLToPath(import.meta.url))
const css = fs.readFileSync(path.join(here, "../src/renderer/src/styles/tokens.css"), "utf8")

/** Reads one theme block out of the stylesheet, as name -> value. */
function block(selector: string) {
  const start = css.indexOf(selector)
  if (start === -1) throw new Error(`no ${selector} block in tokens.css`)
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
  const out: Record<string, string> = {}
  for (const line of css.slice(open, end).split("\n")) {
    const match = /^\s*(--[a-z0-9-]+):\s*(.+);\s*$/.exec(line)
    if (match) out[match[1]] = match[2].trim()
  }
  return out
}

const problems: string[] = []
const oc2 = themeByID("oc-2")

for (const [scheme, selector] of [
  ["dark", ':root[data-theme="dark"]'],
  ["light", ":root {"],
] as const) {
  const written = block(selector)
  const generated = themeTokens(oc2, scheme === "dark")
  for (const [name, value] of Object.entries(generated)) {
    const expected = written[name]
    if (!expected) continue // a token the stylesheet leaves to the engine alone
    if (expected.toLowerCase() !== value.toLowerCase()) {
      problems.push(`${scheme} ${name}: engine ${value}, stylesheet ${expected}`)
    }
  }
}

// Every theme has to produce a usable colour for every token in both schemes:
// a palette with a missing seed would otherwise surface as an undefined that
// only shows up as an unstyled corner of the window.
const hex = /^#[0-9a-f]{6}$/i
const alpha = /^#[0-9a-f]{8}$/i
for (const theme of THEMES) {
  for (const isDark of [true, false]) {
    const tokens = themeTokens(theme, isDark)
    for (const [name, value] of Object.entries(tokens)) {
      if (!hex.test(value) && !alpha.test(value)) {
        problems.push(`${theme.id} ${isDark ? "dark" : "light"} ${name}: ${value}`)
      }
    }
  }
}

/*
 * A dialog that uses the overlay class without defining it.
 *
 * Scoped styles cannot be shared between components, so every dialog that marks
 * its backdrop "scrim" has to carry the rule itself. One that does not still
 * renders, still opens and still closes - it just stops being an overlay, and
 * becomes a block sitting in the page wherever it happened to be mounted, with
 * nothing dimmed behind it and nothing centred. Two shipped that way.
 */
const componentDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/renderer/src/components")
for (const file of fs.readdirSync(componentDir).filter((name) => name.endsWith(".vue"))) {
  const source = fs.readFileSync(path.join(componentDir, file), "utf8")
  if (!source.includes('class="scrim"')) continue
  const styles = source.slice(source.indexOf("<style"))
  if (!/^\.scrim\s*[,{]/m.test(styles)) {
    problems.push(`${file}: uses the scrim class but never defines it`)
  }
}

/*
 * Physical properties in an interface that mirrors.
 *
 * Arabic sets dir="rtl" on the document, and every rule written with padding-inline
 * or inset-inline-start follows it. One written with padding-left does not: it
 * stays where it was while everything around it swaps sides, which reads as one
 * control having come loose rather than as a layout that has not been mirrored.
 * The rule has been stated in every brief on this project and nothing enforced
 * it - so it held only for as long as everyone remembered.
 *
 * `left` and `right` themselves are not listed. They are almost always used here
 * to pin both edges of an absolutely positioned element, or with width: 100% to
 * span it, and both of those are identical under mirroring. What is asymmetric
 * by nature is padding, margin, border and text alignment.
 */
const PHYSICAL = /^\s*(padding-(?:left|right)|margin-(?:left|right)|border-(?:left|right)|text-align\s*:\s*(?:left|right))\b/

/*
 * The exceptions, each of which is physical on purpose.
 *
 * The title bar's are not the app's decision: Windows paints its caption buttons
 * at one end and reports where, and macOS puts its traffic lights on the left
 * whatever the language - so the room reserved for them has to be reserved on
 * the side the platform actually used.
 */
const PHYSICAL_ALLOWED = new Set<string>([])

// parts/ as well as components/ - a message part is as mirrored as a dialog is.
const styledFiles = [
  ...fs.readdirSync(componentDir).filter((name) => name.endsWith(".vue")).map((name) => path.join(componentDir, name)),
  ...fs
    .readdirSync(path.join(componentDir, "parts"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".vue"))
    .map((entry) => path.join(componentDir, "parts", entry.name)),
]

for (const full of styledFiles) {
  const file = path.basename(full)
  const source = fs.readFileSync(full, "utf8")
  const styles = source.slice(source.indexOf("<style"))
  if (!styles) continue
  for (const line of styles.split("\n")) {
    const found = PHYSICAL.exec(line)
    if (!found) continue
    const property = found[1].split(":")[0].trim()
    if (PHYSICAL_ALLOWED.has(`${file}:${property}`)) continue
    problems.push(`${file}: ${line.trim()} - use the logical property, the interface mirrors`)
  }
}

/*
 * The sixteen colours a program's own output is painted in.
 *
 * These are checked here rather than at runtime because the terminal is drawn
 * on a canvas by a WebGL renderer: nothing about the colours reaches the DOM,
 * and the Terminal instance is module-local in a production build, so there is
 * no way to read back what xterm resolved. What can be asserted is that the
 * table is complete and spelled the way xterm's ITheme expects - a misspelled
 * key is not an error, it is silently ignored, which is exactly the failure
 * that would leave a build tool's red looking like xterm's red instead of the
 * reference's.
 */
const ANSI_SLOTS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
]

/*
 * MiMo has two tables - its own light set, and xterm's defaults written out for
 * dark - and they live in lib/terminal.ts so the smoke test can read them. Each
 * must be complete and spread into the palette, and the pane must use that palette.
 */
{
  const libFile = path.join(componentDir, "..", "lib", "terminal.ts")
  const lib = fs.readFileSync(libFile, "utf8")
  for (const name of ["ANSI_LIGHT", "ANSI_DARK"]) {
    const from = lib.indexOf(`export const ${name} = {`)
    const table = from === -1 ? "" : lib.slice(from, lib.indexOf("} as const", from))
    if (!table) {
      problems.push(`lib/terminal.ts: no ${name} table, so the terminal falls back to xterm's own colours`)
      continue
    }
    for (const slot of ANSI_SLOTS) {
      if (!new RegExp(`\\b${slot}:\\s*"#[0-9a-fA-F]{6}"`).test(table)) {
        problems.push(`lib/terminal.ts: ${name} has no ${slot}, which xterm would fill from its own palette`)
      }
    }
    // Handed to xterm, not merely declared.
    if (!new RegExp(`\\.\\.\\.${name}\\b`).test(lib)) {
      problems.push(`lib/terminal.ts: ${name} is never spread into the theme xterm is given`)
    }
  }
  const pane = fs.readFileSync(path.join(componentDir, "TerminalPane.vue"), "utf8")
  if (!/theme:\s*palette\(\)/.test(pane) || !/terminalPalette\(/.test(pane)) {
    problems.push("TerminalPane.vue: xterm is not given lib/terminal.ts's palette")
  }
}

/*
 * A focus ring marks an element. It must not restyle it.
 *
 * The global `:focus-visible` rule used to set `border-radius`, which does not
 * round the ring - an outline already follows whatever radius the element
 * declares - it rounds the element, for as long as it has focus. Every one of
 * the 27 focusable controls surveyed across this app had a radius other than
 * the 4px that rule forced, so taking focus visibly reshaped all of them.
 *
 * The same trap is open to `:hover` and `:active`. Revealing a *child* on
 * hover is a different thing and stays allowed - this looks only at rules
 * whose own selector ends in the state, so `.row:hover .slot { width }` is not
 * caught while `.row:hover { width }` is.
 */
{
  const GEOMETRY = ["border-radius", "padding", "border-width", "font-size"]
  const files: string[] = []
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(here, "..", relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (next.endsWith(".vue") || next.endsWith(".css")) files.push(next)
    }
  }
  walk("src/renderer/src")

  const STATE = /:(hover|focus-visible|focus|active)\s*(,|\{|$)/
  /*
   * Plain string work, no regex. The first attempt built this with
   * `new RegExp(\`^\s*...\`)` - inside a template literal the backslash is
   * eaten, so the pattern became `^s*...` and required the line to start with
   * a literal "s". It matched nothing, and the check passed on the defect it
   * was written for. Twice.
   */
  const declares = (line: string) => {
    const text = line.trim()
    return GEOMETRY.find((property) => text.startsWith(property) && text.slice(property.length).trimStart().startsWith(":"))
  }

  /*
   * Line by line rather than by matching `selector { body }`. A block regex has
   * to assume no brace appears in a comment, and this file's comments do -
   * which silently misaligned every block after the first and made the check
   * pass on the very defect it was written for.
   */
  for (const file of files) {
    const lines = fs.readFileSync(path.join(here, "..", file), "utf8").split(String.fromCharCode(10))
    let selector: string | undefined
    for (const line of lines) {
      const text = line.trim()
      if (text.endsWith("{")) {
        const head = text.slice(0, -1).trim()
        // Only the element carrying the state, not a descendant of it: a
        // trailing state pseudo-class on one of the comma-separated parts.
        selector = head.split(",").some((one) => STATE.test(one.trim() + "{")) ? head : undefined
        continue
      }
      if (text.startsWith("}")) {
        selector = undefined
        continue
      }
      if (!selector) continue
      const property = declares(line)
      if (property) {
        problems.push(`${file}: \`${selector}\` changes ${property}, which reshapes the element it is marking`)
      }
    }
  }
}


/*
 * Two scoped-style selectors that Vue compiles into something else entirely.
 * `:global(X) .y` becomes a bare `X`, so the rule lands on html, :root or the
 * dock instead of the element (the diff-marks setting once hid the window).
 * A selector ending in `:is(...)` or `:where(...)` gets its scope attribute on
 * the wrong compound, so a dark variant written that way never applies.
 */
function scopedBlocks(source: string): string[] {
  return [...source.matchAll(/<style[^>]*\bscoped\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1])
}
function walkVue(directory: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) walkVue(full, out)
    else if (entry.name.endsWith(".vue")) out.push(full)
  }
  return out
}
for (const file of walkVue(path.join(componentDir, ".."))) {
  const name = path.relative(path.join(componentDir, ".."), file)
  for (const block of scopedBlocks(fs.readFileSync(file, "utf8"))) {
    for (const match of block.matchAll(/:global\([^{}]*?\)\s+[.#\[a-zA-Z:*>]/g)) {
      problems.push(`${name}: \`${match[0].trim()}\` in a scoped style compiles to the bare :global selector - write it as a plain scoped selector`)
    }
    for (const match of block.matchAll(/(?:^|[},\n])\s*([^{}]*?\s:(?:is|where)\([^{}]*\))\s*\{/g)) {
      problems.push(`${name}: \`${match[1].trim()}\` ends in :is()/:where(), which the scope attribute misses - list the selectors instead`)
    }
  }
}

console.log(`themes: ${THEMES.length}, tokens each: ${Object.keys(themeTokens(oc2, true)).length}`)
if (problems.length) {
  console.error(`FAILED with ${problems.length} problem(s):`)
  for (const problem of problems.slice(0, 40)) console.error("  " + problem)
  process.exit(1)
}
console.log("OC-2 regenerates tokens.css exactly, and every theme resolves.")
