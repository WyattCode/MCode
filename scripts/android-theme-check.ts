/**
 * Checks the Android theme's colour pairs for the two faults that keep repeating.
 *
 * The pad has two themes drawn from constants, and the failures have not been in
 * the drawing code - they have been in the constants themselves:
 *
 *   `DarkToolWhat = Color(0xFF5C5C57)` - byte for byte what the light `ToolWhat`
 *   holds, so every tool row in dark drew at (92,92,87) on a (20,20,20) page,
 *   2.74:1, and the comment directly above it already said (151,149,142). Found
 *   by sampling pixels; five of these so far.
 *
 *   `LocalMuted.current.copy(alpha = 0.75f)` - the token is fine and the alpha is
 *   what crosses the floor, on light only. Not this script's business; that is
 *   what `scripts/contrast-check.cjs` reads off a screenshot.
 *
 * So this covers what source can prove without a device: a `Dark*` constant that
 * is identical to its light twin cannot be right, and a text-bearing constant has
 * to clear 4.5:1 against the page it is drawn on.
 *
 * What it cannot see: a colour passed through a CompositionLocal, or an alpha
 * applied at the call site. Both need the pixels.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, "..")
const files = [
  path.join(root, "android/app/src/main/java/com/mcode/remote/MainActivity.kt"),
  path.join(root, "android/app/src/main/java/com/mcode/remote/RemoteChrome.kt"),
]

const problems: string[] = []

/** `private val Name = Color(0xFFRRGGBB)` and `const val Name: Long = 0xFFRRGGBB`. */
function constantsOf(source: string, file: string) {
  const found: { name: string; value: number; line: number; file: string }[] = []
  source.split("\n").forEach((line, i) => {
    const a = /^\s*(?:private )?val (\w+) = Color\((0x[0-9A-Fa-f]{8})\)/.exec(line)
    const b = /^\s*const val (\w+):\s*Long = (0xFF[0-9A-Fa-f]{6})\b/.exec(line)
    const hit = a ?? b
    if (hit) found.push({ name: hit[1], value: Number(hit[2]), line: i + 1, file })
  })
  return found
}

const all = files.flatMap((f) => constantsOf(fs.readFileSync(f, "utf8"), path.basename(f)))

/** WCAG relative luminance of a 0xAARRGGBB value, ignoring alpha. */
function luminance(argb: number) {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const r = channel((argb >> 16) & 0xff)
  const g = channel((argb >> 8) & 0xff)
  const b = channel(argb & 0xff)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a: number, b: number) {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

const byName = new Map(all.map((c) => [c.name, c]))

// 1. A dark constant equal to its light twin.
for (const dark of all.filter((c) => c.name.startsWith("Dark"))) {
  const light = byName.get(dark.name.slice(4))
  if (!light) continue
  if (light.value === dark.value) {
    problems.push(
      `${dark.file}:${dark.line}  ${dark.name} is identical to ${light.name} ` +
        `(0x${dark.value.toString(16).toUpperCase()}) - a dark value that matches ` +
        `the light one is almost always a copy-paste, and draws light ink on the dark page`,
    )
  }
}

// 2. Text-bearing constants under 4.5:1 on their own page.
const page = byName.get("Cream")?.value
const darkPage = byName.get("DarkBg")?.value
if (page === undefined || darkPage === undefined) {
  problems.push("could not find Cream / DarkBg, so the contrast pass was skipped")
} else {
  /*
   * The ones that carry words, and whose name says which page they belong to.
   *
   * Only `Dark` as a *prefix* marks a dark-theme value; `AccentDark`,
   * `CodeInkDark` and `SheetLinkLight` use those words for a variant or a
   * purpose, and guessing from the suffix picks the wrong ground and reports
   * nonsense. Anything that is neither prefixed `Dark` nor plainly a light-page
   * name is skipped rather than guessed at - a check that cries wolf gets
   * switched off.
   *
   * Paired inks come first: `DiffAddFg` is drawn on `DiffAddBg`, not on the page,
   * and judging it against the page understates it - 3.38 by that reading,
   * 2.60 as drawn. The pairing is by the name with `Fg` swapped for `Bg`.
   */
  const TEXT = /Ink|Text|Muted|What|Summary|Fg/i
  for (const c of all) {
    if (!TEXT.test(c.name)) continue
    if (/Bg|Line|Pill|Field|Surface|Divider|Bar|Dark$|Light$/.test(c.name)) continue
    const isDark = c.name.startsWith("Dark")
    const pageGround = isDark ? darkPage : page
    /*
     * A paired ground only when the name actually changes. `Ink` has no `Fg` to
     * swap, so `replace` hands back the same name, and pairing with itself
     * reported nine constants at 1.00:1 against their own colour.
     */
    const pairName = c.name.endsWith("Fg") ? c.name.slice(0, -2) + "Bg" : ""
    const paired = pairName ? byName.get(pairName) : undefined
    const ground = paired ? paired.value : pageGround
    const r = ratio(c.value, ground)
    if (r < 4.5) {
      const on = paired ? pairName : isDark ? "DarkBg" : "Cream"
      problems.push(
        `${c.file}:${c.line}  ${c.name} is ${r.toFixed(2)}:1 on ${on} - ` +
          `below 4.5:1 for text`,
      )
    }
  }
}

// 3. Inline colours in a live branch that have no dark twin.
/*
 * The one that got away. 「已连接」 was drawn `if (live) Color(0xFF296118)` inline -
 * no constant to inspect, so nothing above saw it. That green is 7.40:1 on cream
 * and 2.47:1 on the dark page, which made the connected state fainter than the
 * disconnected one on the same row.
 *
 * Scanning every literal would flood the output with diff washes and brand marks
 * that are deliberately one value in both themes. What is worth flagging is a
 * literal that appears once, in a `live`/`enabled`/`running`-ish branch, with no
 * `dark` test near it. Those are the state colours, and they are the ones that
 * carry meaning a reader has to see.
 */
for (const file of files) {
  const source = fs.readFileSync(file, "utf8")
  const lines = source.split("\n")
  lines.forEach((line, i) => {
    if (!/\bif \((?:live|enabled|on|ok|running|connected)\b/.test(line)) return
    const inline = /Color\((0x[0-9A-Fa-f]{8})\)/.exec(line)
    if (!inline) return
    // A theme test on the same line, or a named pair, is fine.
    if (/DarkBg|dark\b|if \(dark\)/.test(line)) return
    const value = Number(inline[1])
    const onCream = ratio(value, byName.get("Cream")!.value)
    const onDark = ratio(value, byName.get("DarkBg")!.value)
    // Only a problem when it reads on one page and not the other.
    if (Math.min(onCream, onDark) < 4.5 && Math.max(onCream, onDark) >= 4.5) {
      problems.push(
        `${path.basename(file)}:${i + 1}  inline ${inline[1]} in a state branch has no theme twin: ` +
          `${onCream.toFixed(2)}:1 on Cream, ${onDark.toFixed(2)}:1 on DarkBg`,
      )
    }
  })
}

if (problems.length) {
  console.error(`${problems.length} problem(s) in the Android palette:\n`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

console.log(`android palette: ${all.length} constants, no light-in-dark twins, all text over 4.5:1`)