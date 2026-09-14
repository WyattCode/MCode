import type JSZip from "jszip"
import { decodeXml } from "./docx-parse"

/*
 * What MiMo reads from a .pptx beside the renderer, straight from its XML:
 * per slide, the full-bleed picture crops and left-aligned paragraphs the
 * renderer gets wrong, the shapes (to name the one a selection falls in), and
 * each chart's cached data, drawn again with echarts; and for presenting, a
 * slide's transition and its entrance effects.
 */

const tag = (name: string) => `(?:[a-z]+:)?${name}`

function inner(xml: string | undefined, name: string): string | undefined {
  if (!xml) return undefined
  return new RegExp(`<${tag(name)}\\b[^>]*>([\\s\\S]*?)</${tag(name)}>`, "i").exec(xml)?.[1]
}

function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag(name)}\\b[\\s\\S]*?</${tag(name)}>`, "gi"))].map((match) => match[0])
}

function attr(xml: string, name: string, key: string, value = "[^\"]*"): string | undefined {
  return new RegExp(`<${tag(name)}\\b[^>]*\\b${key}="(${value})"`, "i").exec(xml)?.[1]
}

/* ------------------------------------------------------------ charts */

export type ChartType = "bubble" | "scatter" | "bar" | "barH" | "line" | "area" | "pie" | "doughnut" | "radar"
export type LegendPos = "r" | "l" | "t" | "b" | "tr"

export interface ChartSeries {
  name: string
  color?: string
  values: number[]
  points: { x: number; y: number; size?: number }[]
}

export interface ChartSpec {
  type: ChartType
  categories: string[]
  series: ChartSeries[]
  title?: string
  legendPos?: LegendPos
  gridX: boolean
  gridY: boolean
  xMin?: number
  xMax?: number
  yMin?: number
  yMax?: number
}

/** A cache's points by index, holes left undefined up to its count. */
function cachedPoints(fragment: string | undefined): (string | undefined)[] {
  if (!fragment) return []
  const count = Number(attr(fragment, "ptCount", "val", "\\d+") ?? 0)
  const found: (string | undefined)[] = []
  for (const match of fragment.matchAll(new RegExp(`<${tag("pt")}\\b[^>]*\\bidx="(\\d+)"[^>]*>([\\s\\S]*?)</${tag("pt")}>`, "gi"))) {
    const value = inner(match[2], "v")
    if (value !== undefined) found[Number(match[1])] = decodeXml(value)
  }
  return Array.from({ length: Math.max(count, found.length) }, (_, index) => found[index])
}

function numbers(fragment: string | undefined): number[] {
  if (!fragment) return []
  const cache = inner(fragment, "numCache") ?? inner(fragment, "numLit") ?? fragment
  return cachedPoints(cache).map((value) => (value === undefined || !value.trim() ? Number.NaN : Number(value)))
}

function strings(fragment: string | undefined): string[] {
  const cache = inner(fragment, "strCache") ?? inner(fragment, "strLit")
  return cache ? cachedPoints(cache).map((value) => value ?? "") : []
}

function seriesName(series: string) {
  const tx = inner(series, "tx")
  if (!tx) return ""
  return strings(tx)[0] ?? (inner(tx, "v") !== undefined ? decodeXml(inner(tx, "v") ?? "") : "")
}

function seriesColor(series: string) {
  const color = attr(inner(series, "spPr") ?? "", "srgbClr", "val", "[0-9a-fA-F]{6}")
  return color ? `#${color}` : undefined
}

function chartTitle(xml: string) {
  const title = inner(xml, "title")
  if (!title) return undefined
  const cached = strings(title)[0]
  if (cached) return cached
  const rich = [...title.matchAll(new RegExp(`<${tag("t")}>([\\s\\S]*?)</${tag("t")}>`, "gi"))].map((match) => decodeXml(match[1])).join("").trim()
  return rich || undefined
}

const AXES = new RegExp(`<${tag("catAx")}\\b[\\s\\S]*?</${tag("catAx")}>|<${tag("valAx")}\\b[\\s\\S]*?</${tag("valAx")}>|<${tag("dateAx")}\\b[\\s\\S]*?</${tag("dateAx")}>`, "gi")

