import type { XlsxChartRef, XlsxDataBar, XlsxGradient, XlsxImage } from "./xlsx-convert"
import { parseSheetChart, renderChartSvg, type SheetChart } from "./xlsx-chart"

/*
 * What MiMo draws over the Univer grid itself: gradient fills and data bars
 * under the text's layer order, pictures, and charts as SVG in white boxes
 * that can be picked. Every layer sits exactly on the grid's canvas and is
 * clipped past the frozen panes, and every item follows its anchor cell
 * through scrolling, edits and resizes. Items on other sheets are hidden.
 */

interface Rect {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
}

export interface SheetLike {
  getSheetId(): string
  getSheetName(): string
  getRange(row: number, column: number): RangeLike
  getRange(a1: string): RangeLike
  getScrollState?(): { sheetViewStartRow?: number; sheetViewStartColumn?: number; offsetX?: number; offsetY?: number }
  getFreeze?(): { xSplit?: number; ySplit?: number }
  onScroll?(callback: () => void): { dispose(): void } | undefined
  getSkeleton?(): unknown
}

interface RangeLike {
  getCellRect(): Rect
  getValues(): unknown[][]
}

export interface WorkbookLike {
  getActiveSheet(): SheetLike | null
  getSheetByName?(name: string): SheetLike | null
}

export interface UniverLike {
  getActiveWorkbook(): WorkbookLike | null
}

/**
 * Whether the grid has laid this sheet out. Until it has, Univer has no scroll
 * service or cell skeleton for it: reading the scroll state throws, and asking
 * a cell's box logs an error before throwing - so nothing is placed until then.
 */
export function gridReady(sheet: SheetLike): boolean {
  try {
    if (sheet.getSkeleton && !sheet.getSkeleton()) return false
    sheet.getScrollState?.()
    return true
  } catch {
    return false
  }
}

/** Where the grid's content starts on the layer: the scroll position as content pixels. */
export function scrollOffset(sheet: SheetLike): { x: number; y: number } {
  try {
    // Before the grid has drawn once, Univer has no scroll service for it yet and this throws.
    const state = sheet.getScrollState?.() ?? {}
    const origin = sheet.getRange(0, 0).getCellRect()
    const start = sheet.getRange(state.sheetViewStartRow ?? 0, state.sheetViewStartColumn ?? 0).getCellRect()
    return { x: start.left - origin.left + (state.offsetX ?? 0), y: start.top - origin.top + (state.offsetY ?? 0) }
  } catch {
    return { x: 0, y: 0 }
  }
}

function frozenEdge(sheet: SheetLike): { left: number; top: number } {
  try {
    const freeze = sheet.getFreeze?.() ?? {}
    return { left: sheet.getRange(0, Math.max(0, freeze.xSplit ?? 0)).getCellRect().left, top: sheet.getRange(Math.max(0, freeze.ySplit ?? 0), 0).getCellRect().top }
  } catch {
    return { left: 0, top: 0 }
  }
}

/** The grid's drawing surface: the largest canvas in the viewer. */
export function gridCanvas(wrap: HTMLElement): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null
  for (const canvas of wrap.querySelectorAll("canvas")) {
    if (!best || canvas.clientWidth * canvas.clientHeight > best.clientWidth * best.clientHeight) best = canvas
  }
  return best
}

export interface LayerBox {
  left: number
  top: number
  width: number
  height: number
  clipTop: number
  clipLeft: number
}

/** The box a layer takes over the canvas, relative to the viewer, and where the frozen panes end. */
export function layerBox(wrap: HTMLElement, sheet: SheetLike): LayerBox | null {
  const canvas = gridCanvas(wrap)
  if (!canvas || !gridReady(sheet)) return null
  const box = canvas.getBoundingClientRect()
  const origin = wrap.getBoundingClientRect()
  const frozen = frozenEdge(sheet)
  return { left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height, clipTop: frozen.top, clipLeft: frozen.left }
}

function placeLayer(layer: HTMLElement, box: LayerBox | null) {
  if (!box) return
  Object.assign(layer.style, {
    inset: "auto",
    left: `${Math.round(box.left)}px`,
    top: `${Math.round(box.top)}px`,
    width: `${Math.round(box.width)}px`,
    height: `${Math.round(box.height)}px`,
    clipPath: `inset(${Math.round(box.clipTop)}px 0 0 ${Math.round(box.clipLeft)}px)`,
  })
}

