import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import JSZip from "jszip"
import { writeAtomic } from "../storage"
import { appDataRefusal } from "./app-data"

/*
 * The AI-generated label on files the model hands over (R18-A1).
 *
 * MiMo 26.920 rewrites every file a present_files call delivers so that it
 * carries China's AI-generated content label (the 标识办法 and GB 45438-2025),
 * and the user chose to do the same, with no switch. There are two halves, as
 * the standard has them:
 *
 * - an explicit label a person sees or hears: a line of text in a Word
 *   document, a slide, a sheet, a PDF and a web page, and a tone at the end of
 *   a WAV recording in the standard's rhythm for "AI", short-long short-short;
 * - an implicit label in the file's metadata: the standard's seven fields
 *   (Label "1" for generated, the producer and propagator, and an id), under
 *   the key the standard names, AIGC, in the place each format keeps
 *   metadata - an Office custom property, the PDF information dictionary, XMP
 *   (and EXIF where there is none) in a picture, an ID3 frame in an MP3, a RIFF
 *   INFO entry in a WAV.
 *
 * The field names, their order, Label "1", the rhythm and the XMP namespace are
 * the standard's. The wording around the label, where it sits, how it looks,
 * the tone's pitch and level and the producer name are MCode's own.
 *
 * A file is never corrupted by this. The new bytes are built in memory, checked
 * by parsing them again (and, where the bundled Python has the library, by
 * opening them with it), written to a temp file beside the original, read back
 * and renamed over it. A file that changed while this ran, one that is too big
 * or read-only, one in the app's own data folder, and one whose format this
 * cannot rewrite safely are left exactly as they were, with a line in the log.
 */

/** The visible label: the regulatory wording itself. */
export const AIGC_TEXT = "AI生成"
/** Who is named as producer and propagator: the standard takes the service's name or its registered code. */
export const AIGC_PRODUCER = "MCode"
/** The standard's field order. */
export const AIGC_FIELDS = ["Label", "ContentProducer", "ProduceID", "ReservedCode1", "ContentPropagator", "PropagateID", "ReservedCode2"] as const
/** The XMP namespace the standard's practice guide gives the AIGC property. */
export const AIGC_XMP_NS = "http://www.tc260.org.cn/ns/aigc/1.0/"
/** Past this a file is left alone: it is read whole, and a delivered file this big is not a document. */
export const AIGC_MAX_BYTES = 256 * 1024 * 1024

export type AigcFields = Record<(typeof AIGC_FIELDS)[number], string>
export type AigcKind = "docx" | "pptx" | "xlsx" | "pdf" | "html" | "wav" | "mp3" | "png" | "jpeg"

/** What labelling one file did. `explicit` and `implicit` are true when that half is on the file afterwards. */
export interface AigcOutcome {
  path: string
  kind?: AigcKind
  /** "labelled" rewrote it; "present" found both halves already there; "skipped" left it as it was. */
  status: "labelled" | "present" | "skipped"
  explicit?: boolean
  implicit?: boolean
  reason?: string
}

/** Which labeller a file goes to, by its extension; anything else is not labelled. */
export function aigcKind(file: string): AigcKind | undefined {
  const name = file.toLowerCase()
  const extension = name.slice(name.lastIndexOf(".") + 1)
  if (extension === "docx" || extension === "pptx" || extension === "xlsx" || extension === "pdf" || extension === "wav" || extension === "mp3" || extension === "png") return extension
  if (extension === "html" || extension === "htm") return "html"
  if (extension === "jpg" || extension === "jpeg") return "jpeg"
  return undefined
}

/** A fresh set of fields, keeping the id a file already carries so delivering it again does not make it another piece of content. */
export function aigcFields(existing?: Partial<AigcFields>): AigcFields {
  const id = existing?.ProduceID?.trim() || `mcode-${randomUUID()}`
  return {
    Label: "1",
    ContentProducer: existing?.ContentProducer?.trim() || AIGC_PRODUCER,
    ProduceID: id,
    ReservedCode1: existing?.ReservedCode1 ?? "",
    ContentPropagator: AIGC_PRODUCER,
    PropagateID: existing?.PropagateID?.trim() || id,
    ReservedCode2: existing?.ReservedCode2 ?? "",
  }
}

/** The fields as JSON, in the standard's order. `wrapped` puts them under an AIGC key, for a carrier that has no key of its own. */
export function aigcJson(fields: AigcFields, wrapped = false): string {
  const flat: Record<string, string> = {}
  for (const key of AIGC_FIELDS) flat[key] = fields[key]
  return JSON.stringify(wrapped ? { AIGC: flat } : flat)
}

const unescapeXml = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&")
const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** The fields out of a stored value, flat or under an AIGC key; nothing when it is not one. */
export function parseAigc(text: string | undefined): AigcFields | undefined {
  if (!text) return undefined
  for (const candidate of [text, unescapeXml(text)]) {
    try {
      let value = JSON.parse(candidate.trim())
      if (value && typeof value === "object" && value.AIGC && typeof value.AIGC === "object") value = value.AIGC
      if (value && typeof value === "object" && typeof value.Label === "string" && typeof value.ProduceID === "string") return value as AigcFields
    } catch {
      // not JSON in this spelling
    }
  }
  return undefined
}

// ------------------------------------------------------------------ checking

/**
 * Whether an XML document is well formed, as far as a rewrite could break it:
 * every tag closed in order, attributes quoted, no stray `<` or `&`. It is not
 * a validating parser; it is what catches a splice that went wrong.
 */
