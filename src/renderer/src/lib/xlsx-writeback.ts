import JSZip from "jszip"

/*
 * MiMo's Excel viewer saves edits by patching the .xlsx's XML in place rather
 * than re-serialising the workbook, so everything it does not understand
 * (styles, charts, pivot caches, shared strings, calcChain) survives untouched.
 * Cell edits rewrite single <c> elements; sheet add, remove and rename touch
 * workbook.xml, its rels and [Content_Types].xml.
 */

export interface CellEdit {
  sheetIndex: number
  row0: number
  col0: number
  value: string | number | boolean | null
}

const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const WORKSHEET_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
const WORKSHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"
const EMPTY_WORKSHEET =
  "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
  "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>"

/* ------------------------------------------------------------ helpers */

/** Column letters from a 0-based column index (0 → A, 26 → AA). */
function columnLetters(col0: number): string {
  let rest = col0 + 1
  let letters = ""
  while (rest > 0) {
    const digit = (rest - 1) % 26
    letters = String.fromCharCode(65 + digit) + letters
    rest = Math.floor((rest - 1) / 26)
  }
  return letters
}

function columnIndex(letters: string): number {
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

/** "A1" style address from 0-based row and column. */
export function a1Of(row0: number, col0: number): string {
  return columnLetters(col0) + (row0 + 1)
}

// Cell text: quotes escaped too since the same helper feeds attribute-free <t>;
// control characters XML 1.0 forbids are dropped, or the file would no longer open
function escapeText(value: string): string {
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// Attribute values (sheet names, targets) also escape the apostrophe
function escapeAttr(value: string): string {
  return escapeText(value).replace(/'/g, "&apos;")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Splice by index: String.replace would read "$&" or "$1" in a typed value as a pattern
function splice(text: string, index: number, length: number, insert: string): string {
  return text.slice(0, index) + insert + text.slice(index + length)
}

async function generate(zip: JSZip): Promise<Uint8Array> {
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
}

/** Zip path of a rels Target: absolute or relative to xl/, always "xl/..." */
function partOfTarget(target: string): string {
  return "xl/" + target.replace(/^\//, "").replace(/^xl\//, "").replace(/^\.?\//, "")
}

interface SheetTag {
  tag: RegExpMatchArray
  part: string
}

/**
 * The workbook's worksheet <sheet> tags in order, each with its part. exceljs
 * drops chartsheets and dialog sheets, so a sheet index counts worksheets only:
 * a rel Type ending in /worksheet, or a target under worksheets/ when Type is absent.
 */
function worksheetTags(workbookXml: string, relsXml: string): SheetTag[] {
  const rels = new Map<string, { target: string; type: string }>()
  for (const match of relsXml.matchAll(/<(?:\w+:)?Relationship\b[^>]*\/>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[0])?.[1]
    if (!id) continue
    rels.set(id, { target: /\bTarget="([^"]+)"/.exec(match[0])?.[1] ?? "", type: /\bType="([^"]+)"/.exec(match[0])?.[1] ?? "" })
  }
  const tags: SheetTag[] = []
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b[^>]*\/>/g)) {
    // The relationship prefix is usually r: but any prefix is accepted
    const id = /\b(?:\w+:)?id="([^"]+)"/.exec(match[0])?.[1]
    const rel = id ? rels.get(id) : undefined
    if (!rel) continue
    const worksheet = rel.type ? /\/worksheet$/.test(rel.type) : /(^|\/)worksheets\//.test(rel.target)
    if (worksheet) tags.push({ tag: match, part: rel.target ? partOfTarget(rel.target) : "" })
  }
  return tags
}

/* ------------------------------------------------------------ cells */

/*
 * Tags may carry a namespace prefix (<x:row>, <x:c>) and attributes in any
 * order, so every lookup accepts a prefix and finds r anywhere in the tag.
 * `p` is the prefix the sheet's sheetData uses ("" or "x:"); new elements take it.
 */

/** A new <c>, carrying only the style attribute of the cell it replaces. */
function plainCell(ref: string, value: CellEdit["value"], style: string, p: string): string {
  if (value === null || value === "") return `<${p}c r="${ref}"${style}/>`
  if (typeof value === "number" && Number.isFinite(value)) return `<${p}c r="${ref}"${style}><${p}v>${value}</${p}v></${p}c>`
  if (typeof value === "boolean") return `<${p}c r="${ref}"${style} t="b"><${p}v>${value ? 1 : 0}</${p}v></${p}c>`
  // Inline strings keep sharedStrings.xml untouched
  return `<${p}c r="${ref}"${style} t="inlineStr"><${p}is><${p}t xml:space="preserve">${escapeText(String(value))}</${p}t></${p}is></${p}c>`
}

/** A formula cell keeps its <f> and only gets a new cached value; null when there is no formula. */
function formulaCell(cellXml: string, ref: string, value: CellEdit["value"], style: string, p: string): string | null {
  const formula = /<(?:\w+:)?f\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?f>)/.exec(cellXml)?.[0]
  if (!formula) return null
  if (value === null || value === "") return `<${p}c r="${ref}"${style}>${formula}<${p}v></${p}v></${p}c>`
  if (typeof value === "number" && Number.isFinite(value)) return `<${p}c r="${ref}"${style}>${formula}<${p}v>${value}</${p}v></${p}c>`
  if (typeof value === "boolean") return `<${p}c r="${ref}"${style} t="b">${formula}<${p}v>${value ? 1 : 0}</${p}v></${p}c>`
  return `<${p}c r="${ref}"${style} t="str">${formula}<${p}v>${escapeText(String(value))}</${p}v></${p}c>`
}

