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
import { LANGUAGES, language, t, tn } from "../src/renderer/src/lib/i18n"
import { toolVerb } from "../src/renderer/src/lib/tool-meta"
import { UPDATE_REASONS, interruptedReason, readOnlyInstall } from "../src/shared/update-reason"
import { subagentsAtWork } from "../src/renderer/src/lib/subagent-chip"
import { PREVIEW_CLOSE_MS, PREVIEW_OPEN_MS, sidePreview } from "../src/renderer/src/lib/side-preview"

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

  section("Round 18 (lane U): R18-U8 an update failure is told by one of nine reasons")
  {
    check("R18-U8: the nine reasons are MiMo 26.920's", JSON.stringify(UPDATE_REASONS) === JSON.stringify(["no-ready", "staging", "read-only-volume", "install-failed", "not-started", "version-mismatch", "stale", "disabled", "unknown"]))
    check("R18-U8: a recorded stale or version-mismatch is read back as itself", interruptedReason("stale").reason === "stale" && interruptedReason("version-mismatch").reason === "version-mismatch" && interruptedReason("no-ready").reason === "no-ready")
    const failed = interruptedReason("spawn EACCES")
    check("R18-U8: an installer's own error is install-failed, its words kept as the detail", failed.reason === "install-failed" && failed.hint === "spawn EACCES", failed)
    check("R18-U8: a damaged record, or none, is unknown", interruptedReason("invalid").reason === "unknown" && interruptedReason("  ").reason === "unknown")
    check("R18-U8: only an app on a disk image or translocated is read-only", readOnlyInstall("/Volumes/MCode/MCode.app/Contents/MacOS/MCode", "darwin") && readOnlyInstall("/private/var/folders/x/AppTranslocation/1/d/MCode.app/Contents/MacOS/MCode", "darwin") && !readOnlyInstall("/Applications/MCode.app/Contents/MacOS/MCode", "darwin") && !readOnlyInstall("/Volumes/x", "win32"))

    const pill = await read("src/renderer/src/components/UpdatePill.vue")
    const map = /UPDATE_REASON_KEYS: Record<UpdateReason, string> = \{([\s\S]*?)\n\}/.exec(pill)?.[1] ?? ""
    const keys = [...map.matchAll(/"(update\.reason\.\w+)"/g)].map((match) => match[1])
    check("R18-U8: every reason has its own string", keys.length === 9 && new Set(keys).size === 9, keys)
    const counts = await Promise.all(keys.map((key) => carrying(key)))
    check("R18-U8: each of the nine is in all 18 tables", counts.every((count) => count === 18), counts)
    const before = language.value
    const distinct = LANGUAGES.map((entry) => {
      language.value = entry.id
      return new Set(keys.map((key) => t(key))).size
    })
    language.value = before
    check("R18-U8: and in every language the nine read differently", distinct.every((size) => size === 9), distinct)
    for (const key of ["update.watchdogTimeout", "update.restartFailed", "update.failReason", "update.failGeneric", "update.interrupted", "update.failedTip"]) {
      check(`R18-U8: the old ${key} has left all 18 tables`, (await carrying(key)) === 0)
    }
    check("R18-U8: the watchdog says not-started, a thrown install says install-failed", /markUpdateFailed\("not-started"\)/.test(pill) && /markUpdateFailed\("install-failed"\)/.test(pill))
    check("R18-U8: a refused install says the reason main gave", /if \(!answer\.ok && updateState\.phase === "installing"\) markUpdateFailed\(answer\.reason, answer\.hint\)/.test(pill))

    const main = await read("src/main/index.ts")
    const handler = /ipcMain\.handle\("mcode:install-update"[\s\S]*?\n {2}\}\)\n/.exec(main)?.[0] ?? ""
    const order = ['reason: "read-only-volume"', 'reason: "disabled"', '"staging" : "no-ready"', "updateTransactions.begin(", "return { ok: true }"].map((text) => handler.indexOf(text))
    check("R18-U8: main answers read-only, then disabled, then staging or no-ready, before it begins", order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), order)
    check("R18-U8: it answers rather than throws", !/throw new Error/.test(handler))
    const app = await read("src/renderer/src/App.vue")
    check("R18-U8: an interrupted install is told by its reason and leaves 重试 on the capsule", /const \{ reason, hint \} = interruptedReason\(state\.interrupted\.error\)\s*markUpdateFailed\(reason, hint, /.test(app))
  }

  section("Round 18 (lane U): R18-U10 custom models sit under their provider's name in the model menu")
  {
    const composer = await read("src/renderer/src/components/Composer.vue")
    const block = composer.slice(composer.indexOf('<template v-if="customRows.length">'), composer.indexOf('<div class="rule" />\n              <button', composer.indexOf('<template v-if="customRows.length">')))
    check("R18-U10: one group per custom provider, keyed by its id", /v-for="group in customGroups" :key="group\.id"[^>]*:data-model-provider="group\.id"/.test(block), block.slice(0, 300))
    check("R18-U10: each headed by the provider's name", /<div class="provider-head" :data-model-provider-head="group\.id">\{\{ group\.name \}\}<\/div>/.test(block))
    check("R18-U10: and its rows under it, not one flat run", /v-for="row in group\.rows"/.test(block) && !/v-for="row in customRows"/.test(block))
    check("R18-U10: the groups come from the configured custom providers, named by display name", /const customGroups = computed\(\(\) =>\s*groups\.value\s*\.filter\(\(group\) => group\.provider\.custom\)\s*\.map\(\(group\) => \(\{ id: group\.provider\.id, name: group\.provider\.name \|\| group\.provider\.id, rows: rowsOf\(group\) \}\)\)/.test(composer))
    check("R18-U10: the keys still walk every custom row in drawn order", /const customRows = computed\(\(\) => customGroups\.value\.flatMap\(\(group\) => group\.rows\)\)/.test(composer) && /\.\.\.customRows\.value\.map\(\(row\) => row\.key\)/.test(composer))
    check("R18-U10: the heading is 12px in the muted colour with 6 by 10 of padding", /\.model-menu \.provider-head \{[^}]*padding: 6px 10px;[^}]*font-size: calc\(12px \* var\(--ui-font-scale, 1\)\)/.test(composer))
  }

  section("Round 18 (lane U): R18-U12 every document view ends on 内容由 AI 生成，请注意核实")
  {
    const note = await read("src/renderer/src/components/right/ViewerAiNote.vue")
    check("R18-U12: the footer is a component of its own, saying the composer's line", /\{\{ t\("composer\.aiNote"\) \}\}/.test(note) && /data-viewer-ai-note/.test(note))
    check("R18-U12: 8 above, 12 at the sides, 6 below, 10px and centred", /padding: 8px 12px 6px;/.test(note) && /font-size: calc\(10px \* var\(--ui-font-scale, 1\)\)/.test(note) && /text-align: center;/.test(note) && /flex: 0 0 auto;/.test(note))
    const before = language.value
    language.value = "zh-CN"
    const zh = t("composer.aiNote")
    language.value = before
    check("R18-U12: in Chinese it reads 内容由 AI 生成，请注意核实", zh === "内容由 AI 生成，请注意核实", zh)
    const views: [string, string, string, string][] = [
      ["PdfView.vue", "pdf", ".pdf-view", ".office-sel"],
      ["DocxView.vue", "docx", ".docx-view", ".office-sel"],
      ["XlsxView.vue", "xlsx", ".xlsx-view", ".xlsx-grid"],
      ["PptxView.vue", "pptx", ".pptx-view", ".pptx-host"],
    ]
    for (const [file, kind, root, body] of views) {
      const source = await read(`src/renderer/src/components/right/${file}`)
      const rule = (selector: string) => new RegExp(`\\n${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(source)?.[1] ?? ""
      check(`R18-U12: the ${kind} view mounts it`, source.includes(`<ViewerAiNote viewer="${kind}" />`) && source.includes('import ViewerAiNote from "./ViewerAiNote.vue"'))
      check(`R18-U12: the ${kind} view is a column, so the line sits under the document`, /display: flex;/.test(rule(root)) && /flex-direction: column;/.test(rule(root)), rule(root))
      check(`R18-U12: and the ${kind} document takes the room the line leaves`, /flex: 1 1 0;/.test(rule(body)) && /min-height: 0;/.test(rule(body)) && !/height: 100%/.test(rule(body)), rule(body))
    }
    const html = await read("src/renderer/src/components/right/HtmlTab.vue")
    check("R18-U12: the HTML view mounts it under the page", /<\/div>\s*<!--[^>]*-->\s*<ViewerAiNote viewer="html" \/>\s*<VersionHistory/.test(html))
  }

  section("Round 18 (lane U): R18-U6 the question dock can be minimised, and stands at most half the window tall")
  {
    const dock = await read("src/renderer/src/components/QuestionDock.vue")
    const form = await read("src/renderer/src/components/parts/QuestionForm.vue")
    const dockRule = /\n\.confirm-dock \{([^}]*)\}/.exec(dock)?.[1] ?? ""
    check("R18-U6: the dock is 50vh at most (it was 72vh)", /max-height: 50vh;/.test(dockRule) && !/max-height: 72vh/.test(dock), dockRule)
    check("R18-U6: and a column, so the question's body can scroll under its head", /display: flex;/.test(dockRule) && /flex-direction: column;/.test(dockRule))
    const body = /\n\.confirm-q-body \{([^}]*)\}/.exec(form)?.[1] ?? ""
    check("R18-U6: the body scrolls on its own, without handing the scroll on", /overflow-y: auto;/.test(body) && /overscroll-behavior: contain;/.test(body) && /min-height: 0;/.test(body), body)
    check("R18-U6: the typed answer sticks to the foot of it", /\n\.q-custom \{[^}]*position: sticky;[^}]*bottom: 0;/.test(form))
    check("R18-U6: a chevron minimises and expands, named for what it will do", /data-confirm-collapse-toggle[\s\S]{0,120}:title="t\(collapsed \? 'questionDock\.expand' : 'questionDock\.collapse'\)"[\s\S]{0,200}:aria-expanded="!collapsed"[\s\S]{0,40}@click\.stop="collapsed = !collapsed"/.test(form))
    check("R18-U6: minimised, the head says how many questions wait and opens it again", /:data-confirm-head-clickable="collapsed \? 'true' : undefined" @click="collapsed && \(collapsed = false\)"/.test(form) && /data-confirm-collapsed>\s*\{\{ tn\("questionDock\.collapsedSummary", total\) \}\}/.test(form))
    check("R18-U6: and hides the body, the pager and the actions", /<div v-if="!collapsed" :key="page" class="confirm-q-body"/.test(form) && /v-if="total > 1 && !collapsed" class="q-pager"/.test(form) && /v-if="!allowCustom && !collapsed" class="q-actions q-actions-row"/.test(form) && /v-if="allDone && !collapsed"/.test(form))
    check("R18-U6: the dismiss X does not also open a minimised card", /data-confirm-dismiss[\s\S]{0,200}@click\.stop="dismiss"/.test(form))
    const before = language.value
    language.value = "zh-CN"
    const zh = [tn("questionDock.collapsedSummary", 3), t("questionDock.collapse"), t("questionDock.expand")]
    language.value = "en"
    const en = [tn("questionDock.collapsedSummary", 1), tn("questionDock.collapsedSummary", 2)]
    language.value = before
    check("R18-U6: 3 个提问待回答, 最小化, 展开", JSON.stringify(zh) === JSON.stringify(["3 个提问待回答", "最小化", "展开"]), zh)
    check("R18-U6: one question, two questions in English", en[0] === "1 question waiting" && en[1] === "2 questions waiting", en)
    for (const key of ["questionDock.collapsedSummary_one", "questionDock.collapsedSummary_other", "questionDock.collapse", "questionDock.expand"]) {
      check(`R18-U6: ${key} is in all 18 tables`, (await carrying(key)) === 18)
    }
  }

  section("Round 18 (lane U): R18-U7 a side column row counts the subagents still at work for it")
  {
    // A conversation c1 whose turn ended, with a1 and a2 working and a3 done; a4 works under a1; c2 is running itself, with b1.
    const parents: Record<string, string> = { a1: "c1", a2: "c1", a3: "c1", a4: "a1", b1: "c2" }
    const rootOf = (id: string) => {
      let at = id
      while (parents[at]) at = parents[at]
      return at
    }
    const subagents = ["a1", "a2", "a3", "a4", "b1"].map((id) => ({ id }))
    const working = subagentsAtWork(subagents, new Set(["a1", "a2", "a4", "b1", "c2"]), rootOf)
    check("R18-U7: the working ones count for their conversation, one under another included", JSON.stringify(working.get("c1")?.map((entry) => entry.id)) === JSON.stringify(["a1", "a2", "a4"]), [...working])
    check("R18-U7: a finished one does not", !working.get("c1")?.some((entry) => entry.id === "a3"))
    check("R18-U7: a conversation that is running itself has no chip", !working.has("c2"))
    check("R18-U7: and nothing counts for a subagent's own id", !working.has("a1"))

    const side = await read("src/renderer/src/components/Sidebar.vue")
    const chips = side.match(/class="subagent-chip"/g)?.length ?? 0
    check("R18-U7: the chip is on all three kinds of row (pinned, in a project, recent)", chips === 3 && ["block.session.id", "session.id", "entry.session.id"].every((x) => side.includes(`:data-conv-subagent-chip="${x}"`)), chips)
    check("R18-U7: it names the subagents under the pointer and opens their tab", /v-tip="\{ label: subagentNames\(workingFor\.get\(session\.id\)!\), placement: 'top' \}"\s*@click\.stop="emit\('openSubagents', session\.id\)"/.test(side))
    check("R18-U7: the row keeps its spinner while they work", /const working = \(sessionID: string\) => app\.running\.has\(sessionID\) \|\| workingFor\.value\.has\(sessionID\)/.test(side) && /if \(working\(sessionID\)\) return "running"/.test(side))
    check("R18-U7: the chip is a 14px-line pill centred in the row, not stretched to its height", /\n\.subagent-chip \{[^}]*align-self: center;[^}]*line-height: calc\(14px \* var\(--ui-font-scale, 1\)\);/.test(side))
    check("R18-U7: under the pointer it steps 54px aside for the pin and menu", /\.row:hover \.subagent-chip,\s*\.row:focus-within \.subagent-chip \{\s*transform: translateX\(-54px\);/.test(side))
    const app = await read("src/renderer/src/App.vue")
    check("R18-U7: the window opens the conversation, then its 子智能体 tab", /@openSubagents="openSubagentsFromSide"/.test(app) && /async function openSubagentsFromSide\(sessionID: string\) \{\s*await openFromSide\(sessionID\)\s*rp\.openSubagents\(\)/.test(app))
    const before = language.value
    language.value = "zh-CN"
    const zh = tn("side.subagentChip", 2)
    language.value = "en"
    const en = [tn("side.subagentChip", 1), tn("side.subagentChip", 3)]
    language.value = before
    check("R18-U7: 2 个子智能体; 1 subagent, 3 subagents", zh === "2 个子智能体" && en[0] === "1 subagent" && en[1] === "3 subagents", [zh, en])
    for (const key of ["side.subagentChip_one", "side.subagentChip_other"]) check(`R18-U7: ${key} is in all 18 tables`, (await carrying(key)) === 18)
  }

  section("Round 18 (lane U): R18-U1 the folded column is gone, and resting on its toggle previews it")
  {
    // A clock the checks move by hand.
    let now = 0
    let timers: { at: number; run: () => void; id: number }[] = []
    let next = 1
    const clock = {
      setTimeout: (run: () => void, ms: number) => {
        const id = next++
        timers.push({ at: now + ms, run, id })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: (id: ReturnType<typeof setTimeout> | undefined) => {
        timers = timers.filter((timer) => timer.id !== (id as unknown as number))
      },
    }
    const advance = (ms: number) => {
      now += ms
      for (const timer of timers.filter((entry) => entry.at <= now)) {
        timers = timers.filter((entry) => entry !== timer)
        timer.run()
      }
    }
    let folded = true
    const shown = { value: false }
    const preview = sidePreview(() => folded, shown, clock)
    check("R18-U1: MiMo's timings - 150ms to open, 200ms to close", PREVIEW_OPEN_MS === 150 && PREVIEW_CLOSE_MS === 200)
    preview.schedule(true)
    advance(149)
    const early = shown.value
    advance(1)
    check("R18-U1: resting on the toggle opens the preview at 150ms, not before", !early && shown.value)
    preview.schedule(false)
    advance(150)
    preview.hold(true)
    advance(400)
    check("R18-U1: moving into the preview before 200ms keeps it", shown.value)
    preview.hold(false)
    advance(199)
    const lingering = shown.value
    advance(1)
    check("R18-U1: leaving it lets it go 200ms later", lingering && !shown.value)
    preview.hold(true)
    advance(500)
    check("R18-U1: the controls beside the toggle never open one themselves", !shown.value)
    preview.schedule(true)
    advance(150)
    preview.close()
    check("R18-U1: Escape, a press elsewhere or the toggle close it at once", !shown.value && timers.length === 0)
    folded = false
    preview.schedule(true)
    advance(1000)
    check("R18-U1: an open column is never previewed", !shown.value)

    const side = await read("src/renderer/src/components/Sidebar.vue")
    check("R18-U1: folded, the column takes no width at all", /:style="\{ width: collapsed \? '0px' : `\$\{RAIL_WIDTH \+ width\}px` \}"/.test(side) && !/\.side\.rail\b/.test(side))
    check("R18-U1: the column keeps its own width inside, hidden and inert while folded", /class="side-shell"[\s\S]{0,200}:style="\{ width: `\$\{RAIL_WIDTH \+ width\}px` \}"/.test(side) && /:inert="collapsed && !preview \? true : undefined"/.test(side) && /\.side\.folded \.side-shell:not\(\.preview\) \{\s*visibility: hidden;/.test(side))
    const card = /\n\.side-shell\.preview \{([^}]*)\}/.exec(side)?.[1] ?? ""
    check("R18-U1: the preview is a card 8 in from the corner, 16 short of the window, 16 round, at 190", /position: fixed;/.test(card) && /inset-block-start: 8px;/.test(card) && /inset-inline-start: 8px;/.test(card) && /height: calc\(100% - 16px\);/.test(card) && /border-radius: 16px;/.test(card) && /z-index: 190;/.test(card), card)
    const tools = /\n\.rail-tools \{([^}]*)\}/.exec(side)?.[1] ?? ""
    check("R18-U1: the folded toggle stands at 75 and 13, above the preview", /position: fixed;/.test(tools) && /top: 13px;/.test(tools) && /inset-inline-start: 75px;/.test(tools) && /z-index: 201;/.test(tools), tools)
    const folded2 = side.slice(side.indexOf('<div v-if="collapsed" class="rail-tools"'), side.indexOf('<div\n      ref="shellEl"'))
    check("R18-U1: folded, only the toggle and 新建任务 are left - back and forward go", /data-toggle-side/.test(folded2) && /data-collapsed-new-task/.test(folded2) && !/emit\('back'\)|emit\('forward'\)/.test(folded2))
    check("R18-U1: the toggle opens the preview and carries no tip of its own", /@pointerenter="schedulePreview\(true\)"\s*@pointerleave="schedulePreview\(false\)"/.test(folded2) && !/data-toggle-side[^>]*v-tip/.test(folded2))
    check("R18-U1: the rail's quick card has gone with the rail", !/rail-quick|quickEnter|data-quick/.test(side) && (await carrying("side.railArtifacts")) === 0)
    const header = await read("src/renderer/src/components/SessionHeader.vue")
    const panel = await read("src/renderer/src/components/RightPanel.vue")
    const app = await read("src/renderer/src/App.vue")
    check("R18-U1: the header starts at 129, past 新建任务, as MiMo's does", /\.head\.after-rail \{\s*padding-inline-start: 129px;/.test(header))
    check("R18-U1: a full-screen panel's tabs start at 139", /\.right-panel\.fullscreen\.side-collapsed \.rp-head \{\s*padding-inline-start: 139px;/.test(panel))
    check("R18-U1: the no-drag patch covers the two controls where they now stand", /\.rail-no-drag \{[^}]*inset-inline-start: 75px;[^}]*width: 56px;/.test(app))
    // The user's 2026-09-21 choice: off macOS the folded controls keep the side column's own start, 18, as the unfolded row does.
    check("R18-U1: off macOS the folded toggle is left-aligned at 18, like the unfolded top row", /\.app:not\(\[data-platform="darwin"\]\) \.rail-tools \{\s*inset-inline-start: 18px;/.test(side) && /\.top \{[^}]*padding-inline: 18px 8px;/.test(side), side.length)
    check("R18-U1: and the header, the full-screen tabs and the no-drag patch move with it (72, 82, 18)", /\.app:not\(\[data-platform="darwin"\]\) \.head\.after-rail \{\s*padding-inline-start: 72px;/.test(header) && /\.app:not\(\[data-platform="darwin"\]\) \.right-panel\.fullscreen\.side-collapsed \.rp-head \{\s*padding-inline-start: 82px;/.test(panel) && /\.rail-no-drag:not\(\[data-platform="darwin"\]\) \{\s*inset-inline-start: 18px;/.test(app) && /class="rail-no-drag" :data-platform="app\.platform \|\| undefined"/.test(app))
  }
}
