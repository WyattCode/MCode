import DOMPurify from "dompurify"
import { stripSvgHazards, svgSize } from "./svg-safe"

/*
 * What MiMo's diagram blocks need from the window: which theme is showing,
 * mermaid loaded once and on first use, SVG sanitised before it is ever put in
 * the page, and a diagram turned into a picture for the clipboard or a file.
 */

/** The scheme the window is showing: an explicit choice, else the system's. */
export function isDarkTheme(): boolean {
  const chosen = document.documentElement.dataset.theme
  if (chosen === "dark") return true
  if (chosen === "light") return false
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
}

/** Calls back whenever the theme may have changed; returns the way to stop. */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
  const media = window.matchMedia?.("(prefers-color-scheme: dark)")
  media?.addEventListener("change", onChange)
  return () => {
    observer.disconnect()
    media?.removeEventListener("change", onChange)
  }
}

/* MiMo's picture ground: white in light, #1e1e1e in dark. */
export const themeBackground = (dark: boolean) => (dark ? "#1e1e1e" : "#ffffff")

type MermaidApi = (typeof import("mermaid"))["default"]
let mermaidLoading: Promise<MermaidApi> | undefined
let renderCount = 0
/* initialize is global to mermaid, so one render waits for the one before it. */
let queue: Promise<unknown> = Promise.resolve()

export function renderMermaid(code: string, dark: boolean): Promise<string> {
  mermaidLoading ??= import("mermaid").then((module) => module.default)
  const job = queue.then(async () => {
    const mermaid = await (mermaidLoading as Promise<MermaidApi>)
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
      fontFamily: "inherit",
    })
    const id = `mmd-${Date.now().toString(36)}-${(renderCount++).toString(36)}`
    try {
      return (await mermaid.render(id, code)).svg
    } finally {
      // A failed render can leave its scratch element behind in the body.
      document.getElementById(`d${id}`)?.remove()
      document.getElementById(id)?.remove()
    }
  })
  queue = job.catch(() => undefined)
  return job
}

/*
 * Mermaid's labels are HTML inside foreignObject, so that one integration point
 * is kept; scripts and handlers are not.
 *
 * `<style>` is taken out by the sanitiser and then put back cleaned. A style
 * element inside an inline SVG is CSS for the whole document, not for the
 * drawing, and DOMPurify never cleans CSS text - so a drawing could hide or
 * cover anything on the page (R26-A2). But R26 stopped there, and Mermaid
 * carries its whole theme in that element: every node fill, stroke and label
 * colour. Without it every diagram in every reply was drawn as solid black
 * blocks with the words unreadable on them, in both schemes (R28-6).
 *
 * So the rules Mermaid wrote for *this* drawing are kept - each selector has to
 * start at the drawing's own id, which the app chose and a diagram cannot -
 * and everything else goes: other selectors, sibling combinators that step out
 * of the drawing, at-rules (imports, fonts, media), and anything that loads an
 * address.
 */
