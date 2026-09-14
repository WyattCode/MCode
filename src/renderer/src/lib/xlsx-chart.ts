import { decodeXml } from "./docx-parse"

/*
 * MiMo draws a workbook's charts itself, as plain SVG laid over the grid, not
 * with a chart library. This reads one chart part the way it does (every plot
 * node in document order, cached points first, cell references otherwise) and
 * draws it with the same margins, scale, legend and colours.
 */

const tag = (name: string) => `(?:[a-z]+:)?${name}`

/** The first element's inner XML; like MiMo, a self-closing tag runs on to the next closing one. */
function inner(xml: string | undefined, name: string): string | undefined {
  if (xml === undefined) return undefined
  return new RegExp(`<${tag(name)}\\b[^>]*>([\\s\\S]*?)</${tag(name)}>`, "i").exec(xml)?.[1]
}

function inners(xml: string, name: string): { body: string; index: number }[] {
  return [...xml.matchAll(new RegExp(`<${tag(name)}\\b[^>]*>([\\s\\S]*?)</${tag(name)}>`, "gi"))].map((match) => ({ body: match[1], index: match.index ?? 0 }))
}

function valOf(xml: string | undefined, name: string): string | undefined {
  if (xml === undefined) return undefined
  return new RegExp(`<${tag(name)}\\b[^>]*\\bval="([^"]*)"`, "i").exec(xml)?.[1]
}

/** Drawing-text runs only, which is where titles keep their words. */
function richText(xml: string): string {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gi)].map((match) => decodeXml(match[1])).join("").trim()
}

/** A reference's cached points in index order (holes closed up), or null when it has no cache at all. */
function cachedPoints(fragment: string): string[] | null {
  if (inner(fragment, "numCache") === undefined && inner(fragment, "strCache") === undefined) return null
  const pattern = new RegExp(`<${tag("pt")}\\b[^>]*\\bidx="(\\d+)"[^>]*>\\s*<${tag("v")}>([\\s\\S]*?)</${tag("v")}>`, "gi")
  return [...fragment.matchAll(pattern)]
    .map((match) => ({ idx: parseInt(match[1], 10), value: decodeXml(match[2]) }))
    .sort((a, b) => a.idx - b.idx)
    .map((point) => point.value)
}

function formulaOf(fragment: string | undefined): string | undefined {
  if (!fragment) return undefined
  const found = new RegExp(`<${tag("f")}>([\\s\\S]*?)</${tag("f")}>`, "i").exec(fragment)?.[1]
  return found === undefined ? undefined : decodeXml(found)
}

/** "12%" is 0.12; currency marks, grouping and spaces are dropped. NaN when nothing numeric is left. */
function parseLoose(raw: unknown): number {
  if (typeof raw === "number") return raw
  const text = String(raw ?? "").trim()
  const parsed = parseFloat(text.replace(/[,¥$%\s]/g, ""))
  if (!Number.isFinite(parsed)) return Number.NaN
  return /%$/.test(text) ? parsed / 100 : parsed
}

/** A plotted value: numbers pass through as they are, unreadable text counts as 0. */
function valueOf(raw: unknown): number {
  if (typeof raw === "number") return raw
  const parsed = parseLoose(raw)
  return Number.isNaN(parsed) ? 0 : parsed
}

const endsWithPercent = (raw: unknown) => /%$/.test(String(raw).trim())

function solidColor(fragment: string | undefined): string | undefined {
  const hex = fragment ? /<a:solidFill>\s*<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/i.exec(fragment)?.[1] : undefined
  return hex ? `#${hex.toUpperCase()}` : undefined
}

/** Positive amounts lighten toward white, negative ones darken toward black. */
function tint(hex: string, amount: number): string {
  const rgb = parseInt(hex.replace("#", ""), 16)
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(amount > 0 ? value + (255 - value) * amount : value * (1 + amount))))
  const packed = (channel((rgb >> 16) & 255) << 16) | (channel((rgb >> 8) & 255) << 8) | channel(rgb & 255)
  return `#${packed.toString(16).padStart(6, "0").toUpperCase()}`
}

/* ------------------------------------------------------------ parse */

interface ChartSeries {
  name: string
  /** Where the name lives when it is not written out. */
  nameRef?: string
  categories: string[]
  values: number[]
  /** Kept only when there is no cache, so the live cells are read instead. */
  catRef?: string
  valRef?: string
  kind: string
  secondary: boolean
  stacked: boolean
  /** Lines are smoothed unless the file says smooth="0". */
  smooth: boolean
  color?: string
  /** Whether the values are percentages; undefined lets the scale guess from the values. */
  pctY?: boolean
}

