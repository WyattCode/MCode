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

  section("Round 18 (lane U): R18-U3 the home screen has no example tasks")
  {
    const hero = await read("src/renderer/src/components/HomeHero.vue")
    const gone = await fs.stat(path.join(process.cwd(), "src/renderer/src/lib/home-suggestions.ts")).then(() => false, () => true)
    check("R18-U3: the hero draws no suggestion list", !/home-suggest|class="sug"|builtinSuggestions/.test(hero))
    check("R18-U3: and the module that listed them is gone", gone)
    check("R18-U3: the tray keeps its place in the three-row grid", /grid-template-rows: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/.test(hero))
    for (const key of ["home.starters", "home.starter.layout.title", "home.starter.bugs.query", "home.starter.tests.title"]) {
      const count = await carrying(key)
      check(`R18-U3: ${key} has left all 18 tables`, count === 0, count)
    }
  }

  section("Round 18 (lane U): R18-U4 a failure's card offers no retry; a stopped or empty turn still does")
  {
    const stream = await read("src/renderer/src/components/MessageStream.vue")
    const template = stream.slice(stream.indexOf("<template>"), stream.lastIndexOf("</template>"))
    const card = template.slice(template.indexOf('data-turn-error>'), template.indexOf("</div>", template.indexOf('data-turn-error>')))
    const finished = template.slice(template.indexOf("data-turn-finished"), template.indexOf("</template>", template.indexOf("data-turn-finished")))
    const actions = template.slice(template.indexOf("data-msg-actions"), template.indexOf("</div>", template.indexOf("data-msg-actions")))
    check("R18-U4: the error card holds its reason and detail but no retry", card.includes("data-err-text") && card.includes("data-err-detail") && !/retry/i.test(card), card.slice(-300))
    check("R18-U4: the stopped or empty line keeps its retry", /data-retry[\s\S]*@click="retry\(turn\)"/.test(finished))
    check("R18-U4: the reply's action row has no retry either", actions.length > 0 && !/retry/i.test(actions))
    check("R18-U4: the pill's style went with it", !stream.includes(".retry-pill"))
  }
}
