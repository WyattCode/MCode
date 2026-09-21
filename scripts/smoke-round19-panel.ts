/**
 * Round 19, lane B: the right panel and two side-column details, moved to
 * MiMo 26.920 (RP-1 onwards, R19-SH2, R19-SH3).
 *
 * What can run here runs against the real code - the panel's width rule, the
 * glow's reducer, the conversation card's lines, the i18n tables. The rest
 * lives in markup and is read from the source; the behaviour behind it is
 * measured in a real window by the lane's Electron probes, whose numbers are
 * in the report. smoke.ts calls `roundNineteenPanelChecks` with its own check
 * and section.
 */
import fs from "node:fs/promises"
import path from "node:path"
import type { Check } from "./smoke-round5"
import { LANGUAGES, language, t } from "../src/renderer/src/lib/i18n"
import { createPinia, setActivePinia } from "pinia"
import { PANEL_MIN_WIDTH, useRightPanel } from "../src/renderer/src/stores/right-panel"
import { panelWidthShown } from "../src/renderer/src/lib/right-tools"
import { subagentItems } from "../src/renderer/src/lib/subagents"
import { convoCard } from "../src/renderer/src/lib/convo-card"
import type { Message, SessionInfo, ToolPart } from "../src/shared/protocol"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundNineteenPanelChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 19 (lane B): RP-7 the launcher's cards carry MiMo's own short descriptions")
  {
    const before = language.value
    const mimo: Record<string, string[]> = {
      "zh-CN": ["查看工作区改动", "浏览项目文件", "发起侧边对话", "打开网站", "启动交互式 shell"],
      "zh-TW": ["檢視工作區變更", "瀏覽專案檔案", "開始一個側邊對話", "開啟一個網站", "啟動一個互動式殼層"],
      en: ["View workspace changes", "Browse project files", "Start a side conversation", "Open a website", "Launch an interactive shell"],
      ko: ["작업 공간 변경 사항 보기", "프로젝트 파일 탐색", "사이드 대화 시작", "웹사이트 열기", "대화형 셸 실행"],
      ja: ["ワークスペースの変更を表示", "プロジェクトファイルを閲覧", "サイド会話を開始", "ウェブサイトを開く", "対話型シェルを起動"],
      de: ["Änderungen im Arbeitsbereich anzeigen", "Projektdateien durchsuchen", "Eine Nebenunterhaltung starten", "Eine Website öffnen", "Eine interaktive Shell starten"],
      fr: ["Voir les modifications de l'espace de travail", "Parcourir les fichiers du projet", "Démarrer une conversation latérale", "Ouvrir un site web", "Lancer un shell interactif"],
    }
    const tools = ["review", "files", "chat", "browser", "terminal"]
    for (const [id, lines] of Object.entries(mimo)) {
      language.value = id as typeof language.value
      const shown = tools.map((tool) => t(`launch.${tool}Desc`))
      check(`RP-7: the ${id} launcher reads as MiMo's`, shown.join("|") === lines.join("|"), shown)
    }
    // The four tables MiMo does not ship follow the same short style, none keeps round 16's sentence.
    const english = mimo.en!
    const own: string[] = []
    for (const { id } of LANGUAGES) {
      if (id in mimo) continue
      language.value = id
      for (const tool of tools) {
        const line = t(`launch.${tool}Desc`)
        if (english.includes(line) || line.split(" ").length > 6) own.push(`${id}:${line}`)
      }
    }
    check("RP-7: the other tables carry short lines of their own", own.length === 0, own)
    language.value = before
  }

  section("Round 19 (lane B): RP-8 a middle click closes a tab on release, as MiMo's auxclick does")
  {
    const panel = await read("src/renderer/src/components/RightPanel.vue")
    const down = /function onTabMouseDown\([^)]*\) \{([\s\S]*?)\n\}/.exec(panel)?.[1] ?? ""
    const aux = /function onTabAuxClick\([^)]*\) \{([\s\S]*?)\n\}/.exec(panel)?.[1] ?? ""
    check("RP-8: the press only keeps the page from autoscrolling", down.includes("preventDefault") && !down.includes("requestClose"), down)
    check("RP-8: the release closes the tab, middle button only", /event\.button !== 1/.test(aux) && aux.includes("requestClose([id])"), aux)
    check("RP-8: each tab listens for the release", /@auxclick="onTabAuxClick\(\$event, tab\.id\)"/.test(panel))
  }

  section("Round 19 (lane B): RP-3 a folded side column leaves no rail for the panel to allow for")
  {
    check("RP-3: folded, a 1000px window lets the panel reach 520, as MiMo's", panelWidthShown(900, 1000, 0, PANEL_MIN_WIDTH, 0) === 520, panelWidthShown(900, 1000, 0, PANEL_MIN_WIDTH, 0))
    check("RP-3: and a stored 500 is drawn at 500", panelWidthShown(500, 1000, 0, PANEL_MIN_WIDTH, 0) === 500)
    check("RP-3: with the column open the rail still counts", panelWidthShown(900, 1000, 0, PANEL_MIN_WIDTH) === 458)
    const panel = await read("src/renderer/src/components/RightPanel.vue")
    check("RP-3: the panel's rail follows the fold", /const rail = computed\(\(\) => \(props\.sideCollapsed \? 0 : RAIL_WIDTH\)\)/.test(panel))
    check("RP-3: the drag's max and the shown width both use it", /const maxWidth = computed\(\(\) => Math\.max\(PANEL_MIN_WIDTH, viewport\.value - rail\.value -/.test(panel) && /panelWidthShown\([^)]*rail\.value\)/.test(panel))
  }

  section("Round 19 (lane B): RP-5 a picture in the files tab zooms into the preview out of itself")
  {
    const files = await read("src/renderer/src/components/right/RpFiles.vue")
    const img = /<img\s[^>]*class="fv-img"[^>]*>/.exec(files)?.[0] ?? ""
    const handler = /function previewImage\(event: Event\) \{([\s\S]*?)\n\}/.exec(files)?.[1] ?? ""
    check("RP-5: a click and Enter or Space both open it through the one handler", /@click="previewImage\(\$event\)"/.test(img) && /@keydown\.enter\.space\.prevent="previewImage\(\$event\)"/.test(img), img)
    check("RP-5: and the handler hands the preview the picture's rect", /rect = \(event\.currentTarget as HTMLElement\)\.getBoundingClientRect\(\)/.test(handler) && /openImagePreview\(mediaUrl\.value, \{[^}]*\brect \}\)/.test(handler), handler)
  }

  section("Round 19 (lane B): RP-6 folding the file tree hides it, so it keeps its scroll")
  {
    const files = await read("src/renderer/src/components/right/RpFiles.vue")
    check("RP-6: the tree stays in the page while folded", /<aside v-show="treeOpen" class="fv-tree"/.test(files) && !/v-if="treeOpen"/.test(files))
  }

  section("Round 19 (lane B): RP-4 a new project under the same tabs sends the files tab back to 打开文件")
  {
    setActivePinia(createPinia())
    const rp = useRightPanel()
    const files = rp.openTool("files")
    rp.update(files.id, { viewFile: "src/old.ts", name: "old.ts", fileRoot: "/elsewhere" })
    const chat = rp.openTool("chat")
    rp.update(chat.id, { convoId: "ses_side" })
    const reroot = (rp as unknown as { reroot?: () => void }).reroot
    if (reroot) reroot()
    const after = rp.tabs.find((tab) => tab.id === files.id)
    check("RP-4: the files tab forgets the old file, its own root and its name", Boolean(reroot) && after?.viewFile === undefined && after?.fileRoot === undefined && after?.name === undefined, after)
    check("RP-4: it stays the same tab, where it was", rp.tabs.length === 2 && rp.tabs[0]?.id === files.id)
    check("RP-4: the other tabs keep what they hold", rp.tabs.find((tab) => tab.id === chat.id)?.convoId === "ses_side")
    const panel = await read("src/renderer/src/components/RightPanel.vue")
    const watcher = /watch\(\s*\(\) => \[props\.sessionID, props\.directory\] as const,([\s\S]*?)\n\)/.exec(panel)?.[1] ?? ""
    check("RP-4: the panel resets it when the directory changes under the same conversation or home screen", /session === sessionBefore && directory !== directoryBefore\) rp\.reroot\(\)/.test(watcher), watcher)
  }

  section("Round 19 (lane B): RP-2 the subagent's transcript head names the model it ran on")
  {
    const call: ToolPart = {
      type: "tool",
      id: "p1",
      callID: "call_1",
      name: "actor",
      status: "running",
      input: { action: "spawn", description: "Look around", prompt: "x", subagent_type: "explore" },
      time: { created: 1000, started: 1000 },
    } as ToolPart
    const early = { ...call, id: "p2", callID: "call_2" } as ToolPart
    const reply = { id: "a1", sessionID: "s", role: "assistant", model: { provider: "p", model: "parent-model" }, agent: "build", parts: [call, early], time: { created: 1 } } as Message
    const child = {
      id: "c1",
      title: "Look around",
      directory: "x",
      model: { provider: "p", model: "mimo-v2-flash" },
      agent: "plan",
      parentID: "s",
      parentCallID: "call_1",
      subagent: { type: "explore", id: "explore-1", background: true, status: "running" },
      created: 1,
      updated: 1,
      usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    } as SessionInfo
    const items = subagentItems([reply], [child]) as Array<{ key: string; model?: { model: string } }>
    check("RP-2: a subagent with its own conversation carries that conversation's model", items.find((item) => item.key === "call_1")?.model?.model === "mimo-v2-flash", items)
    check("RP-2: one still starting carries none, so no pill is drawn", items.find((item) => item.key === "call_2")?.model === undefined)
    const view = await read("src/renderer/src/components/right/RpSubagents.vue")
    const subtitle = /<span class="rp-subagent-detail-subtitle">([\s\S]*?)\n {10}<\/span>/.exec(view)?.[1] ?? ""
    check("RP-2: 执行记录 sits in its own label, then MiMo's pill", /rp-subagent-detail-subtitle-label">\{\{ t\("subagents\.transcript"\) \}\}/.test(subtitle) && /v-if="detail\.model" class="rp-subagent-model" :data-subagent-model="detail\.model\.model" :title="detail\.model\.model">\{\{ modelName\(detail\) \}\}/.test(subtitle), subtitle)
    const pill = /\.rp-subagent-model \{([^}]*)\}/.exec(view)?.[1] ?? ""
    check("RP-2: the pill is MiMo's: 120 at most, cut, 1px 6px, round, 6% of the text colour, line-height 1.35", /max-width: 120px/.test(pill) && /text-overflow: ellipsis/.test(pill) && /padding: 1px 6px/.test(pill) && /border-radius: 999px/.test(pill) && /color-mix\(in srgb, var\(--text-strong\) 6%, transparent\)/.test(pill) && /line-height: 1\.35/.test(pill), pill)
  }

  section("Round 19 (lane B): R19-SH2 a conversation's card names the subagents still at work")
  {
    const before = language.value
    language.value = "zh-CN"
    const session = { id: "ses_a", title: "Tidy", directory: "/p", updated: 1_700_000_000_000 }
    const card = (convoCard as (...args: unknown[]) => { lines: unknown[] })(session, {}, [{ peerID: "ses_b", peerTitle: "Other", direction: "outbound", kind: "request", phase: "running", queueAhead: 0 }], undefined, undefined, [], ["explore-1", "", "general-2"])
    const lines = card.lines.filter(Boolean)
    const at = lines.indexOf("运行中的子智能体：explore-1、general-2")
    check("R19-SH2: MiMo's line, the unnamed left out and the names joined with 、", at >= 0, lines)
    check("R19-SH2: after 更新于 and before the chat-link lines", at > 0 && typeof lines[at - 1] === "string" && /^更新于/.test(lines[at - 1] as string) && typeof lines[at + 1] === "object", lines)
    const quiet = (convoCard as (...args: unknown[]) => { lines: unknown[] })(session, {}, [], undefined, undefined, [], [])
    check("R19-SH2: no line while none is at work", !quiet.lines.some((line) => typeof line === "string" && line.startsWith("运行中的子智能体")))
    language.value = "en"
    check("R19-SH2: the English table carries MiMo's wording", t("subagentDetail.runningList", { names: "a" }) === "Running subagents: a")
    language.value = before
    const side = await read("src/renderer/src/components/Sidebar.vue")
    const calls = side.match(/app\.automationTasks, runningNames\((?:block\.session|session|entry\.session)\.id\)\)/g) ?? []
    check("R19-SH2: every conversation row's card is handed its working subagents' names", calls.length === 3 && (side.match(/convoCard\(/g) ?? []).length === 3, calls.length)
  }
}
