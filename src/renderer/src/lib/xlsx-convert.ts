import JSZip from "jszip"
import type * as ExcelJSTypes from "exceljs"
// @ts-expect-error The browser build ships no typings of its own; it is typed through the package's below
import ExcelJSBrowser from "exceljs/dist/exceljs.min.js"
import { BooleanNumber, BorderStyleTypes, CellValueType, HorizontalAlign, LocaleType, VerticalAlign, WrapStrategy } from "@univerjs/core"
import type { IBorderData, IBorderStyleData, ICellData, IRange, IResources, IStyleData, IWorkbookData, IWorksheetData } from "@univerjs/core"

/*
 * MiMo's Excel viewer loads the workbook with exceljs and hands Univer a
 * snapshot of it. What Univer cannot draw on its own is read from the raw
 * parts beside it: data bars and gradient fills (drawn over the canvas),
 * pictures and charts from the drawings, table styles and the theme palette.
 */

// The browser build carries its own Node polyfills (buffer, streams, sax), which the renderer lacks
const ExcelJS: typeof ExcelJSTypes = ExcelJSBrowser

export const MAX_ROWS = 20000
export const MAX_COLS = 200

export interface XlsxRange { startRow: number; startColumn: number; endRow: number; endColumn: number }
export interface XlsxCfRule {
  sheetIndex: number
  ranges: XlsxRange[]
  kind: "colorScale" | "iconSet"
  /** colorScale: at least two stops, colour as #rrggbb */
  stops?: { index: number; color: string; value: { type: string; value?: string | number } }[]
  /** iconSet: the set name (default "3Arrows") and one config per threshold, already in MiMo's reversed order */
  iconSet?: { name: string; configs: { iconId: number; operator: "greaterThanOrEqual"; value: { type: string; value?: string | number } }[] }
}
export interface XlsxDataBar {
  sheetIndex: number
  range: XlsxRange
  color: string // default #638EC6
  min: { type: string; value?: number }
  max: { type: string; value?: number }
  /** row index -> the solid background removed from that row inside the range */
  banding: Record<number, string>
}
export interface XlsxGradient { sheetIndex: number; range: XlsxRange; css: string } // extended to the cell's merge
export interface XlsxImage { sheetIndex: number; row: number; col: number; width: number; height: number; src: string } // px, data URL
export interface XlsxChartRef { sheetIndex: number; fromRow: number; fromCol: number; width: number; height: number; xml: string } // raw chart part XML, px size cx/cy ÷ 9525 (default 480×288)
export interface XlsxLink { sheetIndex: number; row: number; col: number; target: string }
export interface XlsxParsed {
  data: IWorkbookData // for univerAPI.createWorkbook
  sheetIds: string[] // Univer sheet id per exceljs worksheet index ("sheet_<index>_<exceljsId>")
  sheetNames: string[]
  truncated: boolean
  themeColors: string[] // #rrggbb in order lt1, dk1, lt2, dk2, accent1..6, hlink, folHlink ([] when no theme)
  conditionalFormats: XlsxCfRule[]
  dataBars: XlsxDataBar[]
  gradientFills: XlsxGradient[]
  images: XlsxImage[]
  charts: XlsxChartRef[]
  links: XlsxLink[]
  autoFitRows: { sheetIndex: number; rows: number[] }[]
  /** Whether the original cell (0-based) held a formula; edits to such cells are never written back. */
  isFormula(sheetIndex: number, row: number, col: number): boolean
  /** The original exceljs cell value (undefined when empty), for version notes. */
  originalValue(sheetIndex: number, row: number, col: number): unknown
}

/* ------------------------------------------------------------ xml */

const tag = (name: string) => `(?:[a-z0-9]+:)?${name}`

function inner(xml: string | undefined, name: string): string | undefined {
  if (!xml) return undefined
  return new RegExp(`<${tag(name)}\\b[^>]*>([\\s\\S]*?)</${tag(name)}>`, "i").exec(xml)?.[1]
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag(name)}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag(name)}>)`, "gi"))].map((match) => match[0])
}

function openTags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag(name)}\\b[^>]*>`, "gi"))].map((match) => match[0])
}

/** An attribute of one opening tag; the leading space keeps `id` from matching `r:id`. */
function attrIn(open: string, key: string): string | undefined {
  return new RegExp(`\\s${key}="([^"]*)"`).exec(open)?.[1]
}

function columnIndex(letters: string): number {
  let index = 0
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

function decodeCell(ref: string): { row: number; col: number } | null {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref.trim())
  return match ? { row: parseInt(match[2], 10) - 1, col: columnIndex(match[1]) } : null
}

function decodeRange(ref: string): XlsxRange | null {
  const [first, second] = ref.split(":")
  const from = first ? decodeCell(first) : null
  const to = second ? decodeCell(second) : from
  if (!from || !to) return null
  return {
    startRow: Math.min(from.row, to.row),
    startColumn: Math.min(from.col, to.col),
    endRow: Math.max(from.row, to.row),
    endColumn: Math.max(from.col, to.col),
  }
}

function relationships(xml: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const open of openTags(xml, "Relationship")) {
    const id = attrIn(open, "Id")
    const target = attrIn(open, "Target")
    if (id && target) map.set(id, target)
  }
  return map
}

/** A relationship target resolved against the folder of the part that owns it. */
function resolvePart(folder: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1)
  const parts: string[] = []
  for (const piece of `${folder}/${target}`.split("/")) {
    if (piece === "..") parts.pop()
    else if (piece !== "." && piece !== "") parts.push(piece)
  }
  return parts.join("/")
}

const relsOf = (part: string) => part.replace(/([^/]+)$/, "_rels/$1.rels")
const folderOf = (part: string) => part.slice(0, part.lastIndexOf("/"))

async function text(zip: JSZip, path: string): Promise<string | undefined> {
  return zip.file(path)?.async("string")
}

