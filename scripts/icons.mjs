/**
 * Generates every icon the app ships from one painted source.
 *
 * The source (resources/icon-source.png) is the mark as the designer painted
 * it: a folded M in graphite and silver, centred on a square of plain white.
 * Everything else is derived here, so the Windows icon, the macOS icon, each
 * colourway the Settings gallery offers and the menu bar mark cannot drift
 * from it or from each other:
 *
 * - The mark is lifted off its white ground (`extractMark`): the ground is
 *   found by flooding in from the edges, so the silver fold - lighter than
 *   anything else in the mark but far from white - stays opaque, and only the
 *   anti-aliased rim is unmixed from the white it was painted over.
 * - Classic lays the mark, untouched, on a white tile with the faint top-to-
 *   bottom fall of Apple's light fill; the other colourways lay it on their own
 *   ground with its shading remapped to their two inks.
 * - Windows and Linux (build/icon.ico, build/icon.png, build/icons/) take the
 *   rounded tile edge to edge: a white tile reads on the dark taskbar and on a
 *   light one, where the dark mark alone would vanish on the first.
 * - macOS follows the icon grid of macOS 26 and 27: a 1024 canvas with the
 *   rounded tile 824 wide in the middle and a soft shadow below
 *   (build/icon.icns, resources/app-icons-mac). The same tile in Icon Composer
 *   form (build/icon.icon) lets macOS 26 and later draw it with Liquid Glass
 *   and give it dark and tinted appearances; electron-builder compiles it with
 *   Xcode 26's actool when building on a Mac.
 * - The menu bar template (resources/tray) is the mark's own silhouette, with
 *   the fold left half-transparent so it still reads as a fold at 16 points.
 *
 * Run with: node scripts/icons.mjs
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
const ICON_COMPOSER = path.join(OUT, "icon.icon")
const APP_ICONS = path.join(root, "resources", "app-icons")
const APP_ICONS_MAC = path.join(root, "resources", "app-icons-mac")
const TRAY = path.join(root, "resources", "tray")

const MASTER = 1024

/*
 * The colourways the gallery offers, by the ids in src/shared/app-icons.ts.
 * `tile` is the ground, top to bottom. `ink` is what the mark's shading is
 * remapped to: the first colour takes the darkest paint (the body of the M),
 * the second the lightest (the silver of the fold). On a dark ground the body
 * becomes the light ink, so the mark is lit against it the way Classic's is
 * dark against white. Classic has no ink: it is the painting itself.
 */
export const COLOURWAYS = [
  { id: "classic", tile: ["#ffffff", "#e7e9ec"] },
  { id: "graphite", tile: ["#34373d", "#0f1013"], ink: ["#f3f5f8", "#7f8691"] },
  { id: "paper", tile: ["#fcf9f3", "#e8e1d3"], ink: ["#2a2926", "#cbc2b1"] },
  { id: "indigo", tile: ["#323d80", "#141a3c"], ink: ["#eef1ff", "#8a97dc"] },
  { id: "moss", tile: ["#2c4b37", "#0f1e17"], ink: ["#ebf5ed", "#7fb08c"] },
  { id: "clay", tile: ["#86412f", "#3d1b14"], ink: ["#fff0e8", "#dc9275"] },
  { id: "brass", tile: ["#2a251b", "#0c0a07"], ink: ["#f8e6b6", "#b5873a"] },
]

// ------------------------------------------------------------ the mark

/** Pixels of the mark's darkest body and lightest fold, measured on the source; the colourways' inks are stretched between them. */
const PAINT_DARK = 22
const PAINT_LIGHT = 222

/** Anything this close to white, reachable from the edge, is the ground rather than the mark. */
const GROUND_FLOOR = 236

/**
 * The mark on transparency, on the source's own canvas.
 *
 * Flood fill from the border through near-white pixels finds the ground. The
 * mark is everything else, opaque; the pixels on its rim are a blend of the
 * mark's edge with white, so each is unmixed ("colour to alpha" against the
 * ground) to the least alpha that explains it, and its colour recovered from
 * that. Unmixing the whole image instead would have made the silver fold
 * mostly transparent, since it is the lightest thing in the painting.
 */
