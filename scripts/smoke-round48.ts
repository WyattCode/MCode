/** MiMo update follow-up: directory boundaries, delivery labels and truthful stopped states. */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import JSZip from "jszip"
import type { Check } from "./smoke-round5"
import type { AssistantMessage, SessionInfo, ToolPart } from "../src/shared/protocol"
import { ProjectLocations } from "../src/server/project-location"
import { blankProjectDirectory } from "../src/server/scratch"
import { Config } from "../src/server/config"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import { labelDelivered, officeAigc, wavAigc } from "../src/server/tool/aigc-label"
import { subagentItems } from "../src/renderer/src/lib/subagents"
import { stepState, stepVerb } from "../src/renderer/src/lib/tool-meta"
import { operationKind } from "../src/shared/operation-kind"

const run = promisify(execFile)
const code = async (work: () => Promise<unknown>) => {
  try { await work(); return undefined } catch (error) { return (error as { code?: string }).code }
}

export async function roundFortyEightChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r48-check-"))
  const installation = path.join(root, "installed")
  const safe = path.join(root, "projects")
  await fs.mkdir(installation)
  await fs.mkdir(safe)
  try {
    section("Round 48: project locations checked before writes")
    const locations = new ProjectLocations(installation)
    check("R48: the installation root is rejected", await code(() => locations.assert(installation)) === "error.projectLocationInstall")
    check("R48: a future directory under the installation is rejected", await code(() => locations.assert(path.join(installation, "new", "project"))) === "error.projectLocationInstall")
    check("R48: a same-prefix sibling remains usable", await code(() => locations.assert(installation + "-projects")) === undefined)
    check("R48: relative project locations are refused", await code(() => locations.assert("relative/project")) === "error.projectLocationInvalid")
    const file = path.join(root, "file")
    await fs.writeFile(file, "keep")
    check("R48: a file cannot be selected as a directory", await code(() => locations.assert(file)) === "error.projectLocationInvalid")
    const alias = path.join(root, "alias")
    await fs.symlink(installation, alias, process.platform === "win32" ? "junction" : "dir")
    check("R48: an installation junction with a new leaf is rejected", await code(() => locations.assert(path.join(alias, "future"))) === "error.projectLocationInstall")
    check("R48: blocked blank projects create no files", await code(() => blankProjectDirectory("Denied", installation, locations)) === "error.projectLocationInstall" && !(await fs.stat(path.join(installation, "Denied")).catch(() => undefined)))
    check("R48: automatic task names are reserved", await code(() => blankProjectDirectory("task-20261009-120000", safe, locations)) === "error.projectNameReserved")
    check("R48: Windows device names still become usable project names", path.basename(await blankProjectDirectory("CON", safe, locations)) === "CON project")
    const storage = new Storage(path.join(root, "storage"))
    const config = new Config(storage, new Bus(), path.join(root, "credentials.json"), undefined, installation)
    await config.load()
    await config.set({ projectRoot: safe })
    const before = await fs.readFile(storage.fileOf("config"))
    check("R48: configuration rejects an install root and retains the previous setting", await code(() => config.set({ projectRoot: alias })) === "error.projectLocationInstall" && config.get().projectRoot === safe)
    check("R48: a refused setting leaves the persisted config intact", (await fs.readFile(storage.fileOf("config"))).equals(before))
    check("R48: raw project-list patches cannot bypass the guard", await code(() => config.set({ projects: [installation] })) === "error.projectLocationInstall" && !config.get().projects.includes(installation))

    section("Round 48: visible-label choice retains metadata and content")
    const original = '<!doctype html><html><body><h1>Keep this</h1></body></html>'
    const html = path.join(safe, "page.html")
    await fs.writeFile(html, original)
    const snapshots: string[] = []
    const opts = { removeExplicit: true, python: "", log: () => {}, snapshot: async (target: string) => { snapshots.push(await fs.readFile(target, "utf8")) } }
    const labelled = await labelDelivered(html, opts)
    const bytes = await fs.readFile(html, "utf8")
    check("R48: metadata-only HTML has no visible badge", labelled.status === "labelled" && labelled.explicit === false && labelled.implicit === true && !bytes.includes("data-mcode-aigc"))
    check("R48: HTML metadata and the original content are retained", bytes.includes("<!-- AIGC:") && bytes.includes("<h1>Keep this</h1>") && snapshots[0] === original)
    await labelDelivered(html, opts)
    check("R48: metadata-only repeated delivery is byte-identical", (await fs.readFile(html, "utf8")) === bytes && snapshots.length === 1)
    await labelDelivered(html, { python: "", log: () => {} })
    const visible = await fs.readFile(html)
    check("R48: default policy adds a visible label to a metadata-only page", visible.includes("data-mcode-aigc"))
    await labelDelivered(html, opts)
    check("R48: disabling future labels does not erase an existing one", (await fs.readFile(html)).equals(visible))

    for (const [kind, main, xml] of [
      ["docx", "word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Keep</w:t></w:r></w:p></w:body></w:document>'],
      ["pptx", "ppt/slides/slide1.xml", '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree /></p:cSld></p:sld>'],
      ["xlsx", "xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>'],
    ]) {
      const zip = new JSZip()
      zip.file(main, xml)
      zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>')
      zip.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>')
      const target = path.join(safe, "report." + kind)
      await fs.writeFile(target, await zip.generateAsync({ type: "nodebuffer" }))
      const result = await labelDelivered(target, { removeExplicit: true, python: "", log: () => {} })
      const read = await JSZip.loadAsync(await fs.readFile(target))
      check(`R48: ${kind} keeps the content XML unchanged when visible labels are disabled`, result.status === "labelled" && result.explicit === false && await read.file(main)!.async("string") === xml, result)
      check(`R48: ${kind} still records AI-generated metadata`, (await officeAigc(read))?.Label === "1")
    }
    const wav = Buffer.alloc(44 + 160)
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
    wav.write("data", 36); wav.writeUInt32LE(160, 40)
    const audio = path.join(safe, "voice.wav")
    await fs.writeFile(audio, wav)
    const audioResult = await labelDelivered(audio, { removeExplicit: true, python: "", log: () => {} })
    const audioBytes = await fs.readFile(audio)
    check("R48: disabled visible labels append no tone or audio samples", audioResult.explicit === false && audioBytes.readUInt32LE(40) === 160 && audioBytes.subarray(44, 204).equals(wav.subarray(44)))
    check("R48: audio still carries AI-generated metadata", wavAigc(audioBytes)?.Label === "1")

    const python = process.env.MCODE_PYTHON || path.join(process.cwd(), "resources/runtimes", `${process.platform}-${process.arch}`, "python", process.platform === "win32" ? "python.exe" : "bin/python3")
    if (await fs.stat(python).catch(() => undefined)) {
      const pdf = path.join(safe, "page.pdf")
      await run(python, ["-c", "from pypdf import PdfWriter; import sys; w=PdfWriter(); w.add_blank_page(width=300,height=300); w.write(sys.argv[1])", pdf], { windowsHide: true })
      const outcome = await labelDelivered(pdf, { removeExplicit: true, python, log: () => {} })
      const read = await run(python, ["-c", "from pypdf import PdfReader; import sys,json; r=PdfReader(sys.argv[1]); print(json.dumps({'pages':len(r.pages),'metadata':dict(r.metadata),'text':r.pages[0].extract_text()}))", pdf], { windowsHide: true })
      const info = JSON.parse(read.stdout)
      check("R48: metadata-only PDF has a readable page and no visible overlay", outcome.status === "labelled" && outcome.explicit === false && info.pages === 1 && !info.text.trim() && info.metadata["/AIGC"])
      const beforePdf = await fs.readFile(pdf)
      await labelDelivered(pdf, { removeExplicit: true, python, log: () => {} })
      check("R48: metadata-only repeated PDF delivery is byte-identical", (await fs.readFile(pdf)).equals(beforePdf))
    }

    section("Round 48: stopped actors and operation kinds")
    const part: ToolPart = { type: "tool", callID: "call", name: "actor", status: "completed", input: { action: "spawn", description: "Worker" }, output: "started", time: { created: 1, completed: 2 } }
    const message = { id: "message", sessionID: "parent", role: "assistant", parts: [part], time: { created: 1 }, finish: "end_turn" } as AssistantMessage
    const child = { id: "child", parentID: "parent", parentCallID: "call", title: "Worker", model: { provider: "", model: "" }, subagent: { id: "worker", type: "general", status: "idle" }, time: { created: 1, updated: 2 } } as SessionInfo
    check("R48: an idle actor without an outcome is stopped", subagentItems([message], [child])[0]?.status === "stopped")
    child.subagent!.outcome = "cancelled"
    check("R48: explicit cancellation retains its own rejected state", subagentItems([message], [child])[0]?.status === "rejected")
    const interrupted = { ...part, status: "error", metadata: { aborted: true, interrupted: true } } as ToolPart
    check("R48: interrupted tool calls read incomplete rather than still running", stepState(interrupted) === "incomplete" && stepVerb(interrupted, "incomplete") !== "toolLabel.incomplete")
    check("R48: incomplete actors are stopped", subagentItems([{ ...message, parts: [interrupted] }], [child])[0]?.status === "stopped")
    const app = { ...part, name: "app", input: { action: "open" } }
    check("R48: browser control is marked", operationKind(app) === "browser")
    check("R48: native and Electron app control is marked computer", operationKind({ ...app, input: { action: "attach" } }) === "computer")
    check("R48: later actions retain the active surface", operationKind({ ...app, input: { action: "do" } }, "browser") === "browser")
    check("R48: network fetches do not pretend to control a browser", operationKind({ ...app, name: "webfetch" }, "browser") === undefined)
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected check root")
    await fs.rm(root, { recursive: true, force: true })
  }
}
