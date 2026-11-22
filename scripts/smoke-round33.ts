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
import { macIdentityArgs } from "./mac-identity.mjs"

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
async function markWidth(file: string | Buffer): Promise<number> {
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
    check("the .ico carries every size Windows draws, 20 and 40 among them", sizes.join(",") === "16,20,24,32,40,48,64,128,256", sizes)
    const tile = await pixel(at("build", "icon.png"), 512, 60)
    check("the tile is the light one the painting was made on", tile[3] === 255 && tile[0]! > 235 && tile[2]! > 235, tile)
    const small = await markWidth(at("build", "icons", "32x32.png"))
    const large = await markWidth(at("build", "icons", "64x64.png"))
    // Larger, but not to the edge: the user found 25% larger too tight a rim.
    check("at 32 pixels and below the mark is drawn a little larger on the tile", small > large * 1.04 && small < large * 1.2, { small, large })
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

  section("Round 33: the Mac signing identity, so the keychain can remember it")
  {
    /* Ad-hoc signing (what a Mac with no certificate falls back to) gives the login keychain
     * nothing to recognise across builds, so `MCode Safe Storage` asks for the login password
     * again after every install - and an upgrade that nobody is standing at the machine to
     * authorise is stuck at the splash. The package command therefore names a stable local
     * identity when the keychain has one, and says out loud when it has to go ad-hoc. */
    const listed = (name: string) => `  1) 0123456789ABCDEF0123456789ABCDEF01234567 "${name}"\n     1 valid identities found\n`
    const chosen = macIdentityArgs({ findIdentityOutput: listed("MCode Local") })
    check("a Mac package names the signing identity the keychain has", chosen.args.join(" ") === "--config.mac.identity=MCode Local", chosen)
    check("Certificate Assistant's doubled spelling counts as that identity",
      macIdentityArgs({ findIdentityOutput: listed("MCode Local (MCode Local)") }).identity === "MCode Local")
    check("a certificate that merely contains the name is not it",
      macIdentityArgs({ findIdentityOutput: listed("MCode Local Backup") }).identity === null)
    check("a name that only appears outside an identity line is not usable either",
      macIdentityArgs({ findIdentityOutput: 'note "MCode Local"\n' }).identity === null)
    const adhoc = macIdentityArgs({ findIdentityOutput: "     0 valid identities found\n" })
    check("with no such identity nothing extra is passed, so a bare Mac still packages", adhoc.args.length === 0 && adhoc.identity === null, adhoc)
    check("and the build says what going ad-hoc costs", /ad-hoc/i.test(adhoc.notice) && /keychain/i.test(adhoc.notice), adhoc.notice)
    check("another machine can name its own certificate instead",
      macIdentityArgs({ findIdentityOutput: listed("Wyatt Dev"), env: { MCODE_MAC_IDENTITY: "Wyatt Dev" } }).identity === "Wyatt Dev")
    const script = await fs.readFile(at("scripts", "package.mjs"), "utf8")
    check("the Mac path is the one that asks, and every other system is handed an empty argument list",
      /import \{ macIdentityArgs \} from "\.\/mac-identity\.mjs"/.test(script)
        && /target === "darwin" \? macIdentityArgs[\s\S]*?: \{ args: \[\], notice: "" \}/.test(script))
    check("the identity reaches electron-builder ahead of the caller's own flags",
      /run\("npx", \["electron-builder", "--publish", "never", \.\.\.signing\.args, \.\.\.flags\]\)/.test(script))
    check("nothing here turns on publishing", script.includes('"--publish", "never"') && !/--config\.mac\.notarize/.test(script))
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

  section("Round 33: the wordmark, the new M then Code")
  {
    const light = at("src", "renderer", "src", "assets", "wordmark-light.png")
    const dark = at("src", "renderer", "src", "assets", "wordmark-dark.png")
    const [lightMeta, darkMeta] = await Promise.all([sharp(light).metadata(), sharp(dark).metadata()])
    check("both themes share one canvas, so a theme change does not move it", lightMeta.width === darkMeta.width && lightMeta.height === darkMeta.height, { light: [lightMeta.width, lightMeta.height], dark: [darkMeta.width, darkMeta.height] })
    const ratio = (lightMeta.width ?? 0) / (lightMeta.height ?? 1)
    // Montserrat's wide round letters: Segoe UI's narrower "Code" came out near 4.44.
    check("it is the M-and-Code line in Montserrat's proportions", ratio > 4.6 && ratio < 5, ratio)
    /** The mean colour of a strip's painted pixels: the C, a little past the M. */
    const ink = async (file: string) => {
      const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      let sum = 0
      let count = 0
      for (let y = 0; y < info.height; y++) {
        for (let x = Math.round(info.width * 0.36); x < Math.round(info.width * 0.52); x++) {
          const i = (y * info.width + x) * 4
          if (data[i + 3]! > 250) (sum += data[i]!), count++
        }
      }
      return count ? sum / count : -1
    }
    const [lightInk, darkInk] = await Promise.all([ink(light), ink(dark)])
    // Flat ink, not the old gradient glyphs: near-black by day, off-white by night.
    check("the light theme's letters are flat near-black and the dark theme's flat off-white", lightInk >= 0 && lightInk < 35 && darkInk > 230, { lightInk, darkInk })
    const renderer = await fs.readFile(at("scripts", "wordmark-render.cjs"), "utf8")
    check("the face ships with the script, with its licence", (await exists(at("scripts", "fonts", "montserrat-latin-700-normal.woff2"))) && (await exists(at("scripts", "fonts", "Montserrat-OFL.txt"))) && /montserrat-latin-700-normal\.woff2/.test(renderer))
    check("the renderer refuses to draw in a fallback face", /document\.fonts\.load\("700 /.test(renderer) && /if \(!loaded\) throw/.test(renderer))
    // The space between the M and the C: the empty columns in the band of rows the M fills.
    {
      const { data, info } = await sharp(light).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const painted = (x: number) => {
        for (let y = 0; y < info.height; y++) if (data[(y * info.width + x) * 4 + 3]! > 40) return true
        return false
      }
      let x = 0
      while (x < info.width && !painted(x)) x++
      while (x < info.width && painted(x)) x++
      const gapStart = x
      while (x < info.width && !painted(x)) x++
      const gap = x - gapStart
      let top = info.height
      let bottom = 0
      for (let column = 0; column < gapStart; column++) {
        for (let y = 0; y < info.height; y++) {
          if (data[(y * info.width + column) * 4 + 3]! > 40) {
            top = Math.min(top, y)
            bottom = Math.max(bottom, y)
          }
        }
      }
      const share = gap / (bottom - top + 1)
      check("the M and the C stand about a fifth of the M's height apart", share > 0.2 && share < 0.25, { gap, markHeight: bottom - top + 1, share })
    }
    check("the old ribbon sources are gone", !(await exists(at("resources", "wordmark-source.png"))) && !(await exists(at("resources", "wordmark-light-source.png"))))
  }

  section("Round 34: the window's own icon on Windows, and the Dock on macOS")
  {
    for (const icon of APP_ICONS) {
      const ico = await fs.readFile(at("resources", "app-icons", `${icon.id}.ico`)).catch(() => undefined)
      const sizes = ico ? Array.from({ length: ico.readUInt16LE(4) }, (_, n) => ico[6 + n * 16] || 256).sort((a, b) => a - b) : []
      check(`${icon.name}'s window icon carries every size the taskbar and title bar draw`, sizes.join(",") === "16,20,24,32,40,48,64,128,256", sizes)
    }
    const main = await fs.readFile(at("src", "main", "index.ts"), "utf8")
    const handler = main.slice(main.indexOf('ipcMain.handle("mcode:app-icon"'), main.indexOf('ipcMain.handle("mcode:app-icon"') + 2400)
    check("Windows sets the colourway's .ico on the window, not the 512 PNG", /process\.platform === "win32" \? windowIcoFile\(id\)/.test(handler) && /window\.setIcon\(windowImage\.isEmpty\(\) \? image : windowImage\)/.test(handler), handler.slice(0, 300))
    check("macOS leaves the Dock to the bundle's Liquid Glass icon until a colourway is chosen", /if \(id === DEFAULT_APP_ICON && !dockCustomised\) return \{ ok: true \}/.test(handler) && /dockCustomised = true/.test(handler))
  }

  section("Round 33: the Windows tray, sharp at every scaling")
  {
    for (const icon of APP_ICONS) {
      const file = at("resources", "tray", `${icon.id}.ico`)
      const ico = await fs.readFile(file).catch(() => undefined)
      const sizes = ico ? Array.from({ length: ico.readUInt16LE(4) }, (_, n) => ico[6 + n * 16] || 256).sort((a, b) => a - b) : []
      check(`${icon.name}'s tray icon is drawn for each size 100% to 400% scaling asks`, sizes.join(",") === "16,20,24,32,40,48,64", sizes)
    }
    // The tray's mark is only a hair over the painted size - the user wanted a wider rim there than the taskbar's.
    {
      const ico = await fs.readFile(at("resources", "tray", "classic.ico"))
      let rgba: Buffer | undefined
      for (let n = 0; n < ico.readUInt16LE(4); n++) {
        if (ico[6 + n * 16] !== 64) continue
        const body = ico.subarray(ico.readUInt32LE(6 + n * 16 + 12), ico.readUInt32LE(6 + n * 16 + 12) + ico.readUInt32LE(6 + n * 16 + 8))
        if (body.readUInt32BE(0) === 0x89504e47) rgba = await sharp(body).ensureAlpha().raw().toBuffer()
        else {
          // A 32-bit BMP entry: BGRA rows, bottom up, after its header.
          const header = body.readUInt32LE(0)
          rgba = Buffer.alloc(64 * 64 * 4)
          for (let y = 0; y < 64; y++) {
            for (let x = 0; x < 64; x++) {
              const s = header + ((63 - y) * 64 + x) * 4
              const d = (y * 64 + x) * 4
              rgba[d] = body[s + 2]!
              rgba[d + 1] = body[s + 1]!
              rgba[d + 2] = body[s]!
              rgba[d + 3] = body[s + 3]!
            }
          }
        }
      }
      // Measured at 64, where a few percent is more than one pixel: the taskbar's 10% would read about 1.1 here.
      const trayWidth = rgba ? await markWidth(await sharp(rgba, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer()) : 0
      const painted = await markWidth(at("build", "icons", "64x64.png"))
      check("the tray's mark is only a hair over the painted size, less than the taskbar's", trayWidth >= painted * 0.99 && trayWidth < painted * 1.07, { trayWidth, painted, ratio: trayWidth / painted })
    }
    const main = await fs.readFile(at("src", "main", "index.ts"), "utf8")
    const tray = main.slice(main.indexOf("let image: Electron.NativeImage"), main.indexOf("const open = () =>"))
    check("Windows is handed that .ico whole, not the 512 tile cut to one size", /process\.platform === "win32" && trayIcoFile\(trayIcon\)/.test(tray) && /nativeImage\.createFromPath\(trayIcoFile\(trayIcon\)!\)/.test(tray), tray.slice(0, 600))
    const mac = tray.slice(tray.indexOf('if (process.platform === "darwin")'), tray.indexOf("} else if"))
    check("the macOS template is not resized, so its @2x survives", /trayTemplateFile\(\)/.test(mac) && !/\.resize\(/.test(mac), mac)
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