function axes(xml: string) {
  const out: Pick<ChartSpec, "gridX" | "gridY" | "xMin" | "xMax" | "yMin" | "yMax"> = { gridX: false, gridY: false }
  for (const match of xml.matchAll(AXES)) {
    const axis = match[0]
    const horizontal = /^[bt]$/.test(attr(axis, "axPos", "val", "b|l|t|r") ?? "")
    if (new RegExp(`<${tag("majorGridlines")}\\b`, "i").test(axis)) {
      if (horizontal) out.gridX = true
      else out.gridY = true
    }
    const scaling = inner(axis, "scaling")
    if (!scaling) continue
    const min = attr(scaling, "min", "val", "-?[0-9.eE]+")
    const max = attr(scaling, "max", "val", "-?[0-9.eE]+")
    if (min != null && Number.isFinite(+min)) out[horizontal ? "xMin" : "yMin"] = +min
    if (max != null && Number.isFinite(+max)) out[horizontal ? "xMax" : "yMax"] = +max
  }
  return out
}

const PLOTS: [string, ChartType][] = [
  ["bubbleChart", "bubble"],
  ["scatterChart", "scatter"],
  ["bar3DChart", "bar"],
  ["barChart", "bar"],
  ["line3DChart", "line"],
  ["lineChart", "line"],
  ["areaChart", "area"],
  ["area3DChart", "area"],
  ["pie3DChart", "pie"],
  ["pieChart", "pie"],
  ["doughnutChart", "doughnut"],
  ["radarChart", "radar"],
]

/** A chart part's first plot, with its series' cached data. */
export function parseChart(xml: string): ChartSpec | null {
  if (!xml) return null
  for (const [node, base] of PLOTS) {
    const plot = blocks(xml, node)[0]
    if (!plot) continue
    const list = blocks(plot, "ser")
    if (!list.length) return null
    const type: ChartType = base === "bar" && attr(plot, "barDir", "val", "bar|col") === "bar" ? "barH" : base
    const series: ChartSeries[] = []
    let categories: string[] = []
    for (const entry of list) {
      const name = seriesName(entry)
      const color = seriesColor(entry)
      if (base === "bubble" || base === "scatter") {
        const xs = numbers(inner(entry, "xVal"))
        const ys = numbers(inner(entry, "yVal"))
        const sizes = base === "bubble" ? numbers(inner(entry, "bubbleSize")) : []
        const points: ChartSeries["points"] = []
        for (let at = 0; at < Math.max(xs.length, ys.length); at++) {
          if (!Number.isFinite(xs[at]) || !Number.isFinite(ys[at])) continue
          points.push({ x: xs[at], y: ys[at], ...(Number.isFinite(sizes[at]) ? { size: sizes[at] } : {}) })
        }
        series.push({ name, color, values: [], points })
        continue
      }
      if (!categories.length) {
        const cat = inner(entry, "cat")
        const text = strings(cat)
        categories = cat ? (text.some(Boolean) ? text : numbers(cat).map((value) => (Number.isFinite(value) ? String(value) : ""))) : []
      }
      series.push({ name, color, values: numbers(inner(entry, "val")), points: [] })
    }
    const title = chartTitle(xml)
    const legendPos = new RegExp(`<${tag("legend")}\\b`, "i").test(xml) ? ((attr(xml, "legendPos", "val", "r|l|t|b|tr") as LegendPos | undefined) ?? "r") : undefined
    return { type, categories, series, ...(title ? { title } : {}), ...(legendPos ? { legendPos } : {}), ...axes(xml) }
  }
  return null
}

function niceMax(max: number) {
  if (!Number.isFinite(max) || max <= 0) return 1
  const step = Math.pow(10, Math.floor(Math.log10(max))) / 2
  return Math.ceil((max * 1.08) / step) * step
}