export function wellFormedXml(xml: string): boolean {
  const stack: string[] = []
  let at = 0
  let root = false
  const text = (chunk: string) => !/&(?!(?:[A-Za-z][\w.-]*|#\d+|#x[0-9A-Fa-f]+);)/.test(chunk)
  while (at < xml.length) {
    const open = xml.indexOf("<", at)
    if (open < 0) return text(xml.slice(at)) && stack.length === 0 && root
    if (!text(xml.slice(at, open))) return false
    if (xml.startsWith("<?", open)) {
      const end = xml.indexOf("?>", open)
      if (end < 0) return false
      at = end + 2
    } else if (xml.startsWith("<!--", open)) {
      const end = xml.indexOf("-->", open)
      if (end < 0) return false
      at = end + 3
    } else if (xml.startsWith("<![CDATA[", open)) {
      const end = xml.indexOf("]]>", open)
      if (end < 0) return false
      at = end + 3
    } else if (xml.startsWith("<!", open)) {
      const end = xml.indexOf(">", open)
      if (end < 0) return false
      at = end + 1
    } else {
      const tag = /^<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/.exec(xml.slice(open))
      if (!tag) return false
      const [whole, closing, name, , selfClosing] = tag
      if (closing) {
        if (stack.pop() !== name) return false
      } else if (!selfClosing) {
        if (!stack.length && root) return false
        stack.push(name)
        root = true
      } else if (!stack.length) {
        if (root) return false
        root = true
      }
      at = open + whole.length
    }
  }
  return stack.length === 0 && root
}

/** The bundled Python, when there is one; the document libraries are installed in it. */
export function bundledPython(): string | undefined {
  return process.env.MCODE_PYTHON || undefined
}

/**
 * Everything the labeller asks Python for: opening a rewritten Office file or
 * PDF with the library a reader of it would use, and the PDF rewrite itself.
 */
const PYTHON = String.raw`
import sys, json

def check(kind, path):
    if kind == "docx":
        import docx
        docx.Document(path)
    elif kind == "pptx":
        import pptx
        pptx.Presentation(path)
    elif kind == "xlsx":
        import openpyxl
        openpyxl.load_workbook(path, read_only=True).close()
    elif kind == "pdf":
        from pypdf import PdfReader
        reader = PdfReader(path)
        for page in reader.pages:
            page.mediabox

def pdf(source, target, text, value):
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, TextStringObject
    reader = PdfReader(source)
    if reader.is_encrypted:
        return {"ok": False, "reason": "encrypted"}
    if not reader.pages:
        return {"ok": False, "reason": "empty"}
    info = reader.metadata or {}
    if "/AIGC" in info:
        return {"ok": True, "present": True, "value": str(info["/AIGC"])}
    import io
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    writer = PdfWriter(clone_from=reader)
    last = writer.pages[-1]
    box = last.mediabox
    left, bottom, width, height = float(box.left), float(box.bottom), float(box.width), float(box.height)
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    size = 8
    buffer = io.BytesIO()
    sheet = canvas.Canvas(buffer, pagesize=(left + width, bottom + height))
    sheet.setFont("STSong-Light", size)
    sheet.setFillGray(0.5)
    margin = min(18.0, width * 0.04)
    sheet.drawRightString(left + width - margin, bottom + max(8.0, margin * 0.6), text)
    sheet.showPage()
    sheet.save()
    buffer.seek(0)
    last.merge_page(PdfReader(buffer).pages[0])
    if writer._info is None:
        # A PDF without an information dictionary gets one.
        writer._info = DictionaryObject()
    writer.add_metadata({NameObject("/AIGC"): TextStringObject(value)})
    with open(target, "wb") as handle:
        writer.write(handle)
    again = PdfReader(target)
    if len(again.pages) != len(reader.pages):
        return {"ok": False, "reason": "page-count"}
    if str((again.metadata or {}).get("/AIGC")) != value:
        return {"ok": False, "reason": "metadata-lost"}
    return {"ok": True, "present": False}

try:
    if sys.argv[1] == "check":
        check(sys.argv[2], sys.argv[3])
        print(json.dumps({"ok": True}))
    else:
        print(json.dumps(pdf(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])))
except Exception as error:
    print(json.dumps({"ok": False, "reason": (type(error).__name__ + ": " + str(error))[:240]}))
`

/** Runs the labeller's Python with arguments, answering its one line of JSON. */
async function runPython(python: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; reason?: string; present?: boolean; value?: string }> {
  return new Promise((resolve) => {
    const child = spawn(python, ["-c", PYTHON, ...args], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } })
    let out = ""
    let err = ""
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (err += chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: `python: ${error.message}` })
    })
    child.on("close", () => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).pop() ?? ""
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, reason: (err || out || "python gave no answer").trim().slice(0, 240) })
      }
    })
  })
}

// ------------------------------------------------------------------ office

const CUSTOM_PART = "docProps/custom.xml"
const CUSTOM_TYPE = "application/vnd.openxmlformats-officedocument.custom-properties+xml"
const CUSTOM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties"
/** The format id every user-defined Office property carries. */
const USER_PROPERTY_FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"
/** What names MCode's own visible label inside a document, so it is found again. */
const MARK_NAME = "_MCodeAigc"
const SHAPE_NAME = "MCode AIGC label"

async function zipText(zip: JSZip, name: string): Promise<string | undefined> {
  const entry = zip.file(name)
  return entry ? entry.async("string") : undefined
}

