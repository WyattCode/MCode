/**
 * Draws the monochrome tray image macOS asks for, from build/icon.png.
 *
 * A macOS menu bar icon is a template image: the system ignores its colour and
 * paints the alpha channel itself, dark on a light bar and light on a dark one,
 * so the artwork has to be one flat colour over transparency rather than the
 * colourway the reader picked. MiMo ships the same thing under the same name
 * (`trayTemplate.png`, `setTemplateImage(true)`); this is MCode's own mark.
 *
 * The mark is taken from build/icon.png - the same artwork the app icon and the
 * Dock use - rather than redrawn, so the tray cannot drift from it. On that
 * drawing the ribbon is light over a dark tile, so its luminance becomes the
 * alpha the menu bar paints: below the floor is background and drops out, above
 * the ceiling is the mark, with a ramp between for the soft edges.
 *
 * Run with: node scripts/tray-icon.mjs
 */
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = path.join(root, "build", "icon.png")
const OUT = path.join(root, "resources", "tray")

/* The mark at 11pt tall - a touch smaller than the bar's own ~13pt glyphs, which
   is what reads as level beside them; the @2x file is what a Retina bar shows.
   The mark is wider than tall, so its height is what the bar fixes. */
const SIZES = [
  { name: "trayTemplate.png", height: 11 },
  { name: "trayTemplate@2x.png", height: 22 },
]

/* Luminance to alpha: the light ribbon is the mark, the dark ground drops out.
   A tight ramp keeps the strokes crisp at menu-bar size, where a soft edge is
   what turns the mark into a smudge. */
const FLOOR = 70
const CEIL = 110

async function mask() {
  const { data, info } = await sharp(SOURCE).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const lumAt = (i) => (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000

  /* The mark's own bounds, so the bar cell is filled rather than a padded square. */
  let minX = width
  let minY = height
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (lumAt((y * width + x) * channels) > CEIL - 10) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const pad = 8
  const x0 = Math.max(0, minX - pad)
  const y0 = Math.max(0, minY - pad)
  const w = Math.min(width - 1, maxX + pad) - x0 + 1
  const h = Math.min(height - 1, maxY + pad) - y0 + 1

  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lum = lumAt(((y0 + y) * width + (x0 + x)) * channels)
      let a = Math.round(((lum - FLOOR) / (CEIL - FLOOR)) * 255)
      a = Math.max(0, Math.min(255, a))
      const o = (y * w + x) * 4
      out[o] = 0
      out[o + 1] = 0
      out[o + 2] = 0
      out[o + 3] = a
    }
  }
  return { image: sharp(out, { raw: { width: w, height: h, channels: 4 } }), w, h }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const { image, w, h } = await mask()
  console.log(`  mark ${w}x${h}`)
  for (const { name, height } of SIZES) {
    const png = await image
      .clone()
      .resize({ height, fit: "contain" })
      .png()
      .toBuffer()
    await fs.writeFile(path.join(OUT, name), png)
    console.log(`  ${name.padEnd(22)} h${height}  ${(png.length / 1024).toFixed(1)} KB`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})