/** Worksheet part paths in workbook order, which is also exceljs's worksheet order. */
async function sheetPaths(zip: JSZip): Promise<string[]> {
  const workbook = await text(zip, "xl/workbook.xml")
  const rels = await text(zip, "xl/_rels/workbook.xml.rels")
  if (!workbook || !rels) return []
  const targets = relationships(rels)
  const types = new Map<string, string>()
  for (const open of openTags(rels, "Relationship")) {
    const id = attrIn(open, "Id")
    const type = attrIn(open, "Type")
    if (id && type) types.set(id, type)
  }
  const paths: string[] = []
  for (const open of openTags(workbook, "sheet")) {
    const id = attrIn(open, "r:id") ?? ""
    const target = targets.get(id) ?? ""
    const type = types.get(id)
    // exceljs drops chartsheets and dialog sheets, so only worksheets take an index
    const worksheet = type ? /\/worksheet$/.test(type) : /(^|\/)worksheets\//.test(target)
    if (!worksheet) continue
    paths.push(target ? resolvePart("xl", target.replace(/^\/?xl\//, "")) : "")
  }
  return paths
}

interface SheetPart {
  index: number
  path: string
  xml: string
  rels: Map<string, string>
}

async function sheetParts(zip: JSZip): Promise<SheetPart[]> {
  const parts: SheetPart[] = []
  const paths = await sheetPaths(zip)
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index]
    const xml = path ? await text(zip, path) : undefined
    if (!xml) continue
    const rels = await text(zip, relsOf(path))
    parts.push({ index, path, xml, rels: rels ? relationships(rels) : new Map() })
  }
  return parts
}

/* ------------------------------------------------------------ colour */

const THEME_SLOTS = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]
const OFFICE_ACCENTS = ["#4F81BD", "#C0504D", "#9BBB59", "#8064A2", "#4BACC6", "#F79646"]

/** Excel's tint: towards white when positive, towards black when negative. */
export function tintColor(hex: string, amount: number): string {
  const value = parseInt(hex.replace("#", ""), 16)
  const shift = (channel: number) => {
    const next = amount > 0 ? channel + (255 - channel) * amount : channel * (1 + amount)
    return Math.max(0, Math.min(255, Math.round(next)))
  }
  const rgb = (shift((value >> 16) & 255) << 16) | (shift((value >> 8) & 255) << 8) | shift(value & 255)
  return "#" + rgb.toString(16).padStart(6, "0").toUpperCase()
}

/** The palette in theme-index order; incomplete schemes count as none, as MiMo does. */
function themePalette(xml: string): string[] | null {
  const scheme = inner(xml, "clrScheme")
  if (!scheme) return null
  const colors = THEME_SLOTS.map((slot) => {
    const body = inner(scheme, slot)
    if (!body) return ""
    const srgb = openTags(body, "srgbClr")[0]
    const sys = openTags(body, "sysClr")[0]
    const hex = (srgb && attrIn(srgb, "val")) || (sys && attrIn(sys, "lastClr")) || ""
    return /^[0-9a-f]{6}$/i.test(hex) ? "#" + hex.toUpperCase() : ""
  })
  return colors.slice(0, 10).every(Boolean) ? colors : null
}

async function readTheme(zip: JSZip): Promise<string[] | null> {
  const file = zip.file(/^xl\/theme\/theme\d+\.xml$/i)[0]
  return file ? themePalette(await file.async("string")) : null
}

function hexTail(value: string): string {
  const trimmed = value.trim()
  return "#" + (trimmed.length >= 6 ? trimmed.slice(-6) : "000000")
}

/** An exceljs colour: argb first, else a theme slot with its tint. */
function excelColor(color: unknown, theme: string[] | null): string | undefined {
  if (!color || typeof color !== "object") return undefined
  const { argb, theme: slot, tint } = color as { argb?: unknown; theme?: unknown; tint?: unknown }
  if (typeof argb === "string" && argb) return "#" + (argb.length === 8 ? argb.slice(2) : argb)
  if (typeof slot !== "number" || !theme) return undefined
  const base = theme[slot]
  if (!base) return undefined
  return typeof tint === "number" && tint !== 0 ? tintColor(base, tint) : base
}

/** A `<color>` tag from styles or a CF rule; theme colours resolve too so stop indexes stay aligned. */
function xmlColor(open: string, theme: string[] | null): string | undefined {
  const rgb = attrIn(open, "rgb")
  if (rgb) return hexTail(rgb)
  const slot = attrIn(open, "theme")
  const base = slot !== undefined && theme ? theme[Number(slot)] : undefined
  if (!base) return undefined
  const tint = Number(attrIn(open, "tint") ?? 0)
  return tint ? tintColor(base, tint) : base
}

/* ------------------------------------------------------------ cells */

const colWidthPx = (chars: number) => Math.round(chars * 7 + 5)
const rowPtToPx = (pt: number) => Math.round((pt * 4) / 3)

const HORIZONTAL: Record<string, HorizontalAlign> = {
  left: HorizontalAlign.LEFT,
  center: HorizontalAlign.CENTER,
  right: HorizontalAlign.RIGHT,
  justify: HorizontalAlign.JUSTIFIED,
  fill: HorizontalAlign.LEFT,
  centerContinuous: HorizontalAlign.CENTER,
  distributed: HorizontalAlign.DISTRIBUTED,
}

const VERTICAL: Record<string, VerticalAlign> = {
  top: VerticalAlign.TOP,
  middle: VerticalAlign.MIDDLE,
  bottom: VerticalAlign.BOTTOM,
  justify: VerticalAlign.MIDDLE,
  distributed: VerticalAlign.MIDDLE,
}

const BORDERS: Record<string, BorderStyleTypes> = {
  thin: BorderStyleTypes.THIN,
  hair: BorderStyleTypes.HAIR,
  dotted: BorderStyleTypes.DOTTED,
  dashed: BorderStyleTypes.DASHED,
  dashDot: BorderStyleTypes.DASH_DOT,
  dashDotDot: BorderStyleTypes.DASH_DOT_DOT,
  double: BorderStyleTypes.DOUBLE,
  medium: BorderStyleTypes.MEDIUM,
  mediumDashed: BorderStyleTypes.MEDIUM_DASHED,
  mediumDashDot: BorderStyleTypes.MEDIUM_DASH_DOT,
  mediumDashDotDot: BorderStyleTypes.MEDIUM_DASH_DOT_DOT,
  slantDashDot: BorderStyleTypes.SLANT_DASH_DOT,
  thick: BorderStyleTypes.THICK,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

function hasFormula(value: unknown): boolean {
  return isRecord(value) && !(value instanceof Date) && ("formula" in value || "sharedFormula" in value)
}

function richTextOf(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.richText)) return undefined
  return value.richText.map((run: unknown) => (isRecord(run) && typeof run.text === "string" ? run.text : "")).join("")
}