/** The echarts option MiMo draws a parsed chart with; null keeps the renderer's own (radar, empty pies). */
export function chartOption(spec: ChartSpec): Record<string, unknown> | null {
  const names = spec.series.map((series) => series.name).filter(Boolean)
  const legend = Boolean(spec.legendPos) && names.length > 0
  const pos = spec.legendPos ?? "r"
  const vertical = pos === "r" || pos === "l" || pos === "tr"
  const legendPart = legend
    ? {
        legend: {
          type: "scroll",
          orient: vertical ? "vertical" : "horizontal",
          ...(pos === "l" ? { left: 4 } : pos === "b" ? { bottom: 2 } : pos === "t" ? { top: 2 } : { right: 4 }),
          ...(vertical ? { top: pos === "tr" ? 4 : "middle" } : {}),
          data: names,
          textStyle: { fontSize: 10, width: vertical ? 120 : 220, overflow: "break" },
        },
      }
    : {}
  const titlePart = spec.title ? { title: { text: spec.title, left: "center", textStyle: { fontSize: 12 } } } : {}
  const gridPart = {
    grid: {
      left: pos === "l" && legend ? 150 : 44,
      right: (pos === "r" || pos === "tr") && legend ? 150 : 14,
      top: (spec.title ? 26 : 10) + (pos === "t" && legend ? 20 : 0),
      bottom: 26 + (pos === "b" && legend ? 18 : 0),
      containLabel: true,
    },
  }
  const colorOf = (index: number) => (spec.series[index]?.color ? { itemStyle: { color: spec.series[index].color } } : {})

  if (spec.type === "bubble" || spec.type === "scatter") {
    let maxSize = 0
    let maxX = 0
    let maxY = 0
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    for (const series of spec.series) {
      for (const point of series.points) {
        if (point.size && point.size > maxSize) maxSize = point.size
        maxX = Math.max(maxX, point.x)
        minX = Math.min(minX, point.x)
        maxY = Math.max(maxY, point.y)
        minY = Math.min(minY, point.y)
      }
    }
    const bubble = spec.type === "bubble"
    const axis = (min: number | undefined, max: number | undefined, dataMin: number, dataMax: number, grid: boolean) => {
      const out: Record<string, unknown> = { type: "value", axisLabel: { fontSize: 10 } }
      if (min != null) out.min = min
      else if (Number.isFinite(dataMin) && dataMin >= 0 && dataMax > 0 && dataMin < dataMax * (5 / 6)) out.min = 0
      if (max != null) out.max = max
      else if (out.min === 0) out.max = niceMax(dataMax)
      return { ...out, splitLine: { show: grid } }
    }
    return {
      ...titlePart,
      ...legendPart,
      ...gridPart,
      xAxis: axis(spec.xMin, spec.xMax, minX, maxX, spec.gridX),
      yAxis: axis(spec.yMin, spec.yMax, minY, maxY, spec.gridY),
      series: spec.series.map((series, index) => ({
        name: series.name || undefined,
        type: "scatter",
        ...colorOf(index),
        symbolSize: bubble ? (value: number[]) => (maxSize > 0 ? 8 + 34 * Math.sqrt((value[2] || 0) / maxSize) : 14) : 10,
        data: series.points.map((point) => (bubble ? [point.x, point.y, point.size ?? 0] : [point.x, point.y])),
      })),
    }
  }

  if (spec.type === "pie" || spec.type === "doughnut") {
    const first = spec.series[0]
    if (!first) return null
    return {
      ...titlePart,
      ...legendPart,
      series: [
        {
          type: "pie",
          radius: spec.type === "doughnut" ? ["40%", "70%"] : "70%",
          center: (pos === "r" || pos === "tr") && legend ? ["40%", "55%"] : ["50%", "55%"],
          data: spec.categories.map((name, index) => ({ name: name || `${index + 1}`, value: Number.isFinite(first.values[index]) ? first.values[index] : 0 })),
          label: { fontSize: 10 },
        },
      ],
    }
  }

  if (spec.type === "bar" || spec.type === "barH" || spec.type === "line" || spec.type === "area") {
    const horizontal = spec.type === "barH"
    const category = { type: "category", data: spec.categories, axisLabel: { fontSize: 10 }, splitLine: { show: horizontal ? spec.gridY : spec.gridX } }
    const value = { type: "value", axisLabel: { fontSize: 10 }, splitLine: { show: horizontal ? spec.gridX : spec.gridY } }
    const line = spec.type === "line" || spec.type === "area"
    return {
      ...titlePart,
      ...legendPart,
      ...gridPart,
      xAxis: horizontal ? value : category,
      yAxis: horizontal ? category : value,
      series: spec.series.map((series, index) => ({
        name: series.name || undefined,
        type: line ? "line" : "bar",
        ...(spec.type === "area" ? { areaStyle: {} } : {}),
        ...colorOf(index),
        data: series.values,
      })),
    }
  }
  return null
}