export interface SheetChart {
  /** MiMo's kind name for the chart (e.g. "column", "bar", "line", "area", "pie", "doughnut", "scatter", "radar"), used in the annotation label and prompt. */
  kind: string
  title?: string
  /** The first series' category and value references as written in the XML (e.g. "Sheet1!$A$2:$A$5"), empty when absent or when cached values exist — as MiMo clears them when a cache exists. */
  catRef: string
  valRef: string
  series: ChartSeries[]
  /** Per-series colours as written, or the single series' per-point colours; "" where none. */
  colors: string[]
  /** The theme's six accents, when the theme has them all. */
  palette?: string[]
  holeSize?: number
  varyColors?: boolean
  radarFilled?: boolean
  secondaryTitle?: string
}

const PLOTS: { node: string; kind: (body: string) => string }[] = [
  { node: "barChart", kind: (body) => (valOf(body, "barDir") === "bar" ? "bar" : "column") },
  { node: "lineChart", kind: () => "line" },
  { node: "areaChart", kind: () => "area" },
  { node: "pieChart", kind: () => "pie" },
  { node: "ofPieChart", kind: () => "pie" },
  { node: "doughnutChart", kind: () => "doughnut" },
  { node: "scatterChart", kind: () => "scatter" },
  // Bubbles are drawn as plain scatter dots.
  { node: "bubbleChart", kind: () => "scatter" },
  { node: "radarChart", kind: () => "radar" },
]

const OFFICE_COLORS = ["#4F81BD", "#C0504D", "#9BBB59", "#8064A2", "#4BACC6", "#F79646", "#2C4D75", "#772C2A"]
const STYLE_TINTS = [0, -0.25, 0.25, -0.5, 0.5]

