import { ref, type Ref } from "vue"

/**
 * Find-in-view: Ctrl+F opens a bar over what is on screen, Ctrl+G steps the
 * matches, and the matches are painted by the browser rather than by rewriting
 * the DOM.
 *
 * A transcription of the reference's `createFileFind` and its shortcut
 * installer (main-8t-QUXax.js @1269700-@1276000). Everything structural is
 * copied: a module-level set of hosts, one `current` host that owns the
 * keyboard, a `target` remembered from the last pointer or focus, the CSS
 * Custom Highlight API with a DOM overlay fallback, and Enter/Shift+Enter
 * stepping from inside the input.
 *
 * ONE DELIBERATE DIFFERENCE, and it is worth being loud about. The reference
 * mounts this on its FILE and DIFF viewers and nowhere else - `createFileFind`
 * has exactly one caller, `useFileViewer`, and the bar is drawn by
 * `ViewerShell` (@1407673) - and its scan looks only at code-viewer lines
 * (`[data-content] [data-line], [data-column-content]`). Those viewers live in
 * this app in FilePanel.vue and ReviewPatch.vue, neither of which this parcel
 * owns, so the host here is mounted over the session pane instead and the scan
 * is generic: every text node under the root, in document order. Mounting a
 * second host over the viewers is two lines in each of those files and is
 * handed back rather than done from here.
 */

export interface FindHost {
  element(): HTMLElement | undefined
  isOpen(): boolean
  open(): void
  close(): void
  next(direction: number): void
}

/*
 * Module state, exactly the reference's three variables: every mounted host,
 * the one that currently owns Ctrl+G, and the one a pointer or a focus last
 * touched - which is what Ctrl+F falls back to when the event target is not
 * inside any host.
 */
const hosts = new Set<FindHost>()
let current: FindHost | undefined
let target: FindHost | undefined

/**
 * The highlight registry names.
 *
 * The reference registers `opencode-find` and `opencode-find-current`; a
 * replica names its own, because these are global registry keys and two
 * applications' highlights would otherwise be the same entry.
 */
const PAINT_ALL = "mcode-find"
const PAINT_CURRENT = "mcode-find-current"