/** The formula text; a shared-formula clone only knows its master, so ask the cell for the translation. */
function formulaOf(cell: ExcelJSTypes.Cell, value: Record<string, unknown>): string {
  if (typeof value.formula === "string" && value.formula) return value.formula
  try {
    if (typeof cell.formula === "string" && cell.formula) return cell.formula
  } catch {
    // exceljs throws when a clone's master is gone
  }
  return typeof value.sharedFormula === "string" ? value.sharedFormula : ""
}

function cellValue(cell: ExcelJSTypes.Cell, value: unknown, shown: string): ICellData {
  if (value === null || value === undefined) return {}
  if (typeof value === "number") return { v: value, t: CellValueType.NUMBER }
  if (typeof value === "boolean") return { v: value ? 1 : 0, t: CellValueType.BOOLEAN }
  if (typeof value === "string") return { v: value, t: CellValueType.STRING }
  // Dates keep exceljs's displayed text; Univer gets no date type, as in MiMo
  if (value instanceof Date || !isRecord(value)) return { v: shown, t: CellValueType.STRING }
  if ("formula" in value || "sharedFormula" in value) {
    const source = formulaOf(cell, value)
    const f = source ? (source.startsWith("=") ? source : "=" + source) : undefined
    const result = value.result
    if (isRecord(result) && "error" in result) return { v: String(result.error), t: CellValueType.STRING }
    if (typeof result === "number") return { v: result, t: CellValueType.NUMBER, f }
    if (typeof result === "boolean") return { v: result ? 1 : 0, t: CellValueType.BOOLEAN, f }
    if (typeof result === "string" && result !== "") return { v: result, t: CellValueType.STRING, f }
    return f ? { f } : { v: "", t: CellValueType.STRING }
  }
  const rich = richTextOf(value)
  if (rich !== undefined) return { v: rich, t: CellValueType.STRING }
  if ("text" in value) return { v: richTextOf(value.text) ?? String(value.text), t: CellValueType.STRING }
  if ("error" in value) return { v: String(value.error), t: CellValueType.STRING }
  return { v: shown || "", t: CellValueType.STRING }
}

function borderSide(side: unknown, theme: string[] | null): IBorderStyleData | undefined {
  if (!isRecord(side) || typeof side.style !== "string" || !side.style) return undefined
  return { s: BORDERS[side.style] ?? BorderStyleTypes.THIN, cl: { rgb: excelColor(side.color, theme) ?? "#000000" } }
}

function cellStyle(cell: ExcelJSTypes.Cell, theme: string[] | null): IStyleData | undefined {
  const style: IStyleData = {}
  const font = cell.font
  if (font) {
    if (font.name) style.ff = font.name
    if (font.size) style.fs = font.size
    if (font.bold) style.bl = BooleanNumber.TRUE
    if (font.italic) style.it = BooleanNumber.TRUE
    if (font.underline && font.underline !== "none") style.ul = { s: BooleanNumber.TRUE }
    if (font.strike) style.st = { s: BooleanNumber.TRUE }
    const color = excelColor(font.color, theme)
    if (color) style.cl = { rgb: color }
  }
  const fill = cell.fill
  if (fill && fill.type === "pattern" && fill.pattern === "solid") {
    const color = excelColor(fill.fgColor, theme)
    if (color) style.bg = { rgb: color }
  }
  const alignment = cell.alignment
  if (alignment) {
    if (alignment.horizontal && HORIZONTAL[alignment.horizontal] !== undefined) style.ht = HORIZONTAL[alignment.horizontal]
    if (alignment.vertical && VERTICAL[alignment.vertical] !== undefined) style.vt = VERTICAL[alignment.vertical]
    if (alignment.wrapText) style.tb = WrapStrategy.WRAP
    const rotation = alignment.textRotation
    if (rotation === "vertical") style.tr = { a: 0, v: BooleanNumber.TRUE }
    // Excel turns counter-clockwise for positive angles, Univer clockwise
    else if (typeof rotation === "number" && rotation !== 0) style.tr = { a: -rotation, v: BooleanNumber.FALSE }
  }
  const border = cell.border
  if (border) {
    const sides: IBorderData = {}
    const top = borderSide(border.top, theme)
    const right = borderSide(border.right, theme)
    const bottom = borderSide(border.bottom, theme)
    const left = borderSide(border.left, theme)
    if (top) sides.t = top
    if (right) sides.r = right
    if (bottom) sides.b = bottom
    if (left) sides.l = left
    if (top || right || bottom || left) style.bd = sides
  }
  if (cell.numFmt) style.n = { pattern: cell.numFmt }
  return Object.keys(style).length ? style : undefined
}

/** exceljs's displayed text, which is not always a string (a hyperlink over rich text hands back the runs). */
function textOf(cell: ExcelJSTypes.Cell): string {
  let shown: unknown
  try {
    shown = cell.text
  } catch {
    return ""
  }
  if (typeof shown === "string") return shown
  return richTextOf(shown) ?? (shown === null || shown === undefined ? "" : String(shown))
}

type CellMatrix = Record<number, Record<number, ICellData>>

interface SheetBuild {
  sheet: Partial<IWorksheetData>
  links: { row: number; col: number; target: string }[]
  autoRows: number[]
  originals: Map<number, unknown>
  truncated: boolean
}

const cellKey = (row: number, col: number) => row * 16384 + col

function viewNumber(view: object, key: string): number {
  const value: unknown = (view as Record<string, unknown>)[key]
  return typeof value === "number" ? value : 0
}