/* ------------------------------------------------------------ per-slide fix-ups */

export interface Crop {
  l: number
  t: number
  r: number
  b: number
}

export interface SlideFixup {
  slideId?: string
  /** Pictures that fill the slide and crop their source. */
  crops: Crop[]
  /** Paragraph text with its alignment, and whether its shape is a placeholder. */
  paras: { text: string; algn: string | null; ph: boolean }[]
  shapes: { id: string; name: string; textNorm: string }[]
  charts: (ChartSpec | null)[]
}

function relationships(xml: string) {
  const out = new Map<string, string>()
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[0])?.[1]
    const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1]
    if (id && target) out.set(id, target)
  }
  return out
}

function resolvePart(base: string, target: string) {
  if (target.startsWith("/")) return target.slice(1)
  const parts: string[] = []
  for (const segment of `${base}/${target}`.split("/")) {
    if (segment === "..") parts.pop()
    else if (segment !== "." && segment !== "") parts.push(segment)
  }
  return parts.join("/")
}

const relsOf = (part: string) => part.replace(/([^/]+)$/, "_rels/$1.rels")
const dirOf = (part: string) => part.slice(0, part.lastIndexOf("/"))

function fullBleedCrops(xml: string, cx: number, cy: number): Crop[] {
  const out: Crop[] = []
  for (const pic of blocks(xml, "pic")) {
    const off = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(pic)
    const ext = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(pic)
    const src = /<a:srcRect\b[^>]*\/?>/.exec(pic)
    if (!ext || !src) continue
    const x = off ? Number(off[1]) : 0
    const y = off ? Number(off[2]) : 0
    if (Math.abs(x) > cx * 0.02 || Math.abs(y) > cy * 0.02 || Number(ext[1]) < cx * 0.98 || Number(ext[2]) < cy * 0.98) continue
    const side = (key: string) => Number(new RegExp(`\\b${key}="(-?\\d+)"`).exec(src[0])?.[1] ?? 0) / 1e5
    out.push({ l: side("l"), t: side("t"), r: side("r"), b: side("b") })
  }
  return out
}

function paragraphs(xml: string): SlideFixup["paras"] {
  const out: SlideFixup["paras"] = []
  for (const shape of blocks(xml, "sp")) {
    const ph = new RegExp(`<${tag("ph")}\\b`, "i").test(shape)
    for (const match of shape.matchAll(new RegExp(`<${tag("p")}\\b[^>]*>[\\s\\S]*?</${tag("p")}>`, "gi"))) {
      const text = [...match[0].matchAll(new RegExp(`<${tag("t")}>([\\s\\S]*?)</${tag("t")}>`, "gi"))].map((run) => decodeXml(run[1])).join("").trim()
      if (text) out.push({ text, algn: attr(match[0], "pPr", "algn") ?? null, ph })
    }
  }
  return out
}

function shapesOf(xml: string): SlideFixup["shapes"] {
  const out: SlideFixup["shapes"] = []
  for (const kind of ["sp", "pic", "graphicFrame"]) {
    for (const shape of blocks(xml, kind)) {
      const props = new RegExp(`<${tag("cNvPr")}\\b[^>]*\\bid="(\\d+)"[^>]*\\bname="([^"]*)"`, "i").exec(shape)
      if (!props) continue
      const textNorm = [...shape.matchAll(new RegExp(`<${tag("t")}>([\\s\\S]*?)</${tag("t")}>`, "gi"))]
        .map((run) => decodeXml(run[1]))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      out.push({ id: props[1], name: decodeXml(props[2]), textNorm })
    }
  }
  return out
}

