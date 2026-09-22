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
import type { Annotation, Message, SessionInfo, ToolPart } from "../src/shared/protocol"
import { effectScope, nextTick } from "vue"
import { useApp } from "../src/renderer/src/stores/app"

const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")

export async function roundNineteenPanelChecks(check: Check, section: (name: string) => void): Promise<void> {
  /*
   * R21-F3-3 superseded RP-7. MiMo does render .lc-desc, but its only rule for
   * it is `display: none`, so no description is ever on screen; the user chose
   * parity and the element went, taking the five strings with it. What is left
   * to hold is that no table carries them any more and the card is a name and
   * a key cap.
   */
  section("Round 19 (lane B, as R21-F3-3 settled it): the launcher's cards are a name and a key cap")
  {
    const before = language.value
    const tools = ["review", "files", "chat", "browser", "terminal"]
    const kept: string[] = []
    for (const { id } of LANGUAGES) {
      language.value = id
      for (const tool of tools) {
        const key = `launch.${tool}Desc`
        if (t(key) !== key) kept.push(`${id}:${key}`)
      }
    }
    check("RP-7: no language table still carries a launcher description", kept.length === 0, kept)
    language.value = before
    const panel = await read("src/renderer/src/components/RightPanel.vue")
    check("RP-7: and the card draws only the icon, the name and the key cap", !/lc-desc/.test(panel))
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

  section("Round 19 (lane B): RP-1 annotations sent from the composer, or into a running turn, light their document")
  {
    const fx = (await import("../src/renderer/src/lib/annotation-fx")) as Record<string, unknown> & typeof import("../src/renderer/src/lib/annotation-fx")
    const documents = fx.annotatedDocuments as ((notes: Annotation[]) => Map<string, string[]>) | undefined
    const note = (id: string, path: string, text: string): Annotation => ({ id, kind: "pdf", path, text })
    const grouped = documents?.([note("a", "/p/report.pdf", "fix this"), note("b", "/p/report.pdf", "  "), note("c", "/p/sheet.xlsx", "sum"), note("d", "/p/notes.md", "why"), note("e", "/p/report.pdf", "and this")])
    check("RP-1: only annotations with a note count, grouped by the document they sit on (MiMo's VD, KD and HD)", JSON.stringify(grouped ? [...grouped] : null) === JSON.stringify([["/p/report.pdf", ["a", "e"]], ["/p/sheet.xlsx", ["c"]]]), grouped && [...grouped])

    const app = await read("src/renderer/src/stores/app.ts")
    const send = app.slice(app.indexOf("  async function send("), app.indexOf("  const ABORT_TRIES"))
    check("RP-1: every accepted send registers its documents - a new turn and a steer alike", /await api\(\)\.request\(\{\s*type: "session\.prompt"[\s\S]*?\}\)\s*\n\s*\/\/[^\n]*\n\s*if \(annotations\.length\) watchAnnotatedSend\(target, annotations, text\)\s*\n\s*return true/.test(send), send.slice(send.indexOf("session.prompt"), send.indexOf("session.prompt") + 700))

    // A steer into the same run joins its watch rather than starting another; the prompt stays the first one.
    fx.watchOfficeSend("ses_rp1", "/p/deck.pptx", ["n1"], "first ask")
    if (typeof fx.watchAnnotatedSend === "function") (fx.watchAnnotatedSend as (id: string, notes: Annotation[], prompt: string) => void)("ses_rp1", [note("n2", "/p/deck.pptx", "and this one")], "later ask")
    else fx.watchOfficeSend("ses_rp1", "/p/deck.pptx", ["n2"], "later ask")
    check("RP-1: the run keeps one watch on the document", fx.watchedFilesOf("ses_rp1").length === 1, fx.watchedFilesOf("ses_rp1"))
    check("RP-1: and the prompt it was started with", fx.promptOf("ses_rp1") === "first ask", fx.promptOf("ses_rp1"))

    // The viewer's side: armed on the first note, then MiMo's noteBatch adds the second while it glows.
    setActivePinia(createPinia())
    const store = useApp()
    store.running.add("ses_rp2")
    const scope = effectScope()
    // Outside a component its onBeforeUnmount has nothing to attach to, which Vue says aloud; the scope stops it instead.
    const warn = console.warn
    console.warn = () => undefined
    const light = scope.run(() => fx.useAnnotationFx(() => "/p/memo.docx"))!
    console.warn = warn
    fx.watchOfficeSend("ses_rp2", "/p/memo.docx", ["m1"], "ask")
    await nextTick()
    const armed = light.phase.value === "ignite" && light.annotatedIds.value.join() === "m1"
    fx.watchOfficeSend("ses_rp2", "/p/memo.docx", ["m2"], "steer")
    await nextTick()
    check("RP-1: the viewer arms on the first note", armed, { phase: light.phase.value, ids: light.annotatedIds.value })
    check("RP-1: a note steered into the running turn joins the glow (noteBatch)", light.annotatedIds.value.join() === "m1,m2" && light.phase.value === "ignite", light.annotatedIds.value)
    store.running.delete("ses_rp2")
    await nextTick()
    check("RP-1: the run ending still finishes the glow", light.phase.value === "finish", light.phase.value)
    fx.endOfficeWatches("ses_rp2")
    fx.watchOfficeSend("ses_rp2", "/p/memo.docx", ["m3"], "next run")
    check("RP-1: a send after the run ended starts a watch of its own", fx.promptOf("ses_rp2") === "next run")
    scope.stop()
    fx.endOfficeWatches("ses_rp1")
    fx.endOfficeWatches("ses_rp2")
  }

  section("Round 19 (lane B): R19-SH3 the row menu exports Markdown alone, as MiMo's; the conversation file is gone")
  {
    const app = await read("src/renderer/src/App.vue")
    const menu = /const SESSION_MENU[^=]*= \[([\s\S]*?)\n\]/.exec(app)?.[1] ?? ""
    const ids = [...menu.matchAll(/id: "([^"]+)"/g)].map((found) => found[1]!)
    check("R19-SH3: 导出对话记录 is the row menu's one export, and 删除 follows it", ids.filter((id) => /export/i.test(id)).join() === "session.export" && ids[ids.indexOf("session.export") + 1] === "session.delete", ids)
    check("R19-SH3: nothing in the window exports or imports a conversation file", !/session\.(exportFile|importFile)|exportConversationFile|importConversationFile/.test(app + (await read("src/renderer/src/lib/convo-export.ts"))))
    const gone = await fs.stat(path.join(process.cwd(), "src/shared/convo-file.ts")).then(() => false, () => true)
    check("R19-SH3: the conversation-file module is gone", gone)
    const [protocol, handlers, main, preload] = await Promise.all(["src/shared/protocol.ts", "src/server/handlers.ts", "src/main/index.ts", "src/preload/index.ts"].map(read))
    check("R19-SH3: the server no longer answers for it", !/session\.(exportFile|importFile)/.test(protocol + handlers))
    check("R19-SH3: nor does the main process open a file for it", !main.includes("mcode:open-text") && !/openText/.test(preload))
    check("R19-SH3: the Markdown export and its save dialog stay", app.includes('"session.export": (sessionID) => exportConversationById(sessionID)') && main.includes('ipcMain.handle("mcode:save-text"'))
    const i18n = await read("src/renderer/src/lib/i18n.ts")
    const left = ["menu.exportFile", "cmd.importConvoFile", "toast.importNotJson", "toast.importNotMCode", "toast.importFromNewer", "toast.importNoMessages", "toast.importedConvo", "toast.importFailed"].filter((key) => i18n.includes(`"${key}":`))
    check("R19-SH3: its eight strings have left all 18 tables", left.length === 0, left)
    check("R19-SH3: 导出对话记录 stays in all 18", (i18n.match(/^ {2}"menu\.export": /gm) ?? []).length === 18)
  }
}
