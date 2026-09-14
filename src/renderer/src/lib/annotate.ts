import { ref, shallowRef } from "vue"
import type { Annotation } from "@shared/protocol"

/*
 * Where MiMo's annotation box is asked for, and the text arithmetic behind it.
 *
 * What can be annotated says so in the markup: `data-annotate="answer"` on a
 * reply's text, `data-annotate="code"` (with `data-annotate-path`) on the files
 * tab's code. Inside `data-annotate-scope` - the side chat - they belong to that
 * box rather than the main one, as MiMo keeps each box's annotations apart.
 *
 * Text is compared the way MiMo compares it: with every whitespace character
 * dropped, and anything the reader cannot select (user-select: none, such as
 * line numbers) left out, so a quote is found again however the block is laid
 * out or re-rendered.
 */

export interface AnnotationRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface AnnotationRequest {
  /** Whose box it goes to, when not the main one's. */
  scope?: string
  /** What the box is placed against. */
  rect: AnnotationRect
  /** Where that is now, for following a scroll; nothing when it has gone. */
  follow?: () => AnnotationRect | null
  /** The text being annotated, lit while the box has focus. */
  range?: Range
  /** An annotation already waiting, reopened to change its note. */
  index?: number
  initialText?: string
  /** A new annotation, from what was written. */
  make?: (text: string) => Annotation
}

export const annotationRequest = shallowRef<AnnotationRequest | null>(null)

export function requestAnnotation(request: AnnotationRequest | null) {
  annotationRequest.value = request
}

/** The main box's scope - the open conversation's, or the home screen's - kept here for the document viewers. */
export const mainAnnotationScope = ref("home")

/** Asks the box that holds this scope's annotations to send its message now. */
export const annotationSend = shallowRef<{ scope: string; seq: number } | null>(null)

export function requestAnnotationSend(scope: string) {
  annotationSend.value = { scope, seq: (annotationSend.value?.seq ?? 0) + 1 }
}

/** MiMo's locate pulse: the document view holding this annotation scrolls to it and flashes its frame. */
export const annotationFlash = shallowRef<{ id: string; seq: number } | null>(null)

export function requestAnnotationFlash(id: string) {
  annotationFlash.value = { id, seq: (annotationFlash.value?.seq ?? 0) + 1 }
}

/** MiMo's PDF locate: a PDF view of this file goes to the page (or searches for it) and marks the snippet. */
export const pdfLocate = shallowRef<{ path: string; snippet: string; page?: number; occ?: number; seq: number } | null>(null)

export function requestPdfLocate(target: { path: string; snippet: string; page?: number; occ?: number }) {
  pdfLocate.value = { ...target, seq: (pdfLocate.value?.seq ?? 0) + 1 }
}

let counter = 0
export function annotationId(): string {
  return `ann-${Date.now().toString(36)}-${++counter}`
}

export type AnnotatableKind = "answer" | "code"

export function annotatableOf(
  node: Node | null,
): { el: HTMLElement; kind: AnnotatableKind; path?: string; scope?: string } | null {
  const start = node && node.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null)
  const el = start?.closest<HTMLElement>("[data-annotate]")
  if (!el) return null
  const kind = el.dataset.annotate
  if (kind !== "answer" && kind !== "code") return null
  const scope = el.closest<HTMLElement>("[data-annotate-scope]")?.dataset.annotateScope || undefined
  return { el, kind, path: el.dataset.annotatePath || undefined, scope }
}

/* ------------------------------------------------------------ text matching */

export interface NormalizedText {
  norm: string
  map: { node: Text; offset: number }[]
}

/** A node's selectable text with whitespace dropped, and where each character came from. */
export function normalize(root: Node): NormalizedText {
  const doc = root.ownerDocument ?? document
  const view = doc.defaultView
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element
        return view && element.isConnected && view.getComputedStyle(element).userSelect === "none"
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const parts: string[] = []
  const map: NormalizedText["map"] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = (node as Text).nodeValue ?? ""
    for (let at = 0; at < value.length; at++) {
      if (/\s/.test(value[at])) continue
      parts.push(value[at])
      map.push({ node: node as Text, offset: at })
    }
  }
  return { norm: parts.join(""), map }
}

/** A quote as it is compared: a trailing ellipsis and all whitespace gone. */
export function compact(text: string): string {
  return text.replace(/…+$/, "").replace(/\s+/g, "")
}

/** A selection as it is kept for a reply or code: whitespace folded, at most 280 characters. */
export function quoteOf(selected: string, max = 280): string {
  const folded = selected.replace(/\s+/g, " ").trim()
  return folded.length > max ? `${folded.slice(0, max - 1)}…` : folded
}

function nthIndex(norm: string, quote: string, occ: number): number {
  let at = -1
  for (let n = 0; n < occ; n++) {
    at = norm.indexOf(quote, at < 0 ? 0 : at + quote.length)
    if (at < 0) return -1
  }
  return at
}

function countOf(norm: string, quote: string): number {
  if (!quote) return 0
  let count = 0
  for (let at = norm.indexOf(quote); at >= 0; at = norm.indexOf(quote, at + quote.length)) count++
  return count
}

/** The quote's n-th occurrence in normalised text, as a range. */
export function locateIn(text: NormalizedText, quote: string, occ = 1): Range | null {
  const wanted = compact(quote)
  if (!wanted) return null
  const at = nthIndex(text.norm, wanted, occ)
  if (at < 0) return null
  const first = text.map[at]
  const last = text.map[at + wanted.length - 1]
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset + 1)
  return range
}

