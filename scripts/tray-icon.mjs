/**
 * Draws the monochrome tray image macOS asks for, from MCode's own mark.
 *
 * A macOS menu bar icon is a template image: the system ignores its colour and
 * paints the alpha channel itself, dark on a light bar and light on a dark one,
 * so the artwork has to be one flat colour over transparency rather than the
 * colourway the reader picked. MiMo ships the same thing under the same name
 * (`trayTemplate.png`, `setTemplateImage(true)`); this is MCode's own ribbon M,
 * not MiMo's artwork.
 *
 * The ribbon path is read out of src/shared/app-icons.ts rather than copied, so
 * the tray mark cannot drift from the one the gallery and the app icons draw.
 * Windows and Linux keep the coloured icon, as MiMo keeps its own per platform.
 *
 * Run with: node scripts/tray-icon.mjs
 */
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = path.join(root, "src", "shared", "app-icons.ts")
const OUT = path.join(root, "resources", "tray")

/* The menu bar draws 16pt; the @2x file is what a Retina bar actually shows. */
const SIZES = [
  { name: "trayTemplate.png", size: 16 },
  { name: "trayTemplate@2x.png", size: 32 },
]

/** The ribbon, taken from the shared source so there is only ever one copy of it. */
async function ribbon() {
  const source = await fs.readFile(SOURCE, "utf8")
  const found = /const RIBBON = "([^"]+)"/.exec(source)
  if (!found) throw new Error("src/shared/app-icons.ts no longer declares RIBBON, which this script draws")
  return found[1]
}

/*
 * The mark alone, with no tile behind it: a template image is judged by its
 * alpha, so a filled rectangle would paint the whole menu bar cell solid. The
 * stroke is a little heavier than the app icon's, because 16px of menu bar is
 * where a thin stroke disappears, and the 120 box is inset so the round caps
 * are not clipped by the edge.
 */
function markup(path2, size) {
  return Buffer.from(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="-6 -6 132 132">`,
      `<path d="${path2}" fill="none" stroke="#000000" stroke-width="17"`,
      ` stroke-linecap="round" stroke-linejoin="round"/>`,
      `</svg>`,
    ].join(""),
  )
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const path2 = await ribbon()
  for (const { name, size } of SIZES) {
    /* density so the vector is rasterised at the target size rather than scaled up from 96dpi. */
    const png = await sharp(markup(path2, size), { density: (72 * size) / 16 })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    await fs.writeFile(path.join(OUT, name), png)
    console.log(`  ${name.padEnd(22)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
