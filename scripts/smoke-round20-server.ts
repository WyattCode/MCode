/**
 * Round 20, section B: the backend's own findings from the round's review.
 *
 * Everything here runs in temporary folders of its own. Nothing reads the
 * user's profile, calls a model or reaches the network.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import JSZip from "jszip"
import type { Check } from "./smoke-round5"
import { labelDelivered, labelHtml, officeAigc } from "../src/server/tool/aigc-label"
import { listExternalSessions, readExternalSession } from "../src/server/external-sessions"
import type { Message, SessionInfo } from "../src/shared/protocol"
import { Bus } from "../src/server/bus"
import { Storage } from "../src/server/storage"
import { SessionStore } from "../src/server/session/store"
import { startHistory, stopHistory } from "../src/server/history/service"

const MODEL = { provider: "anthropic", model: "claude-opus-5" } as const

function asked(sessionID: string, id: string, text: string, at: number): Message {
  return { id, sessionID, role: "user", text, attachments: [], time: { created: at } } as Message
}

async function zipOf(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, text] of Object.entries(parts)) zip.file(name, text)
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

const TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/></Types>`
const rootRels = (main: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>`
/** A custom.xml holding an AIGC property written by another tool, with the given ProduceID. */
const customWith = (produceID: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
  `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="AIGC"><vt:lpwstr>{"Label":"1","ContentProducer":"Other","ProduceID":"${produceID}","ReservedCode1":"","ContentPropagator":"Other","PropagateID":"${produceID}","ReservedCode2":""}</vt:lpwstr></property></Properties>`

/** A one-sheet workbook with the given A1 cell, and optionally a custom.xml. */
const workbook = (a1: string, custom?: string) =>
  zipOf({
    "[Content_Types].xml": TYPES,
    "_rels/.rels": rootRels("xl/workbook.xml"),
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1">${a1}</row><row r="2"><c r="B2"><v>42</v></c></row></sheetData></worksheet>`,
    ...(custom ? { "docProps/custom.xml": custom } : {}),
  })

export async function roundTwentyServerChecks(check: Check, section: (name: string) => void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcode-r20b-"))
  const deps = { python: "", log: () => {} }
  const put = async (name: string, bytes: Buffer | string) => {
    const file = path.join(root, name)
    await fs.writeFile(file, bytes)
    return file
  }
  try {
    // ---------------------------------------------------------------- R20-B1
    section("Round 20 (B1): text already in a delivered file is copied into the label as written, $ patterns and all")
    {
      // A1 holding what String.replace reads as patterns: $& (the match), $' (what follows), $$ and $`.
      const a1Xml = "Price $&amp; total $' and $$5 or $`"
      const sheetFile = await put("dollars.xlsx", await workbook(`<c r="A1" t="inlineStr"><is><t>${a1Xml}</t></is></c>`))
      const sheetOut = await labelDelivered(sheetFile, deps)
      const sheetXml = await (await JSZip.loadAsync(await fs.readFile(sheetFile))).file("xl/worksheets/sheet1.xml")!.async("string")
      const a1 = /<c r="A1"[^>]*>[\s\S]*?<\/c>/.exec(sheetXml)?.[0] ?? ""
      check(
        "R20-B1 xlsx: A1's own text with $ patterns comes back exactly, with the label after it",
        sheetOut.status === "labelled" && a1.includes(`<t xml:space="preserve">${a1Xml} [AI生成]</t>`) && (sheetXml.match(/<c r="A1"/g) ?? []).length === 1,
        { sheetOut, a1 },
      )

      // An AIGC property another tool wrote, whose ProduceID the label keeps.
      const id = "id-$`-$'-$$"
      const keptFile = await put("kept.xlsx", await workbook(`<c r="A1" t="inlineStr"><is><t>plain</t></is></c>`, customWith(id)))
      const keptOut = await labelDelivered(keptFile, deps)
      const kept = await officeAigc(await JSZip.loadAsync(await fs.readFile(keptFile)))
      check("R20-B1 office: a kept ProduceID with $ patterns is written back as it was", keptOut.status === "labelled" && kept?.ProduceID === id && kept?.PropagateID === id, { keptOut, kept })
    }

    // ---------------------------------------------------------------- R20-B5
    section("Round 20 (B5): the page's corner tag goes into the real body, never into a script, a style or a comment")
    {
      const script = `<script>const shell = "<body class='x'>" + '<BODY>'</script>`
      const style = `<style>/* <body> */ p { color: red }</style>`
      const comment = `<!-- an old <body> left here -->`
      const page = `<!doctype html><html><head>${script}${style}${comment}</head><body id="real"><p>hi</p></body></html>`
      const out = labelHtml(page) ?? ""
      const tag = out.indexOf("data-mcode-aigc=")
      const real = out.indexOf('<body id="real">')
      check(
        "R20-B5 html: a <body inside a script, a style or a comment is passed over; the tag follows the real one",
        out.includes(script) && out.includes(style) && out.includes(comment) && real > 0 && tag > real && tag < out.indexOf("<p>hi</p>"),
        out,
      )
      // With no body at all, the head's own close is the place, again not one inside a script.
      const headless = `<html><head><script>let s = "</head>"</script></head><p>x</p></html>`
      const headOut = labelHtml(headless) ?? ""
      check("R20-B5 html: and with no body, a </head> inside a script is passed over too", headOut.includes(`<script>let s = "</head>"</script>`) && headOut.indexOf("data-mcode-aigc=") > headOut.indexOf("</script></head>"), headOut)
    }

    // ---------------------------------------------------------------- R20-B3
    section("Round 20 (B3): another tool's conversations are this project's whatever case its path is written in")
    if (process.platform === "win32" || process.platform === "darwin") {
      const project = path.join(root, "Case Project")
      await fs.mkdir(project, { recursive: true })
      const config = path.join(root, "claude-home")
      const folder = path.join(config, "projects", path.resolve(project).replace(/[^A-Za-z0-9-]/g, "-"))
      await fs.mkdir(folder, { recursive: true })
      const row = { type: "user", cwd: project, timestamp: "2026-09-20T10:00:00Z", message: { content: [{ type: "text", text: "case check" }] } }
      await fs.writeFile(path.join(folder, "sess-case.jsonl"), `${JSON.stringify(row)}\n`, "utf8")
      // The same folder as a window may name it: every letter of the path in the other case.
      const swapped = project.replace(/[A-Za-z]/g, (letter) => (letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()))
      const previous = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = config
      try {
        const listed = listExternalSessions({ project: swapped })
        check("R20-B3 the list finds the conversation when the project's path differs only in case", listed.sessions.some((session) => session.sessionID === "sess-case"), listed)
        const read = readExternalSession({ sessionID: "sess-case", project: swapped })
        check("R20-B3 and reading it is allowed from that project", read?.summary.sessionID === "sess-case", read?.summary)
        const elsewhere = path.join(root, "elsewhere")
        await fs.mkdir(elsewhere, { recursive: true })
        const other = listExternalSessions({ project: elsewhere })
        check("R20-B3 while another project still does not see it", !other.sessions.some((session) => session.sessionID === "sess-case"), other)
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = previous
      }
    }

    // ---------------------------------------------------------------- R20-B4
    section("Round 20 (B4): a long pasted query narrows the search instead of failing it")
    {
      const dataDirectory = path.join(root, "history", "data")
      const project = path.join(root, "history", "project")
      await fs.mkdir(project, { recursive: true })
      const storage = new Storage(path.join(dataDirectory, "storage"))
      const bus = new Bus()
      const sessions = new SessionStore(storage, bus)
      const now = Date.now()
      // Six hundred distinct words: more than SQLite lets one compound SELECT join.
      const words = Array.from({ length: 600 }, (_, i) => `word${i.toString(36).padStart(3, "0")}`)
      const holder = await sessions.create({ directory: project, model: MODEL, title: "Pasted" })
      const lacking = await sessions.create({ directory: project, model: MODEL, title: "Short" })
      const longest = "averyveryverylongpiece"
      await sessions.saveMessage(asked(holder.id, "msg_r20_1", `${words.join(" ")} ${longest}`, now), true)
      await sessions.saveMessage(asked(lacking.id, "msg_r20_2", words.join(" "), now), true)
      const history = await startHistory(dataDirectory, sessions, storage, bus)
      check("R20-B4 the index opened", history !== undefined)
      if (history) {
        try {
          const end = Date.now() + 20_000
          while (history.index.building && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
          await history.index.ready
          await history.index.flush()
          const listed: SessionInfo[] = await sessions.list()
          // Every word twice, in two cases, as a paste of a long log might repeat them.
          const query = [...words, ...words.map((word) => word.toUpperCase()), longest].join(" ")
          const named = await history.index.candidates(query, listed).then(
            (ids) => ids,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          )
          check("R20-B4 a query of 1201 pieces is answered, not an SQL error", Array.isArray(named), named)
          check("R20-B4 and it still names the conversation holding them all", Array.isArray(named) && named.includes(holder.id), named)
          check("R20-B4 while the one lacking its longest piece is left out", Array.isArray(named) && !named.includes(lacking.id), named)
        } finally {
          await stopHistory(history)
        }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