function buildSheet(ws: ExcelJSTypes.Worksheet, id: string, theme: string[] | null): SheetBuild {
  const cellData: CellMatrix = {}
  const rowData: Record<number, { h: number }> = {}
  const columnData: Record<number, { w: number }> = {}
  const links: SheetBuild["links"] = []
  const autoRows: number[] = []
  const originals = new Map<number, unknown>()
  const lastRow = Math.min(ws.rowCount, MAX_ROWS)
  let truncated = ws.rowCount > MAX_ROWS || ws.actualColumnCount > MAX_COLS
  let widest = 0

  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > lastRow) return
    const r = rowNumber - 1
    let largestFont = 0
    let wraps = false
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (colNumber > MAX_COLS) {
        truncated = true
        return
      }
      const c = colNumber - 1
      widest = Math.max(widest, colNumber)
      const size = cell.font?.size
      if (size) largestFont = Math.max(largestFont, size)
      // A merged cell's slaves echo the master's value; only the master keeps it
      const merged = cell.type === ExcelJS.ValueType.Merge
      const value: unknown = merged ? undefined : cell.value
      const shown = value === null || value === undefined ? "" : textOf(cell)
      const data = cellValue(cell, value, shown)
      const style = cellStyle(cell, theme)
      if (style) data.s = style
      if (cell.alignment?.wrapText === true || shown.includes("\n")) wraps = true
      if (isRecord(value) && typeof value.hyperlink === "string") links.push({ row: r, col: c, target: value.hyperlink })
      if (value !== null && value !== undefined) originals.set(cellKey(r, c), value)
      if (data.v === undefined && data.f === undefined && !data.s) return
      cellData[r] ??= {}
      cellData[r][c] = data
    })
    // Explicit heights win, then wrapped text waits for Univer's measure, then large fonts
    if (row.height) rowData[r] = { h: rowPtToPx(row.height) }
    else if (wraps) autoRows.push(r)
    else if (largestFont > 11) rowData[r] = { h: Math.round(rowPtToPx(largestFont * 1.32)) }
  })

  const columns = ws.columns as Array<Partial<ExcelJSTypes.Column>> | null | undefined
  columns?.forEach((column, index) => {
    if (index < MAX_COLS && column?.width) columnData[index] = { w: colWidthPx(column.width) }
  })

  const mergeData: IRange[] = []
  const merges: unknown = (ws.model as { merges?: unknown } | undefined)?.merges
  if (Array.isArray(merges)) {
    for (const ref of merges) {
      const range = typeof ref === "string" ? decodeRange(ref) : null
      if (range) mergeData.push(range)
    }
  }

  const frozen = ws.views?.find((view) => view.state === "frozen")
  const xSplit = frozen ? viewNumber(frozen, "xSplit") : 0
  const ySplit = frozen ? viewNumber(frozen, "ySplit") : 0
  const freeze = frozen ? { xSplit, ySplit, startRow: ySplit, startColumn: xSplit } : { xSplit: 0, ySplit: 0, startRow: -1, startColumn: -1 }
  const columnSpan = Math.max(ws.actualColumnCount, widest)
  const tabColor = excelColor(ws.properties?.tabColor, theme)

  const sheet: Partial<IWorksheetData> = {
    id,
    name: ws.name,
    rowCount: Math.max(lastRow + 6, 40),
    columnCount: Math.max(Math.min(columnSpan, MAX_COLS) + 3, 20),
    cellData,
    columnData,
    rowData,
    mergeData,
    freeze,
  }
  if (ws.state === "hidden" || ws.state === "veryHidden") sheet.hidden = BooleanNumber.TRUE
  if (tabColor) sheet.tabColor = tabColor
  return { sheet, links, autoRows, originals, truncated }
}

/* ------------------------------------------------------------ tables */

interface TableBand {
  sheetIndex: number
  range: XlsxRange
  headerRows: number
  headerFill?: string
  headerFont?: string
  bandFill?: string
}

function tableBand(xml: string, sheetIndex: number, theme: string[] | null): TableBand | null {
  const root = openTags(xml, "table")[0]
  const info = openTags(xml, "tableStyleInfo")[0]
  const ref = root && attrIn(root, "ref")
  if (!ref || !info) return null
  const style = /^TableStyle(Light|Medium|Dark)(\d+)$/i.exec(attrIn(info, "name") ?? "")
  const range = decodeRange(ref)
  if (!style || !range) return null
  const light = style[1].toLowerCase() === "light"
  const accentIndex = (parseInt(style[2], 10) - 1) % 7
  const accent = accentIndex === 0 ? "#808080" : (theme?.[3 + accentIndex] ?? OFFICE_ACCENTS[accentIndex - 1])
  return {
    sheetIndex,
    range,
    headerRows: parseInt(attrIn(root, "headerRowCount") ?? "1", 10),
    headerFill: light ? undefined : accent,
    headerFont: light ? undefined : "#FFFFFF",
    bandFill: attrIn(info, "showRowStripes") === "1" ? tintColor(accent, light ? 0.9 : 0.8) : undefined,
  }
}

async function readTables(zip: JSZip, parts: SheetPart[], theme: string[] | null): Promise<TableBand[]> {
  const bands: TableBand[] = []
  for (const part of parts) {
    for (const target of part.rels.values()) {
      if (!/tables?\/table\d+\.xml$/i.test(target)) continue
      const xml = await text(zip, resolvePart(folderOf(part.path), target))
      const band = xml ? tableBand(xml, part.index, theme) : null
      if (band) bands.push(band)
    }
  }
  return bands
}

