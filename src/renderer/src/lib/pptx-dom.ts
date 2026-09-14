import { chartOption, type ChartSpec, type SlideFixup } from "./pptx-parse"

/*
 * MiMo's slide geometry over the renderer's DOM: the pieces a pointer can pick
 * (the smallest box that still groups several pieces, trimmed to its text),
 * regions kept as fractions of a slide so they follow re-layout, the fix-ups
 * for crops and alignment, and charts drawn again from their cached data.
 */

/** Whether motion is turned down: the appearance setting first; left to the system, the system's preference. */
export function reducedMotion(): boolean {
  const motion = document.documentElement.getAttribute("data-motion")
  return motion === "on" || (motion !== "off" && matchMedia("(prefers-reduced-motion: reduce)").matches)
}

const isFull = (rect: DOMRect, of: DOMRect) => rect.width >= of.width * 0.9 && rect.height >= of.height * 0.9

/** A slide's visible pieces, looking through wrappers as large as the slide. */
export function topChildren(slide: HTMLElement): HTMLElement[] {
  const box = slide.getBoundingClientRect()
  const out: HTMLElement[] = []
  const walk = (parent: Element) => {
    for (const child of parent.children) {
      const rect = child.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      if (isFull(rect, box)) walk(child)
      else out.push(child as HTMLElement)
    }
  }
  walk(slide)
  return out
}

/** The text of the pieces a drawn box touches, joined with ⏎. */
export function textInBox(slide: HTMLElement, box: DOMRect): string {
  const touches = (rect: DOMRect) => rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top
  return topChildren(slide)
    .filter((piece) => touches(piece.getBoundingClientRect()))
    .map((piece) => piece.innerText?.trim() ?? "")
    .filter(Boolean)
    .join(" ⏎ ")
}

/** The box around an element's visible text, or null when it has none. */
function textBounds(element: Element): DOMRect | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.trim()) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue
      left = Math.min(left, rect.left)
      top = Math.min(top, rect.top)
      right = Math.max(right, rect.right)
      bottom = Math.max(bottom, rect.bottom)
    }
  }
  return Number.isFinite(left) ? new DOMRect(left, top, right - left, bottom - top) : null
}

export interface ModuleHit {
  el: HTMLElement
  rect: DOMRect
  slide: HTMLElement
  slideIndex: number
}

/**
 * The piece under a point: from the outermost box smaller than the slide, in
 * toward the pointer while the box is at least 0.5% of the slide and groups
 * two or more pieces. A piece with text is its text's box padded 12 by 8, and
 * must hold the point; one without is its own box.
 */
export function moduleAt(x: number, y: number, host: HTMLElement): ModuleHit | null {
  const hit = document.elementFromPoint(x, y)
  if (!hit || !host.contains(hit)) return null
  const slide = hit.closest<HTMLElement>("[data-slide-index]")
  if (!slide || hit === slide) return null
  const slideBox = slide.getBoundingClientRect()
  const chain: HTMLElement[] = []
  for (let element: HTMLElement | null = hit as HTMLElement; element && element !== slide; element = element.parentElement) chain.push(element)
  let chosen: HTMLElement | null = null
  for (let at = chain.length - 1; at >= 0; at--) {
    const rect = chain[at].getBoundingClientRect()
    if (rect.width > 1 && rect.height > 1 && !isFull(rect, slideBox)) {
      chosen = chain[at]
      break
    }
  }
  if (!chosen) return null
  const minArea = slideBox.width * slideBox.height * 0.005
  for (;;) {
    const rect = chosen.getBoundingClientRect()
    const pieces = [...chosen.children].filter((child) => {
      const box = child.getBoundingClientRect()
      return box.width > 1 && box.height > 1 && !isFull(box, slideBox)
    })
    if (rect.width * rect.height < minArea || pieces.length <= 1) break
    const inward: number = chain.indexOf(chosen) - 1
    if (inward < 0) break
    chosen = chain[inward]
  }
  const text = textBounds(chosen)
  const bounds = text ?? chosen.getBoundingClientRect()
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null
  const index = Number.parseInt(slide.getAttribute("data-slide-index") ?? "", 10)
  return {
    el: chosen,
    rect: text ? new DOMRect(bounds.left - 12, bounds.top - 8, bounds.width + 24, bounds.height + 16) : bounds,
    slide,
    slideIndex: Number.isFinite(index) ? index : 0,
  }
}

export interface Region {
  slideIndex: number
  fx: number
  fy: number
  fw: number
  fh: number
}

export function regionOf(rect: DOMRect, slide: HTMLElement): Region {
  const box = slide.getBoundingClientRect()
  const index = Number.parseInt(slide.getAttribute("data-slide-index") ?? "", 10)
  return {
    slideIndex: Number.isFinite(index) ? index : 0,
    fx: (rect.left - box.left) / box.width,
    fy: (rect.top - box.top) / box.height,
    fw: rect.width / box.width,
    fh: rect.height / box.height,
  }
}

/** A region's box on screen now, or null while its slide is not laid out. */
export function rectOfRegion(region: Region, host: HTMLElement): DOMRect | null {
  const slide = host.querySelector(`[data-slide-index="${region.slideIndex}"]`)
  if (!slide) return null
  const box = slide.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return null
  return new DOMRect(box.left + region.fx * box.width, box.top + region.fy * box.height, region.fw * box.width, region.fh * box.height)
}

export function slideIndexOfNode(node: Node | null | undefined, fallback: number): number {
  const element = node instanceof Element ? node : node?.parentElement
  const index = Number.parseInt(element?.closest("[data-slide-index]")?.getAttribute("data-slide-index") ?? "", 10)
  return Number.isFinite(index) ? index : fallback
}

