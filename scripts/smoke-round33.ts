/**
 * Round 33: the new mark (2026-09-27), and its icons on both platforms.
 *
 * Every icon file is generated from resources/icon-source.png by
 * scripts/icons.mjs; these checks read what the script wrote, so a change to
 * either that loses part of the mark, a size, a colourway or the macOS 26+
 * package fails here.
 *
 * smoke.ts calls `roundThirtyThreeChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import type { Check } from "./smoke-round5"
import { APP_ICONS, DEFAULT_APP_ICON } from "../src/shared/app-icons"

const root = process.cwd()
const at = (...parts: string[]) => path.join(root, ...parts)
const exists = (file: string) => fs.access(file).then(() => true, () => false)

/** One pixel of a PNG, as RGBA. */
async function pixel(file: string | Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * 4
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]
}

/** The share of the image's width the dark paint of the mark spans. */
async function markWidth(file: string): Promise<number> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let min = info.width
  let max = -1
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4
      if (data[i + 3]! > 200 && data[i]! < 120) {
        min = Math.min(min, x)
        max = Math.max(max, x)
      }
    }
  }
  return max < 0 ? 0 : (max - min + 1) / info.width
}

export async function roundThirtyThreeChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 33: the new mark, lifted off its ground")
  {
    const source = await sharp(at("resources", "icon-source.png")).metadata()
    check("the source is the painted square", source.width === source.height && (source.width ?? 0) >= 1024, source)
    const mark = at("build", "icon-mark.png")
    check("the mark is kept on transparency", await exists(mark))
    const corner = await pixel(mark, 4, 4)
    check("its ground is gone", corner[3] === 0, corner)
    // The silver fold, the lightest paint in the mark, at the middle of the ribbon: opaque, and still silver.
    const fold = await pixel(mark, 522, 539)
    check("the silver fold stays opaque, not unmixed with the white around it", fold[3] === 255 && fold[0]! > 180, fold)
    const body = await pixel(mark, 780, 560)
    check("and the body stays dark", body[3] === 255 && body[0]! < 80, body)
  }

  section("Round 33: Windows and Linux")
  {
    const ico = await fs.readFile(at("build", "icon.ico"))
    const count = ico.readUInt16LE(4)
    const sizes = Array.from({ length: count }, (_, n) => ico[6 + n * 16] || 256).sort((a, b) => a - b)
    check("the .ico carries 16 to 256", sizes.join(",") === "16,24,32,48,64,128,256", sizes)
    const tile = await pixel(at("build", "icon.png"), 512, 60)
    check("the tile is the light one the painting was made on", tile[3] === 255 && tile[0]! > 235 && tile[2]! > 235, tile)
    const small = await markWidth(at("build", "icons", "32x32.png"))
    const large = await markWidth(at("build", "icons", "64x64.png"))
    check("at 32 pixels and below the mark is drawn larger on the tile", small > large * 1.08, { small, large })
  }

  section("Round 33: macOS 26 and 27")
  {
    const builder = await fs.readFile(at("electron-builder.yml"), "utf8")
    const mac = builder.slice(builder.indexOf("\nmac:"), builder.indexOf("\ndmg:"))
    check("the app's icon is the Icon Composer package", /\n  icon: build\/icon\.icon\n/.test(mac), mac.slice(0, 400))
    check("the disk image keeps the .icns", /\ndmg:\n(?:\s*#.*\n)*\s*icon: build\/icon\.icns/.test(builder))
    const manifest = JSON.parse(await fs.readFile(at("build", "icon.icon", "icon.json"), "utf8")) as Record<string, unknown>
    const groups = manifest.groups as { layers: { "image-name-specializations"?: { appearance?: string; value: string }[] }[]; translucency?: { enabled: boolean } }[]
    const images = groups.flatMap((group) => group.layers.flatMap((layer) => (layer["image-name-specializations"] ?? []).map((entry) => entry.value)))
    check("every image it names is in its Assets", images.length === 2 && (await Promise.all(images.map((name) => exists(at("build", "icon.icon", "Assets", name))))).every(Boolean), images)
    for (const name of images) {
      const meta = await sharp(at("build", "icon.icon", "Assets", name)).metadata()
      check(`${name} is a 1024 canvas with alpha, as Icon Composer's is`, meta.width === 1024 && meta.height === 1024 && meta.hasAlpha === true, meta)
    }
    const fills = manifest["fill-specializations"] as { appearance?: string }[]
    check("it has a dark appearance of its own", fills.some((entry) => entry.appearance === "dark") && groups[0]!.layers[0]!["image-name-specializations"]!.some((entry) => entry.appearance === "dark"))
    const darkMark = await pixel(at("build", "icon.icon", "Assets", "mark-dark.png"), 780, 560)
    check("whose mark is light, so it does not sink into the dark ground", darkMark[0]! > 200, darkMark)
    check("the painting stays opaque under the glass", groups[0]!.translucency?.enabled === false)
    check("it is a square icon for every platform", JSON.stringify(manifest["supported-platforms"]) === '{"squares":"shared"}')
  }

  section("Round 33: every colourway, on both platforms")
  {
    check("Classic is still the default", DEFAULT_APP_ICON === "classic" && APP_ICONS[0]!.id === "classic")
    for (const icon of APP_ICONS) {
      const full = await sharp(at("resources", "app-icons", `${icon.id}.png`)).metadata().catch(() => undefined)
      const dock = await sharp(at("resources", "app-icons-mac", `${icon.id}.png`)).metadata().catch(() => undefined)
      check(`${icon.name} has its tile and its Dock cut`, full?.width === 512 && dock?.width === 512, { full: full?.width, dock: dock?.width })
    }
    const classic = await fs.readFile(at("resources", "app-icons", "classic.png"))
    const graphite = await fs.readFile(at("resources", "app-icons", "graphite.png"))
    check("the colourways are different pictures, not copies of Classic", !classic.equals(graphite))
  }

  section("Round 33: the menu bar mark")
  {
    for (const [name, size] of [
      ["trayTemplate.png", 16],
      ["trayTemplate@2x.png", 32],
    ] as const) {
      const { data, info } = await sharp(at("resources", "tray", name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let coloured = 0
      const alphas = new Set<number>()
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]! > 0 && (data[i]! > 0 || data[i + 1]! > 0 || data[i + 2]! > 0)) coloured++
        if (data[i + 3]! > 0) alphas.add(data[i + 3]!)
      }
      check(`${name} is a ${size}-point template: black over transparency`, info.width === size && info.height === size && coloured === 0, { width: info.width, coloured })
      /*
       * Inside the shape, not on its rim: a pixel whose every neighbour is
       * painted, yet itself only partly opaque, is the fold. Anti-aliasing
       * alone gives partial alpha only at the edge, so a solid silhouette has
       * none of these.
       */
      const alpha = (x: number, y: number) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : data[(y * size + x) * 4 + 3]!)
      let fold = 0
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const own = alpha(x, y)
          const surrounded = [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => alpha(x + dx, y + dy) > 60))
          if (surrounded && own > 40 && own < 200) fold++
        }
      }
      check(`${name} leaves the fold partly see-through`, fold >= Math.round(size / 4), { fold, alphas: alphas.size })
      // Centred: as much empty above the mark as below it, give or take the pixel rounding leaves.
      const rows = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => alpha(x, y)).some((value) => value > 0))
      const top = rows.indexOf(true)
      const bottom = size - 1 - rows.lastIndexOf(true)
      check(`${name} sits in the middle of its cell`, Math.abs(top - bottom) <= 1, { top, bottom })
    }
  }
}