/** Table fills go only where the cell has no background or colour of its own. */
function applyTables(sheets: Record<string, Partial<IWorksheetData>>, sheetIds: string[], bands: TableBand[]) {
  for (const band of bands) {
    const matrix = sheets[sheetIds[band.sheetIndex] ?? ""]?.cellData as CellMatrix | undefined
    if (!matrix) continue
    const { startRow, startColumn } = band.range
    const endRow = Math.min(band.range.endRow, MAX_ROWS - 1)
    const endColumn = Math.min(band.range.endColumn, MAX_COLS - 1)
    for (let row = startRow; row <= endRow; row++) {
      const header = row < startRow + band.headerRows
      const striped = !header && (row - startRow - band.headerRows) % 2 === 0
      const fill = header ? band.headerFill : striped ? band.bandFill : undefined
      if (!fill) continue
      for (let col = startColumn; col <= endColumn; col++) {
        const cell = ((matrix[row] ??= {})[col] ??= {})
        const style: IStyleData = isRecord(cell.s) ? cell.s : (cell.s = {})
        if (!style.bg) style.bg = { rgb: fill }
        if (header && band.headerFont && !style.cl) style.cl = { rgb: band.headerFont }
      }
    }
  }
}

/* ------------------------------------------------------------ conditional formats */

type CfValue = { type: string; value?: string | number }

function cfValue(open: string): CfValue {
  const type = attrIn(open, "type") || "num"
  const raw = attrIn(open, "val")
  if (raw === undefined || raw === "") return { type }
  const number = parseFloat(raw)
  return { type, value: Number.isFinite(number) ? number : raw }
}

interface RawDataBar {
  sheetIndex: number
  ranges: XlsxRange[]
  color: string
  min: CfValue
  max: CfValue
}

function sqrefRanges(sqref: string): XlsxRange[] {
  return sqref.split(/\s+/).filter(Boolean).map(decodeRange).filter((range): range is XlsxRange => !!range)
}

function numericValue(value: CfValue): { type: string; value?: number } {
  return typeof value.value === "number" ? { type: value.type, value: value.value } : { type: value.type }
}

/** Only colorScale, iconSet and dataBar are read, each from the block's first rule. */
function readConditionalFormats(part: SheetPart, theme: string[] | null, rules: XlsxCfRule[], bars: RawDataBar[]) {
  if (!part.xml.includes("conditionalFormatting")) return
  const pattern = new RegExp(`<${tag("conditionalFormatting")}\\b([^>]*)>([\\s\\S]*?)</${tag("conditionalFormatting")}>`, "gi")
  for (const match of part.xml.matchAll(pattern)) {
    const sqref = attrIn(match[1], "sqref")
    if (!sqref) continue
    const rule = blocks(match[2], "cfRule")[0]
    const type = rule && attrIn(openTags(rule, "cfRule")[0] ?? "", "type")
    if (!rule || !type) continue
    const ranges = sqrefRanges(sqref)
    if (!ranges.length) continue
    const colors = openTags(rule, "color").map((open) => xmlColor(open, theme))
    const values = openTags(rule, "cfvo").map(cfValue)
    if (type === "colorScale") {
      const stops = values.map((value, index) => ({ index, color: colors[index] ?? "#FFFFFF", value }))
      if (stops.length >= 2) rules.push({ sheetIndex: part.index, ranges, kind: "colorScale", stops })
    } else if (type === "dataBar") {
      bars.push({
        sheetIndex: part.index,
        ranges,
        color: colors[0] ?? "#638EC6",
        min: values[0] ?? { type: "min" },
        max: values[1] ?? { type: "max" },
      })
    } else if (type === "iconSet") {
      const name = attrIn(openTags(rule, "iconSet")[0] ?? "", "iconSet") || "3Arrows"
      // Univer lists icons from the top threshold down, the file from the bottom up
      const configs = values.map((_, position) => ({
        iconId: position,
        operator: "greaterThanOrEqual" as const,
        value: values[values.length - 1 - position],
      }))
      rules.push({ sheetIndex: part.index, ranges, kind: "iconSet", iconSet: { name, configs } })
    }
  }
}

/* ------------------------------------------------------------ gradient fills */

function gradientCss(fill: string, theme: string[] | null): string | null {
  const gradient = blocks(fill, "gradientFill")[0]
  if (!gradient) return null
  const degree = parseFloat(attrIn(openTags(gradient, "gradientFill")[0] ?? "", "degree") ?? "0") || 0
  const stops: string[] = []
  for (const stop of blocks(gradient, "stop")) {
    const position = parseFloat(attrIn(openTags(stop, "stop")[0] ?? "", "position") ?? "")
    const color = openTags(stop, "color")[0]
    const hex = color ? xmlColor(color, theme) : undefined
    if (Number.isFinite(position) && hex) stops.push(`${hex} ${Math.round(position * 100)}%`)
  }
  // Excel's 0° runs left to right, CSS's 0° bottom to top
  return stops.length < 2 ? null : `linear-gradient(${degree + 90}deg, ${stops.join(", ")})`
}

async function readGradients(zip: JSZip, parts: SheetPart[], theme: string[] | null): Promise<XlsxGradient[]> {
  const styles = await text(zip, "xl/styles.xml")
  if (!styles) return []
  const fills = new Map<number, string>()
  blocks(inner(styles, "fills") ?? "", "fill").forEach((fill, index) => {
    const css = gradientCss(fill, theme)
    if (css) fills.set(index, css)
  })
  if (!fills.size) return []
  const xfFills = openTags(inner(styles, "cellXfs") ?? "", "xf").map((open) => parseInt(attrIn(open, "fillId") ?? "-1", 10))
  const found: XlsxGradient[] = []
  for (const part of parts) {
    const merges = openTags(part.xml, "mergeCell")
      .map((open) => decodeRange(attrIn(open, "ref") ?? ""))
      .filter((range): range is XlsxRange => !!range)
    for (const open of openTags(part.xml, "c")) {
      const styleIndex = attrIn(open, "s")
      const ref = attrIn(open, "r")
      const css = styleIndex !== undefined ? fills.get(xfFills[parseInt(styleIndex, 10)] ?? -1) : undefined
      const at = ref ? decodeCell(ref) : null
      if (!css || !at) continue
      const merge = merges.find((range) => range.startRow === at.row && range.startColumn === at.col)
      found.push({
        sheetIndex: part.index,
        range: merge ?? { startRow: at.row, startColumn: at.col, endRow: at.row, endColumn: at.col },
        css,
      })
    }
  }
  return found
}

/* ------------------------------------------------------------ drawings */

const EMU_PER_PX = 9525
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
}

