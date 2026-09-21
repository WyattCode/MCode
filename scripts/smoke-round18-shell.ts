/**
 * Round 18, lane U: the window shell and the smaller interface changes of
 * MiMo 26.920.
 *
 * What can run here runs against the real code - the preview's timer, the
 * update reasons, the model menu's groups, the i18n tables. The rest lives in
 * markup and stylesheets and is read from the source; the geometry and the
 * behaviour behind it are measured in the real window by the lane's Electron
 * probes (u18-probe*.cjs), whose numbers are in the report.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

/** How many of the 18 tables carry `key`, counted in the source where every table is written. */
async function carrying(key: string): Promise<number> {
  const source = await read("src/renderer/src/lib/i18n.ts")
  return source.split("\n").filter((line) => line.startsWith(`  ${JSON.stringify(key)}: `)).length
}

export async function roundEighteenShellChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 18 (lane U): R18-U2 the tray keeps Open and Quit, its profile switch gone")
  {
    const main = await read("src/main/index.ts")
    const preload = await read("src/preload/index.ts")
    const menu = /tray\.setContextMenu\(\s*Menu\.buildFromTemplate\(\[([\s\S]*?)\]\),\s*\)/.exec(main)?.[1] ?? ""
    const entries = menu.match(/^ {6}\{/gm)?.length ?? 0
    check("R18-U2: the tray menu is Open, a rule and Quit - three entries", entries === 3 && /label\("tray\.open"/.test(menu) && /label\("menu\.quitApp"/.test(menu) && /type: "separator"/.test(menu), menu)
    check("R18-U2: and no submenu of profiles", !/submenu/.test(menu) && !main.includes("tray.profiles"))
    check("R18-U2: nothing carries a profile over IPC any more", !/tray-profile/.test(main) && !/tray-profile|onTrayProfile/.test(preload))
    for (const key of ["tray.profiles", "tray.profilesEmpty", "tray.switched"]) {
      const count = await carrying(key)
      check(`R18-U2: ${key} has left all 18 tables`, count === 0, count)
    }
  }
}
