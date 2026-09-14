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

// Cell text: quotes escaped too since the same helper feeds attribute-free <t>
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
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

function sheetTags(workbookXml: string): RegExpMatchArray[] {
  return [...workbookXml.matchAll(/<sheet\b[^>]*\/>/g)]
}

/** Zip path of a rels Target: absolute or relative to xl/, always "xl/..." */
function partOfTarget(target: string): string {
  return "xl/" + target.replace(/^\//, "").replace(/^xl\//, "").replace(/^\.?\//, "")
}

/** Each <sheet>'s worksheet part in workbook order; "" when its rel is missing. */
function sheetParts(workbookXml: string, relsXml: string): string[] {
  const targets = new Map<string, string>()
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[0])?.[1]
    const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1]
    if (id && target) targets.set(id, target)
  }
  return sheetTags(workbookXml).map((match) => {
    // The relationship prefix is usually r: but any prefix is accepted
    const id = /\b(?:\w+:)?id="([^"]+)"/.exec(match[0])?.[1]
    const target = id ? targets.get(id) : undefined
    return target ? partOfTarget(target) : ""
  })
}

/* ------------------------------------------------------------ cells */

/** A new <c>, carrying only the style attribute of the cell it replaces. */
function plainCell(ref: string, value: CellEdit["value"], style: string): string {
  if (value === null || value === "") return `<c r="${ref}"${style}/>`
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`
  if (typeof value === "boolean") return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`
  // Inline strings keep sharedStrings.xml untouched
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeText(String(value))}</t></is></c>`
}

/** A formula cell keeps its <f> and only gets a new cached value; null when there is no formula. */
function formulaCell(cellXml: string, ref: string, value: CellEdit["value"], style: string): string | null {
  const formula = /<(?:\w+:)?f\b[^>]*(?:\/>|>[\s\S]*?<\/(?:\w+:)?f>)/.exec(cellXml)?.[0]
  if (!formula) return null
  if (value === null || value === "") return `<c r="${ref}"${style}>${formula}<v></v></c>`
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}>${formula}<v>${value}</v></c>`
  if (typeof value === "boolean") return `<c r="${ref}"${style} t="b">${formula}<v>${value ? 1 : 0}</v></c>`
  return `<c r="${ref}"${style} t="str">${formula}<v>${escapeText(String(value))}</v></c>`
}

/** Writes one cell into a row's inner XML, in place or in column order. */
function patchCell(rowInner: string, edit: CellEdit): string {
  const ref = a1Of(edit.row0, edit.col0)
  const found =
    new RegExp(`<c\\s+r="${ref}"[^>]*/>`).exec(rowInner) ??
    new RegExp(`<c\\s+r="${ref}"(?![^>]*/>)[^>]*>[\\s\\S]*?</c>`).exec(rowInner)
  if (found && found.index !== undefined) {
    const styleId = /\bs="(\d+)"/.exec(found[0])?.[1]
    const style = styleId ? ` s="${styleId}"` : ""
    const cell = formulaCell(found[0], ref, edit.value, style) ?? plainCell(ref, edit.value, style)
    return splice(rowInner, found.index, found[0].length, cell)
  }
  const cell = plainCell(ref, edit.value, "")
  const refs = /<c\s+r="([A-Z]+)(\d+)"/g
  let next: RegExpExecArray | null
  while ((next = refs.exec(rowInner))) {
    if (columnIndex(next[1]) > edit.col0) return splice(rowInner, next.index, 0, cell)
  }
  return rowInner + cell
}

function cellsOf(edits: CellEdit[]): string {
  let inner = ""
  for (const edit of [...edits].sort((a, b) => a.col0 - b.col0)) inner = patchCell(inner, edit)
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

/** Applies one sheet's edits to its worksheet XML. */
function patchSheet(sheetXml: string, edits: CellEdit[]): string {
  const empty = /<sheetData\b[^>]*\/>/.exec(sheetXml)
  if (empty && empty.index !== undefined) {
    const rows = byRow(edits).map(([row0, list]) => `<row r="${row0 + 1}">${cellsOf(list)}</row>`).join("")
    return splice(sheetXml, empty.index, empty[0].length, `<sheetData>${rows}</sheetData>`)
  }
  const open = /<sheetData\b[^>]*>/.exec(sheetXml)
  if (!open) return sheetXml
  const start = open.index + open[0].length
  const end = sheetXml.indexOf("</sheetData>", start)
  if (end < 0) return sheetXml
  let data = sheetXml.slice(start, end)

  for (const [row0, list] of byRow(edits)) {
    const r = row0 + 1
    // Self-closing first: the open form's lazy match would otherwise run on into the next row
    const bare = new RegExp(`<row\\s+r="${r}"[^>]*/>`).exec(data)
    const full = bare ? null : new RegExp(`<row\\s+r="${r}"[^>]*>[\\s\\S]*?</row>`).exec(data)
    if (full) {
      const head = full[0].slice(0, full[0].indexOf(">") + 1)
      let inner = full[0].slice(head.length, full[0].lastIndexOf("</row>"))
      for (const edit of [...list].sort((a, b) => a.col0 - b.col0)) inner = patchCell(inner, edit)
      data = splice(data, full.index, full[0].length, `${head}${inner}</row>`)
      continue
    }
    const row = `<row r="${r}">${cellsOf(list)}</row>`
    if (bare) {
      data = splice(data, bare.index, bare[0].length, row)
      continue
    }
    // A missing row goes before the first row numbered after it
    let at = -1
    const rows = /<row\s+r="(\d+)"/g
    let next: RegExpExecArray | null
    while ((next = rows.exec(data))) {
      if (parseInt(next[1], 10) > r) {
        at = next.index
        break
      }
    }
    data = at >= 0 ? splice(data, at, 0, row) : data + row
  }
  return sheetXml.slice(0, start) + data + sheetXml.slice(end)
}

export async function writeCellEdits(bytes: Uint8Array, edits: CellEdit[]): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const workbook = zip.file("xl/workbook.xml")
  const rels = zip.file("xl/_rels/workbook.xml.rels")
  if (!workbook || !rels) throw new Error("xlsx has no workbook.xml or its rels, cannot find worksheets")
  const parts = sheetParts(await workbook.async("string"), await rels.async("string"))

  const byPart = new Map<string, CellEdit[]>()
  for (const edit of edits) {
    const part = parts[edit.sheetIndex]
    if (!part) continue
    const list = byPart.get(part)
    if (list) list.push(edit)
    else byPart.set(part, [edit])
  }
  for (const [part, list] of byPart) {
    const file = zip.file(part)
    if (file) zip.file(part, patchSheet(await file.async("string"), list))
  }
  return generate(zip)
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

  const tag = sheetTags(workbook)[sheetIndex]
  if (!tag || tag.index === undefined) throw new Error(`xlsx workbook.xml has no sheet at index ${sheetIndex}`)
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
  if (!workbookFile) throw new Error("xlsx has no workbook.xml")
  const workbook = await workbookFile.async("string")
  const tag = sheetTags(workbook)[sheetIndex]
  if (!tag || tag.index === undefined) throw new Error(`xlsx workbook.xml has no sheet at index ${sheetIndex}`)
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
