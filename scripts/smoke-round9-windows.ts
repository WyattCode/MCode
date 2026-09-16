/**
 * Round 9, MCode as a Windows application: what the package carries, how it
 * updates, installs and starts. Kept apart from smoke.ts the way the earlier
 * rounds are; smoke.ts calls `roundNineWindowsChecks` with its own check and
 * section. Nothing here starts Electron: the modules under test take their
 * Electron and file-system pieces as arguments.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { APP_NAME, noticeTitle, pinnedProfile } from "../src/main/desktop-rules"

/** Every .ts and .vue file under a folder, as text keyed by its path. */
async function sources(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(ts|vue|mts)$/.test(entry.name)) found.set(full, await fs.readFile(full, "utf8"))
    }
  }
  await walk(root)
  return found
}

/** Whether any of the texts imports the package (or a file inside it). */
function imports(texts: Iterable<string>, name: string): boolean {
  const quoted = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  const pattern = new RegExp(`(?:from\\s+|import\\s*\\(\\s*|require\\(\\s*)["']${quoted}(?:/[^"']*)?["']`)
  for (const text of texts) if (pattern.test(text)) return true
  return false
}

export async function roundNineWindowsChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = process.cwd()
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  section("Round 9 (Windows): the asar carries only what the main process loads")
  {
    /*
     * electron-builder copies every entry of `dependencies` into app.asar as it
     * is. A package only the renderer imports is already inside the renderer's
     * bundle, so listing it there ships it twice.
     */
    const mainSide = [
      ...(await sources(path.join(root, "src/main"))).values(),
      ...(await sources(path.join(root, "src/server"))).values(),
      ...(await sources(path.join(root, "src/preload"))).values(),
      ...(await sources(path.join(root, "src/shared"))).values(),
    ]
    const renderer = [...(await sources(path.join(root, "src/renderer"))).values()]
    const rendererOnly = Object.keys(pkg.dependencies).filter((name) => imports(renderer, name) && !imports(mainSide, name))
    check("no runtime dependency is one only the renderer imports", rendererOnly.length === 0, rendererOnly)
    const addons = ["@xterm/addon-unicode11", "@xterm/addon-webgl"]
    check(
      "the terminal's addons are build-time packages, beside xterm itself",
      addons.every((name) => pkg.devDependencies[name] && !pkg.dependencies[name] && imports(renderer, name)) && Boolean(pkg.devDependencies["@xterm/xterm"]),
    )
    // The links addon was listed and never imported: the terminal opens links through its own handler.
    const unused = "@xterm/addon-web-links"
    check("the links addon nothing imports is not listed at all", !pkg.dependencies[unused] && !pkg.devDependencies[unused] && !imports(renderer, unused))
    const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8")) as {
      packages: Record<string, { dev?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>
    }
    check(
      "and the lock file agrees, so npm ci installs them as dev packages and skips the links addon",
      addons.every((name) => lock.packages[`node_modules/${name}`]?.dev === true && !lock.packages[""]?.dependencies?.[name]) &&
        !lock.packages[`node_modules/${unused}`] &&
        !lock.packages[""]?.devDependencies?.[unused],
    )
  }

  section("Round 9 (Windows): the product is called MCode, and the profile stays where it was")
  {
    const manifest = pkg as unknown as { name: string; productName?: string }
    check("package.json names the product, so the packaged app reports MCode rather than mcode", manifest.productName === APP_NAME && manifest.name === "mcode")
    const main = await fs.readFile(path.join(root, "src/main/index.ts"), "utf8")
    const menu = await fs.readFile(path.join(root, "src/main/menu.ts"), "utf8")
    check(
      "the tray, the notification fallback and the app menu use the product name, never app.getName()",
      /tray\.setToolTip\(APP_NAME\)/.test(main) && /noticeTitle\(notice\)/.test(main) && /label: APP_NAME/.test(menu) && !/getName\(\)\)/.test(main.replace(/pinnedProfile\([^)]*\)/, "")) && !/app\.name\b/.test(menu),
    )
    check("a notice with neither project nor title is headed MCode", noticeTitle({}) === "MCode")
    const posix = path.posix.join
    const win = path.win32.join
    check(
      "Linux: the default profile the new name would give (~/.config/MCode) is pinned back to ~/.config/mcode",
      pinnedProfile("/home/u/.config/MCode", "/home/u/.config", "MCode", posix) === "/home/u/.config/mcode",
    )
    check(
      "a profile chosen on purpose - a probe's, or --user-data-dir - is never moved",
      pinnedProfile("/tmp/probe-data", "/home/u/.config", "MCode", posix) === undefined &&
        pinnedProfile("C:\\probe\\data", "C:\\Users\\u\\AppData\\Roaming", "Electron", win) === undefined,
    )
    check(
      "Windows: the same folder spelled the old way, so nothing moves on disk",
      pinnedProfile("C:\\Users\\u\\AppData\\Roaming\\MCode", "C:\\Users\\u\\AppData\\Roaming", "MCode", win) === "C:\\Users\\u\\AppData\\Roaming\\mcode" &&
        pinnedProfile("C:\\Users\\u\\AppData\\Roaming\\mcode", "C:\\Users\\u\\AppData\\Roaming", "mcode", win) === undefined,
    )
    const pinAt = main.indexOf("pinnedProfile(app.getPath(\"userData\")")
    const firstRead = main.indexOf("app.getPath(\"userData\")", pinAt + 40)
    check(
      "and the pin runs before anything else in the main module reads the profile",
      pinAt > 0 && main.indexOf("app.getPath(\"userData\")") === pinAt + "pinnedProfile(".length && firstRead > pinAt && /if \(pinned\) app\.setPath\("userData", pinned\)/.test(main),
    )
  }
}