interface Anchor {
  fromRow: number
  fromCol: number
  width: number
  height: number
  toRow?: number
  toCol?: number
}

/** Where a drawing sits: its `from` cell (offsets ignored, as MiMo does) and its extent in px. */
function anchorOf(block: string): Anchor | null {
  const from = inner(block, "from")
  if (!from) return null
  const index = (xml: string, name: string) => parseInt(inner(xml, name)?.trim() ?? "0", 10) || 0
  const to = inner(block, "to")
  const extent = new RegExp(`<${tag("ext")}\\b[^>]*\\bcx="(\\d+)"[^>]*\\bcy="(\\d+)"`, "i").exec(block)
  return {
    fromRow: index(from, "row"),
    fromCol: index(from, "col"),
    width: extent ? Math.round(parseInt(extent[1], 10) / EMU_PER_PX) : 480,
    height: extent ? Math.round(parseInt(extent[2], 10) / EMU_PER_PX) : 288,
    toRow: to ? index(to, "row") : undefined,
    toCol: to ? index(to, "col") : undefined,
  }
}

interface Drawings {
  images: (XlsxImage & { anchor: Anchor })[]
  charts: (XlsxChartRef & { anchor: Anchor })[]
}

async function readDrawings(zip: JSZip, parts: SheetPart[]): Promise<Drawings> {
  const found: Drawings = { images: [], charts: [] }
  const anchorPattern = new RegExp(`<${tag("(oneCellAnchor|twoCellAnchor)")}\\b[\\s\\S]*?</${tag("\\1")}>`, "gi")
  for (const part of parts) {
    for (const target of part.rels.values()) {
      if (!/drawings?\/drawing\d+\.xml$/i.test(target)) continue
      const drawingPath = resolvePart(folderOf(part.path), target)
      const drawing = await text(zip, drawingPath)
      if (!drawing) continue
      const relsXml = await text(zip, relsOf(drawingPath))
      const rels = relsXml ? relationships(relsXml) : new Map<string, string>()
      const folder = folderOf(drawingPath)
      for (const match of drawing.matchAll(anchorPattern)) {
        const block = match[0]
        const chartId = openTags(block, "chart").map((open) => attrIn(open, "r:id")).find(Boolean)
        if (chartId) {
          const chartTarget = rels.get(chartId)
          const xml = chartTarget ? await text(zip, resolvePart(folder, chartTarget)) : undefined
          const anchor = anchorOf(block)
          if (xml && anchor) {
            const { fromRow, fromCol, width, height } = anchor
            found.charts.push({ sheetIndex: part.index, fromRow, fromCol, width, height, xml, anchor })
          }
          continue
        }
        if (!new RegExp(`<${tag("pic")}\\b`, "i").test(block)) continue
        const embed = openTags(block, "blip").map((open) => attrIn(open, "r:embed")).find(Boolean)
        const mediaTarget = embed ? rels.get(embed) : undefined
        if (!mediaTarget) continue
        const mediaPath = resolvePart(folder, mediaTarget)
        const media = zip.file(mediaPath)
        const anchor = anchorOf(block)
        if (!media || !anchor) continue
        const extension = (mediaPath.split(".").pop() ?? "png").toLowerCase()
        const src = `data:${IMAGE_TYPES[extension] ?? "image/png"};base64,${await media.async("base64")}`
        found.images.push({ sheetIndex: part.index, row: anchor.fromRow, col: anchor.fromCol, width: anchor.width, height: anchor.height, src, anchor })
      }
    }
  }
  return found
}

/* ------------------------------------------------------------ load */

const DECORATIVE_RELS = /Type="[^"]*\/relationships\/(?:drawing|vmlDrawing|comments|threadedComment|oleObject|control|ctrlProp|table)"/i

function isDecorativePart(path: string): boolean {
  return /^xl\/(drawings|charts|media|embeddings|tables)\//i.test(path) || /^xl\/comments\d+\.xml$/i.test(path) || /^xl\/threadedComments\//i.test(path)
}

/** Rich strings that also carry a bare `<t>` trip exceljs; the runs alone are the text. */
function sanitizeSharedStrings(xml: string): string {
  return xml.replace(/<si\b[^>]*>[\s\S]*?<\/si>/gi, (item) => {
    if (!/<r\b/i.test(item)) return item
    const runs: string[] = []
    const held = item.replace(/<(r|rPh)\b[^>]*>[\s\S]*?<\/\1>/gi, (run) => `\u0000${runs.push(run) - 1}\u0000`)
    if (!runs.length) return item
    return held
      .replace(/<t\b[^>]*\/>/gi, "")
      .replace(/<t\b[^>]*>[\s\S]*?<\/t>/gi, "")
      .replace(/\x00(\d+)\x00/g, (_match, index: string) => runs[Number(index)])
  })
}

/** The fallback when exceljs chokes: drop drawings, controls, comments and tables, keep the cells. */
async function sanitizeWorkbook(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files)
  const empty = /<(?:\w+:)?(drawing|legacyDrawing|picture|oleObjects|controls|tableParts)\b[^>]*\/>/gi
  const full = /<(?:\w+:)?(drawing|legacyDrawing|picture|oleObjects|controls|tableParts)\b[^>]*>[\s\S]*?<\/(?:\w+:)?\1>/gi
  for (const name of names) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) {
      const xml = await zip.files[name].async("string")
      const next = xml.replace(full, "").replace(empty, "")
      if (next !== xml) zip.file(name, next)
    } else if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/i.test(name)) {
      const xml = await zip.files[name].async("string")
      const next = xml.replace(/<Relationship\b[^>]*\/>/gi, (rel) => (DECORATIVE_RELS.test(rel) ? "" : rel))
      if (next !== xml) zip.file(name, next)
    }
  }
  for (const name of names) if (isDecorativePart(name)) zip.remove(name)
  const shared = names.find((name) => /^xl\/sharedStrings\.xml$/i.test(name))
  if (shared) {
    const xml = await zip.files[shared].async("string")
    const next = sanitizeSharedStrings(xml)
    if (next !== xml) zip.file(shared, next)
  }
  return zip.generateAsync({ type: "uint8array" })
}