/** Parses one chart part; theme colours are #rrggbb in order lt1, dk1, lt2, dk2, accent1..6, hlink, folHlink (may be empty). Null when there is nothing drawable. */
export function parseSheetChart(xml: string, themeColors: string[]): SheetChart | null {
  const plotArea = inner(xml, "plotArea")
  if (!plotArea) return null
  // The first title anywhere, which is an axis title when the chart itself has none.
  const titleXml = inner(xml, "title")
  const title = titleXml !== undefined ? richText(titleXml) : ""

  const accents = themeColors.slice(4, 10)
  const palette = accents.length === 6 && accents.every(Boolean) ? accents : undefined

  const plots: { kind: string; body: string; axIds: string[]; stacked: boolean; index: number }[] = []
  for (const plot of PLOTS) {
    for (const found of inners(plotArea, plot.node)) {
      plots.push({
        kind: plot.kind(found.body),
        body: found.body,
        axIds: [...found.body.matchAll(new RegExp(`<${tag("axId")}\\b[^>]*\\bval="(\\d+)"`, "gi"))].map((match) => match[1]),
        stacked: /^(?:stacked|percentStacked)$/i.test(valOf(found.body, "grouping") ?? ""),
        index: found.index,
      })
    }
  }
  if (!plots.length) return null
  plots.sort((a, b) => a.index - b.index)

  // Series on axes the first plot does not use go to the secondary value axis.
  const primaryAxes = new Set(plots[0].axIds)
  const series: ChartSeries[] = []
  const colors: string[] = []
  let pointColors: string[] | null = null
  for (const plot of plots) {
    const secondary = plot.axIds.some((id) => !primaryAxes.has(id))
    for (const { body } of inners(plot.body, "ser")) {
      const tx = inner(body, "tx")
      let name = ""
      if (tx !== undefined) {
        const cache = cachedPoints(tx)
        name = (cache && cache[0] != null ? String(cache[0]) : richText(tx)) || ""
        if (!name) {
          const written = new RegExp(`<${tag("v")}>([\\s\\S]*?)</${tag("v")}>`, "i").exec(inner(tx, "strRef") ?? tx)?.[1]
          name = written !== undefined ? decodeXml(written) : ""
        }
      }
      const cat = inner(body, "cat") ?? inner(body, "xVal")
      const val = inner(body, "val") ?? inner(body, "yVal")
      const cats = cat !== undefined ? cachedPoints(cat) : null
      const vals = val !== undefined ? cachedPoints(val) : null
      const formatCode = val !== undefined ? new RegExp(`<${tag("formatCode")}>([\\s\\S]*?)</${tag("formatCode")}>`, "i").exec(val)?.[1] : undefined
      const pctY = !val ? undefined : formatCode !== undefined ? decodeXml(formatCode).includes("%") : vals?.some(endsWithPercent) ? true : undefined
      const entry: ChartSeries = {
        name,
        nameRef: name ? undefined : formulaOf(tx),
        categories: cats && cats.length ? cats : [],
        values: vals && vals.length ? vals.map(valueOf) : [],
        catRef: cats && cats.length ? undefined : formulaOf(cat),
        valRef: vals && vals.length ? undefined : formulaOf(val),
        kind: plot.kind,
        secondary,
        stacked: plot.stacked,
        smooth: valOf(body, "smooth") !== "0",
        color: solidColor(inner(body, "spPr")),
        pctY,
      }
      series.push(entry)
      colors.push(entry.color ?? "")
      // Per-slice colours come from the first pie series that sets any.
      if ((plot.kind === "pie" || plot.kind === "doughnut") && pointColors === null) {
        const points = inners(body, "dPt")
          .map((point) => ({ idx: parseInt(valOf(point.body, "idx") ?? "0", 10), color: solidColor(point.body) }))
          .filter((point): point is { idx: number; color: string } => Boolean(point.color))
        if (points.length) {
          const list: string[] = []
          for (const point of points.sort((a, b) => a.idx - b.idx)) list[point.idx] = point.color
          pointColors = Array.from(list, (color) => color ?? "")
        }
      }
    }
  }
  if (!series.length) return null

  // Chart styles 3-8 (and their repeats up to 48) colour every series in one accent, tinted apart.
  const style = parseInt(valOf(xml, "style") ?? "", 10)
  if (palette && Number.isFinite(style) && style >= 1 && style <= 48) {
    const variant = ((style - 1) % 8) + 1
    if (variant >= 3) {
      const accent = palette[(variant - 3) % palette.length]
      series.forEach((entry, index) => {
        if (!entry.color && entry.kind !== "pie" && entry.kind !== "doughnut") entry.color = tint(accent, STYLE_TINTS[index % STYLE_TINTS.length])
      })
    }
  }

  let secondaryTitle: string | undefined
  for (const axis of inners(plotArea, "valAx")) {
    const id = valOf(axis.body, "axId")
    if (!id || primaryAxes.has(id)) continue
    const axisTitle = inner(axis.body, "title")
    if (axisTitle !== undefined) {
      secondaryTitle = richText(axisTitle) || undefined
      break
    }
  }

  const kind = plots[0].kind
  const holeSize = kind === "doughnut" ? parseInt(valOf(plotArea, "holeSize") ?? "", 10) || undefined : undefined
  const varyColors = (kind === "pie" || kind === "doughnut") && valOf(plots[0].body, "varyColors") === "0" ? false : undefined
  const radarFilled = kind === "radar" ? valOf(plotArea, "radarStyle") === "filled" : undefined
  const first = series[0]
  return {
    kind,
    ...(title ? { title } : {}),
    catRef: first.catRef ?? "",
    valRef: first.valRef ?? "",
    series,
    colors: series.length === 1 && pointColors ? pointColors : colors,
    palette,
    holeSize,
    varyColors,
    radarFilled,
    secondaryTitle,
  }
}

/** Whether the chart reads cell references without a cache, so it must be redrawn after edits. */
export function chartNeedsLiveData(chart: SheetChart): boolean {
  return chart.series.some((entry) => Boolean(entry.nameRef || entry.catRef || entry.valRef))
}

/* ------------------------------------------------------------ draw */

/** A series with its references read, as it is drawn. */
interface DrawSeries {
  name: string
  categories: unknown[]
  values: number[]
  kind: string
  secondary: boolean
  stacked: boolean
  smooth: boolean
  color?: string
  pctY?: boolean
}

function resolveSeries(chart: SheetChart, readRange?: (ref: string) => unknown[][] | null): DrawSeries[] {
  const read = (ref: string): unknown[] => (readRange?.(ref) ?? []).flat().map((value) => value ?? "")
  return chart.series.map((entry) => {
    const name = entry.name || (entry.nameRef ? String(read(entry.nameRef)[0] ?? "") : "")
    const categories: unknown[] = entry.categories.length ? entry.categories : entry.catRef ? read(entry.catRef) : []
    const live = !entry.values.length && entry.valRef ? read(entry.valRef) : null
    const values = entry.values.length ? entry.values : live ? live.map(valueOf) : []
    const pctY = entry.pctY ?? (live?.some(endsWithPercent) ? true : undefined)
    return { name, categories, values, kind: entry.kind, secondary: entry.secondary, stacked: entry.stacked, smooth: entry.smooth, color: entry.color, pctY }
  })
}