/** Every slide's fix-ups, in presentation order. */
export async function parseFixups(zip: JSZip): Promise<SlideFixup[]> {
  const presentation = await zip.file("ppt/presentation.xml")?.async("string")
  const rels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")
  if (!presentation || !rels) return []
  const size = /<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(presentation)
  const cx = size ? Number(size[1]) : 12192000
  const cy = size ? Number(size[2]) : 6858000
  const targets = relationships(rels)
  const out: SlideFixup[] = []
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*>/g)) {
    const rid = /\br:id="([^"]+)"/.exec(match[0])?.[1]
    const target = rid ? targets.get(rid) : undefined
    if (!target) continue
    const slideId = /\bid="(\d+)"/.exec(match[0])?.[1]
    const part = resolvePart("ppt", target)
    const xml = await zip.file(part)?.async("string")
    if (!xml) {
      out.push({ slideId, crops: [], paras: [], shapes: [], charts: [] })
      continue
    }
    const crops = fullBleedCrops(xml, cx, cy)
    const slideRels = relationships((await zip.file(relsOf(part))?.async("string")) ?? "")
    for (const layoutTarget of slideRels.values()) {
      if (!/slideLayout\d+\.xml$/i.test(layoutTarget)) continue
      const layoutPart = resolvePart(dirOf(part), layoutTarget)
      const layout = await zip.file(layoutPart)?.async("string")
      if (!layout) continue
      crops.push(...fullBleedCrops(layout, cx, cy))
      if (/showMasterSp="0"/.test(layout)) continue
      const layoutRels = relationships((await zip.file(relsOf(layoutPart))?.async("string")) ?? "")
      for (const masterTarget of layoutRels.values()) {
        if (!/slideMaster\d+\.xml$/i.test(masterTarget)) continue
        const master = await zip.file(resolvePart(dirOf(layoutPart), masterTarget))?.async("string")
        if (master) crops.push(...fullBleedCrops(master, cx, cy))
      }
    }
    const charts: SlideFixup["charts"] = []
    for (const frame of blocks(xml, "graphicFrame")) {
      const chartRid = new RegExp(`<${tag("chart")}\\b[^>]*\\br:id="([^"]+)"`, "i").exec(frame)?.[1]
      if (!chartRid) continue
      const chartTarget = slideRels.get(chartRid)
      const chartXml = chartTarget ? await zip.file(resolvePart(dirOf(part), chartTarget))?.async("string") : undefined
      charts.push(chartXml ? parseChart(chartXml) : null)
    }
    const seen = new Set<string>()
    const unique = crops.filter((crop) => {
      const key = [crop.l, crop.t, crop.r, crop.b].map((value) => value.toFixed(4)).join(",")
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    out.push({ slideId, crops: unique, paras: paragraphs(xml), shapes: shapesOf(xml), charts })
  }
  return out
}

/* ------------------------------------------------------------ first-open entrance */

const ENTRANCE_STEP = 150
export const ENTRANCE_ITEM_MS = 350
const ENTRANCE_SLIDE_GAP = 400
const ENTRANCE_STEPS = 12
const ENTRANCE_MAX = 18000

/** When each slide's pieces come in, given how many pieces each slide has; squeezed to 18s at most. */
export function entranceSchedule(counts: number[]): { delays: number[][]; totalMs: number } {
  const delays: number[][] = []
  let at = 0
  counts.forEach((count, slide) => {
    if (slide > 0) at += ENTRANCE_SLIDE_GAP
    const steps = Math.min(count, ENTRANCE_STEPS)
    delays.push(Array.from({ length: count }, (_, index) => at + Math.min(index, steps - 1) * ENTRANCE_STEP))
    at += (steps - 1) * ENTRANCE_STEP + ENTRANCE_ITEM_MS
  })
  if (at <= ENTRANCE_MAX) return { delays, totalMs: at }
  const scale = ENTRANCE_MAX / at
  return { delays: delays.map((row) => row.map((delay) => Math.round(delay * scale))), totalMs: ENTRANCE_MAX }
}

/* ------------------------------------------------------------ presenting */

export interface Transition {
  type: "fade" | "push" | "wipe" | "split" | "cover" | "cut"
  dir?: string
  durMs: number
}

export interface Effect {
  spid: string
  presetId: number
  presetClass: string
  subtype: number
  startMs: number
  durMs: number
  filter?: string
}

export interface SlideMotion {
  transition?: Transition
  effects: Effect[]
}