type LoadInput = Parameters<ExcelJSTypes.Xlsx["load"]>[0]

// exceljs's browser build reads an ArrayBuffer; its typings only name Node's Buffer
const loadInput = (bytes: Uint8Array) => bytes.slice().buffer as unknown as LoadInput

async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJSTypes.Workbook> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(loadInput(bytes))
    return workbook
  } catch (error) {
    console.warn("[xlsx-convert] load failed, retrying without drawings:", error)
    const retry = new ExcelJS.Workbook()
    await retry.xlsx.load(loadInput(await sanitizeWorkbook(bytes)))
    return retry
  }
}

function definedNames(workbook: ExcelJSTypes.Workbook): IResources[number] | undefined {
  const model: unknown = workbook.definedNames?.model
  if (!Array.isArray(model) || !model.length) return undefined
  const entries: Record<string, { id: string; name: string; formulaOrRefString: string }> = {}
  model.forEach((entry: unknown, index) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name) return
    if (!Array.isArray(entry.ranges) || !entry.ranges.length) return
    const id = `dn-${index}`
    entries[id] = { id, name: entry.name, formulaOrRefString: entry.ranges.join(",") }
  })
  return Object.keys(entries).length ? { name: "SHEET_DEFINED_NAME_PLUGIN", data: JSON.stringify(entries) } : undefined
}

async function settle<T>(label: string, work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work
  } catch (error) {
    console.warn(`[xlsx-convert] ${label} failed:`, error)
    return fallback
  }
}

export async function parseXlsx(bytes: Uint8Array, fileName: string): Promise<XlsxParsed> {
  const workbook = await loadWorkbook(bytes)
  let zip: JSZip | null = null
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (error) {
    console.warn("[xlsx-convert] zip load failed:", error)
  }
  const palette = zip ? await settle("theme", readTheme(zip), null) : null

  const sheets: Record<string, Partial<IWorksheetData>> = {}
  const sheetIds: string[] = []
  const sheetNames: string[] = []
  const originals: Map<number, unknown>[] = []
  const links: XlsxLink[] = []
  const autoFitRows: XlsxParsed["autoFitRows"] = []
  let truncated = false
  workbook.worksheets.forEach((ws, index) => {
    const id = `sheet_${index}_${ws.id}`
    const built = buildSheet(ws, id, palette)
    sheets[id] = built.sheet
    sheetIds.push(id)
    sheetNames.push(ws.name)
    originals.push(built.originals)
    truncated ||= built.truncated
    for (const link of built.links) links.push({ sheetIndex: index, ...link })
    if (built.autoRows.length) autoFitRows.push({ sheetIndex: index, rows: built.autoRows })
  })
  // Univer needs a sheet to open; the ids list stays per exceljs worksheet
  const sheetOrder = sheetIds.length ? [...sheetIds] : ["sheet_empty"]
  if (!sheetIds.length) sheets.sheet_empty = { id: "sheet_empty", name: "Sheet1", rowCount: 40, columnCount: 20 }

  const parts = zip ? await settle("sheet parts", sheetParts(zip), []) : []
  if (zip) applyTables(sheets, sheetIds, await settle("table banding", readTables(zip, parts, palette), []))

  const conditionalFormats: XlsxCfRule[] = []
  const rawBars: RawDataBar[] = []
  for (const part of parts) {
    try {
      readConditionalFormats(part, palette, conditionalFormats, rawBars)
    } catch (error) {
      console.warn("[xlsx-convert] conditional formats failed:", error)
    }
  }
  const gradientFills = zip ? await settle("gradient fills", readGradients(zip, parts, palette), []) : []
  const drawings = zip ? await settle("drawings", readDrawings(zip, parts), { images: [], charts: [] }) : { images: [], charts: [] }

  // Grow each sheet so pictures and charts have cells to sit over
  for (const item of [...drawings.charts, ...drawings.images]) {
    const sheet = sheets[sheetIds[item.sheetIndex] ?? ""]
    if (!sheet) continue
    const { anchor } = item
    const columns = Math.min((anchor.toCol ?? anchor.fromCol + Math.ceil(anchor.width / 64)) + 3, MAX_COLS)
    const rows = Math.min((anchor.toRow ?? anchor.fromRow + Math.ceil(anchor.height / 20)) + 3, MAX_ROWS)
    if ((sheet.columnCount ?? 0) < columns) sheet.columnCount = columns
    if ((sheet.rowCount ?? 0) < rows) sheet.rowCount = rows
  }

  // Data bars are painted over the canvas, so the solid fills under them move to the overlay
  const dataBars: XlsxDataBar[] = []
  for (const bar of rawBars) {
    const matrix = sheets[sheetIds[bar.sheetIndex] ?? ""]?.cellData as CellMatrix | undefined
    for (const range of bar.ranges) {
      const banding: Record<number, string> = {}
      if (matrix) {
        // A whole-column rule reaches row 1048576; cells only exist inside the converted size
        const endRow = Math.min(range.endRow, MAX_ROWS - 1)
        const endColumn = Math.min(range.endColumn, MAX_COLS - 1)
        for (let row = range.startRow; row <= endRow; row++) {
          for (let col = range.startColumn; col <= endColumn; col++) {
            const style = matrix[row]?.[col]?.s
            const rgb = style && typeof style === "object" ? style.bg?.rgb : undefined
            if (!style || typeof style !== "object" || typeof rgb !== "string") continue
            banding[row] = rgb
            delete style.bg
          }
        }
      }
      dataBars.push({ sheetIndex: bar.sheetIndex, range, color: bar.color, min: numericValue(bar.min), max: numericValue(bar.max), banding })
    }
  }

  const names = definedNames(workbook)
  const data: IWorkbookData = {
    id: "xlsx-preview",
    name: fileName,
    appVersion: "",
    locale: LocaleType.ZH_CN,
    styles: {},
    sheetOrder,
    sheets,
    ...(names ? { resources: [names] } : {}),
  }

  const original = (sheetIndex: number, row: number, col: number) => originals[sheetIndex]?.get(cellKey(row, col))
  return {
    data,
    sheetIds,
    sheetNames,
    truncated,
    themeColors: palette ?? [],
    conditionalFormats,
    dataBars,
    gradientFills,
    images: drawings.images.map(({ anchor: _anchor, ...image }) => image),
    charts: drawings.charts.map(({ anchor: _anchor, ...chart }) => chart),
    links,
    autoFitRows,
    isFormula: (sheetIndex, row, col) => hasFormula(original(sheetIndex, row, col)),
    originalValue: original,
  }
}

