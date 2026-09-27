/*
 * Builds the two wordmark assets from the app's mark.
 *
 * The wordmark is the folded M standing in for the letter M, followed by
 * "Code" in Segoe UI Bold: the M exactly as tall as the capital C and sitting
 * on the same line, 22% of its height apart (a tenth, then 16%, read as
 * crowded - the user's call). It exists in two colourways
 * rather than being tinted - graphite glyphs for the light theme, the mark's
 * silver cut (its Icon Composer dark appearance) with silver glyphs for the
 * dark one - and both are laid on one shared canvas, so the mark does not move
 * when the theme changes.
 *
 * It reads what scripts/icons.mjs writes (build/icon-mark.png and the dark
 * mark in build/icon.icon), so run that first. "Code" is set in Segoe UI,
 * which ships with Windows; on a machine without it the face falls back and
 * the check below refuses to write.
 *
 * Run with: node scripts/wordmark.mjs
 */
import sharp from "sharp"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const WIDTH = 1200
const FAMILY = "Segoe UI"
const WEIGHT = 700
/* The glyphs' fall, top to bottom with a slight lean, as the mark's own paint falls. */
const GLYPHS = {
  light: ["#4a4f57", "#0f1013"],
  dark: ["#f5f7fa", "#9aa2ad"],
}
const TARGETS = [
  { mark: "build/icon-mark.png", glyphs: GLYPHS.light, out: "wordmark-light.png", label: "light theme" },
  { mark: "build/icon.icon/Assets/mark-dark.png", glyphs: GLYPHS.dark, out: "wordmark-dark.png", label: "dark theme" },
]

/* The space between the M and the C, as a share of the M's height. */
export const GAP = 0.22

/* Big enough that the trim and the M's resize lose nothing before the final scale. */
const SIZE = 1000

function textSvg(text, paint, glyphs, family = FAMILY) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE * 4}" height="${SIZE * 1.6}"><defs>` +
      `<linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${glyphs[0]}"/><stop offset="1" stop-color="${glyphs[1]}"/></linearGradient></defs>` +
      `<text x="${SIZE * 0.2}" y="${SIZE * 1.2}" font-family="${family}" font-weight="${WEIGHT}" font-size="${SIZE}" fill="${paint}">${text}</text></svg>`,
  )
}

/** A text render trimmed to its ink, with where that ink started. */
async function ink(svg) {
  const { data, info } = await sharp(await sharp(svg).png().toBuffer()).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true })
  return { image: data, width: info.width, height: info.height, top: -info.trimOffsetTop }
}

/*
 * Whether the face is really there: a family the renderer cannot find is
 * drawn in its fallback, which is the same picture a made-up name gives. A
 * wordmark in the fallback would be the wrong wordmark rather than a slightly
 * different one, so the script stops instead.
 */
async function faceInstalled() {
  const render = (family) => sharp(textSvg("Code", "#000", GLYPHS.light, family)).raw().toBuffer()
  const [wanted, fallback] = await Promise.all([render(FAMILY), render("No Such Face Anywhere")])
  return !wanted.equals(fallback)
}

async function wordmark(target) {
  const word = await ink(textSvg("Code", "url(#g)", target.glyphs))
  const cap = await ink(textSvg("C", "#000", target.glyphs))
  const mark = sharp(await sharp(join(root, target.mark)).trim({ threshold: 1 }).png().toBuffer())
  const meta = await mark.metadata()
  // The M is the C's height, on the C's line.
  const markHeight = cap.height
  const markWidth = Math.round((meta.width * markHeight) / meta.height)
  const markImage = await mark.resize(markWidth, markHeight, { kernel: "lanczos3" }).png().toBuffer()
  const gap = Math.round(markHeight * GAP)
  const capBottom = cap.top + cap.height - word.top
  const markTop = Math.max(0, capBottom - markHeight)
  const width = markWidth + gap + word.width
  const height = Math.max(word.height, markTop + markHeight)
  const composed = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: markImage, left: 0, top: markTop },
      { input: word.image, left: markWidth + gap, top: 0 },
    ])
    .png()
    .toBuffer()
  return sharp(composed).resize({ width: WIDTH, kernel: "lanczos3" }).png().toBuffer()
}

if (!(await faceInstalled())) throw new Error(`${FAMILY} is not installed here, so "Code" would be drawn in a fallback face; run this on Windows`)

const built = []
for (const target of TARGETS) {
  const buffer = await wordmark(target)
  const { height } = await sharp(buffer).metadata()
  built.push({ ...target, buffer, height })
}

// One canvas for both, so a theme change swaps the picture and not the layout.
const canvas = Math.max(...built.map((entry) => entry.height))
for (const entry of built) {
  const pad = canvas - entry.height
  const top = Math.floor(pad / 2)
  await sharp(entry.buffer)
    .extend({ top, bottom: pad - top, left: 0, right: 0, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(join(root, "src/renderer/src/assets", entry.out))
  console.log(`${entry.out.padEnd(20)} ${WIDTH}x${canvas}  (${entry.label}, padded ${pad}px)`)
}