async function extractMark() {
  const { data, info } = await sharp(SOURCE).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const count = width * height
  const pale = (i) => data[i * 3] >= GROUND_FLOOR && data[i * 3 + 1] >= GROUND_FLOOR && data[i * 3 + 2] >= GROUND_FLOOR
  const ground = new Uint8Array(count)
  const stack = []
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x)
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1)
  while (stack.length) {
    const i = stack.pop()
    if (ground[i] || !pale(i)) continue
    ground[i] = 1
    const x = i % width
    if (x > 0) stack.push(i - 1)
    if (x < width - 1) stack.push(i + 1)
    if (i >= width) stack.push(i - width)
    if (i < count - width) stack.push(i + width)
  }
  // The ground's own white, which the rim was blended with (the source's is 254, not 255).
  let white = 0
  let seen = 0
  for (let i = 0; i < count; i += 97) if (ground[i]) (white += data[i * 3]), seen++
  white = seen ? white / seen : 255

  const rgba = Buffer.alloc(count * 4)
  const touchesGround = (i) => {
    const x = i % width
    return (x > 0 && ground[i - 1]) || (x < width - 1 && ground[i + 1]) || (i >= width && ground[i - width]) || (i < count - width && ground[i + width])
  }
  for (let i = 0; i < count; i++) {
    const r = data[i * 3]
    const g = data[i * 3 + 1]
    const b = data[i * 3 + 2]
    let alpha = 0
    /*
     * A rim pixel's alpha: how far it is from white, against how far the
     * mark's own edge paint is. The edge is nowhere lighter than about 45% of
     * the way from white (the silver fold's rim), so that much distance counts
     * as fully opaque.
     */
    if (!ground[i]) alpha = touchesGround(i) ? Math.min(1, Math.max(white - r, white - g, white - b) / white / 0.55) : 1
    if (alpha <= 0) continue
    // The colour the rim pixel had before it was blended with white.
    const unmix = (c) => Math.max(0, Math.min(255, Math.round((c - (1 - alpha) * white) / alpha)))
    rgba[i * 4] = alpha === 1 ? r : unmix(r)
    rgba[i * 4 + 1] = alpha === 1 ? g : unmix(g)
    rgba[i * 4 + 2] = alpha === 1 ? b : unmix(b)
    rgba[i * 4 + 3] = Math.round(alpha * 255)
  }
  const resized = await sharp(rgba, { raw: { width, height, channels: 4 } }).resize(MASTER, MASTER, { kernel: "lanczos3" }).raw().toBuffer()
  /*
   * Lanczos rings at a hard edge: a pixel or two out from the mark it leaves
   * alpha of a few percent. Over a tile nobody sees it, but the menu bar
   * template is drawn from this alpha alone - the ringing came out as a row of
   * stray dots, and it widened the box the template is trimmed to, so the mark
   * sat off-centre. Anything that faint is ground.
   */
  for (let p = 3; p < resized.length; p += 4) if (resized[p] < 12) resized[p - 3] = resized[p - 2] = resized[p - 1] = resized[p] = 0
  return sharp(resized, { raw: { width: MASTER, height: MASTER, channels: 4 } }).png().toBuffer()
}

const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16))

/** The mark with its shading remapped to two inks, keeping its alpha. */
async function inked(mark, ink) {
  if (!ink) return mark
  const { data, info } = await sharp(mark).raw().toBuffer({ resolveWithObject: true })
  const [from, to] = ink.map(hex)
  const out = Buffer.from(data)
  for (let p = 0; p < data.length; p += 4) {
    if (!data[p + 3]) continue
    const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]
    const t = Math.min(1, Math.max(0, (lum - PAINT_DARK) / (PAINT_LIGHT - PAINT_DARK)))
    for (let c = 0; c < 3; c++) out[p + c] = Math.round(from[c] + (to[c] - from[c]) * t)
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}

// ------------------------------------------------------------ tiles

/* Superellipse |x|^n + |y|^n = 1 with n = 5: the continuous-corner shape, rendered at 4x and brought down anti-aliased. */
const SUPERELLIPSE_N = 5
const SUPERSAMPLE = 4

async function squircleMask(size) {
  const big = size * SUPERSAMPLE
  const mask = Buffer.alloc(big * big)
  const half = big / 2
  for (let y = 0; y < big; y++) {
    const yTerm = Math.pow(Math.abs((y + 0.5 - half) / half), SUPERELLIPSE_N)
    for (let x = 0; x < big; x++) {
      mask[y * big + x] = Math.pow(Math.abs((x + 0.5 - half) / half), SUPERELLIPSE_N) + yTerm <= 1 ? 255 : 0
    }
  }
  // .raw() and the greyscale colourspace both matter: without either, sharp hands back something other than one byte of alpha per pixel.
  return sharp(mask, { raw: { width: big, height: big, channels: 1 } }).resize(size, size, { kernel: "lanczos3" }).toColourspace("b-w").raw().toBuffer()
}