/* ------------------------------------------------------------ facade */

interface CfRuleBuilder {
  setRanges(ranges: IRange[]): { build(): unknown }
}

interface CfBuilder {
  setColorScale(config: { index: number; color: string; value: CfValue }[]): CfRuleBuilder
  setIconSet(config: { iconConfigs: { iconType: string; iconId: string; operator: string; value: CfValue }[]; isShowValue: boolean }): CfRuleBuilder
}

interface FacadeSheet {
  getRowHeight?(row: number): number
  getMaxColumns?(): number
  setRangesAutoHeight?(ranges: IRange[]): unknown
  newConditionalFormattingRule?(): CfBuilder
  addConditionalFormattingRule?(rule: unknown): unknown
}

interface FacadeWorkbook {
  getSheetBySheetId(sheetId: string): FacadeSheet | null
}

function activeWorkbook(univerAPI: unknown): FacadeWorkbook | null {
  if (!isRecord(univerAPI) || typeof univerAPI.getActiveWorkbook !== "function") return null
  const book: unknown = (univerAPI as { getActiveWorkbook(): unknown }).getActiveWorkbook()
  return isRecord(book) && typeof book.getSheetBySheetId === "function" ? (book as unknown as FacadeWorkbook) : null
}

const plainValue = (value: CfValue): CfValue => (value.value !== undefined && value.value !== null ? { type: value.type, value: value.value } : { type: value.type })

/** Adds colorScale and iconSet rules through the Univer facade (univerAPI.getActiveWorkbook().getSheetBySheetId(id).newConditionalFormattingRule()...). Errors per rule are caught and warned. */
export function applyConditionalFormats(univerAPI: unknown, parsed: XlsxParsed): void {
  if (!parsed.conditionalFormats.length) return
  const book = activeWorkbook(univerAPI)
  if (!book) return
  for (const rule of parsed.conditionalFormats) {
    const id = parsed.sheetIds[rule.sheetIndex]
    const sheet = id ? book.getSheetBySheetId(id) : null
    if (!sheet?.newConditionalFormattingRule || !sheet.addConditionalFormattingRule) continue
    try {
      const builder = sheet.newConditionalFormattingRule()
      let ruleBuilder: CfRuleBuilder | undefined
      if (rule.kind === "colorScale" && rule.stops) {
        ruleBuilder = builder.setColorScale(rule.stops.map((stop) => ({ index: stop.index, color: stop.color, value: plainValue(stop.value) })))
      } else if (rule.kind === "iconSet" && rule.iconSet) {
        const name = rule.iconSet.name
        ruleBuilder = builder.setIconSet({
          isShowValue: true,
          iconConfigs: rule.iconSet.configs.map((config) => ({
            iconType: name,
            iconId: String(config.iconId),
            operator: config.operator,
            value: plainValue(config.value),
          })),
        })
      }
      if (ruleBuilder) sheet.addConditionalFormattingRule(ruleBuilder.setRanges(rule.ranges.map((range) => ({ ...range }))).build())
    } catch (error) {
      console.warn("[xlsx-convert] apply conditional format failed:", rule.kind, error)
    }
  }
}

const AUTO_HEIGHT_RETRIES = [60, 180, 420, 900, 1800]

/** Consecutive rows become one range across every column. */
function rowRuns(rows: number[], lastColumn: number): IRange[] {
  const sorted = [...new Set(rows.filter((row) => Number.isInteger(row) && row >= 0))].sort((a, b) => a - b)
  const runs: IRange[] = []
  for (const row of sorted) {
    const last = runs[runs.length - 1]
    if (last && row === last.endRow + 1) last.endRow = row
    else runs.push({ startRow: row, endRow: row, startColumn: 0, endColumn: Math.max(lastColumn, 0) })
  }
  return runs
}

/** Runs setRangesAutoHeight on consecutive runs of the queued rows; retries rows whose height did not change at 60/180/420/900/1800 ms while alive() holds. */
export function fitRowHeights(univerAPI: unknown, parsed: XlsxParsed, alive: () => boolean): void {
  // Univer measures wrapped text only once its fonts and canvas are ready, so an early pass may be a no-op
  const attempt = (pending: XlsxParsed["autoFitRows"], delays: number[]) => {
    if (!alive()) return
    const book = activeWorkbook(univerAPI)
    const retry: XlsxParsed["autoFitRows"] = []
    let failure: unknown = book ? null : new Error("workbook unavailable")
    for (const group of pending) {
      const id = parsed.sheetIds[group.sheetIndex]
      const sheet = book && id ? book.getSheetBySheetId(id) : null
      if (!sheet?.setRangesAutoHeight) {
        if (!book) retry.push(group)
        continue
      }
      const before = group.rows.map((row) => sheet.getRowHeight?.(row))
      try {
        sheet.setRangesAutoHeight(rowRuns(group.rows, (sheet.getMaxColumns?.() ?? 1) - 1))
      } catch (error) {
        failure = error
        retry.push(group)
        continue
      }
      const unchanged = group.rows.filter((row, index) => sheet.getRowHeight?.(row) === before[index])
      if (unchanged.length) retry.push({ sheetIndex: group.sheetIndex, rows: unchanged })
    }
    if (!retry.length) return
    const [delay, ...rest] = delays
    if (delay === undefined) {
      if (failure) console.warn("[xlsx-convert] auto row height failed:", failure)
      return
    }
    setTimeout(() => attempt(retry, rest), delay)
  }
  if (parsed.autoFitRows.length) attempt(parsed.autoFitRows, AUTO_HEIGHT_RETRIES)
}
