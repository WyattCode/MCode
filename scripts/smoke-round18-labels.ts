/**
 * Round 18, lane A: the AI-generated label written into delivered files, as
 * MiMo 26.920 writes it (R18-A1).
 *
 * Each format is built here from nothing, handed to the labeller, and then
 * read back two ways: by the labeller's own readers, and by walking the
 * container independently (the zip reopened and its XML checked, the RIFF and
 * PNG structures walked with their sizes and CRCs, the JPEG's image data and
 * the MP3's audio compared byte for byte). The lane's report adds the same
 * files re-opened by python-docx, python-pptx, openpyxl, pypdf, pypdfium2 and
 * Pillow. The things that must never happen are checked too: a second
 * delivery changing the file again, and a file it cannot rewrite safely being
 * touched at all.
 */
import fs from "node:fs/promises"
import path from "node:path"
import zlib from "node:zlib"
import JSZip from "jszip"
import type { Check } from "./smoke-round5"
import {
  AIGC_FIELDS,
  AIGC_TEXT,
  AIGC_TONE,
  aigcTone,
  endsWithTone,
  jpegAigc,
  labelDelivered,
  mp3Aigc,
  officeAigc,
  parseAigc,
  pngAigc,
  wavAigc,
  wellFormedXml,
} from "../src/server/tool/aigc-label"
import { PresentFilesTool } from "../src/server/tool/present"

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const TYPES = (overrides: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`
const ROOT_RELS = (main: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`

async function zipOf(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, text] of Object.entries(parts)) zip.file(name, text)
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
}