const SVG_NS = "http://www.w3.org/2000/svg"
const fix = (value: number) => value.toFixed(1)

function node(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const element = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value))
  // Titles and labels come from the file, so they only ever become text.
  if (text !== undefined) element.textContent = text
  return element
}

function colorAt(chart: SheetChart, series: DrawSeries[], index: number): string {
  const palette = chart.palette
  return series[index]?.color || chart.colors[index] || (palette && palette.length ? palette[index % palette.length] : OFFICE_COLORS[index % OFFICE_COLORS.length])
}

/** A power of ten times 1, 2, 5 or 10; rounding picks the nearest, otherwise the next one up. */
function niceNumber(span: number, round: boolean): number {
  if (span <= 0) return 1
  const exponent = Math.floor(Math.log10(span))
  const fraction = span / Math.pow(10, exponent)
  const nice = round
    ? fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10
    : fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return nice * Math.pow(10, exponent)
}

function niceScale(low: number, high: number, ticks = 5, zeroBase = true) {
  if (high === low) high = low + Math.abs(low || 1)
  const step = niceNumber(niceNumber(high - low, false) / Math.max(2, ticks - 1), true)
  let min = Math.floor(low / step) * step
  const max = Math.ceil(high / step) * step
  // A floor far above zero would exaggerate differences, so start from 0 unless the values sit in a narrow band.
  if (zeroBase && min > 0 && high > 0 && (high - low) / high > 1 / 6) min = 0
  return { min, max: max > min ? max : min + step, step }
}

function formatTick(value: number): string {
  if (!Number.isFinite(value)) return "0"
  return Math.abs(value) >= 1000 ? value.toLocaleString("en-US") : String(Math.round(value * 100) / 100)
}

interface Scale {
  min: number
  max: number
  step: number
  format: (value: number) => string
}

function valueScale(values: number[], percent: boolean | undefined): Scale {
  const high = Math.max(0, ...values)
  const small = values.length > 0 && values.every((value) => Math.abs(value) < 10000)
  const lowest = values.length ? Math.min(...values) : 0
  const lowOrZero = Math.min(0, ...(values.length ? values : [0]))
  const { min, max, step } = niceScale(small ? lowest : lowOrZero, high)
  const fractions = values.length > 0 && lowest >= 0 && high <= 1 && values.some((value) => value > 0 && value < 1)
  const asPercent = percent ?? fractions
  return { min, max, step, format: asPercent ? (value) => `${Math.round(value * 1000) / 10}%` : formatTick }
}

function percentFlag(series: DrawSeries[]): boolean | undefined {
  if (series.some((entry) => entry.pctY === true)) return true
  if (series.some((entry) => entry.pctY === false)) return false
  return undefined
}

/** Every value the scale must fit: stacked bars and areas count by their totals. */
function scaleValues(series: DrawSeries[]): number[] {
  const stackable = series.filter((entry) => entry.stacked && (entry.kind === "column" || entry.kind === "bar" || entry.kind === "area"))
  const out: number[] = []
  for (const entry of series) if (!stackable.includes(entry)) out.push(...entry.values)
  if (stackable.length) {
    const length = Math.max(0, ...stackable.map((entry) => entry.values.length))
    for (let index = 0; index < length; index++) out.push(stackable.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0))
  }
  return out
}

type Point = { x: number; y: number }

/** Cubic Béziers whose handles run a sixth of the way along each neighbour-to-neighbour tangent. */
function smoothPath(points: Point[]): string {
  if (points.length < 2) return ""
  if (points.length === 2) return `M${points[0].x},${points[0].y} L${points[1].x},${points[1].y}`
  let path = `M${fix(points[0].x)},${fix(points[0].y)}`
  for (let index = 0; index < points.length - 1; index++) {
    const before = points[index - 1] ?? points[index]
    const from = points[index]
    const to = points[index + 1]
    const after = points[index + 2] ?? to
    const c1x = from.x + (to.x - before.x) / 6
    const c1y = from.y + (to.y - before.y) / 6
    const c2x = to.x - (after.x - from.x) / 6
    const c2y = to.y - (after.y - from.y) / 6
    path += ` C${fix(c1x)},${fix(c1y)} ${fix(c2x)},${fix(c2y)} ${fix(to.x)},${fix(to.y)}`
  }
  return path
}