/** A colourway's ground: its two colours falling from top to bottom, as Apple's light and dark fills do. */
function ground(tile) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER}" height="${MASTER}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${tile[0]}"/><stop offset="1" stop-color="${tile[1]}"/></linearGradient></defs>` +
      `<rect width="${MASTER}" height="${MASTER}" fill="url(#g)"/></svg>`,
  )
}

/*
 * Windows' small sizes - title bar, taskbar, file lists at 16 to 32 pixels -
 * take the mark 15% larger on the same tile. At the painted proportion it is
 * 71% of the tile's width, which reads well from 48 up and leaves a speck at
 * 16. Its corners stay inside the rounded tile at this size. macOS draws its
 * small sizes from the grid itself and keeps the painted proportion.
 */
const SMALL_SIZES = 32
const SMALL_SCALE = 1.15

/** The mark grown about the canvas centre, still on a 1024 canvas. */
async function enlarged(mark, factor) {
  const side = Math.round(MASTER * factor)
  const inset = Math.round((side - MASTER) / 2)
  return sharp(mark).resize(side, side, { kernel: "lanczos3" }).extract({ left: inset, top: inset, width: MASTER, height: MASTER }).png().toBuffer()
}

/** The colourway's full square: its ground with its mark over it, no shape cut yet. */
async function square(mark, way) {
  return sharp(ground(way.tile))
    .composite([{ input: await inked(mark, way.ink) }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** The square with the rounded tile written into its alpha. */
async function rounded(flat, mask) {
  const pixels = await sharp(flat).removeAlpha().raw().toBuffer()
  const rgba = Buffer.alloc(MASTER * MASTER * 4)
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    rgba[p] = pixels[i * 3]
    rgba[p + 1] = pixels[i * 3 + 1]
    rgba[p + 2] = pixels[i * 3 + 2]
    rgba[p + 3] = mask[i]
  }
  return sharp(rgba, { raw: { width: MASTER, height: MASTER, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer()
}

async function png(base, size) {
  return sharp(base).resize(size, size, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer()
}

// ------------------------------------------------------------ macOS

/* Apple's icon grid (unchanged in macOS 26 and 27): the tile is 824 of 1024, centred, with a shadow falling below it. */
const MAC_TILE = 824 / 1024
const MAC_SHADOW = { blur: 12 / 1024, drop: 10 / 1024, alpha: 0.3 }

/** The macOS cut of a rounded tile at `size`: the tile shrunk onto the grid and laid over its own shadow, on a transparent square. */
async function macCut(tile, size) {
  const side = Math.round(size * MAC_TILE)
  const inset = Math.round((size - side) / 2)
  const pixels = await sharp(tile).resize(side, side, { kernel: "lanczos3" }).ensureAlpha().raw().toBuffer()
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
  // The shadow may reach past the square's edge and is cut there, as Apple's own template is. Two steps: sharp crops before it composites.
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

/**
 * ICNS: an 8-byte header, then one chunk per entry - a 4-byte OSType, a 4-byte
 * big-endian length counting its own header, and a PNG payload.
 */
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
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

/** A colour as Icon Composer writes it. */
const composerColour = (value) => `extended-srgb:${hex(value).map((c) => (c / 255).toFixed(5)).join(",")},1.00000`

/**
 * The Icon Composer package (macOS 26+). Its canvas is the tile itself, 1024
 * points, which the system shapes and places on the grid; so the mark goes in
 * as painted on the square, and the ground is the package's fill rather than
 * pixels. In the dark appearance the ground turns to Graphite's and the mark
 * to its light ink, so it does not sink into the dark; tinted is left to the
 * system, which works from luminance.
 */
async function writeIconComposer(mark) {
  const classic = COLOURWAYS.find((way) => way.id === "classic")
  const graphite = COLOURWAYS.find((way) => way.id === "graphite")
  await fs.rm(ICON_COMPOSER, { recursive: true, force: true })
  await fs.mkdir(path.join(ICON_COMPOSER, "Assets"), { recursive: true })
  await fs.writeFile(path.join(ICON_COMPOSER, "Assets", "mark.png"), mark)
  await fs.writeFile(path.join(ICON_COMPOSER, "Assets", "mark-dark.png"), await inked(mark, graphite.ink))
  const gradient = (tile) => ({ "linear-gradient": tile.map(composerColour), orientation: { start: { x: 0.5, y: 0 }, stop: { x: 0.5, y: 1 } } })
  const manifest = {
    "fill-specializations": [{ value: gradient(classic.tile) }, { appearance: "dark", value: gradient(graphite.tile) }],
    groups: [
      {
        name: "Mark",
        layers: [
          {
            name: "mark",
            "image-name-specializations": [{ value: "mark.png" }, { appearance: "dark", value: "mark-dark.png" }],
            glass: true,
          },
        ],
        // The painted shading is the mark's own; Liquid Glass adds its edge and light without turning it translucent.
        lighting: "combined",
        specular: true,
        shadow: { kind: "neutral", opacity: 0.5 },
        translucency: { enabled: false, value: 0.5 },
      },
    ],
    "supported-platforms": { squares: "shared" },
  }
  await fs.writeFile(path.join(ICON_COMPOSER, "icon.json"), JSON.stringify(manifest, null, 2) + "\n")
}

// ------------------------------------------------------------ menu bar

/*
 * The macOS menu bar template: black over transparency, the system paints it.
 * The body of the M is solid and the silver fold is left half-see-through, so
 * the fold still separates the two halves at 16 points. The mark is trimmed to
 * its own box first, since a template is drawn at the bar's height and any
 * empty margin is lost size.
 */
async function writeTray(mark) {
  const trimmed = await sharp(mark).trim({ threshold: 1 }).png().toBuffer()
  const { data, info } = await sharp(trimmed).raw().toBuffer({ resolveWithObject: true })
  const out = Buffer.alloc(data.length)
  for (let p = 0; p < data.length; p += 4) {
    const lum = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]
    const t = Math.min(1, Math.max(0, (lum - PAINT_DARK) / (PAINT_LIGHT - PAINT_DARK)))
    out[p + 3] = Math.round(data[p + 3] * (1 - 0.55 * t))
  }
  const silhouette = await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
  await fs.mkdir(TRAY, { recursive: true })
  for (const [name, size] of [
    ["trayTemplate.png", 16],
    ["trayTemplate@2x.png", 32],
  ]) {
    // Mitchell rather than Lanczos: a template shows every stray bit of alpha, and Lanczos rings.
    const image = await sharp(silhouette)
      .resize(size, size, { fit: "contain", kernel: "mitchell", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer()
    await fs.writeFile(path.join(TRAY, name), image)
  }
}

// ------------------------------------------------------------ all of it

async function main() {
  const meta = await sharp(SOURCE).metadata()
  console.log(`source ${meta.width}x${meta.height}`)
  const mark = await extractMark()
  const mask = await squircleMask(MASTER)
  await fs.mkdir(ICONSET, { recursive: true })
  await fs.mkdir(APP_ICONS, { recursive: true })
  await fs.mkdir(APP_ICONS_MAC, { recursive: true })

  for (const way of COLOURWAYS) {
    const flat = await square(mark, way)
    const tile = await rounded(flat, mask)
    await fs.writeFile(path.join(APP_ICONS, `${way.id}.png`), await png(tile, 512))
    await fs.writeFile(path.join(APP_ICONS_MAC, `${way.id}.png`), await macCut(tile, 512))
    if (way.id !== "classic") continue

    // Unmasked, for anywhere the system applies its own shape.
    await fs.writeFile(path.join(OUT, "icon-square.png"), flat)
    await fs.writeFile(path.join(OUT, "icon.png"), tile)
    const small = await rounded(await square(await enlarged(mark, SMALL_SCALE), way), mask)
    const sized = (size) => png(size <= SMALL_SIZES ? small : tile, size)
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) await fs.writeFile(path.join(ICONSET, `${size}x${size}.png`), await sized(size))
    await fs.writeFile(path.join(OUT, "icon.ico"), await pngToIco(await Promise.all([16, 24, 32, 48, 64, 128, 256].map(sized))))
    await fs.writeFile(path.join(OUT, "icon.icns"), await buildIcns(await macCut(tile, MASTER)))
  }
  await fs.writeFile(path.join(OUT, "icon-mark.png"), mark)
  await writeIconComposer(mark)
  await writeTray(mark)

  for (const name of ["icon.png", "icon-square.png", "icon-mark.png", "icon.ico", "icon.icns"]) {
    const stat = await fs.stat(path.join(OUT, name))
    console.log(`  ${name.padEnd(16)} ${(stat.size / 1024).toFixed(1)} KB`)
  }
  console.log(`  icon.icon/        Icon Composer package`)
  console.log(`  app-icons, app-icons-mac   ${COLOURWAYS.length} colourways`)
  console.log(`  tray/             menu bar template`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