/** Its `isEditable`: a chord aimed at a text field is not aimed at us. */
function isEditable(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false
  if (node.closest("[data-prevent-autofocus]")) return true
  if (node.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(node.tagName)
}

function hostForNode(node: EventTarget | null): FindHost | undefined {
  if (!(node instanceof Node)) return undefined
  for (const host of hosts) {
    const element = host.element()
    if (element && element.isConnected && element.contains(node)) return host
  }
  return undefined
}

function supportsHighlights(): boolean {
  const scope = globalThis as { Highlight?: unknown; CSS?: { highlights?: unknown } }
  return typeof scope.Highlight === "function" && scope.CSS?.highlights != null
}

function highlightRegistry(): (Map<string, unknown> & { delete(key: string): boolean }) | undefined {
  return (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights
}

function clearPainted(): void {
  const registry = highlightRegistry()
  if (!registry) return
  registry.delete(PAINT_ALL)
  registry.delete(PAINT_CURRENT)
}

/**
 * Opens find over whatever the user is looking at.
 *
 * The reference's `key === "f"` arm, in order: an already-open bar takes the
 * chord and re-focuses itself, otherwise the host containing the focused
 * element wins, then the host containing the event target, then the last host
 * touched, then any host at all. Returns false when nothing took it, which is
 * what lets the caller fall back to its own Ctrl+F - the reference gets the
 * same effect by not calling `preventDefault`.
 */
export function openFind(event?: Event): boolean {
  // A chord typed into a text field belongs to that field.
  if (isEditable(event?.target ?? null) || isEditable(document.activeElement)) return false
  if (current?.isOpen()) {
    current.open()
    return true
  }
  const host =
    hostForNode(document.activeElement) ??
    hostForNode(event?.target ?? null) ??
    target ??
    [...hosts][0]
  if (!host) return false
  host.open()
  return true
}

/**
 * Which text node an absolute offset falls in, and where inside it.
 *
 * `ends[i]` is the running total THROUGH node i, so node i covers the half-open
 * span [ends[i-1], ends[i]) and the node holding `offset` is the first whose
 * end is strictly past it. Written `>=` instead of `>`, an offset landing
 * exactly on a boundary is given to the node BEFORE it at an offset equal to
 * that node's whole length - and `scan` then asks for `offset + 1`, one past
 * the end. Measured in the running app: `setEnd` threw
 * `IndexSizeError: The offset 12 is larger than the node's length (11)` and
 * took the whole renderer down with it the moment a needle matched across a
 * node boundary.
 *
 * Exported because it is pure arithmetic and the defect was pure arithmetic:
 * nothing about it needs a browser, so nothing about testing it should.
 */
export function locateOffset(ends: number[], offset: number): { index: number; offset: number } {
  let low = 0
  let high = ends.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (ends[middle] > offset) high = middle
    else low = middle + 1
  }
  const before = low === 0 ? 0 : ends[low - 1]
  return { index: low, offset: offset - before }
}

export interface FindOptions {
  /** The element the bar belongs to, and the region a pointer can claim. */
  wrapper: () => HTMLElement | undefined
  /** What to search. Defaults to the wrapper. */
  root?: () => HTMLElement | undefined
  /**
   * Matches in content that is folded away and so not in the DOM - MiMo counts
   * them into the total and says how many are not shown.
   */
  hidden?: (needle: string) => number
}

export interface Find {
  open: Ref<boolean>
  query: Ref<string>
  index: Ref<number>
  count: Ref<number>
  /** Matches inside folded content, not stepped to. */
  hidden: Ref<number>
  setQuery(value: string): void
  focus(): void
  close(): void
  next(direction: number): void
  refresh(options?: { reset?: boolean; scroll?: boolean }): void
  onInputKeydown(event: KeyboardEvent): void
  onPointerDown(): void
  setInput(element: HTMLInputElement | undefined): void
  mount(): void
  unmount(): void
}

export function createFind(options: FindOptions): Find {
  const open = ref(false)
  const query = ref("")
  const index = ref(0)
  const count = ref(0)
  const hidden = ref(0)

  let input: HTMLInputElement | undefined
  let hits: Range[] = []
  let overlay: HTMLDivElement | undefined
  let mode: "highlights" | "overlay" = "overlay"

  const root = () => options.root?.() ?? options.wrapper()

  /**
   * Every match in the region, as ranges over the live DOM.
   *
   * One index over every text node under the root rather than one per line,
   * which is how a match that runs across a `<strong>` or a syntax-highlighted
   * span is still found. The cost is that two adjacent blocks read as one
   * string, so a needle spanning the end of one paragraph and the start of the
   * next can match; that is the same compromise the reference makes inside a
   * column, one level coarser.
   */
  function scan(within: HTMLElement, needle: string): Range[] {
    const nodes: Text[] = []
    const ends: number[] = []
    let total = 0
    const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = (node as Text).parentElement
        if (!parent) return NodeFilter.FILTER_REJECT
        // Script and style hold text that is never on screen, and anything
        // marked skip is chrome rather than content.
        if (parent.closest("script, style, [data-find-skip]")) return NodeFilter.FILTER_REJECT
        return (node as Text).data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })
    let node = walker.nextNode()
    let text = ""
    while (node) {
      const item = node as Text
      text += item.data
      total += item.data.length
      nodes.push(item)
      ends.push(total)
      node = walker.nextNode()
    }
    if (!nodes.length) return []

    const locate = (offset: number) => {
      const found = locateOffset(ends, offset)
      return { node: nodes[found.index], offset: found.offset }
    }

    const hay = text.toLowerCase()
    const ranges: Range[] = []
    let at = hay.indexOf(needle)
    while (at !== -1) {
      const start = locate(at)
      // The end offset lands on the boundary, so it is located one character
      // in and stepped back - otherwise a match ending exactly at a node's
      // last character would be placed at the start of the next one.
      const end = locate(at + needle.length - 1)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset + 1)
      ranges.push(range)
      at = hay.indexOf(needle, at + needle.length)
    }
    return ranges
  }

  function paint(ranges: Range[], at: number): boolean {
    const registry = highlightRegistry()
    const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
    if (!registry || typeof Highlight !== "function") return false
    registry.delete(PAINT_ALL)
    registry.delete(PAINT_CURRENT)
    const active = ranges[at]
    if (active) registry.set(PAINT_CURRENT, new Highlight(active))
    const rest = ranges.filter((_range, position) => position !== at)
    if (rest.length > 0) registry.set(PAINT_ALL, new Highlight(...rest))
    return true
  }

  /**
   * The fallback the reference keeps for a browser without the highlight API:
   * one absolutely positioned box per match rectangle, over the wrapper.
   *
   * Created here rather than asked for as a slot, so that mounting a find host
   * costs a component and a ref and nothing else in the host's markup.
   */
  function overlayElement(): HTMLDivElement | undefined {
    const wrapper = options.wrapper()
    if (!wrapper) return undefined
    if (overlay?.isConnected) return overlay
    overlay = document.createElement("div")
    overlay.dataset.findSkip = "true"
    overlay.style.cssText = "position:absolute;inset:0;z-index:40;pointer-events:none"
    wrapper.appendChild(overlay)
    return overlay
  }

  function clearOverlay(): void {
    if (overlay) overlay.innerHTML = ""
  }

  function dropOverlay(): void {
    overlay?.remove()
    overlay = undefined
  }

  function renderOverlay(): void {
    const wrapper = options.wrapper()
    const host = overlayElement()
    if (!wrapper || !host) return
    host.innerHTML = ""
    if (!hits.length) return
    const base = wrapper.getBoundingClientRect()
    const fragment = document.createDocumentFragment()
    for (let position = 0; position < hits.length; position += 1) {
      const active = position === index.value
      for (const rect of Array.from(hits[position].getClientRects())) {
        const box = document.createElement("div")
        box.style.cssText =
          `position:absolute;left:${rect.left - base.left}px;top:${rect.top - base.top}px;` +
          `width:${rect.width}px;height:${rect.height}px;border-radius:2px;` +
          `background:${active ? "var(--find-current)" : "var(--find-match)"}`
        fragment.appendChild(box)
      }
    }
    host.appendChild(fragment)
  }

  function scrollTo(range: Range): void {
    const start = range.startContainer
    const element = start instanceof Element ? start : start.parentElement
    element?.scrollIntoView({ block: "center", inline: "center" })
  }

  function clear(): void {
    hits = []
    count.value = 0
    hidden.value = 0
    index.value = 0
    clearPainted()
    clearOverlay()
  }

  function refresh(args?: { reset?: boolean; scroll?: boolean }): void {
    if (!open.value) return
    const needle = query.value.trim().toLowerCase()
    if (!needle) {
      clear()
      return
    }
    const within = root()
    if (!within) return
    mode = supportsHighlights() ? "highlights" : "overlay"
    const ranges = scan(within, needle)
    const desired = args?.reset ? 0 : index.value
    const at = ranges.length ? Math.min(desired, ranges.length - 1) : 0
    hits = ranges
    count.value = ranges.length
    hidden.value = options.hidden?.(needle) ?? 0
    index.value = at
    const active = ranges[at]
    if (mode === "highlights") {
      clearOverlay()
      dropOverlay()
      if (!paint(ranges, at)) {
        mode = "overlay"
        clearPainted()
        renderOverlay()
      }
      if (args?.scroll && active) scrollTo(active)
      return
    }
    clearPainted()
    if (args?.scroll && active) scrollTo(active)
    renderOverlay()
  }

  function next(direction: number): void {
    if (!open.value) return
    if (count.value <= 0) return
    index.value = (index.value + direction + count.value) % count.value
    const active = hits[index.value]
    if (!active) return
    if (mode === "highlights") {
      if (!paint(hits, index.value)) {
        mode = "overlay"
        refresh({ reset: true, scroll: true })
        return
      }
      scrollTo(active)
      return
    }
    scrollTo(active)
    renderOverlay()
  }

  const host: FindHost = {
    element: () => options.wrapper(),
    isOpen: () => open.value,
    open: () => focus(),
    close: () => close(),
    next,
  }

  function focus(): void {
    // Only one bar at a time, the reference's rule: opening a second closes the
    // first, so the highlights on screen always belong to the bar being typed
    // into.
    if (current && current !== host) current.close()
    current = host
    target = host
    if (!open.value) open.value = true
    requestAnimationFrame(() => {
      refresh({ scroll: true })
      input?.focus()
      input?.select()
    })
  }

  function close(): void {
    open.value = false
    query.value = ""
    clear()
    dropOverlay()
    if (current === host) current = undefined
  }

  return {
    open,
    query,
    index,
    count,
    hidden,
    setQuery(value: string) {
      query.value = value
      index.value = 0
      refresh({ reset: true, scroll: true })
    },
    focus,
    close,
    next,
    refresh,
    onInputKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        close()
        return
      }
      // Enter that confirms an input method's candidate is not a step, as in MiMo.
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      next(event.shiftKey ? -1 : 1)
    },
    onPointerDown() {
      target = host
    },
    setInput(element) {
      input = element
    },
    mount() {
      hosts.add(host)
      if (!target) target = host
    },
    unmount() {
      hosts.delete(host)
      if (current === host) {
        current = undefined
        clearPainted()
      }
      if (target === host) target = undefined
      dropOverlay()
    },
  }
}