/** The AIGC custom property, read out of an Office package. */
export async function officeAigc(zip: JSZip): Promise<AigcFields | undefined> {
  const custom = await zipText(zip, CUSTOM_PART)
  const property = custom && /<property\b[^>]*\bname="AIGC"[^>]*>([\s\S]*?)<\/property>/.exec(custom)
  if (!property) return undefined
  const value = /<vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>/.exec(property[1])?.[1] ?? ""
  return parseAigc(value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1"))
}

/** Writes the AIGC custom property into a package, replacing an earlier one and registering the part where it is new. */
async function setOfficeAigc(zip: JSZip, fields: AigcFields): Promise<string[]> {
  const changed: string[] = []
  const value = escapeXml(aigcJson(fields))
  const custom = await zipText(zip, CUSTOM_PART)
  if (custom) {
    const pids = [...custom.matchAll(/\bpid="(\d+)"/g)].map((match) => Number(match[1]))
    const existing = /<property\b[^>]*\bname="AIGC"[^>]*>[\s\S]*?<\/property>/.exec(custom)
    const pid = existing ? /\bpid="(\d+)"/.exec(existing[0])?.[1] ?? String(Math.max(1, ...pids) + 1) : String(Math.max(1, ...pids) + 1)
    const property = `<property fmtid="${USER_PROPERTY_FMTID}" pid="${pid}" name="AIGC"><vt:lpwstr>${value}</vt:lpwstr></property>`
    let next: string
    if (existing) next = custom.replace(existing[0], () => property)
    else if (/<Properties\b[^>]*\/>/.test(custom)) next = custom.replace(/<Properties\b([^>]*)\/>/, (_, attributes: string) => `<Properties${attributes}>${property}</Properties>`)
    else if (custom.includes("</Properties>")) next = custom.replace("</Properties>", () => `${property}</Properties>`)
    else throw new Error("docProps/custom.xml has no Properties element")
    if (!/xmlns:vt=/.test(next)) throw new Error("docProps/custom.xml does not declare the vt prefix")
    zip.file(CUSTOM_PART, next)
  } else {
    const property = `<property fmtid="${USER_PROPERTY_FMTID}" pid="2" name="AIGC"><vt:lpwstr>${value}</vt:lpwstr></property>`
    zip.file(
      CUSTOM_PART,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${property}</Properties>`,
    )
  }
  changed.push(CUSTOM_PART)
  const types = await zipText(zip, "[Content_Types].xml")
  if (!types) throw new Error("the package has no [Content_Types].xml")
  if (!/PartName="\/docProps\/custom\.xml"/i.test(types)) {
    if (!types.includes("</Types>")) throw new Error("[Content_Types].xml has no Types element")
    zip.file("[Content_Types].xml", types.replace("</Types>", `<Override PartName="/docProps/custom.xml" ContentType="${CUSTOM_TYPE}"/></Types>`))
    changed.push("[Content_Types].xml")
  }
  const rels = await zipText(zip, "_rels/.rels")
  if (!rels) throw new Error("the package has no _rels/.rels")
  if (!/Target="\/?docProps\/custom\.xml"/i.test(rels)) {
    if (!rels.includes("</Relationships>")) throw new Error("_rels/.rels has no Relationships element")
    const ids = new Set([...rels.matchAll(/\bId="([^"]+)"/g)].map((match) => match[1]))
    let n = ids.size + 1
    while (ids.has(`rId${n}`)) n += 1
    zip.file("_rels/.rels", rels.replace("</Relationships>", `<Relationship Id="rId${n}" Type="${CUSTOM_REL}" Target="docProps/custom.xml"/></Relationships>`))
    changed.push("_rels/.rels")
  }
  return changed
}

/** The largest numeric id attribute of a given name in a part, so a new one can follow it. */
const maxId = (xml: string, attribute: string) => Math.max(0, ...[...xml.matchAll(new RegExp(`\\b${attribute}="(\\d+)"`, "g"))].map((match) => Number(match[1])))

/** Word: a closing paragraph, right-aligned in small grey type, bookmarked so it is found again. */
function docxExplicit(document: string): string | undefined {
  if (document.includes(`w:name="${MARK_NAME}"`)) return undefined
  if (!/xmlns:w="http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main"/.test(document)) throw new Error("word/document.xml does not use the w prefix")
  const bodyEnd = document.lastIndexOf("</w:body>")
  if (bodyEnd < 0) throw new Error("word/document.xml has no body")
  // The body's own section properties close the body; the paragraph goes before them.
  const section = document.lastIndexOf("<w:sectPr", bodyEnd)
  let at = bodyEnd
  if (section >= 0) {
    const selfClosed = /^<w:sectPr\b[^>]*\/>/.exec(document.slice(section))
    const close = selfClosed ? section + selfClosed[0].length : document.indexOf("</w:sectPr>", section) + "</w:sectPr>".length
    if (close > section && !document.slice(close, bodyEnd).trim()) at = section
  }
  const id = maxId(document, "w:id") + 1
  const paragraph =
    `<w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:bookmarkStart w:id="${id}" w:name="${MARK_NAME}"/>` +
    `<w:r><w:rPr><w:color w:val="808080"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t>${AIGC_TEXT}</w:t></w:r>` +
    `<w:bookmarkEnd w:id="${id}"/></w:p>`
  return document.slice(0, at) + paragraph + document.slice(at)
}

/** Where a relationship's target sits in the package, from the part that names it. */
function partPath(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1)
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), target))
}

/** The part a relationship id points at, out of a part's .rels. */
async function relationTarget(zip: JSZip, part: string, id: string): Promise<string | undefined> {
  const rels = await zipText(zip, path.posix.join(path.posix.dirname(part), "_rels", `${path.posix.basename(part)}.rels`))
  const match = rels && new RegExp(`<Relationship\\b[^>]*\\bId="${id}"[^>]*>`).exec(rels)
  const target = match && /\bTarget="([^"]+)"/.exec(match[0])?.[1]
  return target ? partPath(part, target) : undefined
}

/** PowerPoint: a small grey text box in the bottom-right corner of the last slide. */
async function pptxExplicit(zip: JSZip): Promise<{ part: string; xml: string } | undefined> {
  const presentation = await zipText(zip, "ppt/presentation.xml")
  if (!presentation) throw new Error("the package has no ppt/presentation.xml")
  const ids = [...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((match) => match[1])
  if (!ids.length) throw new Error("the presentation has no slides")
  const part = await relationTarget(zip, "ppt/presentation.xml", ids[ids.length - 1])
  const slide = part && (await zipText(zip, part))
  if (!part || !slide) throw new Error("the last slide cannot be found")
  if (slide.includes(`name="${SHAPE_NAME}"`)) return undefined
  if (!/xmlns:a="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/main"/.test(slide) || !/xmlns:p="/.test(slide)) throw new Error("the slide does not use the p and a prefixes")
  const size = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(presentation)
  const cx = size ? Number(size[1]) : 12192000
  const cy = size ? Number(size[2]) : 6858000
  const width = Math.round(cx * 0.12)
  const height = Math.round(cy * 0.035)
  const x = cx - width - Math.round(cx * 0.015)
  const y = cy - height - Math.round(cy * 0.015)
  const close = slide.lastIndexOf("</p:spTree>")
  if (close < 0) throw new Error("the slide has no shape tree")
  const shape =
    `<p:sp><p:nvSpPr><p:cNvPr id="${maxId(slide, "id") + 1}" name="${SHAPE_NAME}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="b"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
    `<a:p><a:pPr algn="r"/><a:r><a:rPr lang="zh-CN" sz="1000"><a:solidFill><a:srgbClr val="808080"/></a:solidFill></a:rPr><a:t>${AIGC_TEXT}</a:t></a:r></a:p></p:txBody></p:sp>`
  return { part, xml: slide.slice(0, close) + shape + slide.slice(close) }
}

/** The text of a shared string or an inline string: its t elements, joined. */
const runsText = (xml: string) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((match) => unescapeXml(match[1] ?? "")).join("")

/** What the label adds to the text already in A1. */
const A1_SUFFIX = ` [${AIGC_TEXT}]`

/**
 * Excel: the label in cell A1 of the sheet the workbook opens on - the cell
 * alone when it is empty, after its text when it holds text. A number, a date
 * or a formula there is not turned into text: the sheet keeps the metadata
 * and A1 is left as it is.
 */
async function xlsxExplicit(zip: JSZip): Promise<{ part: string; xml: string } | { skip: string } | undefined> {
  const workbook = await zipText(zip, "xl/workbook.xml")
  if (!workbook) throw new Error("the package has no xl/workbook.xml")
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((match) => /\br:id="([^"]+)"/.exec(match[0])?.[1]).filter((id): id is string => !!id)
  if (!sheets.length) throw new Error("the workbook has no sheets")
  const active = Number(/<workbookView\b[^>]*\bactiveTab="(\d+)"/.exec(workbook)?.[1] ?? 0)
  const part = await relationTarget(zip, "xl/workbook.xml", sheets[Math.min(active, sheets.length - 1)])
  const sheet = part && (await zipText(zip, part))
  if (!part || !sheet) throw new Error("the active sheet cannot be found")
  const inline = (text: string, style: string) => `<c r="A1"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`
  const cell = /<c\b(?=[^>]*\br="A1")[^>]*?(?:\/>|>[\s\S]*?<\/c>)/.exec(sheet)
  let next: string
  if (cell) {
    const head = /^<c\b[^>]*?\/?>/.exec(cell[0])![0]
    const style = /\bs="\d+"/.exec(head)?.[0]
    const styleAttr = style ? ` ${style}` : ""
    const type = /\bt="([^"]+)"/.exec(head)?.[1]
    const body = cell[0].slice(head.length)
    if (/<f\b/.test(body)) return { skip: "a1-formula" }
    let text: string
    if (type === "s") {
      const index = Number(/<v>(\d+)<\/v>/.exec(body)?.[1])
      const shared = await zipText(zip, "xl/sharedStrings.xml")
      const item = shared ? [...shared.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)][index] : undefined
      if (!item) throw new Error("A1 names a shared string that is not there")
      text = runsText(item[1] ?? "")
    } else if (type === "inlineStr") {
      text = runsText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "")
    } else if (/<v>/.test(body)) {
      return { skip: "a1-not-text" }
    } else {
      text = ""
    }
    if (text.includes(AIGC_TEXT)) return undefined
    next = sheet.replace(cell[0], () => inline(text ? text + A1_SUFFIX : AIGC_TEXT, styleAttr))
  } else {
    const row = /<row\b(?=[^>]*\br="1")[^>]*?(\/?)>/.exec(sheet)
    if (row) {
      const opened = row[0].replace(/\s+spans="[^"]*"/, "").replace(/\/>$/, ">")
      next = sheet.replace(row[0], () => opened + inline(AIGC_TEXT, "") + (row[1] ? "</row>" : ""))
    } else if (/<sheetData\s*\/>/.test(sheet)) {
      next = sheet.replace(/<sheetData\s*\/>/, `<sheetData><row r="1">${inline(AIGC_TEXT, "")}</row></sheetData>`)
    } else if (/<sheetData\b[^>]*>/.test(sheet)) {
      next = sheet.replace(/<sheetData\b[^>]*>/, (open) => `${open}<row r="1">${inline(AIGC_TEXT, "")}</row>`)
    } else {
      throw new Error("the sheet has no sheetData")
    }
    // The used range has to reach A1 now.
    next = next.replace(/<dimension\b[^>]*\bref="([^"]+)"/, (whole, ref: string) => whole.replace(ref, `A1:${ref.split(":").pop()}`))
  }
  return { part, xml: next }
}