/** Writes one cell into a row's inner XML, in place or in column order. */
function patchCell(rowInner: string, edit: CellEdit, p: string): string {
  const ref = a1Of(edit.row0, edit.col0)
  const at = `<(?:\\w+:)?c\\b(?=[^>]*\\sr="${ref}")`
  const found =
    new RegExp(`${at}[^>]*/>`).exec(rowInner) ??
    new RegExp(`${at}(?![^>]*/>)[^>]*>[\\s\\S]*?</(?:\\w+:)?c>`).exec(rowInner)
  if (found) {
    const head = found[0].slice(0, found[0].indexOf(">") + 1)
    const styleId = /\ss="(\d+)"/.exec(head)?.[1]
    const style = styleId ? ` s="${styleId}"` : ""
    const cell = formulaCell(found[0], ref, edit.value, style, p) ?? plainCell(ref, edit.value, style, p)
    return splice(rowInner, found.index, found[0].length, cell)
  }
  const cell = plainCell(ref, edit.value, "", p)
  const refs = /<(?:\w+:)?c\b[^>]*?\sr="([A-Z]+)(\d+)"/g
  let next: RegExpExecArray | null
  while ((next = refs.exec(rowInner))) {
    if (columnIndex(next[1]) > edit.col0) return splice(rowInner, next.index, 0, cell)
  }
  return rowInner + cell
}

function cellsOf(edits: CellEdit[], p: string): string {
  let inner = ""
  for (const edit of [...edits].sort((a, b) => a.col0 - b.col0)) inner = patchCell(inner, edit, p)
  return inner
}

function byRow(edits: CellEdit[]): [number, CellEdit[]][] {
  const rows = new Map<number, CellEdit[]>()
  for (const edit of edits) {
    const list = rows.get(edit.row0)
    if (list) list.push(edit)
    else rows.set(edit.row0, [edit])
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0])
}

/** Applies one sheet's edits to its worksheet XML; null when it has no sheetData to write into. */
function patchSheet(sheetXml: string, edits: CellEdit[]): string | null {
  const empty = /<(\w+:)?sheetData\b[^>]*\/>/.exec(sheetXml)
  if (empty) {
    const p = empty[1] ?? ""
    const rows = byRow(edits).map(([row0, list]) => `<${p}row r="${row0 + 1}">${cellsOf(list, p)}</${p}row>`).join("")
    return splice(sheetXml, empty.index, empty[0].length, `<${p}sheetData>${rows}</${p}sheetData>`)
  }
  const open = /<(\w+:)?sheetData\b[^>]*>/.exec(sheetXml)
  if (!open) return null
  const p = open[1] ?? ""
  const start = open.index + open[0].length
  const end = sheetXml.indexOf(`</${p}sheetData>`, start)
  if (end < 0) return null
  let data = sheetXml.slice(start, end)

  for (const [row0, list] of byRow(edits)) {
    const r = row0 + 1
    const at = `<(?:\\w+:)?row\\b(?=[^>]*\\sr="${r}")`
    // Self-closing first: the open form's lazy match would otherwise run on into the next row
    const bare = new RegExp(`${at}[^>]*/>`).exec(data)
    const full = bare ? null : new RegExp(`${at}[^>]*>[\\s\\S]*?</(?:\\w+:)?row>`).exec(data)
    if (full) {
      const head = full[0].slice(0, full[0].indexOf(">") + 1)
      const closeAt = full[0].lastIndexOf("</")
      let inner = full[0].slice(head.length, closeAt)
      for (const edit of [...list].sort((a, b) => a.col0 - b.col0)) inner = patchCell(inner, edit, p)
      data = splice(data, full.index, full[0].length, `${head}${inner}${full[0].slice(closeAt)}`)
      continue
    }
    const row = `<${p}row r="${r}">${cellsOf(list, p)}</${p}row>`
    if (bare) {
      data = splice(data, bare.index, bare[0].length, row)
      continue
    }
    // A missing row goes before the first row numbered after it
    let before = -1
    const rows = /<(?:\w+:)?row\b[^>]*?\sr="(\d+)"/g
    let next: RegExpExecArray | null
    while ((next = rows.exec(data))) {
      if (parseInt(next[1], 10) > r) {
        before = next.index
        break
      }
    }
    data = before >= 0 ? splice(data, before, 0, row) : data + row
  }
  return sheetXml.slice(0, start) + data + sheetXml.slice(end)
}

