/*
 * Builds the two wordmark assets from the app's mark.
 *
 * The wordmark is the folded M standing in for the letter M, followed by
 * "Code" in Montserrat Bold (the user's choice, 2026-09-27): the M exactly as
 * tall as the capital C and sitting on the same line, 22% of its height apart
 * (a tenth, then 16%, read as crowded - the user's call). The letters are flat
 * ink - near-black for the light theme, a soft off-white for the dark one -
 * beside the mark's own painted cut and its silver cut (its Icon Composer dark
 * appearance). Both are laid on one shared canvas, so the mark does not move
 * when the theme changes.
 *
 * Chromium draws the letters (scripts/wordmark-render.cjs, started here with
 * Electron) from the font file in scripts/fonts, so the result is the same on
 * any machine; sharp inks them and lays them beside the mark. It reads what
 * scripts/icons.mjs writes (build/icon-mark.png and the dark mark in
 * build/icon.icon), so run that first.
 *
 * Run with: node scripts/wordmark.mjs
 */
import sharp from "sharp"
import fs from "node:fs"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const WIDTH = 1200
/* The space between the M and the C, as a share of the M's height. */
export const GAP = 0.22
const TARGETS = [
  { mark: "build/icon-mark.png", ink: [23, 24, 27], out: "wordmark-light.png", label: "light theme" },
  { mark: "build/icon.icon/Assets/mark-dark.png", ink: [242, 243, 245], out: "wordmark-dark.png", label: "dark theme" },
]

/*
 * Montserrat's "Code" and "C", white on black, rendered by Chromium into a
 * scratch folder. The renderer refuses when the face did not load: a wordmark
 * in a fallback face would be the wrong wordmark rather than a slightly
 * different one.
 */
function renderLetters() {
  const scratch = fs.mkdtempSync(join(os.tmpdir(), "mcode-wordmark-"))
  const electron = join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron")
  const run = spawnSync(electron, [join(root, "scripts", "wordmark-render.cjs"), scratch], { stdio: "ignore", windowsHide: true, timeout: 60_000 })
  const error = join(scratch, "error.txt")
  if (run.status !== 0 || fs.existsSync(error)) {
    const why = fs.existsSync(error) ? fs.readFileSync(error, "utf8") : `electron exited ${run.status}`
    fs.rmSync(scratch, { recursive: true, force: true })
    throw new Error(`the letters could not be rendered: ${why}`)
  }
  return { word: join(scratch, "word.png"), cap: join(scratch, "cap.png"), scratch }
}

/** A white-on-black render as flat ink on transparency, trimmed, with where its ink began. */
async function inked(file, ink) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true })
  const rgba = Buffer.alloc(info.width * info.height * 4)
  for (let i = 0; i < data.length; i++) {
    rgba[i * 4] = ink[0]
    rgba[i * 4 + 1] = ink[1]
    rgba[i * 4 + 2] = ink[2]
    rgba[i * 4 + 3] = data[i]
  }
  const { data: image, info: trimmed } = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim({ threshold: 1 })
    .png()
    .toBuffer({ resolveWithObject: true })
  return { image, width: trimmed.width, height: trimmed.height, top: -trimmed.trimOffsetTop }
}

async function wordmark(target, letters) {
  const word = await inked(letters.word, target.ink)
  const cap = await inked(letters.cap, target.ink)
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

const letters = renderLetters()
try {
  const built = []
  for (const target of TARGETS) {
    const buffer = await wordmark(target, letters)
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
} finally {
  fs.rmSync(letters.scratch, { recursive: true, force: true })
}