function columnName(column: number) {
  let n = column + 1
  let out = ""
  while (n > 0) {
    const rest = (n - 1) % 26
    out = String.fromCharCode(65 + rest) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function columnIndex(letters: string) {
  let n = 0
  for (const letter of letters.toUpperCase()) n = n * 26 + (letter.charCodeAt(0) - 64)
  return n - 1
}

/** An A1 cell or range as 0-based corners. */
export function parseA1(a1: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(a1.replace(/\$/g, ""))
  if (!match) return null
  const c1 = columnIndex(match[1])
  const r1 = Number(match[2]) - 1
  const c2 = match[3] ? columnIndex(match[3]) : c1
  const r2 = match[4] ? Number(match[4]) - 1 : r1
  return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) }
}

function rectOf(sheet: SheetLike, row: number, column: number): Rect | null {
  try {
    const rect = sheet.getRange(row, column).getCellRect()
    return rect.width || rect.height ? rect : null
  } catch {
    return null
  }
}

export type MarkAnchor = { type: "cell"; sheetName: string; a1: string } | { type: "chart"; sheetIndex: number; fromRow: number; fromCol: number; width: number; height: number }

/** An annotation's box on the layer, or null when it is on another sheet or not laid out. */
export function anchorBox(sheet: SheetLike, sheetIds: string[], anchor: MarkAnchor): { left: number; top: number; w: number; h: number } | null {
  if (!gridReady(sheet)) return null
  const offset = scrollOffset(sheet)
  if (anchor.type === "chart") {
    if (sheetIds.indexOf(sheet.getSheetId()) !== anchor.sheetIndex) return null
    const from = rectOf(sheet, anchor.fromRow, anchor.fromCol)
    return from ? { left: from.left - offset.x, top: from.top - offset.y, w: anchor.width, h: anchor.height } : null
  }
  if (anchor.sheetName !== sheet.getSheetName()) return null
  const cells = parseA1(anchor.a1)
  if (!cells) return null
  const first = rectOf(sheet, cells.r1, cells.c1)
  const last = cells.r1 === cells.r2 && cells.c1 === cells.c2 ? first : rectOf(sheet, cells.r2, cells.c2)
  if (!first || !last) return null
  const box = { left: first.left - offset.x, top: first.top - offset.y, w: last.right - first.left, h: last.bottom - first.top }
  return box.w > 0 && box.h > 0 ? box : null
}

