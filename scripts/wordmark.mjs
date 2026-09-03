/*
 * Builds the two wordmark assets from their source renders.
 *
 * The artwork exists in two colourways - light glyphs for dark backgrounds and
 * dark glyphs for light ones - and the two source renders are framed slightly
 * differently (their trimmed aspects differ by ~2%). Emitting them as-is would
 * make the mark jump when the theme changes, because the CSS constrains width
 * and lets height follow. So both are trimmed to their glyphs, scaled to one
 * width, then padded to a shared canvas: identical box, identical glyph scale,
 * no reflow on theme switch.
 */
import sharp from "sharp"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const WIDTH = 1200

const TARGETS = [
  { source: "resources/wordmark-source.png", out: "wordmark-dark.png", label: "dark theme" },
  { source: "resources/wordmark-light-source.png", out: "wordmark-light.png", label: "light theme" },
]

const trimmed = []
for (const target of TARGETS) {
  // threshold 1 so the faint anti-aliased edge is kept, not shaved off.
  const buffer = await sharp(join(root, target.source))
    .trim({ threshold: 1 })
    .resize({ width: WIDTH })
    .png()
    .toBuffer()
  const { height } = await sharp(buffer).metadata()
  trimmed.push({ ...target, buffer, height })
}

const canvas = Math.max(...trimmed.map((entry) => entry.height))

for (const entry of trimmed) {
  const pad = canvas - entry.height
  const top = Math.floor(pad / 2)
  const file = join(root, "src/renderer/src/assets", entry.out)
  await sharp(entry.buffer)
    .extend({
      top,
      bottom: pad - top,
      left: 0,
      right: 0,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(file)
  console.log(`${entry.out.padEnd(20)} ${WIDTH}x${canvas}  (${entry.label}, padded ${pad}px)`)
}
