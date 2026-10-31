#!/usr/bin/env node
/*
 * Measure the contrast of every piece of text on a screen, from a screenshot and
 * its uiautomator dump.
 *
 * The device is a 400dpi pad in two themes, and the theme colours are drawn from
 * a handful of tokens that the light and dark pages use differently. Reading the
 * source tells you which token a line uses; only the pixels tell you what it
 * resolves to after a surface, a wash and an alpha have stacked on top of each
 * other. Twice now a line has passed review at 6:1 in dark and measured 3.7:1 in
 * light, because the alpha that was harmless on a #141414 page is what crosses
 * the floor on a #FFFEFD one.
 *
 * Usage:
 *   adb shell screencap -p /sdcard/c.png && adb pull /sdcard/c.png shot.png
 *   adb shell uiautomator dump /sdcard/c.xml && adb pull /sdcard/c.xml shot.xml
 *   node scripts/contrast-check.cjs shot.png shot.xml
 *
 * Exits 1 when anything lands under 4.5:1, so it can gate a change.
 */
const fs = require('fs')
const zlib = require('zlib')

/** Minimal PNG reader: 8-bit RGB or RGBA, no interlace, which is what screencap writes. */
function decodePng(path) {
  const buf = fs.readFileSync(path)
  let off = 8
  let width = 0
  let height = 0
  let colorType = 0
  const chunks = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.slice(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') {
      chunks.push(data)
    }
    off += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks))
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 255
    }
    cur.copy(pixels, y * stride)
    prev = cur
  }
  return { width, height, channels, pixels }
}

/** WCAG relative luminance. */
function luminance(r, g, b) {
  const lin = (v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function ratioOf(a, b) {
  const la = luminance(a[0], a[1], a[2])
  const lb = luminance(b[0], b[1], b[2])
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

function parseNodes(xmlPath) {
  const xml = fs.readFileSync(xmlPath, 'utf8')
  return [...xml.matchAll(/<node ([^>]*)\/?>/g)].map((m) => {
    const attrs = {}
    for (const kv of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[kv[1]] = kv[2]
    const b = attrs.bounds && attrs.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    attrs.box = b ? { l: +b[1], t: +b[2], r: +b[3], b: +b[4] } : null
    return attrs
  })
}

const [, , pngPath, xmlPath] = process.argv
if (!pngPath || !xmlPath) {
  console.error('usage: node scripts/contrast-check.cjs <screenshot.png> <dump.xml>')
  process.exit(2)
}

const img = decodePng(pngPath)
const { width, height, channels, pixels } = img
const px = (x, y) => {
  const o = (y * width + x) * channels
  return [pixels[o], pixels[o + 1], pixels[o + 2]]
}

const rows = []
for (const node of parseNodes(xmlPath)) {
  if (!node.text || node.text.trim().length < 2 || !node.box) continue
  const { l, t, r, b } = node.box
  if (r <= l || b <= t) continue
  /*
   * Skip boxes too short to hold a line.
   *
   * Compose's semantics tree sometimes reports the same text twice with the
   * bounds interleaved - on the Artifacts header, "Artifacts" came back as
   * y 131..146 and again as 146..206, and the burger and the search field did
   * the same. Only the 60-tall pair is what is drawn; the 15-tall ones are
   * artefacts of measurement, and sampling one lands on empty page between the
   * glyphs, which reads as ink == ground and reports 1.00:1 on text that is
   * perfectly visible.
   *
   * A real line of 11sp at this density is about 34px, so anything under 20
   * cannot be type.
   */
  if (b - t < 20) continue

  // The ink is whichever extreme inside the box is furthest from the page behind
  // it - text darker than its ground in light, lighter in dark, and both cases
  // fall out of the same comparison.
  let brightest = -1
  let darkest = 2
  let brightRgb = null
  let darkRgb = null
  for (let y = Math.max(0, t); y < Math.min(height, b); y += 2) {
    for (let x = Math.max(0, l); x < Math.min(width, r); x += 2) {
      const rgb = px(x, y)
      const L = luminance(rgb[0], rgb[1], rgb[2])
      if (L > brightest) { brightest = L; brightRgb = rgb }
      if (L < darkest) { darkest = L; darkRgb = rgb }
    }
  }

  // The ground: just outside the box, on the text's own baseline.
  const bgX = Math.min(width - 1, r + 8)
  const bgY = Math.min(height - 1, Math.round((t + b) / 2))
  const bg = px(bgX, bgY)
  const bgL = luminance(bg[0], bg[1], bg[2])

  const useBright = Math.abs(brightest - bgL) > Math.abs(darkest - bgL)
  const ink = useBright ? brightRgb : darkRgb
  const ratio = ratioOf(ink, bg)

  rows.push({ text: node.text, y: t, ink, bg, ratio })
}

rows.sort((a, b) => a.ratio - b.ratio)

console.log('元素'.padEnd(28) + '前景'.padStart(14) + '背景'.padStart(14) + '对比度'.padStart(9))
for (const row of rows) {
  const mark = row.ratio < 3 ? '  << 低于 3' : row.ratio < 4.5 ? '  < 低于 4.5' : ''
  console.log(
    (row.text.slice(0, 12) + ' @y' + row.y).padEnd(28) +
      ('(' + row.ink.join(',') + ')').padStart(14) +
      ('(' + row.bg.join(',') + ')').padStart(14) +
      row.ratio.toFixed(2).padStart(9) +
      mark,
  )
}

const failures = rows.filter((r) => r.ratio < 4.5)
console.log()
console.log(`${rows.length} 个文本元素，${failures.length} 个低于 4.5:1`)
if (failures.length) process.exit(1)