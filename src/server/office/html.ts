/**
 * Office documents as one HTML page each.
 *
 * The desktop renders docx, xlsx and pptx in a browser with libraries built for
 * it. A phone on the far side of the gateway has no such libraries and no
 * LibreOffice, so the conversion happens here, where the file is, and the page
 * travels instead of the document.
 *
 * Everything is read with `jszip`: all three formats are zip archives of XML,
 * and their own schemas say what the parts mean. That keeps the conversion
 * dependency-free and predictable - no headless browser, no external program -
 * at the cost of fidelity: a Word page's exact layout is not reproduced, its
 * content is, in order, with its images, headings, lists and tables.
 */
import JSZip from "jszip"
import * as path from "node:path"

/**
 * The relationships of a part, by id.
 *
 * `Id`, `Type` and `Target` come in any order and the tag may carry an
 * `xmlns:...` declaration between them, so each is read on its own rather than
 * one pattern spanning the tag. `Target` may be absolute (`/xl/worksheets/...`)
 * or relative (`worksheets/...`); both are resolved against the part's folder
 * by the caller.
 */
async function readRels(zip: JSZip, name: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const file = zip.file(name)
  if (!file) return found
  const xml = await file.async("string")
  for (const tag of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(tag[0])?.[1]
    const target = /\bTarget="([^"]+)"/.exec(tag[0])?.[1]
    if (id && target) found.set(id, target)
  }
  return found
}

/** The zip entry a `Target` names, from the folder the part lives in. */
function resolvePart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1)
  return path.posix.normalize(path.posix.join(base, target))
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

/**
 * The entities an OOXML part writes its text with.
 *
 * Every text node in these formats is XML-escaped, so a name in Chinese arrives
 * as `&#22320;` rather than as itself. This turns those back into characters -
 * the one place the conversion has to do it, since everywhere else the text is
 * taken straight out of the tag.
 */