/** Writes the edits into the file; `applied` counts the edits that found their sheet, so a shortfall is not reported as saved. */
export async function writeCellEdits(bytes: Uint8Array, edits: CellEdit[]): Promise<{ bytes: Uint8Array; applied: number }> {
  const zip = await JSZip.loadAsync(bytes)
  const workbook = zip.file("xl/workbook.xml")
  const rels = zip.file("xl/_rels/workbook.xml.rels")
  if (!workbook || !rels) throw new Error("xlsx has no workbook.xml or its rels, cannot find worksheets")
  const workbookXml = await workbook.async("string")
  const parts = worksheetTags(workbookXml, await rels.async("string")).map((sheet) => sheet.part)

  const byPart = new Map<string, CellEdit[]>()
  for (const edit of edits) {
    const part = parts[edit.sheetIndex]
    if (!part) continue
    const list = byPart.get(part)
    if (list) list.push(edit)
    else byPart.set(part, [edit])
  }
  let applied = 0
  for (const [part, list] of byPart) {
    const file = zip.file(part)
    const patched = file ? patchSheet(await file.async("string"), list) : null
    if (patched === null) continue
    zip.file(part, patched)
    applied += list.length
  }

  // Cached formula results are stale now; Excel recalculates on open when calcPr says so (never added when absent)
  const calc = applied ? /<(?:\w+:)?calcPr\b[^>]*>/.exec(workbookXml) : null
  if (calc) {
    const flag = /\sfullCalcOnLoad="[^"]*"/.exec(calc[0])
    const nameEnd = calc[0].search(/[\s/>]/)
    const tagged = flag ? splice(calc[0], flag.index, flag[0].length, ` fullCalcOnLoad="1"`) : splice(calc[0], nameEnd, 0, ` fullCalcOnLoad="1"`)
    zip.file("xl/workbook.xml", splice(workbookXml, calc.index, calc[0].length, tagged))
  }
  return { bytes: await generate(zip), applied }
}

/* ------------------------------------------------------------ sheets */

