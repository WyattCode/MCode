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

/* Mermaid's labels are HTML inside foreignObject, so that one integration point is kept; scripts and handlers are not. */
export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(stripSvgHazards(svg, true), {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject", "use"],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  })
}

/* A reply's own SVG: MiMo's svg and svgFilters profiles with use allowed, so no foreignObject, script or handler survives. */
export function sanitizeSvgFence(code: string): string {
  const clean = DOMPurify.sanitize(stripSvgHazards(code), { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["use"] })
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
  return root.outerHTML
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