const docx = (body: string) =>
  zipOf({
    "[Content_Types].xml": TYPES('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    "_rels/.rels": ROOT_RELS("word/document.xml"),
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  })

const pptx = () =>
  zipOf({
    "[Content_Types].xml": TYPES(""),
    "_rels/.rels": ROOT_RELS("ppt/presentation.xml"),
    "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`,
    ...Object.fromEntries(
      [1, 2].map((n) => [
        `ppt/slides/slide${n}.xml`,
        `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></p:sld>`,
      ]),
    ),
  })

const xlsx = (a1: string, shared = "") =>
  zipOf({
    "[Content_Types].xml": TYPES(""),
    "_rels/.rels": ROOT_RELS("xl/workbook.xml"),
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1">${a1}</row><row r="2"><c r="B2"><v>42</v></c></row></sheetData></worksheet>`,
    ...(shared ? { "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">${shared}</sst>` } : {}),
  })

function wav(seconds: number, rate = 16000, channels = 1): Buffer {
  const frames = Math.round(seconds * rate)
  const data = Buffer.alloc(frames * channels * 2)
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 6000), i * channels * 2)
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE(rate * channels * 2, 8)
  fmt.writeUInt16LE(channels * 2, 12)
  fmt.writeUInt16LE(16, 14)
  const chunk = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id, "latin1"), Buffer.from(Uint32Array.of(body.length).buffer), body])
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), chunk("fmt ", fmt), chunk("data", data)])
  return Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from(Uint32Array.of(body.length).buffer), body])
}

/** CRC-32 as PNG defines it, written out here rather than borrowed from the code under test. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, "latin1")
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(4, 0)
  ihdr.writeUInt32BE(4, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array.from({ length: 12 }, (_, i) => (i * 40) % 256)])))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])
}

/** Every PNG chunk's CRC, recomputed independently. */
function pngIntact(bytes: Buffer): boolean {
  let at = 8
  while (at + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(at)
    const type = bytes.toString("latin1", at + 4, at + 8)
    if (crc(bytes.subarray(at + 4, at + 8 + size)) !== bytes.readUInt32BE(at + 8 + size)) return false
    at += 12 + size
    if (type === "IEND") return at === bytes.length
  }
  return false
}

const JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDPooor3Dwj/9k="

/** The image data of a JPEG, from its start-of-scan marker on. */
const jpegScan = (bytes: Buffer) => bytes.subarray(bytes.indexOf(Buffer.from([0xff, 0xda])))

const syncsafe = (n: number) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127])
const MP3_FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)])
function mp3WithTitle(): Buffer {
  const title = Buffer.concat([Buffer.from([3]), Buffer.from("歌名", "utf8")])
  const frame = Buffer.concat([Buffer.from("TIT2", "latin1"), syncsafe(title.length), Buffer.from([0, 0]), title])
  return Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([4, 0, 0]), syncsafe(frame.length), frame, MP3_FRAME, MP3_FRAME])
}

/** A bundled Python, when this checkout has one, for the PDF half. */
async function python(): Promise<string | undefined> {
  if (process.env.MCODE_PYTHON) return process.env.MCODE_PYTHON
  const bundled = path.join(process.cwd(), "resources", "runtimes", `${process.platform}-${process.arch}`, "python", process.platform === "win32" ? "python.exe" : "bin/python3")
  return (await fs.stat(bundled).catch(() => undefined)) ? bundled : undefined
}

export async function roundEighteenLabelChecks(check: Check, section: (name: string) => void): Promise<void> {
  // Under the checkout's out/, not the system temp folder: MiMo's demotions treat pictures in a folder named temp as scratch renders.
  await fs.mkdir(path.join(process.cwd(), "out"), { recursive: true })
  const root = await fs.mkdtemp(path.join(process.cwd(), "out", "smoke-r18a-"))
  const dir = path.join(root, "work")
  await fs.mkdir(dir)
  const put = async (name: string, bytes: Buffer | string) => {
    const file = path.join(dir, name)
    await fs.writeFile(file, bytes)
    return file
  }
  const logs: string[] = []
  const deps = { python: "", log: (line: string) => void logs.push(line) }
  try {
    // ---------------------------------------------------------------- R18-A1
    section("Round 18 (A1): delivered files carry the AI-generated label, visible and in their metadata")
    {
      const fields = (value: unknown) => value && typeof value === "object" && Object.keys(value).join() === AIGC_FIELDS.join() && (value as { Label: string }).Label === "1"

      // Word: a closing paragraph before the body's section properties, and the AIGC custom property.
      const docFile = await put("report.docx", await docx(`<w:p><w:r><w:t>正文</w:t></w:r></w:p>`))
      const docOut = await labelDelivered(docFile, deps)
      const docZip = await JSZip.loadAsync(await fs.readFile(docFile))
      const documentXml = await docZip.file("word/document.xml")!.async("string")
      const lastParagraph = documentXml.slice(documentXml.lastIndexOf("<w:p>"), documentXml.indexOf("<w:sectPr"))
      check("R18-A1 docx: labelled, the last paragraph reads AI生成 and sits before the section properties", docOut.status === "labelled" && lastParagraph.includes(`<w:t>${AIGC_TEXT}</w:t>`) && documentXml.indexOf(AIGC_TEXT) < documentXml.indexOf("<w:sectPr"), { docOut, lastParagraph })
      check("R18-A1 docx: the paragraph is right-aligned small grey type, and the body text is untouched", /<w:jc w:val="right"\/>/.test(lastParagraph) && /<w:sz w:val="18"\/>/.test(lastParagraph) && /<w:color w:val="808080"\/>/.test(lastParagraph) && documentXml.includes("<w:t>正文</w:t>"))
      const docProps = await officeAigc(docZip)
      const types = await docZip.file("[Content_Types].xml")!.async("string")
      const rels = await docZip.file("_rels/.rels")!.async("string")
      check("R18-A1 docx: the AIGC custom property holds the standard's seven fields, registered in the package", fields(docProps) && types.includes('PartName="/docProps/custom.xml"') && rels.includes('Target="docProps/custom.xml"'), { docProps })
      check("R18-A1 docx: every part it touched is well-formed XML", [documentXml, types, rels, await docZip.file("docProps/custom.xml")!.async("string")].every(wellFormedXml))

      // Delivering it again changes nothing, byte for byte.
      const docBefore = await fs.readFile(docFile)
      const docAgain = await labelDelivered(docFile, deps)
      check("R18-A1 idempotent: a second delivery finds the label and leaves the file as it is", docAgain.status === "present" && (await fs.readFile(docFile)).equals(docBefore), docAgain)

      // PowerPoint: a text box on the last slide only.
      const deckFile = await put("deck.pptx", await pptx())
      const deckOut = await labelDelivered(deckFile, deps)
      const deckZip = await JSZip.loadAsync(await fs.readFile(deckFile))
      const slide1 = await deckZip.file("ppt/slides/slide1.xml")!.async("string")
      const slide2 = await deckZip.file("ppt/slides/slide2.xml")!.async("string")
      check("R18-A1 pptx: the last slide gets a text box reading AI生成, the first does not", deckOut.status === "labelled" && slide2.includes(`<a:t>${AIGC_TEXT}</a:t>`) && !slide1.includes(AIGC_TEXT) && wellFormedXml(slide2), deckOut)
      const box = /<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(slide2)
      check("R18-A1 pptx: the box sits inside the slide's bottom-right corner", !!box && Number(box[1]) + Number(box[3]) <= 9144000 && Number(box[1]) > 9144000 / 2 && Number(box[2]) + Number(box[4]) <= 5143500 && Number(box[2]) > 5143500 * 0.8, box?.slice(1))
      check("R18-A1 pptx: the AIGC custom property is there", fields(await officeAigc(deckZip)))

      // Excel: A1 of the open sheet, with its text kept; B2 untouched.
      const sheetFile = await put("sheet.xlsx", await xlsx('<c r="A1" t="s"><v>0</v></c>', "<si><t>销售表</t></si>"))
      await labelDelivered(sheetFile, deps)
      const sheetXml = await (await JSZip.loadAsync(await fs.readFile(sheetFile))).file("xl/worksheets/sheet1.xml")!.async("string")
      check("R18-A1 xlsx: A1 keeps its shared text and gains the label, as an inline string", sheetXml.includes(`<c r="A1" t="inlineStr"><is><t xml:space="preserve">销售表 [${AIGC_TEXT}]</t></is></c>`) && sheetXml.includes('<c r="B2"><v>42</v></c>') && wellFormedXml(sheetXml), sheetXml)
      const formulaFile = await put("formula.xlsx", await xlsx('<c r="A1"><f>1+2</f><v>3</v></c>'))
      const formulaOut = await labelDelivered(formulaFile, deps)
      const formulaXml = await (await JSZip.loadAsync(await fs.readFile(formulaFile))).file("xl/worksheets/sheet1.xml")!.async("string")
      check("R18-A1 xlsx: a formula in A1 is never turned into text; the file still gets the metadata", formulaOut.status === "labelled" && formulaOut.explicit === false && formulaOut.reason === "a1-formula" && formulaXml.includes("<f>1+2</f>") && !formulaXml.includes(AIGC_TEXT), formulaOut)
      const emptyFile = await put("empty.xlsx", await xlsx(""))
      await labelDelivered(emptyFile, deps)
      const emptyXml = await (await JSZip.loadAsync(await fs.readFile(emptyFile))).file("xl/worksheets/sheet1.xml")!.async("string")
      check("R18-A1 xlsx: an empty A1 becomes the label alone", emptyXml.includes(`<c r="A1" t="inlineStr"><is><t xml:space="preserve">${AIGC_TEXT}</t></is></c>`) && wellFormedXml(emptyXml))

      // A web page: the corner tag at the top of the body and a comment after the doctype, nothing else changed.
      const page = "<!DOCTYPE html>\n<html><head><title>t</title></head>\n<body>\n<h1>你好</h1>\n</body></html>\n"
      const pageFile = await put("page.html", page)
      await labelDelivered(pageFile, deps)
      const pageOut = await fs.readFile(pageFile, "utf8")
      const badge = /<div data-mcode-aigc="1"[^>]*style="([^"]*)"[^>]*>AI生成<\/div>/.exec(pageOut)
      check("R18-A1 html: the tag reads AI生成, fixed in a corner, and does not take clicks", !!badge && /position:fixed/.test(badge[1]) && /pointer-events:none/.test(badge[1]) && pageOut.indexOf(badge[0]) > pageOut.indexOf("<body>"), pageOut)
      check("R18-A1 html: the comment follows the doctype, so the page keeps its standards mode", /^<!DOCTYPE html>\n<!-- AIGC: AI生成/.test(pageOut))
      check("R18-A1 html: taking the two insertions out gives the page back exactly", pageOut.replace(/\n<!-- AIGC:[^\n]*-->/, "").replace(/\n<div data-mcode-aigc[^\n]*<\/div>/, "") === page)
      const gbkFile = await put("gbk.html", Buffer.from([0x3c, 0x70, 0x3e, 0xc4, 0xe3, 0xba, 0xc3, 0x3c, 0x2f, 0x70, 0x3e]))
      const gbkOut = await labelDelivered(gbkFile, deps)
      check("R18-A1 html: a page that is not UTF-8 is left exactly as it was", gbkOut.status === "skipped" && (await fs.readFile(gbkFile)).length === 11, gbkOut)

      // WAV: the tone after the samples, the AIGC entry beside the file's own INFO.
      const voice = wav(1)
      const voiceFile = await put("voice.wav", voice)
      await labelDelivered(voiceFile, deps)
      const voiceOut = await fs.readFile(voiceFile)
      const dataAt = voiceOut.indexOf(Buffer.from("data", "latin1"))
      const dataSize = voiceOut.readUInt32LE(dataAt + 4)
      const samples = voiceOut.subarray(dataAt + 8, dataAt + 8 + dataSize)
      const toneMs = ((dataSize - 32000) / 2 / 16000) * 1000
      const expectedMs = AIGC_TONE.leadInMs + AIGC_TONE.tailMs + AIGC_TONE.pattern.reduce((sum, step) => sum + Math.abs(step), 0) * AIGC_TONE.unitMs
      check("R18-A1 wav: the original samples come first, untouched, and the tone is appended", samples.subarray(0, 32000).equals(voice.subarray(44)) && Math.abs(toneMs - expectedMs) < 1, { toneMs, expectedMs })
      check("R18-A1 wav: the tone is the standard's rhythm for AI, short-long short-short, and was not there before", endsWithTone(samples, 1, 16000) && !endsWithTone(voice.subarray(44), 1, 16000) && AIGC_TONE.pattern.join() === "1,-1,3,-3,1,-1,1")
      check("R18-A1 wav: the RIFF size matches the file and the AIGC INFO entry reads back", voiceOut.readUInt32LE(4) === voiceOut.length - 8 && fields(wavAigc(voiceOut)))
      const toneStereo = aigcTone(44100, 2)
      check("R18-A1 wav: the tone peaks at its level, a quarter of full scale", Math.max(...Array.from({ length: toneStereo.length / 2 }, (_, i) => Math.abs(toneStereo.readInt16LE(i * 2)))) / 32767 <= AIGC_TONE.amplitude + 0.001)

      // MP3: a TXXX frame described AIGC, the tag's title kept, the audio byte for byte.
      const song = mp3WithTitle()
      const songFile = await put("song.mp3", song)
      const songOut = await labelDelivered(songFile, deps)
      const songBytes = await fs.readFile(songFile)
      check("R18-A1 mp3: the AIGC frame reads back, the title frame is kept, the audio is unchanged", songOut.status === "labelled" && fields(mp3Aigc(songBytes)) && songBytes.includes(Buffer.from("歌名", "utf8")) && songBytes.subarray(songBytes.length - MP3_FRAME.length * 2).equals(song.subarray(song.length - MP3_FRAME.length * 2)), songOut)

      // PNG and JPEG: XMP with the AIGC property, the image data identical.
      const picture = png()
      const pictureFile = await put("picture.png", picture)
      await labelDelivered(pictureFile, deps)
      const pictureOut = await fs.readFile(pictureFile)
      check("R18-A1 png: every chunk's CRC checks, the image data is unchanged, the XMP AIGC property reads back", pngIntact(pictureOut) && fields(pngAigc(pictureOut)) && pictureOut.includes(picture.subarray(picture.indexOf(Buffer.from("IDAT")) - 4, picture.length - 12)))
      const photo = Buffer.from(JPEG, "base64")
      const photoFile = await put("photo.jpg", photo)
      await labelDelivered(photoFile, deps)
      const photoOut = await fs.readFile(photoFile)
      check("R18-A1 jpeg: the image data is byte for byte the same, JFIF still first, the AIGC property reads back", jpegScan(photoOut).equals(jpegScan(photo)) && photoOut.toString("latin1", 6, 10) === "JFIF" && fields(jpegAigc(photoOut)))

      // A file labelled by another service keeps its id; MCode becomes the propagator.
      const other = { Label: "1", ContentProducer: "SomeoneElse", ProduceID: "abc-123", ReservedCode1: "", ContentPropagator: "SomeoneElse", PropagateID: "abc-123", ReservedCode2: "" }
      const propagated = await zipOf({
        "[Content_Types].xml": TYPES('<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>'),
        "_rels/.rels": ROOT_RELS("word/document.xml").replace("</Relationships>", '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>'),
        "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body><w:p/></w:body></w:document>`,
        "docProps/custom.xml": `<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="AIGC"><vt:lpwstr>${JSON.stringify(other).replace(/"/g, "&quot;")}</vt:lpwstr></property></Properties>`,
      })
      const propagatedFile = await put("propagated.docx", propagated)
      await labelDelivered(propagatedFile, deps)
      const carried = await officeAigc(await JSZip.loadAsync(await fs.readFile(propagatedFile)))
      const customXml = await (await JSZip.loadAsync(await fs.readFile(propagatedFile))).file("docProps/custom.xml")!.async("string")
      check("R18-A1 propagation: an earlier producer and id are kept, MCode is the propagator, and one AIGC property remains", carried?.ProduceID === "abc-123" && carried.ContentProducer === "SomeoneElse" && carried.ContentPropagator === "MCode" && customXml.split('name="AIGC"').length === 2, carried)
      check("R18-A1 parse: a value wrapped under an AIGC key is read too", parseAigc(JSON.stringify({ AIGC: other }))?.ProduceID === "abc-123")

      // What must never be touched.
      const broken = await put("broken.docx", Buffer.from("PK not really a zip"))
      const brokenOut = await labelDelivered(broken, deps)
      check("R18-A1 safety: a damaged document is left byte for byte, and the reason is logged", brokenOut.status === "skipped" && (await fs.readFile(broken)).toString("latin1") === "PK not really a zip" && logs.some((line) => line.includes("broken.docx")), brokenOut)
      const odd = await put("odd.docx", await zipOf({ "[Content_Types].xml": TYPES(""), "_rels/.rels": ROOT_RELS("word/document.xml"), "word/document.xml": `<?xml version="1.0"?><x:document xmlns:x="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><x:body/></x:document>` }))
      const oddBefore = await fs.readFile(odd)
      const oddOut = await labelDelivered(odd, deps)
      check("R18-A1 safety: a document written with prefixes this does not splice is left alone", oddOut.status === "skipped" && (await fs.readFile(odd)).equals(oddBefore), oddOut)
      const locked = await put("locked.png", png())
      await fs.chmod(locked, 0o444)
      const lockedOut = await labelDelivered(locked, deps)
      await fs.chmod(locked, 0o644)
      check("R18-A1 safety: a read-only file is not rewritten", lockedOut.status === "skipped" && lockedOut.reason === "read-only" && (await fs.readFile(locked)).equals(png()), lockedOut)
      const big = await put("big.wav", wav(1))
      const bigOut = await labelDelivered(big, { ...deps, maxBytes: 1000 })
      check("R18-A1 safety: a file past the size limit is not read or rewritten", bigOut.status === "skipped" && bigOut.reason === "too-large" && (await fs.readFile(big)).equals(wav(1)), bigOut)
      const noPython = await put("paper.pdf", "%PDF-1.4\n%%EOF\n")
      const noPythonOut = await labelDelivered(noPython, deps)
      check("R18-A1 safety: without the bundled Python a PDF is left alone and logged", noPythonOut.status === "skipped" && noPythonOut.reason === "python-missing" && (await fs.readFile(noPython, "utf8")) === "%PDF-1.4\n%%EOF\n", noPythonOut)
      check("R18-A1 scope: a text file is not something the label goes into", (await labelDelivered(await put("notes.txt", "x"), deps)).status === "skipped" && (await fs.readFile(path.join(dir, "notes.txt"), "utf8")) === "x")

      // The PDF half, where this checkout has the bundled Python.
      const py = await python()
      if (py) {
        const pdfFile = await put("real.pdf", minimalPdf())
        const pdfOut = await labelDelivered(pdfFile, { python: py, log: deps.log })
        const pdfBytes = await fs.readFile(pdfFile)
        const info = /\/AIGC\s*\(([^)]*)\)/.exec(pdfBytes.toString("latin1"))
        check("R18-A1 pdf: labelled through the bundled Python, the Info dictionary carries AIGC", pdfOut.status === "labelled" && pdfBytes.toString("latin1", 0, 5) === "%PDF-" && !!info && fields(parseAigc(pdfString(info[1]))), { pdfOut, info: info?.[1] })
        const pdfAgain = await labelDelivered(pdfFile, { python: py, log: deps.log })
        check("R18-A1 pdf: a second delivery leaves it as it is", pdfAgain.status === "present" && (await fs.readFile(pdfFile)).equals(pdfBytes), pdfAgain)
      } else {
        check("R18-A1 pdf: this checkout has no bundled Python to label a PDF with (resources/runtimes)", false)
      }

      // present_files: labels what it hands over, except a render demoted beside its document; undo sees it first.
      const handed = [await put("brief.docx", await docx("<w:p><w:r><w:t>x</w:t></w:r></w:p>")), await put("brief.png", png()), await put("chart.png", png())]
      const snapshotted: string[] = []
      const presented = await PresentFilesTool.execute({ files: handed, cwd: dir, explanation: "x" }, { directory: dir, snapshot: async (target: string) => void snapshotted.push(path.basename(target)) } as never)
      const labelled = ((presented.metadata as { aigc?: { path: string; status: string }[] }).aigc ?? []).map((outcome) => `${path.basename(outcome.path)}:${outcome.status}`)
      check("R18-A1 present_files: the document and the picture are labelled; the render named as the document is not", labelled.join() === "brief.docx:labelled,chart.png:labelled" && (await fs.readFile(path.join(dir, "brief.png"))).equals(png()), labelled)
      check("R18-A1 present_files: each file is recorded for undo before it is rewritten", snapshotted.join() === "brief.docx,chart.png", snapshotted)
      check("R18-A1 present_files: the model is told the label was written and to leave it", /The AI-generated label \(AI生成\) was written into brief\.docx, chart\.png/.test(presented.output), presented.output)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/** A PDF literal string's text: octal escapes and backslashed characters undone. */
const pdfString = (literal: string) => literal.replace(/\\([0-7]{1,3}|.)/g, (_, escaped: string) => (/^[0-7]/.test(escaped) ? String.fromCharCode(parseInt(escaped, 8)) : escaped))

const CONTENT ="BT /F1 12 Tf 20 150 Td (Hello) Tj ET"

/** A one-page PDF with a correct cross-reference table. */
function minimalPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${CONTENT.length} >>\nstream\n${CONTENT}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let text = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(text.length)
    text += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text, "latin1")
}
