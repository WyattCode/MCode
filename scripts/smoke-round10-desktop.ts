/**
 * Round 10, MiMo's desktop toolkit as its engine and window run it:
 * present_files and pdf_locate (paths, addresses, demotions, the automatic
 * opens), the desktop settings and session chat tools' answers, and
 * automation_update's checks and schedule. Kept apart from smoke.ts the way
 * the earlier rounds are; smoke.ts calls `roundTenDesktopChecks`.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPinia, setActivePinia } from "pinia"
import type { Check } from "./smoke-round5"
import type { Message } from "../src/shared/protocol"
import { findTool } from "../src/server/tool/registry"
import { toolContext } from "./smoke-round10-files"
import { addressName, demotedInBatch, normalizedAddress, sessionArtifacts } from "../src/shared/session-files"

const tool = (callID: string, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  type: "tool",
  id: callID,
  callID,
  name,
  status,
  input: {},
  time: { created: Date.now(), ...(status === "completed" ? { completed: Date.now() } : {}) },
  ...extra,
})

const assistant = (sessionID: string, id: string, parts: unknown[]) =>
  ({ id, sessionID, role: "assistant", parts, time: { created: Date.now() } }) as unknown as Message

export async function roundTenDesktopChecks(check: Check, section: (name: string) => void): Promise<void> {
  // ------------------------------------------------------------ T10-24, T10-56
  section("Round 10 (T10-24, T10-56): present_files paths and addresses, as MiMo resolves them")
  {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-present-"))
    try {
      const project = path.join(base, "project")
      await fs.mkdir(path.join(project, "out", "deep"), { recursive: true })
      await fs.writeFile(path.join(project, "report.docx"), "d")
      await fs.writeFile(path.join(project, "out", "deep", "x.txt"), "x")
      await fs.mkdir(path.join(base, "desktop"))
      await fs.writeFile(path.join(base, "desktop", "for-you.xlsx"), "sheet")
      const present = (files: string[], cwd: string) => findTool("present_files")!.execute({ files, cwd, explanation: "probe" }, toolContext(project))
      const fallback = await present(["report.docx", "x.txt"], "out/deep")
      const names = ((fallback.metadata?.files ?? []) as { name: string }[]).map((file) => file.name).join(",")
      check("a relative entry the cwd does not hold is looked for in the project (T10-24a)", names === "report.docx,x.txt", fallback.metadata)
      const outside = await present([path.join(base, "desktop", "for-you.xlsx")], project)
      const handed = (outside.metadata?.files ?? []) as { path: string }[]
      check("an absolute path outside the project is handed over (T10-24b)", handed[0]?.path === path.join(base, "desktop", "for-you.xlsx") && outside.output.startsWith("Showed 1 file"), outside)
      const addresses = await present(["https://example.com:443/docs/Guide%20One.html#part", "https://example.com/docs/Guide%20One.html", "http://example.com:80/", "https://exa mple"], project)
      const urls = (addresses.metadata?.files ?? []) as { url: string; name: string }[]
      check(
        "addresses lose their #fragment and default port, and the same page is kept once",
        urls.map((entry) => entry.url).join(" ") === "https://example.com/docs/Guide%20One.html http://example.com/",
        urls,
      )
      check("a card calls an address by its last path part, decoded, or by its host", urls.map((entry) => entry.name).join("|") === "Guide One.html|example.com", urls)
      check("an address that does not parse is skipped", ((addresses.metadata?.skipped ?? []) as { entry: string }[])[0]?.entry === "https://exa mple", addresses.metadata)
      check("the helpers agree with the tool", normalizedAddress("HTTPS://Example.com:443/a#b") === "https://example.com/a" && addressName("https://example.com") === "example.com")
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  }

  // ------------------------------------------------------------ T10-19
  section("Round 10 (T10-19): what a present_files call hands over is demoted as MiMo demotes it")
  {
    const root = process.platform === "win32" ? "C:\\work" : "/work"
    const at = (...parts: string[]) => path.join(root, ...parts)
    const batch = [at("report.docx"), at("report.pdf"), at("pages", "p_1.png"), at("chart.png"), at("report.png")]
    const demoted = demotedInBatch(batch)
    check(
      "beside a document: its PDF, a picture in a render folder and a picture named as it are intermediate",
      [...demoted].sort().join("|") === [at("pages", "p_1.png"), at("report.pdf"), at("report.png")].sort().join("|"),
      [...demoted],
    )
    const numbered = demotedInBatch([at("deck.pdf"), at("s_1.png"), at("s_2.png"), at("s_3.png"), at("cover.png")])
    check("a numbered run of three pictures beside a document is demoted, the rest kept", numbered.size === 3 && !numbered.has(at("cover.png")), [...numbered])
    check("pictures on their own are never demoted", demotedInBatch([at("pages", "a.png"), at("b_1.png"), at("b_2.png"), at("b_3.png")]).size === 0)
    const notes = demotedInBatch([at("notes.md"), at("notes.html"), at("notes.pdf"), at("page.html"), at("page.pdf")])
    check("an HTML page or PDF made from Markdown, and a PDF made from a page, are demoted", notes.size === 3 && !notes.has(at("notes.md")) && !notes.has(at("page.html")), [...notes])

    const messages = [
      assistant("s", "m1", [tool("c1", "present_files", "completed", { metadata: { files: batch.map((file) => ({ path: file, name: path.basename(file), size: 1 })) } })]),
    ]
    const artifacts = sessionArtifacts(messages, root)
    const role = (name: string) => artifacts.find((entry) => entry.path.endsWith(name))?.role
    check(
      "the info card keeps the document and the chart as deliverables, the rest as intermediate",
      role("report.docx") === "deliverable" && role("chart.png") === "deliverable" && role("report.pdf") === "intermediate" && role("p_1.png") === "intermediate",
      artifacts,
    )
    const { deliveredFiles } = await import("../src/renderer/src/lib/delivered")
    check("the cards under the reply leave the intermediate files out", deliveredFiles(messages[0]!.role === "assistant" ? messages[0]!.parts : []).map((item) => item.name).join(",") === "report.docx,chart.png")
  }

  // ------------------------------------------------------------ T10-18, T10-48
  section("Round 10 (T10-18, T10-48): the automatic opens, for every conversation, at the end of the turn")
  {
    const external: string[] = []
    const globals = globalThis as { window?: unknown }
    const hadWindow = "window" in globals
    const previous = globals.window
    globals.window = {
      mcode: {
        fileSize: async () => 1,
        openExternal: (url: string) => void external.push(url),
        resolveExistingPath: async (paths: string[]) => ({ path: paths[0], directory: false }),
        revealPath: async () => ({ ok: true }),
        officeConvertLegacy: async () => ({ ok: false, error: "none" }),
      },
    }
    try {
      setActivePinia(createPinia())
      const { useRightPanel } = await import("../src/renderer/src/stores/right-panel")
      const { pdfLocate } = await import("../src/renderer/src/lib/annotate")
      const delivered = await import("../src/renderer/src/lib/delivered")
      const rp = useRightPanel()
      const shown = new Set<string>()
      delivered.setDeliveryView({ shown: (id) => shown.has(id), directory: () => undefined })
      const tabs = () => rp.tabs.map((tab) => tab.name ?? tab.type).join(",")
      const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
      const presentPart = (callID: string, status: string, files: { path?: string; url?: string; name: string }[]) =>
        tool(callID, "present_files", status, { metadata: { files: files.map((file) => ({ size: 1, ...file })) } })
      const run = async (sessionID: string, calls: ReturnType<typeof presentPart>[][]) => {
        delivered.noteDeliveryUpdate({ id: `u-${sessionID}`, sessionID, role: "user", text: "go", attachments: [], time: { created: Date.now() } } as never)
        for (const step of calls) delivered.noteDeliveryUpdate(assistant(sessionID, `a-${sessionID}`, step))
      }
      // Not under the temp folder: MiMo demotes a picture anywhere below a folder named temp.
      const doc = (name: string) => ({ path: path.join(process.platform === "win32" ? "C:\\work" : "/work", name), name })

      shown.add("front")
      await run("front", [
        [presentPart("f1", "running", [doc("first.docx")])],
        [presentPart("f1", "completed", [doc("first.docx")])],
        [presentPart("f1", "completed", [doc("first.docx")]), presentPart("f2", "completed", [doc("second.xlsx")])],
      ])
      await settle()
      check("nothing opens while the turn is still running", tabs() === "", tabs())
      delivered.noteDeliveryTurnEnded("front")
      await settle()
      check("at the end of the turn only the turn's first deliverable opens, once", tabs() === "first.docx", tabs())

      await run("back", [[presentPart("b1", "running", [doc("later.pptx")])], [presentPart("b1", "completed", [doc("later.pptx")])]])
      delivered.noteDeliveryTurnEnded("back")
      await settle()
      check("a conversation not on show opens nothing yet", tabs() === "first.docx", tabs())
      shown.add("back")
      delivered.deliveryShown("back")
      await settle()
      check("and opens its file when it comes on show", tabs() === "first.docx,later.pptx", tabs())
      delivered.deliveryShown("back")
      await settle()
      check("only once", rp.tabs.length === 2, tabs())

      await run("front", [[presentPart("i1", "running", [doc("shot.png")])], [presentPart("i1", "completed", [doc("shot.png"), doc("after.docx")])]])
      delivered.noteDeliveryTurnEnded("front")
      await settle()
      check("a turn whose first deliverable is a picture opens nothing (T10-48)", rp.tabs.length === 2, tabs())

      await run("front", [[presentPart("w1", "running", [{ url: "https://example.com/x", name: "x" }])], [presentPart("w1", "completed", [{ url: "https://example.com/x", name: "x" }])]])
      delivered.noteDeliveryTurnEnded("front")
      await settle()
      check("a turn whose first deliverable is an address opens it in the system browser (T10-48)", external.join() === "https://example.com/x" && rp.tabs.length === 2, external)

      const old = { ...presentPart("o1", "completed", [doc("old.docx")]), time: { created: 1, completed: 2 } }
      delivered.noteDeliveryUpdate(assistant("front", "a-old", [old]))
      delivered.noteDeliveryTurnEnded("front")
      await settle()
      check("a completion this window did not see happen opens nothing", rp.tabs.length === 2, tabs())

      const locate = (callID: string, status: string) => tool(callID, "pdf_locate", status, { input: { file: path.join(os.tmpdir(), "paper.pdf"), snippet: "the passage", page: 4 } })
      delivered.noteDeliveryUpdate(assistant("hidden", "a-h", [locate("l1", "running")]))
      delivered.noteDeliveryUpdate(assistant("hidden", "a-h", [locate("l1", "completed")]))
      await settle()
      // 6b81dd96: the locate is global and every viewer of that path matches it, so one for a conversation off screen could pulse another's open copy.
      check("a PDF locate in a conversation not on show marks nothing yet", !pdfLocate.value, pdfLocate.value)
      check("and holds the PDF until the conversation is shown", !rp.tabs.some((tab) => tab.name === "paper.pdf"), tabs())
      shown.add("hidden")
      delivered.deliveryShown("hidden")
      await settle()
      check("then opens it, with the passage and page that were held", rp.tabs.some((tab) => tab.name === "paper.pdf") && pdfLocate.value?.snippet === "the passage" && pdfLocate.value.page === 4, pdfLocate.value)
      check("what opens is decided by kind: a picture or a sound nothing, an address outside, the rest in the panel", [
        delivered.autoOpenKind({ kind: "file", path: "a.PNG", name: "a.PNG", size: 1 }),
        delivered.autoOpenKind({ kind: "file", path: "a.mp3", name: "a.mp3", size: 1 }),
        delivered.autoOpenKind({ kind: "file", path: "a.mp4", name: "a.mp4", size: 1 }),
        delivered.autoOpenKind({ kind: "url", url: "https://x", name: "x" }),
      ].join() === "none,none,panel,external")
    } finally {
      if (hadWindow) globals.window = previous
      else delete globals.window
    }
  }

  // ------------------------------------------------------------ T10-20, T10-21, T10-22, T10-52, T10-53
  section("Round 10 (T10-20/21/22/52/53): automation_update checks what MiMo checks, and compares tasks as MiMo does")
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r10-auto-"))
    try {
      const { Storage } = await import("../src/server/storage")
      const { SessionStore } = await import("../src/server/session/store")
      const { Bus } = await import("../src/server/bus")
      const { AutomationService, scheduleKey } = await import("../src/server/automation/service")
      const { scheduleLabel } = await import("../src/server/automation/rrule")
      const { ToolError } = await import("../src/server/tool/types")
      const store = new SessionStore(new Storage(path.join(root, "storage")), new Bus())
      const model = { provider: "fake", model: "m" }
      const home = await store.create({ directory: root, model, title: "Home" })
      const other = await store.create({ directory: root, model, title: "Other" })
      const archived = await store.create({ directory: root, model, title: "Old" })
      await store.update(archived.id, { archived: true })
      const side = await store.create({ directory: root, model, title: "Side", sideOf: home.id } as never)
      const child = await store.create({ directory: root, model, title: "general-1", parentID: home.id, subagent: { type: "general", id: "general-1" } } as never)
      let clock = new Date(2026, 0, 2, 10, 0).getTime()
      let locale = "zh-CN"
      const service = new AutomationService({
        file: path.join(root, "automations.json"),
        now: () => clock,
        sessions: store,
        prompt: async () => undefined,
        busy: () => false,
        models: () => [
          { provider: "fake", id: "m", name: "M", efforts: ["low", "high"] },
          { provider: "fake", id: "plain", name: "Plain", efforts: [] },
        ],
        agent: () => "build",
        effort: () => "high",
        locale: () => locale,
        scratch: async () => root,
        publish: () => undefined,
      })
      await service.start({ interval: false })
      const call = async (input: Record<string, unknown>) => JSON.parse(await service.handle(input, { sessionID: home.id })) as Record<string, any>
      const refusal = (input: Record<string, unknown>) =>
        service.handle(input, { sessionID: home.id }).then(
          () => "",
          (failure: unknown) => (failure instanceof ToolError ? failure.message : `crash: ${String(failure)}`),
        )
      const daily = "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0"

      check("new-task with important-updates is refused (T10-20)", (await refusal({ mode: "create", title: "a", prompt: "p", rrule: daily, notification: "important-updates" })).includes("does not fit"))
      check("so is existing-task with all-runs", (await refusal({ mode: "create", title: "a", prompt: "p", rrule: daily, runMode: "existing-task", notification: "all-runs" })).includes("does not fit"))
      const task = await call({ mode: "create", title: "Digest", prompt: "Sum up", rrule: daily })
      const id = task.automation.id as string
      const merged = await refusal({ mode: "update", id, notification: "important-updates" })
      check("an update is checked on the task as it would become, and a refused one changes nothing", merged.includes("does not fit") && service.list()[0]?.notification === "all-runs", { merged, kept: service.list()[0]?.notification })

      // T10-21
      clock = new Date(2026, 0, 3, 9, 0, 1).getTime()
      await service.tick()
      check("the task has run once, so it has a run history", (service.list()[0]?.runHistory?.length ?? 0) === 1, service.list()[0]?.runHistory)
      const reordered = await call({ mode: "create", title: "Digest", prompt: "Sum up", rrule: "RRULE:FREQ=DAILY;BYMINUTE=0;BYHOUR=9", scheduleLabel: "Every morning" })
      check("the same task with its rule's parts in another order, or a label on a simple rule, is the same task", reordered.deduplicated === true, reordered)
      check("schedules compare by meaning", scheduleKey("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0") === scheduleKey("RRULE:FREQ=DAILY;BYMINUTE=0;BYHOUR=9", "x") && scheduleKey("RRULE:FREQ=DAILY;INTERVAL=2", "a") !== scheduleKey("RRULE:FREQ=DAILY;INTERVAL=2", "b"))

      // T10-22
      check("an existing-task task may run in another listed conversation", (await call({ mode: "create", title: "In other", prompt: "p", rrule: daily, runMode: "existing-task", targetThreadId: other.id })).automation.targetThreadId === other.id)
      for (const [label, target] of [["an archived", archived.id], ["a side chat's", side.id], ["a subagent's", child.id], ["a made-up", "ses_nope"]] as const) {
        check(`but not in ${label} conversation`, (await refusal({ mode: "create", title: `t-${label}`, prompt: "p", rrule: daily, runMode: "existing-task", targetThreadId: target })).includes("targetThreadId"))
      }
      check("nor may an update move it there", (await refusal({ mode: "update", id, runMode: "existing-task", targetThreadId: archived.id })).includes("targetThreadId"))

      // T10-53
      check("a reasoning level the model does not take is refused, naming the ones it does", (await refusal({ mode: "create", title: "r", prompt: "p", rrule: daily, reasoning: "max" })).includes("it takes: low, high"))
      check("a model that takes none says so", (await refusal({ mode: "create", title: "r2", prompt: "p", rrule: daily, model: "plain", reasoning: "low" })).includes("none"))
      const plain = await call({ mode: "create", title: "r3", prompt: "p", rrule: daily, model: "plain" })
      check("the app's own level is not given to a model that does not take it", plain.automation.reasoning === undefined, plain.automation)
      check("an empty title in an update is refused rather than ignored", (await refusal({ mode: "update", id, title: "  " })).includes("title cannot be empty"))
      check("so is an empty prompt", (await refusal({ mode: "update", id, prompt: "" })).includes("prompt cannot be empty"))

      // T10-52
      check("the schedule reads in Chinese for a Chinese interface", task.automation.schedule === "每天 9:00", task.automation.schedule)
      locale = "en"
      check("and in English otherwise", (await call({ mode: "view", id })).automation.schedule === "Every day 9:00")
      check(
        "MiMo's Chinese names and its rule for labels",
        scheduleLabel("RRULE:FREQ=HOURLY;BYMINUTE=0", undefined, "zh-CN") === "每小时" &&
          scheduleLabel("RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=30", undefined, "zh-TW") === "工作日 18:30" &&
          scheduleLabel("RRULE:FREQ=WEEKLY;BYDAY=SU;BYHOUR=8;BYMINUTE=0", undefined, "zh-CN") === "星期日（时间：8:00）" &&
          scheduleLabel("RRULE:FREQ=DAILY;INTERVAL=2", "隔天提醒", "zh-CN") === "隔天提醒" &&
          scheduleLabel("RRULE:FREQ=DAILY;INTERVAL=2", "Every other day", "zh-CN") === "每隔 2 天" &&
          scheduleLabel("RRULE:FREQ=DAILY;INTERVAL=2", "自定义", "en") === "Every 2 days" &&
          scheduleLabel("RRULE:FREQ=DAILY;INTERVAL=2", "隔天提醒", "en") === "Every 2 days",
      )
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
}
