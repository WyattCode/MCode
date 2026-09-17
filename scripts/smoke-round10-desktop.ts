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
      check("a PDF locate in a conversation not on show marks the passage at once", pdfLocate.value?.snippet === "the passage" && pdfLocate.value.page === 4, pdfLocate.value)
      check("but holds the PDF until the conversation is shown", !rp.tabs.some((tab) => tab.name === "paper.pdf"), tabs())
      shown.add("hidden")
      delivered.deliveryShown("hidden")
      await settle()
      check("and opens it then", rp.tabs.some((tab) => tab.name === "paper.pdf"), tabs())
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
}