/** MiMo's corrections to a rendered slide: a cropped full-bleed picture, and paragraphs pushed right that are left-aligned. */
export function applyFixup(slide: HTMLElement, fixup: SlideFixup) {
  applyCropSoon(slide, fixup, 0)
  applyAlignment(slide, fixup)
}

/*
 * The crop needs the slide's box, which a slide rendered hidden (the next
 * layer of a slide show) or not yet in the page (a new deck's entrance) does
 * not have yet - so it is tried again a few times until the slide is laid out.
 */
function applyCropSoon(slide: HTMLElement, fixup: SlideFixup, tries: number) {
  if (applyCrop(slide, fixup) || tries >= 5) return
  setTimeout(() => applyCropSoon(slide, fixup, tries + 1), 16 * 2 ** tries)
}

/** True once there is nothing left to do: the crop is applied, or there is none. */
function applyCrop(slide: HTMLElement, fixup: SlideFixup): boolean {
  const crop = fixup.crops[0]
  if (!crop || slide.dataset.mcodeCropped) return true
  const box = slide.getBoundingClientRect()
  if (box.width <= 1 || box.height <= 1) return false
  slide.dataset.mcodeCropped = "1"
  for (const image of slide.querySelectorAll("img")) {
    const parent = image.parentElement
    if (!parent) continue
    const rect = parent.getBoundingClientRect()
    const fills = rect.width >= box.width * 0.85 && rect.height >= box.height * 0.85
    const atOrigin = rect.left - box.left < box.width * 0.08 && rect.top - box.top < box.height * 0.08
    if (!fills || !atOrigin) continue
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative"
    parent.style.overflow = "hidden"
    const width = Math.max(0.01, 1 - crop.l - crop.r)
    const height = Math.max(0.01, 1 - crop.t - crop.b)
    const set = (name: string, value: string) => image.style.setProperty(name, value, "important")
    set("margin", "0")
    set("position", "absolute")
    set("width", `${(100 / width).toFixed(3)}%`)
    set("height", `${(100 / height).toFixed(3)}%`)
    set("left", `${((-crop.l / width) * 100).toFixed(3)}%`)
    set("top", `${((-crop.t / height) * 100).toFixed(3)}%`)
    set("max-width", "none")
    set("max-height", "none")
    set("object-fit", "fill")
    break
  }
  return true
}

function applyAlignment(slide: HTMLElement, fixup: SlideFixup) {
  if (!fixup.paras.length) return
  const fold = (text: string) => text.replace(/\s+/g, " ").trim()
  const used = new Set<number>()
  for (const element of slide.querySelectorAll<HTMLElement>("[style]")) {
    if (element.style.textAlign !== "right" || !element.innerText.trim()) continue
    const text = fold(element.innerText)
    const index = fixup.paras.findIndex((para, at) => !used.has(at) && fold(para.text) === text)
    if (index < 0) continue
    used.add(index)
    const para = fixup.paras[index]
    if (!para.ph && (para.algn == null || para.algn === "l")) element.style.setProperty("text-align", "left", "important")
  }
}

export interface ChartInstance {
  setOption(option: object): void
  dispose(): void
  resize(): void
  getDom(): HTMLElement | undefined
}

export interface Echarts {
  init(element: HTMLElement): ChartInstance
  getInstanceByDom(element: HTMLElement): { dispose(): void } | undefined
}

/**
 * The renderer's chart boxes, in order, drawn again from the slide's parsed
 * charts; the renderer's own legend and title beside each are hidden. Not all
 * done while fewer boxes than charts are on the slide yet.
 */
export function renderCharts(echarts: Echarts, slide: HTMLElement, charts: (ChartSpec | null)[]): { made: ChartInstance[]; allDone: boolean } {
  const made: ChartInstance[] = []
  if (!charts.length) return { made, allDone: true }
  const boxes = [...slide.querySelectorAll<HTMLElement>("[_echarts_instance_],[data-mimo-chart]")]
  if (boxes.length < charts.length) return { made, allDone: false }
  let done = 0
  charts.forEach((spec, index) => {
    const box = boxes[index]
    if (!box) return
    if (box.getAttribute("data-mimo-chart")) {
      done += 1
      return
    }
    const option = spec ? chartOption(spec) : null
    if (!option) {
      box.setAttribute("data-mimo-chart", "skip")
      done += 1
      return
    }
    try {
      echarts.getInstanceByDom(box)?.dispose()
      box.innerHTML = ""
      box.removeAttribute("_echarts_instance_")
      const chart = echarts.init(box)
      chart.setOption(option)
      box.setAttribute("data-mimo-chart", "1")
      for (const sibling of box.parentElement?.children ?? []) if (sibling !== box) (sibling as HTMLElement).style.display = "none"
      made.push(chart)
      done += 1
    } catch (err) {
      console.warn("[PptxView] chart re-render failed:", err)
    }
  })
  return { made, allDone: done >= charts.length }
}

/** The rendered element an effect's shape id names: its place among the slide's nodes, counted from the end of the slide's children. */
export function effectTarget(slide: Element, spid: string, nodes: readonly { id: string | number }[]): HTMLElement | null {
  const index = nodes.findIndex((node) => String(node.id) === spid)
  if (index < 0) return null
  const children = [...slide.children]
  if (children.length < nodes.length) return null
  return (children.slice(-nodes.length)[index] as HTMLElement | undefined) ?? null
}