export async function addSheet(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const workbookFile = zip.file("xl/workbook.xml")
  const relsFile = zip.file("xl/_rels/workbook.xml.rels")
  const typesFile = zip.file("[Content_Types].xml")
  if (!workbookFile || !relsFile || !typesFile) throw new Error("xlsx has no workbook.xml, rels or [Content_Types].xml, cannot add a sheet")
  const [workbook, rels, types] = await Promise.all([workbookFile.async("string"), relsFile.async("string"), typesFile.async("string")])

  // Ids one past the largest in use; the part takes the first free sheet number
  let sheetId = 0
  for (const match of workbook.matchAll(/<sheet\b[^>]*\bsheetId="(\d+)"/g)) sheetId = Math.max(sheetId, parseInt(match[1], 10))
  sheetId += 1
  let relNumber = 0
  for (const match of rels.matchAll(/\bId="rId(\d+)"/g)) relNumber = Math.max(relNumber, parseInt(match[1], 10))
  const relId = `rId${relNumber + 1}`
  const taken = new Set(Object.keys(zip.files).map((path) => path.toLowerCase()))
  let k = 1
  while (taken.has(`xl/worksheets/sheet${k}.xml`)) k++
  const part = `xl/worksheets/sheet${k}.xml`

  const sheetsEnd = workbook.indexOf("</sheets>")
  if (sheetsEnd < 0) throw new Error("xlsx workbook.xml has no </sheets>, cannot add a sheet")
  // Reuse whatever prefix the workbook binds to the relationships namespace
  const root = /<(?:\w+:)?workbook\b[^>]*>/.exec(workbook)?.[0] ?? ""
  const prefix = new RegExp(`\\bxmlns:(\\w+)="${escapeRegExp(RELS_NS)}"`).exec(root)?.[1]
  const idAttr = prefix ? `${prefix}:id="${relId}"` : `xmlns:r="${RELS_NS}" r:id="${relId}"`
  zip.file("xl/workbook.xml", splice(workbook, sheetsEnd, 0, `<sheet name="${escapeAttr(name)}" sheetId="${sheetId}" ${idAttr}/>`))

  const relsEnd = rels.indexOf("</Relationships>")
  if (relsEnd < 0) throw new Error("xlsx workbook.xml.rels has no </Relationships>")
  const target = part.replace(/^xl\//, "")
  zip.file("xl/_rels/workbook.xml.rels", splice(rels, relsEnd, 0, `<Relationship Id="${relId}" Type="${WORKSHEET_REL}" Target="${escapeAttr(target)}"/>`))

  const partName = "/" + part
  if (!types.includes(`PartName="${partName}"`)) {
    const typesEnd = types.indexOf("</Types>")
    if (typesEnd < 0) throw new Error("xlsx [Content_Types].xml has no </Types>")
    zip.file("[Content_Types].xml", splice(types, typesEnd, 0, `<Override PartName="${partName}" ContentType="${WORKSHEET_TYPE}"/>`))
  }

  zip.file(part, EMPTY_WORKSHEET)
  return generate(zip)
}

export async function removeSheet(bytes: Uint8Array, sheetIndex: number): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const workbookFile = zip.file("xl/workbook.xml")
  const relsFile = zip.file("xl/_rels/workbook.xml.rels")
  const typesFile = zip.file("[Content_Types].xml")
  if (!workbookFile || !relsFile || !typesFile) throw new Error("xlsx has no workbook.xml, rels or [Content_Types].xml")
  const [workbook, rels, types] = await Promise.all([workbookFile.async("string"), relsFile.async("string"), typesFile.async("string")])

  const tag = worksheetTags(workbook, rels)[sheetIndex]?.tag
  if (!tag || tag.index === undefined) throw new Error(`xlsx workbook.xml has no worksheet at index ${sheetIndex}`)
  zip.file("xl/workbook.xml", splice(workbook, tag.index, tag[0].length, ""))

  // The rel, the content-type override and the part go only when the rel is found
  const relId = /\b(?:\w+:)?id="([^"]+)"/.exec(tag[0])?.[1]
  const rel = relId ? new RegExp(`<Relationship\\b[^>]*\\bId="${escapeRegExp(relId)}"[^>]*/>`).exec(rels) : null
  if (rel) {
    zip.file("xl/_rels/workbook.xml.rels", splice(rels, rel.index, rel[0].length, ""))
    const part = partOfTarget(/\bTarget="([^"]+)"/.exec(rel[0])?.[1] ?? "")
    const override = new RegExp(`<Override\\b[^>]*\\bPartName="/${escapeRegExp(part)}"[^>]*/>`).exec(types)
    zip.file("[Content_Types].xml", override ? splice(types, override.index, override[0].length, "") : types)
    zip.remove(part)
  }
  return generate(zip)
}

export async function renameSheet(bytes: Uint8Array, sheetIndex: number, name: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const workbookFile = zip.file("xl/workbook.xml")
  const relsFile = zip.file("xl/_rels/workbook.xml.rels")
  if (!workbookFile || !relsFile) throw new Error("xlsx has no workbook.xml or its rels")
  const [workbook, rels] = await Promise.all([workbookFile.async("string"), relsFile.async("string")])
  const tag = worksheetTags(workbook, rels)[sheetIndex]?.tag
  if (!tag || tag.index === undefined) throw new Error(`xlsx workbook.xml has no worksheet at index ${sheetIndex}`)
  const nameAttr = /\bname="[^"]*"/.exec(tag[0])
  const renamed = nameAttr ? splice(tag[0], nameAttr.index, nameAttr[0].length, `name="${escapeAttr(name)}"`) : tag[0]
  zip.file("xl/workbook.xml", splice(workbook, tag.index, tag[0].length, renamed))
  return generate(zip)
}

/* ------------------------------------------------------------ version notes */

/** A cell value (an exceljs value or a Univer value) as a version note shows it. */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "空"
  if (typeof value !== "object") return String(value)
  if (value instanceof Date) return "(日期)"
  // exceljs shapes: formula {result}, rich text {richText: [{text}]}, hyperlink {text}
  if ("result" in value) {
    const result = (value as { result?: unknown }).result
    return result === null || result === undefined ? "(公式)" : String(result)
  }
  if ("richText" in value) {
    const runs = (value as { richText?: unknown }).richText
    return Array.isArray(runs) ? runs.map((run: { text?: unknown }) => run?.text ?? "").join("") : "(值)"
  }
  if ("text" in value) return String((value as { text?: unknown }).text)
  return "(值)"
}

function clip(text: string, max = 12): string {
  return text.length > max ? text.slice(0, max) + "…" : text
}

/** The note on a cell-edit version: the first three changes, then how many in all. */
export function editsNote(entries: { a1: string; before: string; after: string }[]): string {
  if (!entries.length) return ""
  const shown = 3
  let note = entries.slice(0, shown).map((entry) => `${entry.a1}:${clip(entry.before)}→${clip(entry.after)}`).join(";")
  if (entries.length > shown) note += ` 等 ${entries.length} 处`
  return note
}