function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/** The page every document is wrapped in: the same body type the app reads in. */
function shell(title: string, body: string, extra = ""): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 20px 22px 40px;
    font: 15px/1.75 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f1e1c; background: #fffefd;
    -webkit-text-size-adjust: 100%;
  }
  h1 { font-size: 26px; line-height: 1.3; margin: 22px 0 12px; }
  h2 { font-size: 21px; line-height: 1.35; margin: 20px 0 10px; }
  h3 { font-size: 17px; line-height: 1.4; margin: 18px 0 8px; }
  h4, h5, h6 { font-size: 15px; margin: 16px 0 6px; }
  p { margin: 0 0 10px; }
  ul, ol { margin: 0 0 10px; padding-inline-start: 22px; }
  li { margin: 2px 0; }
  table { border-collapse: collapse; margin: 10px 0 14px; font-size: 13px; }
  td, th { border: 1px solid #dcdcd8; padding: 5px 8px; vertical-align: top; }
  th { background: #f4f3f0; font-weight: 600; }
  img { max-width: 100%; height: auto; display: block; margin: 8px 0; }
  .sheet-name { font-size: 13px; color: #6b6862; margin: 18px 0 6px; }
  .slide { border: 1px solid #e4e1d8; border-radius: 10px; padding: 16px 18px; margin: 0 0 14px; }
  .slide-no { font-size: 12px; color: #6b6862; margin-bottom: 6px; }
  .empty { color: #6b6862; }
  @media (prefers-color-scheme: dark) {
    body { color: #f5f4ef; background: #151515; }
    td, th { border-color: #2e2e2e; }
    th { background: #20201f; }
    .slide { border-color: #2c2c2b; }
    .sheet-name, .slide-no, .empty { color: #888681; }
  }
</style>${extra}</head>
<body>${body}</body></html>`
}

export interface Rendered {
  kind: string
  html: string
  error?: string
}

/* ------------------------------------------------------------------ */
/* docx                                                                */
/* ------------------------------------------------------------------ */

/**
 * A `.docx` as paragraphs, headings, lists and tables.
 *
 * `word/document.xml` holds the body as `<w:p>` elements of `<w:r>` runs; a run's
 * text is `<w:t>`, a break is `<w:br>`, a tab is `<w:tab>`. Paragraph style comes
 * from `<w:pStyle w:val="...">`, where `Heading1`.. mean what they say. Bold and
 * italic live on the run's `<w:rPr>`. Numbering resolves through
 * `word/numbering.xml`, which maps a `numId` to a bullet/glyph and a level.
 */
async function renderDocx(zip: JSZip): Promise<string> {
  const docFile = zip.file("word/document.xml")
  if (!docFile) return `<p class="empty">这个文档里没有正文。</p>`
  const xml = await docFile.async("string")

  // Relationships name the media files, so an inline picture can be found.
  const rels = await readRels(zip, "word/_rels/document.xml.rels")
  const media = new Map<string, string>()
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/media\//.test(name) || name.endsWith("/")) continue
    const data = await zip.file(name)?.async("base64")
    if (!data) continue
    const ext = path.extname(name).slice(1).toLowerCase()
    const mime =
      ext === "png" ? "image/png"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "gif" ? "image/gif"
      : ext === "svg" ? "image/svg+xml"
      : ext === "webp" ? "image/webp"
      : "application/octet-stream"
    media.set(name, `data:${mime};base64,${data}`)
  }

  /*
   * Numbering: `numId` -> level -> { ordered, bullet }. A paragraph's
   * `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>` selects it.
   */
  const numbering = new Map<string, { ordered: boolean; start: number }[]>()
  const numberingFile = zip.file("word/numbering.xml")
  if (numberingFile) {
    const numXml = await numberingFile.async("string")
    const abstract = new Map<string, { ordered: boolean; start: number }[]>()
    for (const m of numXml.matchAll(/<w:abstractNum[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g)) {
      const levels: { ordered: boolean; start: number }[] = []
      for (const lvl of m[0].matchAll(/<w:lvl[^>]*w:ilvl="(\d+)"[\s\S]*?<\/w:lvl>/g)) {
        const fmt = /<w:numFmt w:val="([^"]+)"/.exec(lvl[0])?.[1] ?? "bullet"
        const start = Number(/<w:start w:val="(\d+)"/.exec(lvl[0])?.[1] ?? "1")
        levels[Number(lvl[1])] = { ordered: fmt !== "bullet" && fmt !== "none", start }
      }
      abstract.set(m[1], levels)
    }
    for (const m of numXml.matchAll(/<w:num[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
      const ref = /<w:abstractNumId w:val="(\d+)"/.exec(m[2])?.[1]
      if (ref && abstract.has(ref)) numbering.set(m[1], abstract.get(ref)!)
    }
  }

  const out: string[] = []
  let listOpen: "ul" | "ol" | null = null
  const closeList = () => {
    if (listOpen) {
      out.push(`</${listOpen}>`)
      listOpen = null
    }
  }

  // Each top-level <w:p> and <w:tbl> in document order.
  const bodyMatch = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)
  const body = bodyMatch?.[1] ?? xml

  const blocks = body.match(/<w:p\b[\s\S]*?<\/w:p>|<w:tbl\b[\s\S]*?<\/w:tbl>/g) ?? []
  for (const block of blocks) {
    if (block.startsWith("<w:tbl")) {
      closeList()
      out.push(renderDocxTable(block, escapeHtml))
      continue
    }

    const style = /<w:pStyle w:val="([^"]+)"/.exec(block)?.[1] ?? ""
    const numId = /<w:numId w:val="(\d+)"/.exec(block)?.[1]
    const ilvl = Number(/<w:ilvl w:val="(\d+)"/.exec(block)?.[1] ?? "0")

    // Runs, in order: text, tabs, breaks, and inline pictures.
    let inner = ""
    for (const run of block.match(/<w:r\b[\s\S]*?<\/w:r>/g) ?? []) {
      const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? ""
      const bold = /<w:b\b(?! w:val="(?:0|false)")/.test(rPr)
      const italic = /<w:i\b(?! w:val="(?:0|false)")/.test(rPr)
      const underline = /<w:u\b/.test(rPr)
      const strike = /<w:strike\b/.test(rPr)

      // An inline drawing names its relationship; that is the media file.
      for (const embed of run.matchAll(/(?:r:embed|r:link)="([^"]+)"/g)) {
        const target = rels.get(embed[1])
        if (!target) continue
        const key = resolvePart("word", target)
        const url = media.get(key)
        if (url) inner += `<img src="${url}" alt="">`
      }

      let text = ""
      for (const piece of run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
        if (piece[1] !== undefined) text += escapeHtml(decodeXml(piece[1]))
        else if (piece[0] === "<w:tab/>") text += "&emsp;"
        else text += "<br>"
      }
      if (!text) continue
      if (bold) text = `<strong>${text}</strong>`
      if (italic) text = `<em>${text}</em>`
      if (underline) text = `<u>${text}</u>`
      if (strike) text = `<s>${text}</s>`
      inner += text
    }

    if (!inner.trim()) {
      closeList()
      continue
    }

    /*
     * A title is the document's own name, which Word sets at Title style; it
     * reads as the top heading rather than as an ordinary paragraph.
     */
    if (/^Title$/i.test(style)) {
      closeList()
      out.push(`<h1>${inner}</h1>`)
      continue
    }

    const heading = /^Heading(\d)$/i.exec(style)?.[1]
    if (heading) {
      closeList()
      const level = Math.min(6, Math.max(1, Number(heading)))
      out.push(`<h${level}>${inner}</h${level}>`)
      continue
    }

    /*
     * A list has two spellings in OOXML and both are common: a paragraph can
     * carry a `numId` (numbering.xml decides the glyph) or simply wear a style
     * whose name says what it is - `ListBullet`, `ListNumber`, and their
     * `2`/`3` variants for deeper levels. Word's own template writes the second,
     * so a converter that only reads `numId` turns every list into plain
     * paragraphs.
     */
    const listStyle = /^List(Bullet|Number|Paragraph)(\d)?$/i.exec(style)
    if (listStyle) {
      const ordered = /number/i.test(listStyle[1])
      const depth = Number(listStyle[2] ?? "1")
      const want = ordered ? "ol" : "ul"
      if (listOpen !== want) {
        closeList()
        out.push(ordered ? "<ol>" : "<ul>")
        listOpen = want
      }
      // A deeper style is a nested list inside the item above it.
      out.push(depth > 1 ? `<li style="margin-inline-start:${(depth - 1) * 18}px">${inner}</li>` : `<li>${inner}</li>`)
      continue
    }

    if (numId && numbering.has(numId)) {
      const level = numbering.get(numId)![ilvl] ?? { ordered: false, start: 1 }
      const want = level.ordered ? "ol" : "ul"
      if (listOpen !== want) {
        closeList()
        out.push(level.ordered ? `<ol start="${level.start}">` : "<ul>")
        listOpen = want
      }
      out.push(`<li>${inner}</li>`)
      continue
    }

    closeList()
    // A quote or an aside is a paragraph with its own style; the words are what
    // matter, so the only distinction kept is centred/right alignment.
    const align = /<w:jc w:val="(center|right|both)"/.exec(block)?.[1]
    const attr = align === "center" ? ' style="text-align:center"' : align === "right" ? ' style="text-align:right"' : ""
    out.push(`<p${attr}>${inner}</p>`)
  }
  closeList()

  return out.join("\n") || `<p class="empty">这个文档里没有可读的文字。</p>`
}

/** One `w:tbl` as an HTML table, spans included. */
function renderDocxTable(table: string, esc: (text: string) => string): string {
  const rows: string[] = []
  for (const row of table.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []) {
    const cells: string[] = []
    for (const cell of row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []) {
      const span = Number(/<w:gridSpan w:val="(\d+)"/.exec(cell)?.[1] ?? "1")
      const merged = /<w:vMerge w:val="continue"\/>/.test(cell)
      const text = (cell.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) ?? [])
        .map((t) => esc(decodeXml(t.replace(/<[^>]+>/g, ""))))
        .join(" ")
      if (merged) continue
      const attr = span > 1 ? ` colspan="${span}"` : ""
      cells.push(`<td${attr}>${text}</td>`)
    }
    if (cells.length) rows.push(`<tr>${cells.join("")}</tr>`)
  }
  return rows.length ? `<table>${rows.join("")}</table>` : ""
}

/* ------------------------------------------------------------------ */
/* xlsx                                                                */
/* ------------------------------------------------------------------ */

/**
 * A `.xlsx` as one table per sheet.
 *
 * Sheet names and order come from `xl/workbook.xml`; each sheet is
 * `xl/worksheets/sheetN.xml` where a cell is `<c r="B3" t="s"><v>12</v></c>` -
 * `t="s"` means the value is an index into `xl/sharedStrings.xml`, otherwise it
 * is the number itself. Only the cells that carry a value exist, so the grid is
 * built from the addresses that are there.
 */
async function renderXlsx(zip: JSZip): Promise<string> {
  const wbFile = zip.file("xl/workbook.xml")
  if (!wbFile) return `<p class="empty">这个工作簿里没有表。</p>`
  const wb = await wbFile.async("string")

  // Shared strings, in order: every `t="s"` cell points at one of these.
  const strings: string[] = []
  const ssFile = zip.file("xl/sharedStrings.xml")
  if (ssFile) {
    const ss = await ssFile.async("string")
    for (const si of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      // The text inside `<t>` is XML-escaped (`&#22320;` for 地), so it is
      // decoded once before being escaped for HTML - escaping it twice is what
      // printed `&amp;#22320;` on the page.
      strings.push((si[1].match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? [])
        .map((t) => escapeHtml(decodeXml(t.replace(/<[^>]+>/g, ""))))
        .join(""))
    }
  }

  const rels = await readRels(zip, "xl/_rels/workbook.xml.rels")

  const out: string[] = []
  /*
   * The two attributes are read separately, not by one pattern that expects
   * `name` before `r:id`: the sheet element also carries an `xmlns:r`
   * declaration, and a pattern spanning the whole tag breaks the moment the
   * attributes appear in another order - which is what a workbook written by a
   * different tool does.
   */
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((tag) => ({
    name: /\bname="([^"]*)"/.exec(tag[0])?.[1] ?? "",
    rid: /\br:id="([^"]+)"/.exec(tag[0])?.[1] ?? "",
  })).filter((entry) => entry.rid)
  for (const { name, rid } of sheets) {
    const target = rels.get(rid)
    if (!target) continue
    const sheetFile = zip.file(resolvePart("xl", target))
    if (!sheetFile) continue
    const xml = await sheetFile.async("string")

    const rows: string[] = []
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const c of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = c[1]
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? ""
        const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? ""
        const raw = /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1] ?? ""
        const inline = /<is>([\s\S]*?)<\/is>/.exec(c[2])?.[1]
        let value = ""
        if (type === "s") value = strings[Number(raw)] ?? ""
        else if (type === "inlineStr" && inline) value = escapeHtml(decodeXml(inline.replace(/<[^>]+>/g, "")))
        else value = escapeHtml(decodeXml(raw))
        if (!value) continue
        // Keep the column letter so a gap in the row is a gap in the table.
        cells.push(`<td data-c="${ref}">${value}</td>`)
      }
      if (cells.length) rows.push(`<tr>${cells.join("")}</tr>`)
    }
    out.push(`<div class="sheet-name">${escapeHtml(name)}</div>`)
    out.push(rows.length ? `<table>${rows.join("")}</table>` : `<p class="empty">这张表是空的。</p>`)
  }
  return out.join("\n") || `<p class="empty">这个工作簿里没有可读的表。</p>`
}

/* ------------------------------------------------------------------ */
/* pptx                                                                */
/* ------------------------------------------------------------------ */

/**
 * A `.pptx` as a stack of slides.
 *
 * Slide order comes from `ppt/presentation.xml`'s `<p:sldIdLst>`; each slide is
 * `ppt/slides/slideN.xml` where the words are `<a:t>` runs inside shapes. The
 * text of each shape is kept in order and separated, which reproduces what a
 * slide says - not where it sits, which is the part a phone cannot show anyway.
 */
async function renderPptx(zip: JSZip): Promise<string> {
  const presFile = zip.file("ppt/presentation.xml")
  if (!presFile) return `<p class="empty">这个演示文稿里没有幻灯片。</p>`
  const pres = await presFile.async("string")
  const rels = await readRels(zip, "ppt/_rels/presentation.xml.rels")

  const order: string[] = []
  for (const m of pres.matchAll(/<p:sldId[^>]*r:id="([^"]+)"/g)) {
    const target = rels.get(m[1])
    if (target) order.push(resolvePart("ppt", target))
  }

  const out: string[] = []
  let shown = 0
  for (const name of order) {
    const file = zip.file(name)
    if (!file) continue
    const xml = await file.async("string")
    shown += 1
    // Each shape's paragraphs; a title shape is its own block.
    const shapes: string[] = []
    for (const sp of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
      const paras: string[] = []
      for (const p of sp[1].matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
        const text = (p[1].match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? [])
          .map((t) => escapeHtml(decodeXml(t.replace(/<[^>]+>/g, ""))))
          .join("")
        if (text.trim()) paras.push(`<p>${text}</p>`)
      }
      if (paras.length) shapes.push(paras.join(""))
    }
    out.push(`<div class="slide"><div class="slide-no">第 ${shown} 页</div>${shapes.join("") || '<p class="empty">这一页只有图形。</p>'}</div>`)
  }
  return out.join("\n") || `<p class="empty">这个演示文稿里没有可读的文字。</p>`
}

/* ------------------------------------------------------------------ */

/** The document at `file`, as the page the reader shows. */
export async function renderOffice(file: string, name = file): Promise<Rendered> {
  const ext = path.extname(name || file).slice(1).toLowerCase()
  const kind = ext === "docx" ? "docx" : ext === "xlsx" ? "xlsx" : ext === "pptx" ? "pptx" : ext
  if (!["docx", "xlsx", "pptx"].includes(kind)) {
    return { kind, html: "", error: `不支持的类型：.${ext}` }
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await (await import("node:fs/promises")).readFile(file))
  } catch (err) {
    return { kind, html: "", error: `打不开这个文件：${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    const body =
      kind === "docx" ? await renderDocx(zip)
      : kind === "xlsx" ? await renderXlsx(zip)
      : await renderPptx(zip)
    return { kind, html: shell(name.split(/[\\/]/).pop() ?? name, body) }
  } catch (err) {
    return { kind, html: "", error: `读不懂这个文件：${err instanceof Error ? err.message : String(err)}` }
  }
}