/** Rewrites an Office package: the visible label where it is missing, and the AIGC property. */
async function labelOffice(kind: "docx" | "pptx" | "xlsx", bytes: Buffer): Promise<{ bytes?: Buffer; explicit: boolean; reason?: string; changed: string[]; before: string[] }> {
  const zip = await JSZip.loadAsync(bytes)
  const before = Object.keys(zip.files).sort()
  const existing = await officeAigc(zip)
  const changed: string[] = []
  let explicit = true
  let reason: string | undefined
  if (kind === "docx") {
    const document = await zipText(zip, "word/document.xml")
    if (!document) throw new Error("the package has no word/document.xml")
    const next = docxExplicit(document)
    if (next) {
      zip.file("word/document.xml", next)
      changed.push("word/document.xml")
    }
  } else if (kind === "pptx") {
    const next = await pptxExplicit(zip)
    if (next) {
      zip.file(next.part, next.xml)
      changed.push(next.part)
    }
  } else {
    const next = await xlsxExplicit(zip)
    if (next && "skip" in next) {
      explicit = false
      reason = next.skip
    } else if (next) {
      zip.file(next.part, next.xml)
      changed.push(next.part)
    }
  }
  const current = existing && existing.Label === "1" && existing.ContentPropagator === AIGC_PRODUCER
  if (!changed.length && current) return { explicit, reason, changed, before }
  changed.push(...(await setOfficeAigc(zip, aigcFields(existing))))
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  return { bytes: out, explicit, reason, changed, before }
}

/** Opens a rewritten package again and checks every part it touched, and that nothing else went missing. */
async function checkOffice(bytes: Buffer, changed: string[], before: string[]): Promise<void> {
  const zip = await JSZip.loadAsync(bytes)
  const after = new Set(Object.keys(zip.files))
  for (const name of before) if (!after.has(name)) throw new Error(`${name} went missing`)
  for (const name of changed) {
    const xml = await zipText(zip, name)
    if (!xml || !wellFormedXml(xml)) throw new Error(`${name} is not well formed after the rewrite`)
  }
  if (!(await officeAigc(zip))) throw new Error("the AIGC property cannot be read back")
}

// ------------------------------------------------------------------ html

const HTML_MARK = "data-mcode-aigc"
const HTML_COMMENT = `<!-- AIGC: ${AIGC_TEXT} - the contents of this page were generated by AI -->`
/** A small tag in the page's corner that stays out of the page's own layout and clicks. */
const HTML_BADGE =
  `<div ${HTML_MARK}="1" aria-label="${AIGC_TEXT}" style="position:fixed;right:8px;bottom:6px;z-index:2147483647;` +
  `padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.45);color:#fff;font:11px/1.5 system-ui,sans-serif;pointer-events:none">${AIGC_TEXT}</div>`

/**
 * The page with every comment and every element whose contents are text, not
 * tags (a script, a style, a title...), blanked to spaces of the same length:
 * a `<body>` written inside one is not the page's body, and the tag spliced
 * there would break the script or show as text.
 */
const markupOnly = (text: string) =>
  text.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, (range) => " ".repeat(range.length))

/** A web page: the corner tag at the top of the body, and a comment after the doctype. */
export function labelHtml(html: string): string | undefined {
  if (html.includes(HTML_MARK)) return undefined
  const bom = html.startsWith("\uFEFF") ? "\uFEFF" : ""
  let text = html.slice(bom.length)
  const markup = markupOnly(text)
  const body = /<body\b[^>]*>/i.exec(markup)
  if (body) {
    const at = body.index + body[0].length
    text = `${text.slice(0, at)}\n${HTML_BADGE}${text.slice(at)}`
  } else {
    const head = /<\/head\s*>/i.exec(markup)
    const opener = head ?? /<html\b[^>]*>/i.exec(markup) ?? /<!doctype\b[^>]*>/i.exec(markup)
    const at = opener ? opener.index + opener[0].length : 0
    text = at ? `${text.slice(0, at)}\n${HTML_BADGE}${text.slice(at)}` : `${HTML_BADGE}\n${text}`
  }
  const doctype = /^\s*<!doctype\b[^>]*>/i.exec(text)
  const at = doctype ? doctype[0].length : 0
  text = at ? `${text.slice(0, at)}\n${HTML_COMMENT}${text.slice(at)}` : `${HTML_COMMENT}\n${text}`
  return bom + text
}

// ------------------------------------------------------------------ wav

/**
 * The tone: the standard's rhythm for "AI" (short-long, short-short, a dash
 * three units long, letters three units apart), at MCode's pitch, speed and
 * level - 1.2 kHz, 80 ms units, a quarter of full scale - after a short pause,
 * with soft edges so it does not click.
 */
export const AIGC_TONE = {
  frequencyHz: 1200,
  unitMs: 80,
  amplitude: 0.25,
  leadInMs: 300,
  tailMs: 200,
  rampMs: 5,
  /** On and off, in units: dot, gap, dash, letter gap, dot, gap, dot. */
  pattern: [1, -1, 3, -3, 1, -1, 1],
} as const

interface WavChunk {
  id: string
  start: number
  size: number
}

function wavChunks(bytes: Buffer): WavChunk[] {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") throw new Error("not a RIFF/WAVE file")
  const chunks: WavChunk[] = []
  let at = 12
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("latin1", at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    if (at + 8 + size > bytes.length) throw new Error(`the ${id} chunk runs past the end of the file`)
    chunks.push({ id, start: at, size })
    at += 8 + size + (size % 2)
  }
  return chunks
}

interface WavFormat {
  channels: number
  sampleRate: number
  bits: number
  pcm: boolean
}

function wavFormat(bytes: Buffer, chunks: WavChunk[]): WavFormat {
  const fmt = chunks.find((chunk) => chunk.id === "fmt ")
  if (!fmt || fmt.size < 16) throw new Error("the file has no fmt chunk")
  const body = fmt.start + 8
  const tag = bytes.readUInt16LE(body)
  // WAVE_FORMAT_EXTENSIBLE names its real format in the first two bytes of its sub-format GUID.
  const real = tag === 0xfffe && fmt.size >= 40 ? bytes.readUInt16LE(body + 24) : tag
  return { channels: bytes.readUInt16LE(body + 2), sampleRate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14), pcm: real === 1 }
}

/** The tone as 16-bit PCM frames at a file's rate and channel count. */
export function aigcTone(sampleRate: number, channels: number): Buffer {
  const { frequencyHz, unitMs, amplitude, leadInMs, tailMs, rampMs, pattern } = AIGC_TONE
  const frames = (ms: number) => Math.round((sampleRate * ms) / 1000)
  const parts: Buffer[] = [Buffer.alloc(frames(leadInMs) * channels * 2)]
  const ramp = Math.max(1, frames(rampMs))
  for (const step of pattern) {
    const count = frames(Math.abs(step) * unitMs)
    const block = Buffer.alloc(count * channels * 2)
    if (step > 0) {
      for (let i = 0; i < count; i++) {
        const edge = Math.min(1, i / ramp, (count - 1 - i) / ramp)
        const envelope = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, edge))
        const sample = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude * envelope * 32767)
        for (let c = 0; c < channels; c++) block.writeInt16LE(sample, (i * channels + c) * 2)
      }
    }
    parts.push(block)
  }
  parts.push(Buffer.alloc(frames(tailMs) * channels * 2))
  return Buffer.concat(parts)
}

