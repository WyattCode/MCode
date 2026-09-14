import { shallowRef } from "vue"
import type { Annotation } from "@shared/protocol"

/*
 * Where MiMo's annotation box is asked for, and the text arithmetic behind it.
 *
 * What can be annotated says so in the markup: `data-annotate="answer"` on a
 * reply's text, `data-annotate="code"` (with `data-annotate-path`) on the files
 * tab's code. Inside `data-annotate-scope` - the side chat - they belong to that
 * box rather than the main one, as MiMo keeps each box's annotations apart.
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

/** Asks the box that holds this scope's annotations to send its message now. */
export const annotationSend = shallowRef<{ scope: string; seq: number } | null>(null)

export function requestAnnotationSend(scope: string) {
  annotationSend.value = { scope, seq: (annotationSend.value?.seq ?? 0) + 1 }
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

/*
 * A block's text with every run of whitespace folded to one space, and for
 * each character kept, the text node and offset it came from - so a quote can
 * be found again after the reply has been re-rendered, and turned back into a
 * range on screen.
 */
function folded(root: Node): { text: string; map: { node: Text; offset: number }[] } {
  const parts: string[] = []
  const map: { node: Text; offset: number }[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let lastSpace = true
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.data
    for (let at = 0; at < value.length; at++) {
      const space = /\s/.test(value[at])
      if (space && lastSpace) continue
      parts.push(space ? " " : value[at])
      map.push({ node, offset: at })
      lastSpace = space
    }
  }
  return { text: parts.join(""), map }
}

function occurrences(text: string, quote: string): number[] {
  const found: number[] = []
  if (!quote) return found
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) found.push(at)
  return found
}

/** Which occurrence of the quote the selection is, of how many in the block. */
export function occurrenceOf(root: HTMLElement, range: Range, quote: string): { occ: number; occTotal: number } {
  const { text } = folded(root)
  const found = occurrences(text, quote)
  if (found.length <= 1) return { occ: 1, occTotal: Math.max(1, found.length) }
  const before = document.createRange()
  before.setStart(root, 0)
  before.setEnd(range.startContainer, range.startOffset)
  const lead = folded(before.cloneContents()).text.length
  const index = found.findIndex((at) => at >= lead - 1)
  return { occ: index < 0 ? found.length : index + 1, occTotal: found.length }
}

/** The quote's n-th occurrence in the block, as a range; nothing when it is no longer there. */
export function locate(root: HTMLElement, quote: string, occ = 1): Range | null {
  const { text, map } = folded(root)
  const found = occurrences(text, quote)
  const at = found[Math.min(Math.max(occ, 1), found.length) - 1]
  if (at === undefined) return null
  const first = map[at]
  const last = map[at + quote.length - 1]
  const range = document.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset + 1)
  return range
}

/** A range's box, or the box of its last line when it wraps. */
export function rectOf(range: Range): AnnotationRect | null {
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0)
  const box = rects.length ? range.getBoundingClientRect() : null
  return box && (box.width > 0 || box.height > 0) ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null
}
