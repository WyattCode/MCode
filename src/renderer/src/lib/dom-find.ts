import { locateOffset } from "./find"

/*
 * Finding text in whatever a viewer has drawn, MiMo's domFind: ranges over the
 * live text nodes painted with the CSS Custom Highlight API, so rendered
 * markdown and coloured code stay exactly as they are while they are searched.
 */

type Registry = Map<string, unknown>

function registry(): Registry | undefined {
  return (globalThis as { CSS?: { highlights?: Registry } }).CSS?.highlights
}

/* Every case-insensitive match under `root`, skipping anything marked `data-find-skip`. */
export function textRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const nodes: Text[] = []
  const ends: number[] = []
  let text = ""
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest("[data-find-skip], script, style")) return NodeFilter.FILTER_REJECT
      return (node as Text).data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const item = node as Text
    nodes.push(item)
    text += item.data
    ends.push(text.length)
  }
  const hay = text.toLowerCase()
  const ranges: Range[] = []
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    const first = locateOffset(ends, at)
    const last = locateOffset(ends, at + needle.length - 1)
    const range = document.createRange()
    range.setStart(nodes[first.index]!, first.offset)
    range.setEnd(nodes[last.index]!, last.offset + 1)
    ranges.push(range)
  }
  return ranges
}

/* Paints every match under one name and the current one under another. */
export function paintRanges(all: string, current: string, ranges: Range[], index: number): void {
  const found = registry()
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (!found || typeof Highlight !== "function") return
  const rest = ranges.filter((_range, position) => position !== index)
  if (rest.length) found.set(all, new Highlight(...rest))
  else found.delete(all)
  const active = ranges[index]
  if (active) found.set(current, new Highlight(active))
  else found.delete(current)
}

export function clearPaint(...names: string[]): void {
  const found = registry()
  for (const name of names) found?.delete(name)
}

/* MiMo's centring: the match to the middle of the nearest scrolling ancestor. */
export function centreRange(range: Range): void {
  const start = range.startContainer
  const element = start instanceof Element ? start : start.parentElement
  if (!(element instanceof HTMLElement)) return
  const rect = range.getBoundingClientRect()
  let scroller: HTMLElement | null = null
  if (rect.width !== 0 || rect.height !== 0) {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY
      if ((overflow === "auto" || overflow === "scroll") && parent.scrollHeight > parent.clientHeight + 1) {
        scroller = parent
        break
      }
    }
  }
  if (!scroller) {
    element.scrollIntoView({ block: "center" })
    return
  }
  const box = scroller.getBoundingClientRect()
  scroller.scrollTop += rect.top - box.top - (box.height - rect.height) / 2
}