/** The tone's strength at its own pitch over a stretch of channel 0, 0 to about 1 of full scale. */
function toneLevel(samples: Buffer, channels: number, sampleRate: number, from: number, count: number): number {
  const w = (2 * Math.PI * AIGC_TONE.frequencyHz) / sampleRate
  let re = 0
  let im = 0
  for (let i = 0; i < count; i++) {
    const at = (from + i) * channels * 2
    if (at < 0 || at + 2 > samples.length) return 0
    const value = samples.readInt16LE(at) / 32767
    re += value * Math.cos(w * i)
    im += value * Math.sin(w * i)
  }
  return (2 * Math.hypot(re, im)) / count
}

/** Whether a recording already ends with the tone: each unit of the rhythm is checked where it has to be. */
export function endsWithTone(samples: Buffer, channels: number, sampleRate: number): boolean {
  const frames = (ms: number) => Math.round((sampleRate * ms) / 1000)
  const total = Math.floor(samples.length / (channels * 2))
  let at = total - frames(AIGC_TONE.tailMs)
  const units: boolean[] = []
  for (const step of AIGC_TONE.pattern) for (let i = 0; i < Math.abs(step); i++) units.push(step > 0)
  const unit = frames(AIGC_TONE.unitMs)
  at -= units.length * unit
  if (at < 0) return false
  // Allow for rounding of each block, which the builder does per step.
  const starts: number[] = []
  let cursor = at
  for (const step of AIGC_TONE.pattern) {
    const count = frames(Math.abs(step) * AIGC_TONE.unitMs)
    for (let i = 0; i < Math.abs(step); i++) starts.push(cursor + Math.round((i * count) / Math.abs(step)))
    cursor += count
  }
  const window = Math.max(8, Math.round(unit * 0.6))
  return units.every((on, i) => {
    const level = toneLevel(samples, channels, sampleRate, starts[i] + Math.round((unit - window) / 2), window)
    return on ? level > AIGC_TONE.amplitude * 0.5 : level < AIGC_TONE.amplitude * 0.1
  })
}

/** The AIGC entry of a WAV file's INFO list. */
export function wavAigc(bytes: Buffer): AigcFields | undefined {
  for (const chunk of wavChunks(bytes)) {
    if (chunk.id !== "LIST" || bytes.toString("latin1", chunk.start + 8, chunk.start + 12) !== "INFO") continue
    let at = chunk.start + 12
    const end = chunk.start + 8 + chunk.size
    while (at + 8 <= end) {
      const id = bytes.toString("latin1", at, at + 4)
      const size = bytes.readUInt32LE(at + 4)
      if (id === "AIGC") return parseAigc(bytes.toString("utf8", at + 8, at + 8 + size).replace(/\0+$/, ""))
      at += 8 + size + (size % 2)
    }
  }
  return undefined
}

const riffChunk = (id: string, body: Buffer) => {
  const head = Buffer.alloc(8)
  head.write(id, 0, "latin1")
  head.writeUInt32LE(body.length, 4)
  return Buffer.concat(body.length % 2 ? [head, body, Buffer.alloc(1)] : [head, body])
}

/** A WAV recording: the tone appended to its samples, and the AIGC entry in its INFO list (the other entries kept). */
function labelWav(bytes: Buffer): { bytes?: Buffer; explicit: boolean; reason?: string } {
  const chunks = wavChunks(bytes)
  const format = wavFormat(bytes, chunks)
  const data = chunks.find((chunk) => chunk.id === "data")
  if (!data) throw new Error("the file has no data chunk")
  const samples = bytes.subarray(data.start + 8, data.start + 8 + data.size)
  const toneable = format.pcm && format.bits === 16 && format.channels > 0 && format.sampleRate >= 8000
  const hasTone = toneable && endsWithTone(samples, format.channels, format.sampleRate)
  const existing = wavAigc(bytes)
  if ((hasTone || !toneable) && existing?.ContentPropagator === AIGC_PRODUCER) return { explicit: hasTone, reason: toneable ? undefined : "wav-encoding" }
  const entry = riffChunk("AIGC", Buffer.from(`${aigcJson(aigcFields(existing))}\0`, "utf8"))
  const out: Buffer[] = []
  let listed = false
  for (const chunk of chunks) {
    if (chunk.id === "data") {
      out.push(riffChunk("data", toneable && !hasTone ? Buffer.concat([samples, aigcTone(format.sampleRate, format.channels)]) : samples))
    } else if (chunk.id === "LIST" && !listed && bytes.toString("latin1", chunk.start + 8, chunk.start + 12) === "INFO") {
      const kept: Buffer[] = [Buffer.from("INFO", "latin1")]
      let at = chunk.start + 12
      const end = chunk.start + 8 + chunk.size
      while (at + 8 <= end) {
        const id = bytes.toString("latin1", at, at + 4)
        const size = bytes.readUInt32LE(at + 4)
        const next = at + 8 + size + (size % 2)
        if (id !== "AIGC") kept.push(bytes.subarray(at, Math.min(next, end)))
        at = next
      }
      kept.push(entry)
      out.push(riffChunk("LIST", Buffer.concat(kept)))
      listed = true
    } else {
      out.push(bytes.subarray(chunk.start, chunk.start + 8 + chunk.size + (chunk.size % 2)))
    }
  }
  if (!listed) out.push(riffChunk("LIST", Buffer.concat([Buffer.from("INFO", "latin1"), entry])))
  const body = Buffer.concat(out)
  const head = Buffer.alloc(12)
  head.write("RIFF", 0, "latin1")
  head.writeUInt32LE(body.length + 4, 4)
  head.write("WAVE", 8, "latin1")
  return { bytes: Buffer.concat([head, body]), explicit: toneable, reason: toneable ? undefined : "wav-encoding" }
}

/** Walks a rewritten WAV again: sizes consistent, format unchanged, the original samples first in its data. */
function checkWav(before: Buffer, after: Buffer): void {
  const chunks = wavChunks(after)
  if (after.readUInt32LE(4) !== after.length - 8) throw new Error("the RIFF size does not match the file")
  const a = wavFormat(before, wavChunks(before))
  const b = wavFormat(after, chunks)
  if (a.channels !== b.channels || a.sampleRate !== b.sampleRate || a.bits !== b.bits) throw new Error("the format changed")
  const oldData = wavChunks(before).find((chunk) => chunk.id === "data")!
  const newData = chunks.find((chunk) => chunk.id === "data")
  if (!newData || newData.size < oldData.size) throw new Error("the samples were cut")
  if (!after.subarray(newData.start + 8, newData.start + 8 + oldData.size).equals(before.subarray(oldData.start + 8, oldData.start + 8 + oldData.size))) {
    throw new Error("the original samples changed")
  }
  if (!wavAigc(after)) throw new Error("the AIGC entry cannot be read back")
}

// ------------------------------------------------------------------ mp3

const syncsafe = (bytes: Buffer, at: number) => ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) | ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f)
const toSyncsafe = (n: number) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f])

interface Id3Frame {
  id: string
  bytes: Buffer
  body: Buffer
}