function straightPath(points: Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${fix(point.x)},${fix(point.y)}`).join(" ")
}

/** The right-hand legend, centred on the plot's height; its width is taken off the plot. */
function legend(names: string[], color: (index: number) => string, width: number, top: number, height: number, shape: (index: number) => "line" | "square") {
  const items = names.map((name, index) => ({ name, index })).filter((item) => item.name && item.name.trim())
  if (!items.length) return { nodes: [] as SVGElement[], width: 0 }
  const longest = Math.max(...items.map((item) => item.name.length))
  const legendWidth = Math.min(140, Math.max(56, longest * 13 + 26))
  const x = width - legendWidth + 8
  const startY = top + (height - top) / 2 - (items.length * 20) / 2 + 10
  const nodes: SVGElement[] = []
  items.forEach((item, row) => {
    const y = startY + row * 20
    const line = shape(item.index) === "line"
    nodes.push(
      line
        ? node("line", { x1: x, y1: y, x2: x + 18, y2: y, stroke: color(item.index), "stroke-width": 3 })
        : node("rect", { x, y: y - 6, width: 12, height: 12, fill: color(item.index) }),
    )
    nodes.push(node("text", { x: x + (line ? 24 : 18), y: y + 4, "font-size": 12, fill: "#000000" }, item.name))
  })
  return { nodes, width: legendWidth }
}

function drawAxisChart(chart: SheetChart, series: DrawSeries[], width: number, height: number, top: number): SVGElement[] {
  const allScatter = series.length > 0 && series.every((entry) => entry.kind === "scatter")
  const categories = (series.find((entry) => entry.categories.length)?.categories ?? []).map((value) => String(value))
  const bandCount = allScatter ? 0 : categories.length || Math.max(1, ...series.map((entry) => entry.values.length))
  const primary = series.filter((entry) => !entry.secondary)
  const secondary = series.filter((entry) => entry.secondary)
  const scaleOf = primary.length ? primary : series
  const y1 = valueScale(scaleValues(scaleOf), percentFlag(scaleOf))
  const y2 = secondary.length ? valueScale(scaleValues(secondary), percentFlag(secondary)) : null
  const key = legend(series.map((entry) => entry.name), (index) => colorAt(chart, series, index), width, top, height, (index) => ((series[index]?.kind ?? chart.kind) === "line" ? "line" : "square"))

  const right = 16 + key.width + (y2 ? 48 : 0) + (y2 && chart.secondaryTitle ? 16 : 0)
  const left = 76
  const plotTop = top + 6
  const plotRight = width - right
  const plotBottom = height - 30
  const plotWidth = Math.max(1, plotRight - left)
  const plotHeight = Math.max(1, plotBottom - plotTop)
  const yOf = (value: number) => plotBottom - ((value - y1.min) / (y1.max - y1.min || 1)) * plotHeight
  const y2Of = y2 ? (value: number) => plotBottom - ((value - y2.min) / (y2.max - y2.min || 1)) * plotHeight : yOf
  const out: SVGElement[] = []

  for (let tick = y1.min; tick <= y1.max + 1e-6; tick += y1.step) {
    const y = yOf(tick)
    out.push(node("line", { x1: left, y1: fix(y), x2: plotRight, y2: fix(y), stroke: "#d9d9d9" }))
    out.push(node("text", { x: left - 8, y: fix(y + 4), "text-anchor": "end", "font-size": 11, fill: "#000000" }, y1.format(tick)))
  }
  if (y2) {
    for (let tick = y2.min; tick <= y2.max + 1e-6; tick += y2.step) {
      out.push(node("text", { x: plotRight + 8, y: fix(y2Of(tick) + 4), "text-anchor": "start", "font-size": 11, fill: "#000000" }, y2.format(tick)))
    }
    if (chart.secondaryTitle) {
      const x = plotRight + 52
      const y = (plotTop + plotBottom) / 2
      out.push(node("text", { x, y, "font-size": 11, fill: "#000000", "text-anchor": "middle", transform: `rotate(90 ${x} ${y})` }, chart.secondaryTitle))
    }
  }

  const horizontal = chart.kind === "bar" && !y2 && series.every((entry) => entry.kind === "bar")
  const band = plotWidth / Math.max(1, bandCount || 1)
  let xOf = (_value: number) => left
  if (allScatter) {
    const xs = series.flatMap((entry) => entry.categories.map(parseLoose)).filter((value) => Number.isFinite(value))
    const xScale = niceScale(xs.length ? Math.min(...xs) : 0, xs.length ? Math.max(...xs) : 1, 6, false)
    xOf = (value) => left + ((value - xScale.min) / (xScale.max - xScale.min || 1)) * plotWidth
    for (let tick = xScale.min; tick <= xScale.max + 1e-6; tick += xScale.step) {
      out.push(node("text", { x: fix(xOf(tick)), y: plotBottom + 18, "text-anchor": "middle", "font-size": 11, fill: "#000000" }, formatTick(tick)))
    }
  } else if (!horizontal) {
    for (let index = 0; index < bandCount; index++) {
      out.push(node("text", { x: fix(left + band * (index + 0.5)), y: plotBottom + 18, "text-anchor": "middle", "font-size": 12, fill: "#000000" }, categories[index] ?? ""))
    }
  }

  const areas = series.filter((entry) => entry.kind === "area")
  const bars = series.filter((entry) => entry.kind === "bar" || entry.kind === "column")
  const lines = series.filter((entry) => entry.kind === "line")
  const dots = series.filter((entry) => entry.kind === "scatter")
  const scaleFor = (entry: DrawSeries) => (entry.secondary ? y2Of : yOf)
  const baseline = (entry: DrawSeries) => (entry.secondary && y2 ? y2Of(Math.max(y2.min, 0)) : yOf(Math.max(y1.min, 0)))

  if (areas.length) {
    const stacked = areas.some((entry) => entry.stacked)
    const totals = new Array<number>(Math.max(0, ...areas.map((entry) => entry.values.length))).fill(0)
    for (const entry of areas) {
      const map = scaleFor(entry)
      const upper: Point[] = []
      const lower: Point[] = []
      entry.values.forEach((value, index) => {
        const x = left + band * (index + 0.5)
        const below = stacked ? totals[index] : 0
        const above = below + value
        upper.push({ x, y: map(above) })
        lower.push({ x, y: stacked ? map(below) : baseline(entry) })
        if (stacked) totals[index] = above
      })
      if (!upper.length) continue
      const back = lower.slice().reverse().map((point) => `L${fix(point.x)},${fix(point.y)}`).join(" ")
      out.push(node("path", { d: `${straightPath(upper)} ${back} Z`, fill: colorAt(chart, series, series.indexOf(entry)) }))
    }
  }

  if (bars.length) {
    const stacked = bars.some((entry) => entry.stacked)
    const slots = stacked ? 1 : bars.length
    // The group takes 62% of the band; each bar fills 90% of its slot.
    const slot = (band * 0.62) / slots
    const totals = new Array<number>(Math.max(0, ...bars.map((entry) => entry.values.length))).fill(0)
    bars.forEach((entry, order) => {
      const fill = colorAt(chart, series, series.indexOf(entry))
      const map = scaleFor(entry)
      entry.values.forEach((value, index) => {
        const below = stacked ? totals[index] : 0
        const above = below + value
        if (horizontal) {
          const x0 = left + ((below - y1.min) / (y1.max - y1.min || 1)) * plotWidth
          const x1 = left + ((above - y1.min) / (y1.max - y1.min || 1)) * plotWidth
          const y = plotTop + band * (index + 0.19) + (stacked ? 0 : slot * order)
          out.push(node("rect", { x: fix(Math.min(x0, x1)), y: fix(y), width: fix(Math.abs(x1 - x0)), height: fix(slot * 0.9), fill }))
          if (order === 0) out.push(node("text", { x: left - 8, y: fix(plotTop + band * (index + 0.5) + 4), "text-anchor": "end", "font-size": 12, fill: "#000000" }, categories[index] ?? ""))
        } else {
          const y = Math.min(map(above), map(below))
          const barHeight = Math.abs(map(below) - map(above))
          const x = left + band * index + (band - slot * slots) / 2 + (stacked ? 0 : slot * order)
          out.push(node("rect", { x: fix(x), y: fix(y), width: fix(slot * 0.9), height: fix(barHeight), fill }))
        }
        if (stacked) totals[index] = above
      })
    })
  }

  for (const entry of lines) {
    const map = scaleFor(entry)
    const points = entry.values.map((value, index) => ({ x: left + band * (index + 0.5), y: map(value) }))
    const d = entry.smooth ? smoothPath(points) : straightPath(points)
    if (d) out.push(node("path", { d, fill: "none", stroke: colorAt(chart, series, series.indexOf(entry)), "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }))
  }

  for (const entry of dots) {
    const fill = colorAt(chart, series, series.indexOf(entry))
    const map = scaleFor(entry)
    entry.values.forEach((value, index) => {
      const xValue = parseLoose(entry.categories[index])
      const x = allScatter && Number.isFinite(xValue) ? xOf(xValue) : left + band * (index + 0.5)
      out.push(node("circle", { cx: fix(x), cy: fix(map(value)), r: 3.5, fill }))
    })
  }

  out.push(node("line", { x1: left, y1: plotTop, x2: left, y2: plotBottom, stroke: "#808080" }))
  out.push(node("line", { x1: left, y1: plotBottom, x2: plotRight, y2: plotBottom, stroke: "#808080" }))
  return [...out, ...key.nodes]
}

function drawPie(chart: SheetChart, series: DrawSeries[], width: number, height: number, top: number): SVGElement[] {
  const rings = series.length > 1
  const first = series[0]
  const pointColors = rings ? null : chart.colors
  const sliceColor = (index: number) => pointColors?.[index] || (chart.palette && chart.palette.length ? chart.palette[index % chart.palette.length] : OFFICE_COLORS[index % OFFICE_COLORS.length])
  const bySeries = chart.varyColors === false
  const categories = (first?.categories ?? []).map((value) => String(value))
  const names = bySeries || !categories.length ? series.map((entry) => entry.name) : categories
  const keyColor = bySeries ? (index: number) => colorAt(chart, series, index) : categories.length ? sliceColor : () => sliceColor(0)
  const key = legend(names, keyColor, width, top, height, () => "square")
  const cx = (width - key.width) / 2
  const cy = top + (height - top) / 2
  const radius = Math.max(10, Math.min((width - key.width) / 2, (height - top) / 2) - 8)
  const hole = chart.kind === "doughnut" ? Math.min(90, Math.max(0, chart.holeSize ?? 55)) / 100 : 0
  const out: SVGElement[] = []

  const slice = (innerR: number, outerR: number, start: number, end: number, fill: string): SVGElement => {
    // A lone full slice cannot be an arc, so it becomes a circle (or a thick ring).
    if (end - start >= Math.PI * 2 - 1e-6) {
      return innerR > 0
        ? node("circle", { cx, cy, r: fix((innerR + outerR) / 2), fill: "none", stroke: fill, "stroke-width": fix(outerR - innerR) })
        : node("circle", { cx, cy, r: fix(outerR), fill })
    }
    const large = end - start > Math.PI ? 1 : 0
    const ox0 = cx + outerR * Math.cos(start)
    const oy0 = cy + outerR * Math.sin(start)
    const ox1 = cx + outerR * Math.cos(end)
    const oy1 = cy + outerR * Math.sin(end)
    if (innerR <= 0) return node("path", { d: `M${cx},${cy} L${fix(ox0)},${fix(oy0)} A${outerR},${outerR} 0 ${large} 1 ${fix(ox1)},${fix(oy1)} Z`, fill })
    const ix0 = cx + innerR * Math.cos(start)
    const iy0 = cy + innerR * Math.sin(start)
    const ix1 = cx + innerR * Math.cos(end)
    const iy1 = cy + innerR * Math.sin(end)
    return node("path", { d: `M${fix(ox0)},${fix(oy0)} A${outerR},${outerR} 0 ${large} 1 ${fix(ox1)},${fix(oy1)} L${fix(ix1)},${fix(iy1)} A${innerR},${innerR} 0 ${large} 0 ${fix(ix0)},${fix(iy0)} Z`, fill })
  }

  const drawRing = (values: number[], innerR: number, outerR: number, fillFor: (index: number) => string) => {
    // Only positive values take a share of the circle.
    const total = values.reduce((sum, value) => sum + (value > 0 ? value : 0), 0) || 1
    let angle = -Math.PI / 2
    values.forEach((value, index) => {
      if (value <= 0) return
      const end = angle + (value / total) * Math.PI * 2
      out.push(slice(innerR, outerR, angle, end, fillFor(index)))
      angle = end
    })
  }

  if (rings) {
    // Several series nest outward from the hole, each ring 92% as thick as its share.
    const holeR = radius * hole
    const thickness = (radius - holeR) / series.length
    series.forEach((entry, ring) => {
      const innerR = holeR + thickness * ring
      drawRing(entry.values, innerR, innerR + thickness * 0.92, (index) => (bySeries ? colorAt(chart, series, ring) : sliceColor(index)))
    })
  } else {
    drawRing(first?.values ?? [], radius * hole, radius, (index) => (bySeries ? colorAt(chart, series, 0) : sliceColor(index)))
  }
  return [...out, ...key.nodes]
}

function drawRadar(chart: SheetChart, series: DrawSeries[], width: number, height: number, top: number): SVGElement[] {
  const categories = (series.find((entry) => entry.categories.length)?.categories ?? []).map((value) => String(value))
  const spokes = Math.max(categories.length, ...series.map((entry) => entry.values.length), 3)
  const all = series.flatMap((entry) => entry.values)
  const { max, step } = niceScale(0, all.length ? Math.max(...all) : 1, 4)
  const key = legend(series.map((entry) => entry.name), (index) => colorAt(chart, series, index), width, top, height, () => "square")
  const cx = (width - key.width) / 2
  const cy = top + (height - top) / 2 + 4
  const radius = Math.max(12, Math.min((width - key.width) / 2, (height - top) / 2) - 26)
  const angleOf = (index: number) => -Math.PI / 2 + (index * 2 * Math.PI) / spokes
  const at = (index: number, distance: number) => ({ x: cx + distance * Math.cos(angleOf(index)), y: cy + distance * Math.sin(angleOf(index)) })
  const out: SVGElement[] = []

  for (let tick = step; tick <= max + 1e-6; tick += step) {
    const distance = (tick / max) * radius
    const points = Array.from({ length: spokes }, (_, index) => {
      const point = at(index, distance)
      return `${fix(point.x)},${fix(point.y)}`
    }).join(" ")
    out.push(node("polygon", { points, fill: "none", stroke: "#d9d9d9" }))
  }
  for (let index = 0; index < spokes; index++) {
    const end = at(index, radius)
    out.push(node("line", { x1: cx, y1: cy, x2: fix(end.x), y2: fix(end.y), stroke: "#d9d9d9" }))
  }
  for (let tick = 0; tick <= max + 1e-6; tick += step) {
    out.push(node("text", { x: cx + 4, y: fix(cy - (tick / max) * radius + 4), "font-size": 10, fill: "#595959" }, formatTick(tick)))
  }
  for (let index = 0; index < spokes; index++) {
    const cos = Math.cos(angleOf(index))
    const point = at(index, radius + 12)
    // Labels lean away from the centre: left of the spoke on the left side, right on the right.
    const anchor = Math.abs(cos) < 0.3 ? "middle" : cos > 0 ? "start" : "end"
    out.push(node("text", { x: fix(point.x), y: fix(point.y + 4), "text-anchor": anchor, "font-size": 12, fill: "#000000" }, categories[index] ?? ""))
  }
  series.forEach((entry, order) => {
    if (!entry.values.length) return
    const color = colorAt(chart, series, order)
    const points = entry.values
      .slice(0, spokes)
      .map((value, index) => {
        const point = at(index, (Math.max(0, value) / max) * radius)
        return `${fix(point.x)},${fix(point.y)}`
      })
      .join(" ")
    out.push(
      chart.radarFilled
        ? node("polygon", { points, fill: color, stroke: "#ffffff", "stroke-width": 0.5 })
        : node("polygon", { points, fill: "none", stroke: color, "stroke-width": 2.5, "stroke-linejoin": "round" }),
    )
  })
  return [...out, ...key.nodes]
}

/** Draws the chart at width×height px (min 80×60). readRange returns a reference's live values (row-major 2-D) when a series has no cache, or null. */
export function renderChartSvg(chart: SheetChart, width: number, height: number, readRange?: (ref: string) => unknown[][] | null): SVGSVGElement {
  const w = Math.max(80, Math.round(width))
  const h = Math.max(60, Math.round(height))
  const series = resolveSeries(chart, readRange)
  const svg = document.createElementNS(SVG_NS, "svg")
  svg.setAttribute("width", String(w))
  svg.setAttribute("height", String(h))
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`)
  svg.style.display = "block"
  svg.appendChild(node("rect", { x: 0, y: 0, width: w, height: h, fill: "#ffffff" }))
  let top = 12
  if (chart.title) {
    svg.appendChild(node("text", { x: w / 2, y: 26, "text-anchor": "middle", "font-size": 16, "font-weight": 700, fill: "#000000" }, chart.title))
    top = 42
  }
  const parts =
    chart.kind === "pie" || chart.kind === "doughnut"
      ? drawPie(chart, series, w, h, top)
      : chart.kind === "radar"
        ? drawRadar(chart, series, w, h, top)
        : drawAxisChart(chart, series, w, h, top)
  for (const part of parts) svg.appendChild(part)
  return svg
}
