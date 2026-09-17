/**
 * Generates every platform icon from one full-bleed square source.
 *
 * The source is authored the way a modern macOS icon wants it: a square canvas
 * with sharp corners, its background baked in, and no drop shadow - the system
 * supplies the shape, the shadow, and the material. Legacy containers (.icns
 * and .ico) still expect the rounded shape baked into the pixels, so the
 * superellipse mask is applied here on the way out.
 *
 * That is also why the unmasked square is emitted alongside them: it is the
 * asset Icon Composer takes for a layered icon, and it cannot be recovered
 * from a masked one.
 *
 * macOS gets its own cut (build/icon.icns and resources/app-icons-mac): the
 * rounded tile on Apple's icon grid, 824 of 1024 with a soft shadow below it,
 * so the Dock and Finder show it at the size of every other app. MiMo ships
 * such a cut too (its macOS artwork leaves about 9% on each side, measured);
 * this one is drawn from MCode's own icon.
 *
 * Run with: node scripts/icons.mjs            (everything)
 *           node scripts/icons.mjs --mac      (only the macOS cut)
 */
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import pngToIco from "png-to-ico"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, "..")
const SOURCE = path.join(root, "resources", "icon-source.png")
const OUT = path.join(root, "build")
const ICONSET = path.join(OUT, "icons")
const APP_ICONS = path.join(root, "resources", "app-icons")
const APP_ICONS_MAC = path.join(root, "resources", "app-icons-mac")

const MASTER = 1024

/**
 * Superellipse: |x|^n + |y|^n = 1. n≈5 gives the continuous-corner shape rather
 * than a circular-arc rounded rect. Rendered at 4x and downsampled so the curve
 * lands anti-aliased instead of stair-stepped.
 */
const SUPERELLIPSE_N = 5
const SUPERSAMPLE = 4

async function squircleMask(size) {
  const big = size * SUPERSAMPLE
  const mask = Buffer.alloc(big * big)
  const half = big / 2

  for (let y = 0; y < big; y++) {
    const ny = Math.abs((y + 0.5 - half) / half)
    const yTerm = Math.pow(ny, SUPERELLIPSE_N)
    for (let x = 0; x < big; x++) {
      const nx = Math.abs((x + 0.5 - half) / half)
      mask[y * big + x] = Math.pow(nx, SUPERELLIPSE_N) + yTerm <= 1 ? 255 : 0
    }
  }

  // Both of these matter. Without .raw() sharp encodes the result as an image
  // file; without the greyscale colourspace it widens the single channel to
  // three on output. Either one leaves the caller reading interleaved RGB as
  // alpha, which silently produces a garbage mask rather than an error.
  return sharp(mask, { raw: { width: big, height: big, channels: 1 } })
    .resize(size, size, { kernel: "lanczos3" })
    .toColourspace("b-w")
    .raw()
    .toBuffer()
}

/**
 * The ground the mark sits on.
 *
 * The source is authored on flat black, and on a black desktop that means the
 * icon has no edge at all - the mark floats and the shape it is supposed to sit
 * in is invisible. A diagonal gradient gives the square a lit corner and a dark
 * one, so its outline reads against black without the icon stopping being a
 * dark icon. The tint is the cool grey of the mark itself rather than a neutral
 * one, so the two belong to each other.
 */
const GROUND = `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER}" height="${MASTER}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#343842"/>
      <stop offset="0.55" stop-color="#16181d"/>
      <stop offset="1" stop-color="#08090b"/>
    </linearGradient>
  </defs>
  <rect width="${MASTER}" height="${MASTER}" fill="url(#g)"/>
</svg>`

/**
 * The square as authored, over that ground.
 *
 * `lighten` keeps whichever of the two is brighter at each pixel. The mark is
 * far lighter than any part of the gradient, so it survives untouched; the
 * background it was drawn on is black, so the gradient is what shows there.
 * Compositing the other way round, or with a normal blend, would have tinted
 * the mark as well.
 */