/** The frames of a leading ID3v2.3 or 2.4 tag this can rewrite, and where the audio starts; undefined when there is no tag. */
function id3Frames(bytes: Buffer): { version: number; frames: Id3Frame[]; end: number } | undefined {
  if (bytes.length < 10 || bytes.toString("latin1", 0, 3) !== "ID3") return undefined
  const version = bytes[3]
  if (version !== 3 && version !== 4) throw new Error(`ID3v2.${version} is not rewritten`)
  // Unsynchronisation, an extended header or a footer each change how the tag is laid out.
  if (bytes[5] & 0xd0) throw new Error("the ID3 tag uses flags this does not rewrite")
  const end = 10 + syncsafe(bytes, 6)
  if (end > bytes.length) throw new Error("the ID3 tag runs past the end of the file")
  const frames: Id3Frame[] = []
  let at = 10
  while (at + 10 <= end) {
    const id = bytes.toString("latin1", at, at + 4)
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const size = version === 4 ? syncsafe(bytes, at + 4) : bytes.readUInt32BE(at + 4)
    if (at + 10 + size > end) throw new Error(`the ${id} frame runs past the tag`)
    frames.push({ id, bytes: bytes.subarray(at, at + 10 + size), body: bytes.subarray(at + 10, at + 10 + size) })
    at += 10 + size
  }
  return { version, frames, end }
}

/** Whether a TXXX frame is the AIGC one, and its value when it is. */
function txxxAigc(body: Buffer): string | undefined {
  if (body[0] !== 3 && body[0] !== 0) return undefined
  const split = body.indexOf(0, 1)
  if (split < 0 || body.toString("latin1", 1, split) !== "AIGC") return undefined
  return body.toString(body[0] === 3 ? "utf8" : "latin1", split + 1).replace(/\0+$/, "")
}

export function mp3Aigc(bytes: Buffer): AigcFields | undefined {
  const tag = id3Frames(bytes)
  for (const frame of tag?.frames ?? []) {
    if (frame.id !== "TXXX") continue
    const value = txxxAigc(frame.body)
    if (value !== undefined) return parseAigc(value)
  }
  return undefined
}

/** An MP3: a TXXX frame described AIGC in its ID3 tag, the tag's other frames kept; a tag is added where there is none. */
function labelMp3(bytes: Buffer): Buffer | undefined {
  const tag = id3Frames(bytes)
  const existing = mp3Aigc(bytes)
  if (existing?.ContentPropagator === AIGC_PRODUCER) return undefined
  const version = tag?.version ?? 3
  const body = Buffer.concat([Buffer.from([3]), Buffer.from("AIGC\0", "latin1"), Buffer.from(aigcJson(aigcFields(existing)), "utf8")])
  const head = Buffer.alloc(10)
  head.write("TXXX", 0, "latin1")
  if (version === 4) toSyncsafe(body.length).copy(head, 4)
  else head.writeUInt32BE(body.length, 4)
  const frames = [...(tag?.frames ?? []).filter((frame) => !(frame.id === "TXXX" && txxxAigc(frame.body) !== undefined)).map((frame) => frame.bytes), Buffer.concat([head, body])]
  const content = Buffer.concat(frames)
  const header = Buffer.from([0x49, 0x44, 0x33, version, 0, tag ? bytes[5] : 0, 0, 0, 0, 0])
  toSyncsafe(content.length).copy(header, 6)
  return Buffer.concat([header, content, bytes.subarray(tag?.end ?? 0)])
}

function checkMp3(before: Buffer, after: Buffer): void {
  const oldTag = id3Frames(before)
  const newTag = id3Frames(after)
  if (!newTag) throw new Error("the ID3 tag cannot be read back")
  if (!after.subarray(newTag.end).equals(before.subarray(oldTag?.end ?? 0))) throw new Error("the audio after the tag changed")
  if (!mp3Aigc(after)) throw new Error("the AIGC frame cannot be read back")
}

// ------------------------------------------------------------------ pictures