function numberOf(value: unknown) {
  if (typeof value === "number") return value
  const parsed = Number.parseFloat(String(value ?? "").replace(/[,¥$%\s]/g, ""))
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function bound(kind: { type: string; value?: number }, values: number[], min: number, max: number) {
  switch (kind.type) {
    case "max":
      return max
    case "num":
      return kind.value ?? min
    case "percent":
      return min + ((kind.value ?? 0) / 100) * (max - min)
    case "percentile": {
      const sorted = [...values].sort((a, b) => a - b)
      const at = ((kind.value ?? 0) / 100) * (sorted.length - 1)
      const low = Math.floor(at)
      const high = Math.ceil(at)
      return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (at - low)
    }
    default:
      return min
  }
}

export interface ChartPick {
  title?: string
  kind: string
  sheetIndex: number
  fromRow: number
  fromCol: number
  width: number
  height: number
  catRef: string
  valRef: string
}

export interface SheetOverlays {
  reposition(): void
  /** Cell values changed: charts and data bars read their data again. */
  invalidate(): void
  /** The chart box under a point, now selected, or null (clearing the selection). */
  selectChartAt(x: number, y: number): ChartPick | null
  clearChartSelection(): void
  dispose(): void
}

interface Options {
  wrap: HTMLElement
  api: UniverLike
  sheetIds: string[]
  themeColors: string[]
  gradients: XlsxGradient[]
  dataBars: XlsxDataBar[]
  images: XlsxImage[]
  charts: XlsxChartRef[]
  /** Called after every placement, so the view can place its own marks. */
  onPlaced?: () => void
}

function makeLayer(wrap: HTMLElement, z: number, attribute?: string) {
  const layer = document.createElement("div")
  if (attribute) layer.setAttribute(attribute, "")
  Object.assign(layer.style, { position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", zIndex: String(z) })
  wrap.appendChild(layer)
  return layer
}

export function createSheetOverlays(options: Options): SheetOverlays {
  const { wrap, api, sheetIds } = options
  const layers: HTMLElement[] = []
  const later = (z: number, attribute?: string) => {
    const layer = makeLayer(wrap, z, attribute)
    layers.push(layer)
    return layer
  }

  const gradientLayer = options.gradients.length ? later(1) : null
  const gradients = options.gradients.map((region) => {
    const el = document.createElement("div")
    Object.assign(el.style, { position: "absolute", display: "none", background: region.css, pointerEvents: "none" })
    gradientLayer?.appendChild(el)
    return { region, el }
  })

  const barLayer = options.dataBars.length ? later(1) : null
  const barEls: HTMLElement[] = []
  const barData: ({ values: number[][]; lo: number; hi: number } | null)[] = options.dataBars.map(() => null)

  const chartLayer = options.charts.length ? later(10) : null
  const charts = options.charts
    .map((ref) => ({ ref, chart: parseSheetChart(ref.xml, options.themeColors) }))
    .filter((entry): entry is { ref: XlsxChartRef; chart: SheetChart } => Boolean(entry.chart))
    .map((entry) => {
      const el = document.createElement("div")
      el.setAttribute("data-chart-overlay", "")
      Object.assign(el.style, {
        position: "absolute",
        display: "none",
        boxSizing: "border-box",
        pointerEvents: "auto",
        overflow: "hidden",
        cursor: "pointer",
        background: "#ffffff",
        border: "1px solid #d9d9d9",
        borderRadius: "2px",
      })
      chartLayer?.appendChild(el)
      return { ...entry, el, drawnKey: "" }
    })
  const frame = document.createElement("div")
  Object.assign(frame.style, { position: "absolute", display: "none", boxSizing: "border-box", border: "1px solid #7f7f7f", pointerEvents: "none", zIndex: "1" })
  for (const [x, y] of [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]]) {
    const handle = document.createElement("div")
    Object.assign(handle.style, {
      position: "absolute",
      width: "8px",
      height: "8px",
      borderRadius: "50%",
      background: "#ffffff",
      border: "1px solid #7f7f7f",
      left: `${x * 100}%`,
      top: `${y * 100}%`,
      transform: "translate(-50%,-50%)",
    })
    frame.appendChild(handle)
  }
  chartLayer?.appendChild(frame)
  let selected: number | null = null

  const imageLayer = options.images.length ? later(10, "data-img-overlay") : null
  const images = options.images.map((image) => {
    const el = document.createElement("img")
    el.src = image.src
    el.alt = ""
    Object.assign(el.style, { position: "absolute", display: "none", objectFit: "fill", pointerEvents: "none" })
    imageLayer?.appendChild(el)
    return { image, el }
  })

  const readRange = (ref: string): unknown[][] | null => {
    const cut = ref.lastIndexOf("!")
    const name = cut >= 0 ? ref.slice(0, cut).replace(/^'|'$/g, "").replace(/''/g, "'") : ""
    const book = api.getActiveWorkbook()
    const sheet = name ? book?.getSheetByName?.(name) : book?.getActiveSheet()
    if (!sheet) return null
    try {
      return sheet.getRange((cut >= 0 ? ref.slice(cut + 1) : ref).replace(/\$/g, "")).getValues() ?? null
    } catch {
      return null
    }
  }

  const show = (el: HTMLElement, left: number, top: number, width: number, height: number) => {
    el.style.display = "block"
    el.style.left = `${Math.round(left)}px`
    el.style.top = `${Math.round(top)}px`
    el.style.width = `${Math.round(width)}px`
    el.style.height = `${Math.round(height)}px`
  }

  function placeBars(sheet: SheetLike, index: number, offset: { x: number; y: number }, visibleHeight: number) {
    let used = 0
    options.dataBars.forEach((bar, at) => {
      if (bar.sheetIndex !== index) return
      let data = barData[at]
      if (!data || !data.values.flat().some(Number.isFinite)) {
        const { startRow, startColumn, endRow, endColumn } = bar.range
        let raw: unknown[][] = []
        try {
          raw = sheet.getRange(`${columnName(startColumn)}${startRow + 1}:${columnName(endColumn)}${endRow + 1}`).getValues() ?? []
        } catch {
          return
        }
        const values = raw.map((row) => (row ?? []).map(numberOf))
        const finite = values.flat().filter(Number.isFinite)
        if (!finite.length) return
        const min = Math.min(...finite)
        const max = Math.max(...finite)
        data = { values, lo: bound(bar.min, finite, min, max), hi: bound(bar.max, finite, min, max) }
        barData[at] = data
      }
      const span = data.hi - data.lo
      for (let row = bar.range.startRow; row <= bar.range.endRow; row++) {
        const first = rectOf(sheet, row, bar.range.startColumn)
        if (!first) continue
        const top = first.top - offset.y
        if (top >= visibleHeight) break
        if (top + first.height <= 0) continue
        for (let column = bar.range.startColumn; column <= bar.range.endColumn; column++) {
          const value = data.values[row - bar.range.startRow]?.[column - bar.range.startColumn]
          if (value == null || !Number.isFinite(value)) continue
          const cell = column === bar.range.startColumn ? first : rectOf(sheet, row, column)
          if (!cell) continue
          const share = Math.round((span > 0 ? Math.max(0, Math.min(1, (value - data.lo) / span)) : 0) * 100)
          const band = bar.banding[row] || "transparent"
          let el = barEls[used]
          if (!el) {
            el = document.createElement("div")
            Object.assign(el.style, { position: "absolute", pointerEvents: "none" })
            barLayer?.appendChild(el)
            barEls.push(el)
          }
          used += 1
          el.style.background = `linear-gradient(90deg, ${bar.color} 0%, ${bar.color}55 ${share}%, ${band} ${share}%, ${band} 100%)`
          show(el, cell.left - offset.x, cell.top - offset.y, cell.width, cell.height)
        }
      }
    })
    for (let at = used; at < barEls.length; at++) barEls[at].style.display = "none"
  }

  let scrollSheet = ""
  let scrollSubscription: { dispose(): void } | undefined
  let scrollTimer: ReturnType<typeof setTimeout> | undefined

  function reposition() {
    const sheet = api.getActiveWorkbook()?.getActiveSheet()
    const hideAll = () => {
      for (const entry of gradients) entry.el.style.display = "none"
      for (const el of barEls) el.style.display = "none"
      for (const entry of charts) entry.el.style.display = "none"
      for (const entry of images) entry.el.style.display = "none"
      frame.style.display = "none"
    }
    if (!sheet || !gridReady(sheet)) {
      hideAll()
      options.onPlaced?.()
      return
    }
    const id = sheet.getSheetId()
    if (id !== scrollSheet) {
      scrollSubscription?.dispose()
      try {
        scrollSubscription = sheet.onScroll?.(() => {
          if (scrollTimer) return
          scrollTimer = setTimeout(() => {
            scrollTimer = undefined
            reposition()
          }, 16)
        })
      } catch {
        scrollSubscription = undefined
      }
      scrollSheet = id
    }
    const index = sheetIds.indexOf(id)
    const offset = scrollOffset(sheet)
    const box = layerBox(wrap, sheet)
    for (const layer of layers) placeLayer(layer, box)

    for (const { region, el } of gradients) {
      const first = region.sheetIndex === index ? rectOf(sheet, region.range.startRow, region.range.startColumn) : null
      const last = first ? rectOf(sheet, region.range.endRow, region.range.endColumn) : null
      if (!first || !last) el.style.display = "none"
      else show(el, first.left - offset.x, first.top - offset.y, last.left + last.width - first.left, last.top + last.height - first.top)
    }
    if (options.dataBars.length) placeBars(sheet, index, offset, box?.height ?? 100000)
    for (const { image, el } of images) {
      const from = image.sheetIndex === index ? rectOf(sheet, image.row, image.col) : null
      if (!from) el.style.display = "none"
      else show(el, from.left - offset.x, from.top - offset.y, image.width, image.height)
    }
    for (const entry of charts) {
      const from = entry.ref.sheetIndex === index ? rectOf(sheet, entry.ref.fromRow, entry.ref.fromCol) : null
      if (!from) {
        entry.el.style.display = "none"
        entry.drawnKey = ""
        continue
      }
      const left = Math.round(from.left - offset.x)
      const top = Math.round(from.top - offset.y)
      show(entry.el, left, top, entry.ref.width, entry.ref.height)
      const key = `${entry.ref.width}x${entry.ref.height}`
      if (entry.drawnKey === key) continue
      entry.drawnKey = key
      try {
        entry.el.replaceChildren(renderChartSvg(entry.chart, entry.ref.width, entry.ref.height, readRange))
      } catch (err) {
        console.warn("[chartOverlay] draw failed:", err)
      }
    }
    const pick = selected != null ? charts[selected] : undefined
    if (pick && pick.el.style.display !== "none") {
      Object.assign(frame.style, { display: "block", left: pick.el.style.left, top: pick.el.style.top, width: pick.el.style.width, height: pick.el.style.height })
    } else frame.style.display = "none"
    options.onPlaced?.()
  }

  const timers = [120, 400, 900, 1600, 2600].map((delay) => setTimeout(reposition, delay))
  reposition()

  return {
    reposition,
    invalidate() {
      barData.fill(null)
      for (const entry of charts) entry.drawnKey = ""
      reposition()
    },
    selectChartAt(x, y) {
      selected = null
      charts.forEach((entry, at) => {
        if (selected != null || entry.el.style.display === "none") return
        const rect = entry.el.getBoundingClientRect()
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) selected = at
      })
      reposition()
      if (selected == null) return null
      const { ref, chart } = charts[selected]
      return { title: chart.title, kind: chart.kind, sheetIndex: ref.sheetIndex, fromRow: ref.fromRow, fromCol: ref.fromCol, width: ref.width, height: ref.height, catRef: chart.catRef, valRef: chart.valRef }
    },
    clearChartSelection() {
      selected = null
      frame.style.display = "none"
    },
    dispose() {
      timers.forEach(clearTimeout)
      clearTimeout(scrollTimer)
      scrollSubscription?.dispose()
      for (const layer of layers) layer.remove()
    },
  }
}