export function sanitizeMermaidSvg(svg: string): string {
  const clean = DOMPurify.sanitize(stripSvgHazards(svg, true), {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject", "use"],
    FORBID_TAGS: ["style"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  })
  const id = /<svg\b[^>]*?\sid="(mmd-[a-z0-9-]+)"/i.exec(clean)?.[1]
  if (!id) return clean
  return withStyle(clean, drawingStyle(svg, id))
}

/** A drawing's markup with its cleaned CSS as the first thing inside it. */
function withStyle(markup: string, css: string): string {
  if (!css) return markup
  /*
   * Written as text for the HTML parser, every markup character escaped - the
   * parser decodes them again inside the drawing, so the CSS arrives intact.
   * `<` and `&` stop a rule closing the element or naming an entity. The
   * quotes and `>` are for the insertion point: it is found by a pattern on
   * the serialized opening tag, which is sound only while the serializer
   * escapes `>` inside attribute values (Chromium 146 does, measured). If it
   * ever did not, a `"` in a font name would close that attribute and start
   * new ones; escaped, the worst case is a drawing without its colours.
   */
  const text = css.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
  return markup.replace(/<svg\b[^>]*>/i, (open) => `${open}<style>${text}</style>`)
}

/* Each reply's drawing gets an id of the app's choosing, for its CSS to be moved under. */
let fenceCount = 0

/** The rules in a drawing's own style elements that stay inside it, keeping only what they may set. */
export function drawingStyle(svg: string, id: string, rescope = false): string {
  if (typeof CSSStyleSheet !== "function" || typeof DOMParser !== "function") return ""
  const parsed = new DOMParser().parseFromString(svg, "text/html")
  const source = [...parsed.querySelectorAll("style")].map((node) => node.textContent ?? "").join("\n")
  if (!source.trim()) return ""
  const sheet = new CSSStyleSheet()
  try {
    sheet.replaceSync(source)
  } catch {
    return ""
  }
  const own = `#${id}`
  const kept: string[] = []
  for (const rule of [...sheet.cssRules]) {
    // Plain rules only: no @import, @font-face, @media, @keyframes.
    if (!(rule instanceof CSSStyleRule)) continue
    if (rule.cssRules?.length) continue
    /*
     * A drawing a reply wrote itself names its own classes (`.box`), not an id
     * it could not know, so each of its selectors is moved under the one the
     * app gave it: `svg` and `:root` become the drawing, anything else a
     * descendant of it. Mermaid already writes its rules under its id.
     */
    const selectors = splitSelectors(rule.selectorText).map((part) => (rescope ? underDrawing(part, own) : part))
    if (!selectors.every((part) => staysInside(part, own))) continue
    /*
     * And only what paints. Mermaid's `classDef` and `style` lines let the
     * diagram's author write any declaration, and a label is HTML inside
     * foreignObject - so `position: fixed` with a size and a z-index on one
     * label covered the page from inside a rule that never left the drawing.
     * Paint, type and the box model are kept: the drawing and each
     * foreignObject clip what is inside them, and nothing on this list can
     * step outside that clip. Positioning, stacking, overflow and anything
     * that loads an address are not.
     */
    const declarations: string[] = []
    for (let at = 0; at < rule.style.length; at++) {
      const name = rule.style.item(at)
      if (!DRAWING.has(name)) continue
      const value = rule.style.getPropertyValue(name)
      if (/url\(|image-set\(|expression\(|attr\(/i.test(value)) continue
      declarations.push(`${name}: ${value}${rule.style.getPropertyPriority(name) ? " !important" : ""};`)
    }
    if (declarations.length) kept.push(`${selectors.join(", ")} { ${declarations.join(" ")} }`)
  }
  return kept.join("\n")
}

/** A selector list split at its own commas, not the ones inside `:is(a, b)` or `[title="a,b"]`. */
export function splitSelectors(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ""
  let from = 0
  for (let at = 0; at < list.length; at++) {
    const ch = list[at]!
    if (quote) {
      if (ch === "\\") at++
      else if (ch === quote) quote = ""
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === "(" || ch === "[") depth++
    else if (ch === ")" || ch === "]") depth--
    else if (ch === "," && depth === 0) {
      out.push(list.slice(from, at).trim())
      from = at + 1
    }
  }
  out.push(list.slice(from).trim())
  return out.filter(Boolean)
}

/** A reply's selector, moved under the drawing: `svg .box` and `.box` both become `#id .box`. */
export function underDrawing(part: string, own: string): string {
  const root = /^(?:svg|:root)(?![\w-])/i.exec(part)
  return root ? `${own}${part.slice(root[0].length)}` : `${own} ${part}`
}

/*
 * Whether a selector's subject can only be the drawing or something in it: it
 * starts at the drawing's id - whole, so `#mmd-1` is not `#mmd-10` - and does
 * not step to the drawing's siblings. A sibling combinator further in is
 * fine; the siblings of something inside the drawing are inside it too.
 */
export function staysInside(part: string, own: string): boolean {
  if (!part.startsWith(own)) return false
  const after = part.slice(own.length)
  if (after && !/^[\s.:>[]/.test(after)) return false
  return !/^\s*[~+]/.test(after)
}

/*
 * What a drawing's own CSS may set: how things are painted and lettered, and
 * the box model inside the clip - never `position`, `z-index`, `overflow` or
 * `transform`, the ways out of it.
 *
 * The box model is not optional: Mermaid sets `#id p { margin: 0 }` for its
 * labels, and with only paint kept every label's paragraph took the page's
 * default margin and was pushed half out of its box - the words cut off at
 * the middle (measured, R28-6).
 */
export const DRAWING = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "color", "background-color", "font-family", "font-size",
  "font-weight", "font-style", "font-variant", "line-height", "letter-spacing", "text-anchor", "text-align", "text-decoration",
  "text-decoration-line", "text-decoration-color", "dominant-baseline", "alignment-baseline", "white-space", "word-break",
  "overflow-wrap", "text-overflow", "shape-rendering", "text-rendering", "paint-order", "vector-effect", "cursor", "filter",
  "display", "vertical-align", "box-sizing", "width", "height", "min-width", "min-height", "max-width", "max-height", "rx", "ry",
  "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
])

/* A reply's own SVG: MiMo's svg and svgFilters profiles with use allowed, so no foreignObject, script or handler survives. */
export function sanitizeSvgFence(code: string): string {
  const clean = DOMPurify.sanitize(stripSvgHazards(code), { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["use"], FORBID_TAGS: ["style"] })
  if (!clean) return ""
  const holder = document.createElement("div")
  holder.innerHTML = clean
  const root = holder.firstElementChild
  if (!(root instanceof SVGSVGElement)) return ""
  if (!root.getAttribute("viewBox")) {
    const { w, h } = svgSize(code)
    root.setAttribute("viewBox", `0 0 ${w} ${h}`)
  }
  root.removeAttribute("height")
  root.setAttribute("width", "100%")
  root.style.display = "block"
  /*
   * The drawing's own `<style>`, cleaned and scoped as Mermaid's is. R26 took
   * it out with nothing put back, and a reply's SVG styled that way - the
   * usual way to write one - came out as black shapes with its words black on
   * them (R28-7).
   */
  const id = `svgf-${(fenceCount++).toString(36)}`
  root.setAttribute("id", id)
  return withStyle(root.outerHTML, drawingStyle(code, id, true))
}

/*
 * abcjs's score: its sizing wrapper and SVG, through the same pre-pass and
 * DOMPurify's svg profiles (the html profile only for that wrapper div), so no
 * script, handler, foreignObject or javascript: address can reach the page.
 */
export function sanitizeAbcSvg(markup: string): string {
  return DOMPurify.sanitize(stripSvgHazards(markup), { USE_PROFILES: { svg: true, svgFilters: true, html: true }, FORBID_TAGS: ["foreignObject", "script", "style"] })
}

/** The sanitised SVG with a size and the theme's ground, as a standalone document. */
export function exportableSvg(svg: string, background: string): { xml: string; w: number; h: number } | undefined {
  const holder = document.createElement("div")
  holder.innerHTML = svg
  const root = holder.querySelector("svg")
  if (!root) return undefined
  const { w, h } = svgSize(svg)
  root.setAttribute("width", String(w))
  root.setAttribute("height", String(h))
  if (!root.getAttribute("viewBox")) root.setAttribute("viewBox", `0 0 ${w} ${h}`)
  root.style.background = background
  root.style.maxWidth = "none"
  return { xml: new XMLSerializer().serializeToString(root), w, h }
}

export const svgDataUrl = (xml: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`

function loadImage(url: string, width?: number, height?: number): Promise<HTMLImageElement> {
  const image = new Image()
  if (width && height) {
    image.width = width
    image.height = height
  }
  image.decoding = "async"
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("image load failed"))
    image.src = url
  })
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas toBlob failed"))), "image/png"))
}

/** A PNG of the SVG at `scale` times its size, on a filled ground. */
export async function rasterise(xml: string, w: number, h: number, background: string, scale = 2): Promise<Blob> {
  const image = await loadImage(svgDataUrl(xml), w, h)
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const context = canvas.getContext("2d")
  if (!context) throw new Error("canvas 2d context unavailable")
  context.fillStyle = background
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvasBlob(canvas)
}

/** Any picture the browser can draw, as a PNG; a PNG is passed through. */
export async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob
  const url = URL.createObjectURL(blob)
  try {
    const image = await loadImage(url)
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth || 1024
    canvas.height = image.naturalHeight || 1024
    const context = canvas.getContext("2d")
    if (!context) throw new Error("canvas 2d context unavailable")
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await canvasBlob(canvas)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function writeClipboardPng(png: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(blob)
  })
}

export function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at)
  return new Blob([bytes], { type })
}