function parseTransition(xml: string): Transition | undefined {
  const block = /<p:transition\b[^>]*>[\s\S]*?<\/p:transition>|<p:transition\b[^>]*\/>/.exec(xml)?.[0]
  if (!block) return undefined
  const kind = /<p:(fade|push|wipe|split|cover|cut)\b([^/>]*)\/?>/.exec(block)
  if (!kind) return undefined
  const duration = /p14:dur="(\d+)"/.exec(block) ?? /dur="(\d+)"/.exec(block)
  return { type: kind[1] as Transition["type"], dir: /dir="([^"]+)"/.exec(kind[2] ?? "")?.[1], durMs: duration ? Number(duration[1]) : 500 }
}

interface TimeNode {
  effect?: Effect
  delayMs: number
  ownDurMs: number
  inStart: boolean
}

/** Entrance effects from p:timing: each preset's target, start (its delays added up) and longest duration. */
function parseEffects(xml: string): Effect[] {
  const timing = /<p:timing>[\s\S]*?<\/p:timing>/.exec(xml)?.[0]
  if (!timing) return []
  const stack: TimeNode[] = []
  const out: Effect[] = []
  const nearestPreset = (test: (effect: Effect) => boolean) => {
    for (let at = stack.length - 1; at >= 0; at--) {
      const effect = stack[at].effect
      if (effect && test(effect)) return effect
    }
    return undefined
  }
  const token = /<p:cTn\b([^>]*?)(\/)?>|<\/p:cTn>|<p:cond\b([^/>]*)\/?>|<p:stCondLst>|<\/p:stCondLst>|<p:spTgt\s+spid="([^"]+)"\s*\/?>|<p:animEffect\b([^/>]*)\/?>/g
  for (let match = token.exec(timing); match; match = token.exec(timing)) {
    const text = match[0]
    if (text.startsWith("<p:cTn")) {
      const attrs = match[1] ?? ""
      const preset = /presetID="(\d+)"/.exec(attrs)
      const node: TimeNode = { delayMs: 0, ownDurMs: Number(/\bdur="(\d+)"/.exec(attrs)?.[1] ?? 0), inStart: false }
      if (preset) {
        node.effect = {
          spid: "",
          presetId: Number(preset[1]),
          presetClass: /presetClass="([^"]+)"/.exec(attrs)?.[1] ?? "",
          subtype: Number(/presetSubtype="(\d+)"/.exec(attrs)?.[1] ?? 0),
          startMs: 0,
          durMs: 0,
        }
      }
      if (match[2] !== "/") stack.push(node)
      else if (node.ownDurMs > 1) {
        const effect = nearestPreset(() => true)
        if (effect) effect.durMs = Math.max(effect.durMs, node.ownDurMs)
      }
    } else if (text === "</p:cTn>") {
      const node = stack.pop()
      if (!node) continue
      if (node.effect) {
        node.effect.startMs = stack.reduce((sum, parent) => sum + parent.delayMs, 0) + node.delayMs
        node.effect.durMs ||= 500
        if (node.effect.spid) out.push(node.effect)
      } else if (node.ownDurMs > 1) {
        const effect = nearestPreset(() => true)
        if (effect) effect.durMs = Math.max(effect.durMs, node.ownDurMs)
      }
    } else if (text === "<p:stCondLst>" || text === "</p:stCondLst>") {
      const top = stack.at(-1)
      if (top) top.inStart = text === "<p:stCondLst>"
    } else if (text.startsWith("<p:cond")) {
      const top = stack.at(-1)
      const delay = /delay="([^"]+)"/.exec(match[3] ?? "")?.[1]
      if (!top?.inStart || !delay || delay === "indefinite" || !Number.isFinite(Number(delay))) continue
      top.delayMs = Math.max(top.delayMs, Number(delay))
    } else if (text.startsWith("<p:spTgt")) {
      const effect = nearestPreset((candidate) => !candidate.spid)
      if (effect && match[4]) effect.spid = match[4]
    } else if (text.startsWith("<p:animEffect")) {
      const filter = /filter="([^"]+)"/.exec(match[5] ?? "")?.[1]
      const effect = filter ? nearestPreset((candidate) => !candidate.filter) : undefined
      if (effect && filter) effect.filter = filter
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

export function parseMotion(xml: string): SlideMotion {
  return { transition: parseTransition(xml), effects: parseEffects(xml) }
}

const visible = { visibility: "visible" }