async function flatSquare() {
  const mark = await sharp(SOURCE)
    .resize(MASTER, MASTER, { fit: "cover", kernel: "lanczos3" })
    .png()
    .toBuffer()

  return sharp(Buffer.from(GROUND))
    .composite([{ input: mark, blend: "lighten" }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** The same square with the rounded shape written into the alpha channel. */
async function masked(square) {
  const mask = await squircleMask(MASTER)
  const flat = await sharp(square).removeAlpha().raw().toBuffer()
  const rgba = Buffer.alloc(MASTER * MASTER * 4)

  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    rgba[p] = flat[i * 3]
    rgba[p + 1] = flat[i * 3 + 1]
    rgba[p + 2] = flat[i * 3 + 2]
    rgba[p + 3] = mask[i]
  }

  return sharp(rgba, { raw: { width: MASTER, height: MASTER, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

async function png(base, size) {
  return sharp(base)
    .resize(size, size, { kernel: "lanczos3", fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/**
 * ICNS container: an 8-byte header, then one chunk per entry. Each chunk is a
 * 4-byte OSType, a 4-byte big-endian length that counts its own 8-byte header,
 * and the payload - modern readers accept PNG payloads directly.
 */
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32], // 16x16@2x
  ["ic12", 64], // 32x32@2x
  ["ic07", 128],
  ["ic13", 256], // 128x128@2x
  ["ic08", 256],
  ["ic14", 512], // 256x256@2x
  ["ic09", 512],
  ["ic10", 1024], // 512x512@2x
]

async function buildIcns(base) {
  const chunks = []
  for (const [type, size] of ICNS_TYPES) {
    const body = await png(base, size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, "ascii")
    header.writeUInt32BE(body.length + 8, 4)
    chunks.push(header, body)
  }
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write("icns", 0, 4, "ascii")
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

/* Apple's icon grid: the tile is 824 of 1024, centred, with a shadow falling below it. */
const MAC_TILE = 824 / 1024
const MAC_SHADOW = { blur: 12 / 1024, drop: 10 / 1024, alpha: 0.3 }

/** An image as RGBA pixels of the given side. */
async function rgba(input, side) {
  return sharp(input).resize(side, side, { kernel: "lanczos3" }).ensureAlpha().raw().toBuffer()
}

/**
 * The macOS cut of a rounded tile at `size`: the tile shrunk onto the grid
 * and laid over its own shadow, on a transparent square.
 */
async function macCut(tile, size) {
  const side = Math.round(size * MAC_TILE)
  const inset = Math.round((size - side) / 2)
  const pixels = await rgba(tile, side)
  const shadow = Buffer.alloc(side * side * 4)
  for (let i = 3; i < pixels.length; i += 4) shadow[i] = Math.round(pixels[i] * MAC_SHADOW.alpha)
  const pad = Math.ceil(size * MAC_SHADOW.blur * 3)
  const blurred = await sharp(shadow, { raw: { width: side, height: side, channels: 4 } })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .blur(Math.max(0.3, size * MAC_SHADOW.blur))
    .png()
    .toBuffer()
  const drop = Math.round(size * MAC_SHADOW.drop)
  const tileImage = await sharp(pixels, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer()
  // The shadow may reach past the square's edge; it is cut there, as Apple's own template is.
  // Two steps: sharp crops before it composites, whatever order the calls are written in.
  const padded = await sharp({ create: { width: size + 2 * pad, height: size + 2 * pad, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: blurred, left: inset, top: inset + drop }])
    .png()
    .toBuffer()
  const shadowLayer = await sharp(padded).extract({ left: pad, top: pad, width: size, height: size }).png().toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: shadowLayer }, { input: tileImage, left: inset, top: inset }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** The macOS cut: the master, the .icns, and each colourway the Settings gallery offers. */
async function writeMac(rounded) {
  console.log("writing icon.icns (macOS cut)")
  await fs.writeFile(path.join(OUT, "icon.icns"), await buildIcns(await macCut(rounded, MASTER)))
  await fs.mkdir(APP_ICONS_MAC, { recursive: true })
  const colourways = (await fs.readdir(APP_ICONS)).filter((name) => name.endsWith(".png")).sort()
  for (const name of colourways) {
    const source = path.join(APP_ICONS, name)
    const { width } = await sharp(source).metadata()
    await fs.writeFile(path.join(APP_ICONS_MAC, name), await macCut(source, width))
  }
  console.log(`  app-icons-mac/    ${colourways.length} colourways`)
}

async function main() {
  await fs.mkdir(ICONSET, { recursive: true })

  if (process.argv.includes("--mac")) {
    // Only the macOS cut, from the rounded icon already in build/.
    await writeMac(await fs.readFile(path.join(OUT, "icon.png")))
    return
  }

  const meta = await sharp(SOURCE).metadata()
  console.log(`source ${meta.width}x${meta.height}`)

  const square = await flatSquare()
  const rounded = await masked(square)

  // Unmasked, for Icon Composer and anywhere the system applies its own shape.
  await fs.writeFile(path.join(OUT, "icon-square.png"), square)
  await fs.writeFile(path.join(OUT, "icon.png"), rounded)

  console.log("writing PNG set")
  const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
  for (const size of SIZES) {
    await fs.writeFile(path.join(ICONSET, `${size}x${size}.png`), await png(rounded, size))
  }

  console.log("writing icon.ico")
  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const ico = await pngToIco(await Promise.all(icoSizes.map((size) => png(rounded, size))))
  await fs.writeFile(path.join(OUT, "icon.ico"), ico)

  await writeMac(rounded)

  const report = await Promise.all(
    ["icon.png", "icon-square.png", "icon.ico", "icon.icns"].map(async (name) => {
      const stat = await fs.stat(path.join(OUT, name))
      return `  ${name.padEnd(16)} ${(stat.size / 1024).toFixed(1)} KB`
    }),
  )
  console.log("done:")
  console.log(report.join("\n"))
  console.log(`  ${"icons/".padEnd(16)} ${SIZES.length} PNG sizes`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
