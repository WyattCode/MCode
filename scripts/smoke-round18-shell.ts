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
import { LANGUAGES, language, t } from "../src/renderer/src/lib/i18n"
import { toolVerb } from "../src/renderer/src/lib/tool-meta"

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

  section("Round 18 (lane U): R18-U5 the footer's menu has no quit row")
  {
    const side = await read("src/renderer/src/components/Sidebar.vue")
    const items = /const footMenuItems = computed<MenuItem\[\]>\(\(\) => \[([\s\S]*?)\n\]\)/.exec(side)?.[1] ?? ""
    check("R18-U5: the footer's menu is settings alone", /key: "settings"/.test(items) && (items.match(/key: "/g) ?? []).length === 1, items)
    check("R18-U5: the side column no longer quits the app", !side.includes("quitApp"))
    check("R18-U5: side.quitApp has left all 18 tables", (await carrying("side.quitApp")) === 0)
    const preload = await read("src/preload/index.ts")
    check("R18-U5: quitting stays in the menu bar and the tray", preload.includes('quitApp: (): void => ipcRenderer.send("mcode:quit")') && (await read("src/main/menu.ts")).includes('L("menu.quitApp"'))
  }

  section("Round 18 (lane U): R18-U11 a webfetch step reads a web page, it does not search")
  {
    const before = language.value
    const states = ["completed", "running", "error", "rejected", "skipped"] as const
    language.value = "zh-CN"
    const zh = states.map((state) => toolVerb("webfetch", state))
    language.value = "en"
    const en = states.map((state) => toolVerb("webfetch", state))
    const others = LANGUAGES.map((entry) => entry.id).filter((id) => id !== "zh-CN" && id !== "en")
    const spread = others.map((id) => {
      language.value = id
      return states.map((state) => toolVerb("webfetch", state))
    })
    language.value = before
    check("R18-U11: the five states in Chinese are 读取网页's", JSON.stringify(zh) === JSON.stringify(["已读取网页", "正在读取网页", "读取网页失败", "已拒绝读取网页", "未执行：读取网页"]), zh)
    check("R18-U11: and in English they read a web page", en.every((verb) => /web page/i.test(verb)) && !en.some((verb) => /search/i.test(verb)), en)
    check("R18-U11: no language still calls it a search", !zh.some((verb) => verb.includes("搜索")) && spread.every((set) => set.every((verb) => verb.length > 0 && !verb.startsWith("toolLabel."))), spread)
    check("R18-U11: every language has five distinct words for the five states", spread.every((set) => new Set(set).size === 5), spread)
  }

  section("Round 18 (lane U): R18-U9 the box says 发送中… and 压缩中… while it sends or compacts")
  {
    const composer = await read("src/renderer/src/components/Composer.vue")
    const placeholder = /const placeholder = computed\(\(\) => \{([\s\S]*?)\n\}\)/.exec(composer)?.[1] ?? ""
    const order = ["composer.shellPlaceholder", "composer.compacting", "composer.sending", "composer.reviewRestricted", "composer.placeholder\""].map((key) => placeholder.indexOf(key))
    check("R18-U9: compacting, then sending, then the rest - MiMo's order", order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), order)
    const submit = composer.slice(composer.indexOf("async function submit()"), composer.indexOf("/*\n * MiMo's /compact from the box"))
    const on = submit.indexOf("sending.value = true")
    const cleared = submit.indexOf('text.value = ""\n  attachments.value = []')
    check("R18-U9: sending starts once the draft has left the box", on > cleared && cleared > 0)
    check("R18-U9: and ends however the send ends", /\} finally \{\s*sending\.value = false\s*\}\s*\}$/.test(submit.trimEnd()), submit.slice(-160))
    const before = language.value
    language.value = "zh-CN"
    const zh = [t("composer.sending"), t("composer.compacting")]
    language.value = "en"
    const en = [t("composer.sending"), t("composer.compacting")]
    language.value = before
    check("R18-U9: the words are 发送中… and 压缩中…", zh[0] === "发送中…" && zh[1] === "压缩中…", zh)
    check("R18-U9: Sending… and Compacting… in English", en[0] === "Sending…" && en[1] === "Compacting…", en)
    for (const key of ["composer.sending", "composer.compacting"]) check(`R18-U9: ${key} is in all 18 tables`, (await carrying(key)) === 18)
  }
}