/** An entrance effect as Web Animations keyframes: fade, fly in, wipe, zoom, split; anything else fades. */
export function effectAnimation(effect: Effect): { keyframes: Keyframe[]; timing: KeyframeAnimationOptions } {
  const timing: KeyframeAnimationOptions = { duration: effect.durMs, delay: effect.startMs, fill: "forwards", easing: "ease-out" }
  const fade = [{ opacity: 0, ...visible }, { opacity: 1, ...visible }]
  switch (effect.presetId) {
    case 2: {
      const bits = effect.subtype
      const from = bits & 8 ? "translate(-100%, 0)" : bits & 4 ? "translate(0, 100%)" : bits & 2 ? "translate(100%, 0)" : bits & 1 ? "translate(0, -100%)" : "translate(100%, 0)"
      return { keyframes: [{ transform: from, opacity: 0, ...visible }, { transform: "translate(0, 0)", opacity: 1, ...visible }], timing }
    }
    case 22: {
      const dir = /wipe\((\w+)\)/.exec(effect.filter ?? "")?.[1] ?? "left"
      const from = dir === "down" ? "inset(100% 0 0 0)" : dir === "up" ? "inset(0 0 100% 0)" : dir === "right" ? "inset(0 0 0 100%)" : "inset(0 100% 0 0)"
      return { keyframes: [{ clipPath: from, opacity: 1, ...visible }, { clipPath: "inset(0 0 0 0)", opacity: 1, ...visible }], timing }
    }
    case 23:
      return { keyframes: [{ transform: "scale(0.2)", opacity: 0, ...visible }, { transform: "scale(1)", opacity: 1, ...visible }], timing }
    case 16:
      return { keyframes: [{ clipPath: "inset(50% 0 50% 0)", opacity: 1, ...visible }, { clipPath: "inset(0 0 0 0)", opacity: 1, ...visible }], timing }
    default:
      return { keyframes: fade, timing }
  }
}

function offset(dir: string | undefined, entering: boolean) {
  const table: Record<string, [string, string]> = {
    l: ["translateX(-100%)", "translateX(100%)"],
    r: ["translateX(100%)", "translateX(-100%)"],
    u: ["translateY(-100%)", "translateY(100%)"],
    d: ["translateY(100%)", "translateY(-100%)"],
  }
  const pair = table[dir ?? "l"] ?? table.l
  return entering ? pair[0] : pair[1]
}

/** A slide change as keyframes for the leaving and the arriving layer. */
export function transitionAnimation(transition: Transition | undefined): { current: Keyframe[]; next: Keyframe[]; timing: KeyframeAnimationOptions } {
  const timing: KeyframeAnimationOptions = { duration: transition?.durMs ?? 500, fill: "both", easing: "ease-in-out" }
  if (!transition) return { current: [], next: [{ opacity: 1 }, { opacity: 1 }], timing }
  const wipeFrom: Record<string, string> = { d: "inset(100% 0 0 0)", u: "inset(0 0 100% 0)", l: "inset(0 100% 0 0)", r: "inset(0 0 0 100%)" }
  switch (transition.type) {
    case "fade":
      return { current: [{ opacity: 1 }, { opacity: 0 }], next: [{ opacity: 0 }, { opacity: 1 }], timing }
    case "push":
      return {
        current: [{ transform: "translate(0, 0)", opacity: 1 }, { transform: offset(transition.dir, false), opacity: 1 }],
        next: [{ transform: offset(transition.dir, true), opacity: 1 }, { transform: "translate(0, 0)", opacity: 1 }],
        timing,
      }
    case "wipe":
      return { current: [], next: [{ clipPath: wipeFrom[transition.dir ?? "l"] ?? wipeFrom.l, opacity: 1 }, { clipPath: "inset(0 0 0 0)", opacity: 1 }], timing }
    case "split":
      return { current: [], next: [{ clipPath: "inset(50% 0 50% 0)", opacity: 1 }, { clipPath: "inset(0 0 0 0)", opacity: 1 }], timing }
    case "cover":
      return { current: [], next: [{ transform: offset(transition.dir, true), opacity: 1 }, { transform: "translate(0, 0)", opacity: 1 }], timing }
    default:
      return { current: [{ opacity: 0 }, { opacity: 0 }], next: [{ opacity: 1 }, { opacity: 1 }], timing: { ...timing, duration: 0 } }
  }
}