/** An XMP packet holding the AIGC property, for a picture that has none. */
function xmpPacket(fields: AigcFields): string {
  return (
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:AIGC="${AIGC_XMP_NS}"><AIGC:AIGC>${escapeXml(aigcJson(fields))}</AIGC:AIGC></rdf:Description>` +
    `</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`
  )
}

/** The AIGC property out of an XMP packet, whatever prefix it was written with. */
export function xmpAigc(xmp: string): AigcFields | undefined {
  const match = /<([\w.-]+):AIGC\b[^>]*>([\s\S]*?)<\/\1:AIGC>/.exec(xmp)
  return match ? parseAigc(unescapeXml(match[2])) : undefined
}

/** An existing XMP packet with the AIGC property set in it, or undefined when its shape is not one this can edit. */
function xmpWith(xmp: string, fields: AigcFields): string | undefined {
  const value = escapeXml(aigcJson(fields))
  const match = /<([\w.-]+):AIGC\b[^>]*>[\s\S]*?<\/\1:AIGC>/.exec(xmp)
  if (match) return xmp.replace(match[0], () => `<${match[1]}:AIGC>${value}</${match[1]}:AIGC>`)
  const close = xmp.lastIndexOf("</rdf:RDF>")
  if (close < 0) return undefined
  return `${xmp.slice(0, close)}<rdf:Description rdf:about="" xmlns:AIGC="${AIGC_XMP_NS}"><AIGC:AIGC>${value}</AIGC:AIGC></rdf:Description>${xmp.slice(close)}`
}

/** A little-endian TIFF block with one EXIF UserComment holding the fields, for a picture that has no EXIF. */
function exifBlock(fields: AigcFields): Buffer {
  const comment = Buffer.concat([Buffer.from("ASCII\0\0\0", "latin1"), Buffer.from(aigcJson(fields, true), "utf8")])
  const ifd0 = 8
  const exifIfd = ifd0 + 2 + 12 + 4
  const data = exifIfd + 2 + 12 + 4
  const out = Buffer.alloc(data + comment.length)
  out.write("II", 0, "latin1")
  out.writeUInt16LE(42, 2)
  out.writeUInt32LE(ifd0, 4)
  out.writeUInt16LE(1, ifd0)
  // ExifIFDPointer (34665), LONG, 1
  out.writeUInt16LE(34665, ifd0 + 2)
  out.writeUInt16LE(4, ifd0 + 4)
  out.writeUInt32LE(1, ifd0 + 6)
  out.writeUInt32LE(exifIfd, ifd0 + 10)
  out.writeUInt16LE(1, exifIfd)
  // UserComment (37510), UNDEFINED
  out.writeUInt16LE(37510, exifIfd + 2)
  out.writeUInt16LE(7, exifIfd + 4)
  out.writeUInt32LE(comment.length, exifIfd + 6)
  out.writeUInt32LE(data, exifIfd + 10)
  comment.copy(out, data)
  return out
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const XMP_KEYWORD = "XML:com.adobe.xmp"

interface PngChunk {
  type: string
  start: number
  end: number
  data: Buffer
}

function pngChunks(bytes: Buffer, checkCrc = false): PngChunk[] {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG file")
  const chunks: PngChunk[] = []
  let at = 8
  while (at + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(at)
    const type = bytes.toString("latin1", at + 4, at + 8)
    const end = at + 12 + size
    if (end > bytes.length) throw new Error(`the ${type} chunk runs past the end of the file`)
    if (checkCrc && crc32(bytes.subarray(at + 4, at + 8 + size)) !== bytes.readUInt32BE(at + 8 + size)) throw new Error(`the ${type} chunk fails its CRC`)
    chunks.push({ type, start: at, end, data: bytes.subarray(at + 8, at + 8 + size) })
    at = end
    if (type === "IEND") return chunks
  }
  throw new Error("the PNG has no IEND chunk")
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "latin1")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** The uncompressed XMP text of an iTXt chunk, or undefined when it is not one (or is compressed). */
function pngXmp(chunk: PngChunk): string | undefined {
  if (chunk.type !== "iTXt" || chunk.data.toString("latin1", 0, XMP_KEYWORD.length + 1) !== `${XMP_KEYWORD}\0`) return undefined
  if (chunk.data[XMP_KEYWORD.length + 1] !== 0) return undefined
  let at = chunk.data.indexOf(0, XMP_KEYWORD.length + 3)
  at = chunk.data.indexOf(0, at + 1)
  return at < 0 ? undefined : chunk.data.toString("utf8", at + 1)
}

const xmpItxt = (xmp: string) => pngChunk("iTXt", Buffer.concat([Buffer.from(`${XMP_KEYWORD}\0\0\0\0\0`, "latin1"), Buffer.from(xmp, "utf8")]))

export function pngAigc(bytes: Buffer): AigcFields | undefined {
  for (const chunk of pngChunks(bytes)) {
    const xmp = pngXmp(chunk)
    const fields = xmp && xmpAigc(xmp)
    if (fields) return fields
  }
  return undefined
}

/** A PNG: the AIGC property in its XMP (added, or set in the one it has), and an EXIF block where it has none. */
function labelPng(bytes: Buffer): Buffer | undefined {
  const chunks = pngChunks(bytes)
  const existing = pngAigc(bytes)
  if (existing?.ContentPropagator === AIGC_PRODUCER) return undefined
  const fields = aigcFields(existing)
  const xmpChunk = chunks.find((chunk) => pngXmp(chunk) !== undefined)
  if (!xmpChunk && chunks.some((chunk) => chunk.type === "iTXt" && chunk.data.toString("latin1", 0, XMP_KEYWORD.length) === XMP_KEYWORD)) {
    throw new Error("the PNG's XMP is compressed")
  }
  const hasExif = chunks.some((chunk) => chunk.type === "eXIf")
  const out: Buffer[] = [PNG_SIGNATURE]
  let placed = false
  for (const chunk of chunks) {
    if (chunk === xmpChunk) {
      const next = xmpWith(pngXmp(chunk)!, fields)
      if (!next) throw new Error("the PNG's XMP has no rdf:RDF")
      out.push(xmpItxt(next))
      continue
    }
    // New chunks go before the image data, where a reader streaming the file meets them first.
    if (!placed && (chunk.type === "IDAT" || chunk.type === "IEND")) {
      if (!hasExif) out.push(pngChunk("eXIf", exifBlock(fields)))
      if (!xmpChunk) out.push(xmpItxt(xmpPacket(fields)))
      placed = true
    }
    out.push(bytes.subarray(chunk.start, chunk.end))
  }
  return Buffer.concat(out)
}

function checkPng(before: Buffer, after: Buffer): void {
  const chunks = pngChunks(after, true)
  const image = (list: PngChunk[]) => Buffer.concat(list.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data))
  if (!image(chunks).equals(image(pngChunks(before)))) throw new Error("the image data changed")
  if (chunks[0].type !== "IHDR" || !chunks[0].data.equals(pngChunks(before)[0].data)) throw new Error("the header changed")
  if (!pngAigc(after)) throw new Error("the AIGC property cannot be read back")
}

const XMP_APP1 = "http://ns.adobe.com/xap/1.0/\0"
const EXIF_APP1 = "Exif\0\0"

interface JpegSegment {
  marker: number
  start: number
  end: number
  body: Buffer
}

/** The segments before the image data, and where it starts. */
function jpegSegments(bytes: Buffer): { segments: JpegSegment[]; scan: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG file")
  const segments: JpegSegment[] = []
  let at = 2
  for (;;) {
    if (at + 4 > bytes.length || bytes[at] !== 0xff) throw new Error("the JPEG's headers are broken")
    const marker = bytes[at + 1]
    if (marker === 0xda) return { segments, scan: at }
    if (marker === 0xd9) throw new Error("the JPEG has no image data")
    const size = bytes.readUInt16BE(at + 2)
    if (size < 2 || at + 2 + size > bytes.length) throw new Error("a JPEG segment runs past the end of the file")
    segments.push({ marker, start: at, end: at + 2 + size, body: bytes.subarray(at + 4, at + 2 + size) })
    at += 2 + size
  }
}

const isApp1 = (segment: JpegSegment, signature: string) => segment.marker === 0xe1 && segment.body.toString("latin1", 0, signature.length) === signature

function app1(signature: string, payload: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(signature, "latin1"), payload])
  if (body.length + 2 > 0xffff) throw new Error("the metadata does not fit in one JPEG segment")
  const head = Buffer.from([0xff, 0xe1, 0, 0])
  head.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([head, body])
}

export function jpegAigc(bytes: Buffer): AigcFields | undefined {
  for (const segment of jpegSegments(bytes).segments) {
    if (!isApp1(segment, XMP_APP1)) continue
    const fields = xmpAigc(segment.body.toString("utf8", XMP_APP1.length))
    if (fields) return fields
  }
  return undefined
}

/** A JPEG: the AIGC property in its XMP (added, or set in the one it has), and an EXIF block where it has none; its own EXIF is kept. */
function labelJpeg(bytes: Buffer): Buffer | undefined {
  const { segments, scan } = jpegSegments(bytes)
  const existing = jpegAigc(bytes)
  if (existing?.ContentPropagator === AIGC_PRODUCER) return undefined
  const fields = aigcFields(existing)
  const xmp = segments.find((segment) => isApp1(segment, XMP_APP1))
  const exif = segments.find((segment) => isApp1(segment, EXIF_APP1))
  const added: Buffer[] = []
  if (!exif) added.push(app1(EXIF_APP1, exifBlock(fields)))
  if (!xmp) added.push(app1(XMP_APP1, Buffer.from(xmpPacket(fields), "utf8")))
  // After a leading JFIF (APP0) and the file's own EXIF, which readers expect first.
  let insertAfter = 0
  while (insertAfter < segments.length && (segments[insertAfter].marker === 0xe0 || segments[insertAfter] === exif)) insertAfter += 1
  const out: Buffer[] = [bytes.subarray(0, 2)]
  segments.forEach((segment, index) => {
    if (index === insertAfter) out.push(...added)
    if (segment === xmp) {
      const next = xmpWith(segment.body.toString("utf8", XMP_APP1.length), fields)
      if (!next) throw new Error("the JPEG's XMP has no rdf:RDF")
      out.push(app1(XMP_APP1, Buffer.from(next, "utf8")))
    } else out.push(bytes.subarray(segment.start, segment.end))
  })
  if (insertAfter >= segments.length) out.push(...added)
  out.push(bytes.subarray(scan))
  return Buffer.concat(out)
}

function checkJpeg(before: Buffer, after: Buffer): void {
  const a = jpegSegments(before)
  const b = jpegSegments(after)
  if (!after.subarray(b.scan).equals(before.subarray(a.scan))) throw new Error("the image data changed")
  const others = (list: JpegSegment[], bytes: Buffer) => list.filter((segment) => !isApp1(segment, XMP_APP1) && !isApp1(segment, EXIF_APP1)).map((segment) => bytes.subarray(segment.start, segment.end).toString("hex"))
  if (others(a.segments, before).join() !== others(b.segments, after).join()) throw new Error("the JPEG's other headers changed")
  if (!jpegAigc(after)) throw new Error("the AIGC property cannot be read back")
}

// ------------------------------------------------------------------ the file

/** What labelling needs from its caller. */
export interface AigcDeps {
  /** Records the file's contents before they change, so undo can put them back. */
  snapshot?: (target: string) => Promise<void>
  /** The bundled Python; without it PDFs are left alone and Office files are checked by this module alone. */
  python?: string
  log?: (line: string) => void
  /** The size past which a file is left alone; AIGC_MAX_BYTES unless a test asks for less. */
  maxBytes?: number
}

/** The new bytes for a file, with whether its visible label is on it; undefined bytes when both halves already are. */
async function rewrite(kind: AigcKind, bytes: Buffer): Promise<{ bytes?: Buffer; explicit: boolean; reason?: string; check: (next: Buffer) => Promise<void> | void }> {
  switch (kind) {
    case "docx":
    case "pptx":
    case "xlsx": {
      const result = await labelOffice(kind, bytes)
      return { bytes: result.bytes, explicit: result.explicit, reason: result.reason, check: (next) => checkOffice(next, result.changed, result.before) }
    }
    case "html": {
      const text = bytes.toString("utf8")
      // A page in another encoding would be damaged by a UTF-8 rewrite.
      if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("the page is not UTF-8")
      const next = labelHtml(text)
      return {
        bytes: next === undefined ? undefined : Buffer.from(next, "utf8"),
        explicit: true,
        check: (out) => {
          // Only insertions: taking the two out again gives the page back byte for byte.
          const written = out.toString("utf8")
          const without = stripOnce(stripOnce(written, [`\n${HTML_COMMENT}`, `${HTML_COMMENT}\n`]), [`\n${HTML_BADGE}`, `${HTML_BADGE}\n`])
          if (without !== text) throw new Error("the page's own text changed")
        },
      }
    }
    case "wav": {
      const result = labelWav(bytes)
      return { bytes: result.bytes, explicit: result.explicit, reason: result.reason, check: (next) => checkWav(bytes, next) }
    }
    case "mp3":
      return { bytes: labelMp3(bytes), explicit: false, reason: "no-visible-form", check: (next) => checkMp3(bytes, next) }
    case "png":
      return { bytes: labelPng(bytes), explicit: false, reason: "no-visible-form", check: (next) => checkPng(bytes, next) }
    case "jpeg":
      return { bytes: labelJpeg(bytes), explicit: false, reason: "no-visible-form", check: (next) => checkJpeg(bytes, next) }
    case "pdf":
      throw new Error("PDFs are rewritten by Python")
  }
}

/** The text with the first of the given insertions taken out. */
function stripOnce(text: string, insertions: string[]): string {
  for (const insertion of insertions) {
    const at = text.indexOf(insertion)
    if (at >= 0) return text.slice(0, at) + text.slice(at + insertion.length)
  }
  return text
}

const sameFile = (a: { size: number; mtimeMs: number }, b: { size: number; mtimeMs: number }) => a.size === b.size && a.mtimeMs === b.mtimeMs

/** Replaces a file with bytes already checked, reading the temp copy back before it goes over the original. */
async function replaceWith(target: string, bytes: Buffer, check: (next: Buffer) => Promise<void> | void, mode: number): Promise<void> {
  await writeAtomic(target, bytes, mode, true, async (temp) => {
    const written = await fs.readFile(temp)
    if (!written.equals(bytes)) throw new Error("the temp copy does not match what was written")
    await check(written)
  })
}

/**
 * Labels one delivered file, never leaving it half-written: the outcome says
 * what happened, and anything but "labelled" means the file is as it was.
 */
export async function labelDelivered(target: string, deps: AigcDeps = {}): Promise<AigcOutcome> {
  const log = deps.log ?? ((line: string) => console.warn(line))
  const kind = aigcKind(target)
  const skip = (reason: string, extra: Partial<AigcOutcome> = {}): AigcOutcome => {
    if (kind) log(`[aigc] ${path.basename(target)} was not labelled: ${reason}`)
    return { path: target, kind, status: "skipped", reason, ...extra }
  }
  if (!kind) return { path: target, status: "skipped", reason: "kind" }
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat?.isFile()) return skip("missing")
  if (stat.size > (deps.maxBytes ?? AIGC_MAX_BYTES)) return skip("too-large")
  if (await appDataRefusal(target, "write")) return skip("app-data")
  if (!(await fs.access(target, fs.constants.W_OK).then(() => true, () => false))) return skip("read-only")
  const python = deps.python ?? bundledPython()
  try {
    if (kind === "pdf") return await labelPdf(target, stat, python, deps, skip)
    const bytes = await fs.readFile(target)
    const plan = await rewrite(kind, bytes)
    if (!plan.bytes) return { path: target, kind, status: "present", explicit: plan.explicit, implicit: true, ...(plan.reason ? { reason: plan.reason } : {}) }
    const next = plan.bytes
    await plan.check(next)
    if ((kind === "docx" || kind === "pptx" || kind === "xlsx") && python) {
      // Opened by the library a reader of the file would use, from a copy, before the original is touched.
      const probe = path.join(os.tmpdir(), `mcode-aigc-${process.pid}-${randomUUID()}.${kind}`)
      await fs.writeFile(probe, next)
      try {
        const opened = await runPython(python, ["check", kind, probe])
        // A Python the user pointed MCODE_PYTHON at may lack the library, or not run; that is no verdict on the file.
        const unavailable = /^python:|ModuleNotFoundError|ImportError/.test(opened.reason ?? "")
        if (!opened.ok && !unavailable) throw new Error(`it would not open after the rewrite (${opened.reason})`)
      } finally {
        await fs.rm(probe, { force: true }).catch(() => {})
      }
    }
    const now = await fs.stat(target)
    if (!sameFile(stat, now)) return skip("changed-meanwhile")
    await deps.snapshot?.(target)
    await replaceWith(target, next, plan.check, stat.mode & 0o777)
    return { path: target, kind, status: "labelled", explicit: plan.explicit, implicit: true, ...(plan.reason ? { reason: plan.reason } : {}) }
  } catch (err) {
    return skip(`error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** A PDF, which Python rewrites into a temp copy and opens again; the copy then replaces the original as any other file does. */
async function labelPdf(
  target: string,
  stat: { size: number; mtimeMs: number; mode: number },
  python: string | undefined,
  deps: AigcDeps,
  skip: (reason: string) => AigcOutcome,
): Promise<AigcOutcome> {
  if (!python) return skip("python-missing")
  const bytes = await fs.readFile(target)
  if (bytes.toString("latin1", 0, 5) !== "%PDF-") return skip("error: not a PDF file")
  const temp = `${target}.${process.pid}.aigc.pdf`
  try {
    const result = await runPython(python, ["pdf", target, temp, AIGC_TEXT, aigcJson(aigcFields())])
    if (!result.ok) return skip(result.reason === "encrypted" ? "encrypted" : `error: ${result.reason}`)
    if (result.present) return { path: target, kind: "pdf", status: "present", explicit: true, implicit: true }
    const next = await fs.readFile(temp)
    const now = await fs.stat(target)
    if (!sameFile(stat, now)) return skip("changed-meanwhile")
    await deps.snapshot?.(target)
    await replaceWith(target, next, async (written) => {
      if (written.toString("latin1", 0, 5) !== "%PDF-" || !written.includes("/AIGC")) throw new Error("the rewritten PDF lost its label")
    }, stat.mode & 0o777)
    return { path: target, kind: "pdf", status: "labelled", explicit: true, implicit: true }
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}