/** The quote's n-th occurrence in the block, as a range; nothing when it is no longer there. */
export function locate(root: Node, quote: string, occ = 1): Range | null {
  return locateIn(normalize(root), quote, occ)
}

function boxOf(range: Range): AnnotationRect | null {
  const rect = range.getBoundingClientRect()
  return !rect || (rect.width === 0 && rect.height === 0) ? null : { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
}

/* How far apart two boxes are, rows weighing far more than columns. */
function distance(a: AnnotationRect, b: AnnotationRect): number {
  const rows = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom))
  const columns = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right))
  return rows * 1000 + columns
}

/**
 * Which occurrence of the quote the selection is, of how many in the block:
 * the occurrence whose box lies nearest the selection's, or failing that the
 * count of occurrences before where the selection starts.
 */
export function occurrenceOf(root: HTMLElement, range: Range, quote: string): { occ: number; occTotal: number } {
  const wanted = compact(quote)
  if (!wanted) return { occ: 1, occTotal: 1 }
  const text = normalize(root)
  const total = countOf(text.norm, wanted)
  if (total <= 1) return { occ: 1, occTotal: Math.max(1, total) }
  const selected = boxOf(range)
  if (selected) {
    let best = 0
    let nearest = Infinity
    for (let n = 1; n <= total; n++) {
      const candidate = locateIn(text, wanted, n)
      const box = candidate && boxOf(candidate)
      if (!box) continue
      const gap = distance(selected, box)
      if (gap < nearest) {
        nearest = gap
        best = n
      }
    }
    if (best > 0) return { occ: best, occTotal: total }
  }
  const before = (root.ownerDocument ?? document).createRange()
  before.selectNodeContents(root)
  try {
    before.setEnd(range.startContainer, range.startOffset)
  } catch {
    return { occ: 1, occTotal: total }
  }
  return { occ: Math.min(total, countOf(normalize(before.cloneContents()).norm, wanted) + 1), occTotal: total }
}

/** A range's whole box. */
export function rectOf(range: Range): AnnotationRect | null {
  return boxOf(range)
}

/**
 * What MiMo places the annotation box against: the selection's first line -
 * the rects within 4px of where the selection starts - or its whole box.
 */
export function anchorRectOf(range: Range): AnnotationRect | null {
  const start = range.cloneRange()
  start.collapse(true)
  const startRects = [...start.getClientRects()].filter((rect) => rect.height >= 1)
  const origin = startRects.length ? startRects[0] : start.getBoundingClientRect()
  const top = origin ? origin.top : null
  const line = [...range.getClientRects()].filter(
    (rect) => rect.width >= 1 && rect.height >= 1 && (top === null || Math.abs(rect.top - top) <= 4),
  )
  if (!line.length) {
    return origin && (origin.width > 0 || origin.height > 0)
      ? { top: origin.top, left: origin.left, bottom: origin.bottom, right: origin.right }
      : boxOf(range)
  }
  let minTop = Infinity
  let minLeft = Infinity
  let maxBottom = -Infinity
  let maxRight = -Infinity
  for (const rect of line) {
    minTop = Math.min(minTop, rect.top)
    minLeft = Math.min(minLeft, rect.left)
    maxBottom = Math.max(maxBottom, rect.bottom)
    maxRight = Math.max(maxRight, rect.right)
  }
  return { top: minTop, left: minLeft, bottom: maxBottom, right: maxRight }
}

/* ------------------------------------------------------------------- jumps */

/* The nearest ancestor that scrolls, which is what a jump moves. */
export function scrollerOf(node: Node): HTMLElement | null {
  for (let el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && /^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY)) return el
  }
  return null
}

const FLASH = "mcode-annotation-flash"
let flashTimer: ReturnType<typeof setTimeout> | undefined

/**
 * MiMo's click on a chip: the passage it points at is scrolled to the middle
 * of its scroller and lit for 1.2s. Looked for in the box's own conversation -
 * the side chat's when the chip is in the side chat - latest block first; code
 * only while that file is open. False when it is not on screen.
 */
export function jumpToAnnotation(note: Annotation, origin: Element | null): boolean {
  if ((note.kind !== "answer" && note.kind !== "code") || !note.quote) return false
  const side = origin?.closest<HTMLElement>("[data-annotate-scope]") ?? null
  const blocks = [...(side ?? document).querySelectorAll<HTMLElement>(`[data-annotate="${note.kind}"]`)]
    .filter((el) => side || !el.closest("[data-annotate-scope]"))
    .filter((el) => note.kind !== "code" || el.dataset.annotatePath === note.path)
    .reverse()
  for (const el of blocks) {
    const range = locate(el, note.quote, note.occ)
    if (!range) continue
    const rect = range.getBoundingClientRect()
    const scroller = scrollerOf(range.startContainer)
    if (scroller && (rect.height > 0 || rect.width > 0)) {
      const box = scroller.getBoundingClientRect()
      scroller.scrollBy({ top: rect.top - box.top - box.height / 2 + rect.height / 2, behavior: "smooth" })
    }
    if (typeof CSS !== "undefined" && "highlights" in CSS) {
      CSS.highlights.set(FLASH, new Highlight(range))
      clearTimeout(flashTimer)
      flashTimer = setTimeout(() => CSS.highlights.delete(FLASH), 1200)
    }
    return true
  }
  return false
}
