<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist"
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import type { Annotation } from "@shared/protocol"
import { collapse } from "@shared/annotations"
import { useApp } from "../../stores/app"
import { useAnnotations } from "../../stores/annotations"
import { useAnnotationBatch } from "../../stores/annotation-batch"
import { annotationFlash, annotationId, compact, mainAnnotationScope, normalize, pdfLocate } from "../../lib/annotate"
import { useOfficeVersions } from "../../stores/office-versions"
import { aiTouch } from "../../lib/ai-touch"
import { splitFilePath } from "../../lib/file-path"
import { sendAnnotationNow } from "../../lib/annotation-send"
import { useAnnotationFx, type FxBox } from "../../lib/annotation-fx"
import { notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"
import { dialogOpen } from "../../lib/escape-layer"
import { PdfLinkService, namedActionPage, pdfLinkAction, resolveDestination } from "../../lib/pdf-links"
import CellAffordance from "../CellAffordance.vue"
import AnnotationFx from "../AnnotationFx.vue"
import ViewerAiNote from "./ViewerAiNote.vue"

/**
 * MiMo's PDF view.
 *
 * Pages are white sheets 12 apart, 16 in, all as wide as the view less 32
 * times the zoom (0.5 to 3, in tenths); page heights follow each page's shape
 * (the first page's until the rest are measured), and only the pages within a
 * screen of the view are drawn. A pill at the bottom end holds zoom out, the
 * percentage, zoom in, fit width and "page / pages"; the current page is the
 * first whose foot is past a third of the view.
 *
 * Selecting text opens the note box at the pointer. Its arrow sends the
 * annotation at once (and the passage keeps a frame, lit while the reply
 * runs); "add to chat" puts it in the box, framed and numbered. A chip click
 * flashes the frame; a sent message's chip finds the passage again, marked in
 * amber. Escape clears what was sent from here. The file reloads when it
 * changes on disk, keeping its place.
 *
 * Over each drawn page lies pdf.js's annotation layer, as react-pdf lays it
 * over MiMo's: links, highlight and note popups, attachments; form fields stay
 * painted on the canvas (renderForms off). A link to the web goes out through
 * the app's external-open path; one into the document scrolls to its place.
 */
const props = withDefaults(defineProps<{ path: string; name: string; root?: string; origin?: string; active?: boolean }>(), {
  root: undefined,
  origin: undefined,
  active: true,
})
const versions = useOfficeVersions()
const app = useApp()
const annotations = useAnnotations()
const batch = useAnnotationBatch()

const PAD = 16
const GAP = 12
const ALIGN_MS = 3000
const BADGE = 15
const BADGE_EDGE = 6

type PdfJs = typeof import("pdfjs-dist")
let loadingLibrary: Promise<PdfJs> | undefined
function library(): Promise<PdfJs> {
  loadingLibrary ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl
    return lib
  })
  return loadingLibrary
}

const assets = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href

const rootEl = ref<HTMLElement>()
const scroller = ref<HTMLElement>()
const pagesEl = ref<HTMLElement>()
const layerEls: (HTMLElement | undefined)[] = []

let lastBase64 = ""
const splitPath = () => splitFilePath(props.path)
/* The watcher answers with whichever spelling it was asked with; slashes and case still name one file. */
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase()
const doc = shallowRef<PDFDocumentProxy>()
const count = ref(0)
const ratios = ref<number[]>([])
const sizes: Record<number, { w: number; h: number }> = {}
const width = ref(0)
const zoom = ref(1)
const visible = ref<[number, number]>([0, -1])
const current = ref(1)
const loading = ref(true)
const restoring = ref(false)
const failure = ref<string | null>(null)

const pageWidth = computed(() => Math.max(1, Math.round(width.value * zoom.value)))
const heights = computed(() => ratios.value.map((ratio) => Math.max(1, Math.round(pageWidth.value * (ratio > 0 && Number.isFinite(ratio) ? ratio : 1.414)))))
const tops = computed(() => {
  const out: number[] = []
  let top = PAD
  for (const height of heights.value) {
    out.push(top)
    top += height + GAP
  }
  return out
})

/* ------------------------------------------------------------ loading */

let generation = 0
let task: PDFDocumentLoadingTask | undefined
let saved: { path: string; top: number } | null = null
let stopRestore: (() => void) | undefined

function fail(err: unknown) {
  // As MiMo: the exception's name stays in front of its message ("PasswordException: No password given").
  failure.value = t("rp.pdf.failed", { err: String(err).slice(0, 120) })
  loading.value = false
  if (scroller.value) scroller.value.style.visibility = ""
  restoring.value = false
}

function release() {
  for (const state of drawn.values()) {
    state.canvas?.cancel()
    state.text?.cancel()
  }
  drawn.clear()
  for (const layer of layerEls) layer?.replaceChildren()
  const old = doc.value
  doc.value = undefined
  void task?.destroy()
  task = undefined
  void old?.destroy()
}

async function load() {
  const mine = ++generation
  // The last load's restore loop stops here, or two of them would fight over scrollTop after two writes in a row.
  stopRestore?.()
  stopRestore = undefined
  if (saved && saved.path === props.path && saved.top > 0) {
    restoring.value = true
    if (scroller.value) scroller.value.style.visibility = "hidden"
  }
  failure.value = null
  loading.value = true
  hideNote()
  locateRange = null
  locateRects.value = []
  release()
  count.value = 0
  ratios.value = []
  for (const key of Object.keys(sizes)) delete sizes[Number(key)]
  visible.value = [0, -1]
  current.value = 1
  // Every load returns to 100%, as MiMo's does after a write, an outside change, undo or a restore (the user's choice).
  zoom.value = 1
  try {
    /*
     * The bytes come off the local preview server rather than through an IPC
     * read (R17-V4). The read caps a document at 25MB, which shut out the very
     * files a reader most wants a viewer for - a scanned report, a printed
     * book - while MiMo, which fetches its own scheme, opens them; and pdf.js
     * asks the server for the ranges it needs instead of holding the whole
     * file twice over in base64 and in an array.
     */
    const [lib, served] = await Promise.all([library(), window.mcode.officeServe(props.path)])
    if (mine !== generation) return
    if (!served.ok) return fail(served.error === "missing" ? t("office.fileMissing") : t("rp.files.errCannotRead"))
    task = lib.getDocument({
      url: served.url,
      cMapUrl: assets("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: assets("standard_fonts"),
      wasmUrl: assets("wasm"),
      iccUrl: assets("iccs"),
      isEvalSupported: false,
    })
    const pdf = await task.promise
    if (mine !== generation) return void pdf.destroy()
    void firstVersion()
    await loaded(pdf, mine)
  } catch (err) {
    if (mine === generation) fail(err)
  }
}

/*
 * The file as opened becomes the first version (or the next, when it changed
 * while closed), so undo and history have something to hold.
 *
 * The store keeps whole copies, so it still reads the bytes over IPC and still
 * stops at the document limit: a document too large to version is shown all
 * the same, with nothing behind undo until it is written to.
 */
async function firstVersion() {
  const [dir, base] = splitPath()
  const read = await window.mcode.readFileBytes(dir, base).catch(() => undefined)
  if (!read?.ok || read.unchanged) return
  lastBase64 = read.base64
  const { ai, prompt } = aiTouch(props.path, 60_000)
  await versions.init(props.path, read.base64, { assumeAi: ai, note: ai ? prompt.trim() : t("office.versionNoteExternal") })
}

async function loaded(pdf: PDFDocumentProxy, mine: number) {
  try {
    const first = (await pdf.getPage(1)).getViewport({ scale: 1 })
    if (mine !== generation) return
    doc.value = pdf
    sizes[1] = { w: first.width, h: first.height }
    ratios.value = Array(pdf.numPages).fill(first.height / first.width)
    count.value = pdf.numPages
    loading.value = false
    await nextTick()
    const top = saved && saved.path === props.path && saved.top > 0 ? saved.top : null
    saved = null
    if (top !== null && scroller.value) stopRestore = restoreScroll(scroller.value, top)
    if (restoring.value) {
      setTimeout(() => {
        if (scroller.value) scroller.value.style.visibility = ""
        restoring.value = false
      }, 16)
    }
    measure()
    refreshMarks()
    const next: number[] = []
    for (let number = 1; number <= pdf.numPages; number++) {
      const viewport = (await pdf.getPage(number)).getViewport({ scale: 1 })
      if (mine !== generation) return
      sizes[number] = { w: viewport.width, h: viewport.height }
      next.push(viewport.height / viewport.width)
    }
    ratios.value = next
  } catch (err) {
    if (mine === generation) fail(err)
  }
}

/* Puts the view back where it was, frame by frame while the pages grow, unless the reader scrolls first. */
function restoreScroll(el: HTMLElement, target: number): () => void {
  let stopped = false
  let frames = 0
  let last = -1
  let timer: ReturnType<typeof setTimeout> | undefined
  const step = () => {
    if (stopped || (last >= 0 && Math.abs(el.scrollTop - last) > 8)) return
    el.scrollTop = target
    last = el.scrollTop
    frames += 1
    if (last >= target - 1 || frames >= 60) return
    timer = setTimeout(step, 16)
  }
  timer = setTimeout(step, 16)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

function reload() {
  if (scroller.value) saved = { path: props.path, top: scroller.value.scrollTop }
  void load()
}

/* A change on disk becomes a version - the assistant's when it touched the file - and the view reloads. */
async function onDiskChange() {
  const { ai, prompt } = aiTouch(props.path)
  try {
    const [dir, base] = splitPath()
    const read = await window.mcode.readFileBytes(dir, base)
    if (read.ok && !read.unchanged && read.base64 !== lastBase64) {
      lastBase64 = read.base64
      await versions.record(props.path, read.base64, ai ? "ai_local" : "external", ai ? prompt.trim() : t("office.versionNoteExternal"))
    }
  } catch (err) {
    console.error("[PdfView] fs-watch record error:", err)
  }
  reload()
}

watch(
  () => props.path,
  (next, previous) => {
    if (previous) void window.mcode.unwatchFile(previous)
    void window.mcode.watchFile(next)
    void load()
  },
)
watch(
  () => versions.reloadTick[props.path] ?? 0,
  (tick, before) => {
    if (tick !== before) reload()
  },
)

/* ------------------------------------------------------------ drawing */

interface Drawn {
  scale: number
  canvas?: RenderTask
  text?: TextLayer
}
const drawn = new Map<number, Drawn>()

async function draw(index: number) {
  const pdf = doc.value
  const layer = layerEls[index]
  if (!pdf || !layer) return
  const lib = await library()
  const page = await pdf.getPage(index + 1)
  const base = page.getViewport({ scale: 1 })
  const scale = pageWidth.value / base.width
  const previous = drawn.get(index)
  if (previous && Math.abs(previous.scale - scale) < 1e-6) return
  previous?.canvas?.cancel()
  previous?.text?.cancel()
  const state: Drawn = { scale }
  drawn.set(index, state)
  const viewport = page.getViewport({ scale })
  const ratio = window.devicePixelRatio || 1
  const canvas = document.createElement("canvas")
  canvas.className = "pdf-canvas"
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  state.canvas = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
  const text = document.createElement("div")
  text.className = "textLayer"
  state.text = new lib.TextLayer({
    textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
    container: text,
    viewport,
  })
  const notes = document.createElement("div")
  notes.className = "annotationLayer"
  try {
    const [annotations] = await Promise.all([page.getAnnotations({ intent: "display" }), state.canvas.promise, state.text.render()])
    if (drawn.get(index) !== state) return
    /*
     * react-pdf's call, as MiMo makes it: the viewport unflipped, no editor,
     * accessibility or struct tree, forms left on the canvas. The icons of
     * note annotations come from pdf.js's own images, copied beside the page.
     */
    const flat = viewport.clone({ dontFlip: true })
    await new lib.AnnotationLayer({
      div: notes,
      accessibilityManager: null,
      annotationCanvasMap: null,
      annotationEditorUIManager: null,
      page,
      viewport: flat,
      structTreeLayer: null,
      commentManager: null,
      linkService,
      annotationStorage: pdf.annotationStorage,
    }).render({
      annotations,
      annotationStorage: pdf.annotationStorage,
      div: notes,
      imageResourcesPath: assets("images"),
      linkService,
      page,
      renderForms: false,
      viewport: flat,
    } as unknown as Parameters<InstanceType<PdfJs["AnnotationLayer"]>["render"]>[0])
  } catch {
    return // cancelled by a newer drawing, or the document went away
  }
  if (drawn.get(index) !== state) return
  /*
   * react-pdf's end marker, which pdf.js's TextLayer does not add: while a drag
   * is under way it covers the blanks between lines and past the last glyph,
   * so the selection grows smoothly instead of snapping to the layer's start.
   */
  const end = document.createElement("div")
  end.className = "endOfContent"
  text.append(end)
  layer.style.setProperty("--scale-factor", String(scale))
  // A page with a /UserUnit is that many times larger than its points say; the layers size themselves by both, as react-pdf's page sets them.
  layer.style.setProperty("--user-unit", String(viewport.userUnit))
  layer.replaceChildren(canvas, text, notes)
  refreshMarks()
}

let drawTimer: ReturnType<typeof setTimeout> | undefined
function scheduleDraw() {
  clearTimeout(drawTimer)
  drawTimer = setTimeout(() => {
    const [from, to] = visible.value
    for (const index of [...drawn.keys()]) {
      if (index >= from && index <= to) continue
      const state = drawn.get(index)
      state?.canvas?.cancel()
      state?.text?.cancel()
      drawn.delete(index)
      layerEls[index]?.replaceChildren()
    }
    for (let index = from; index <= to; index++) void draw(index)
  }, 16)
}

/* The pages drawn: those within a screen above and below the view. */
function measure() {
  const el = scroller.value
  const list = heights.value
  if (!el || !list.length) return
  const top = el.scrollTop
  const view = el.clientHeight
  const from = top - view
  const to = top + view + view
  let first = 0
  while (first < list.length - 1 && tops.value[first] + list[first] <= from) first++
  let last = first
  while (last < list.length - 1 && tops.value[last + 1] < to) last++
  visible.value = [first, last]
  const line = top + view / 3
  const index = list.findIndex((height, at) => tops.value[at] + height > line)
  current.value = index < 0 ? list.length : index + 1
}

watch([heights, tops], () => {
  measure()
  realign()
})
watch([visible, pageWidth, doc], scheduleDraw)

/* ------------------------------------------------------------ scrolling */

let align: { page: number; until: number } | null = null
let programmaticAt = 0

function scrollToTop(el: HTMLElement, top: number) {
  programmaticAt = Date.now()
  el.scrollTo({ top })
}

/* While a found passage is being brought into view, its page top stays 4px below the view top as heights settle. */
function realign() {
  const target = align
  const el = scroller.value
  if (!target || !el || Date.now() > target.until) return
  const pageEl = rootEl.value?.querySelector<HTMLElement>(`[data-pdf-page="${target.page}"]`)
  if (!pageEl) return
  const offset = pageEl.getBoundingClientRect().top - el.getBoundingClientRect().top + 4
  if (Math.abs(offset) > 2) scrollToTop(el, Math.max(0, el.scrollTop + offset))
  measure()
}

let scrollTimer: ReturnType<typeof setTimeout> | undefined
function onScroll() {
  if (Date.now() - programmaticAt > 200) align = null
  if (scrollTimer) return
  scrollTimer = setTimeout(() => {
    scrollTimer = undefined
    measure()
    if (locateRange) locateRects.value = rectsOf(locateRange)
    refreshMarks()
  }, 16)
}

const stopAlign = () => {
  align = null
}

const resizer = new ResizeObserver(() => {
  const el = scroller.value
  if (!el) return
  width.value = Math.max(0, el.clientWidth - PAD * 2)
  onScroll()
})

function setZoom(next: number) {
  zoom.value = Math.min(Math.max(Math.round(next * 10) / 10, 0.5), 3)
}

/*
 * Links go out only to the web, mail and phone, through the app's external
 * path. The "#" ones pdf.js bound to a destination or a named action reach
 * their own click handler, which moves within the document.
 */
function onLinkClick(event: MouseEvent) {
  const link = (event.target as Element | null)?.closest?.("a[href]")
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute("href") || ""
  const action = pdfLinkAction(href)
  if (action === "internal") return
  event.stopPropagation()
  if (action === "external") window.mcode.openExternal(href)
}

/* A destination's page and point, brought to the top of the view as pdf.js's viewer brings it. */
async function goToDestination(dest: unknown) {
  const pdf = doc.value
  const el = scroller.value
  if (!pdf || !el) return
  const mine = generation
  const target = await resolveDestination(pdf, dest)
  if (!target || mine !== generation || doc.value !== pdf) return
  const top = tops.value[target.pageIndex]
  const height = heights.value[target.pageIndex]
  if (top === undefined || height === undefined) return
  let offset = 0
  if (target.top !== null) {
    const page = await pdf.getPage(target.pageIndex + 1).catch(() => null)
    if (!page || mine !== generation) return
    const base = page.getViewport({ scale: 1 })
    const [, y] = page.getViewport({ scale: pageWidth.value / base.width }).convertToViewportPoint(target.left ?? 0, target.top)
    offset = Math.min(Math.max(y, 0), height)
  }
  hideNote()
  align = null
  scrollToTop(el, Math.max(0, Math.round(top + offset)))
}

function goToPage(number: number) {
  const el = scroller.value
  const top = tops.value[number - 1]
  if (!el || top === undefined) return
  hideNote()
  align = null
  scrollToTop(el, Math.max(0, top))
}

const linkService = new PdfLinkService({
  goTo: (dest) => void goToDestination(dest),
  named: (action) => {
    const page = namedActionPage(action, current.value, count.value)
    if (page !== null) goToPage(page)
  },
})

/* ------------------------------------------------------------ rects and marks */

interface Box {
  left: number
  top: number
  w: number
  h: number
}

function rectsOf(range: Range): Box[] {
  const origin = rootEl.value?.getBoundingClientRect()
  if (!origin) return []
  const out: Box[] = []
  for (const rect of range.getClientRects()) {
    if (rect.width < 2 || rect.height < 2) continue
    out.push({ left: rect.left - origin.left, top: rect.top - origin.top, w: rect.width, h: rect.height })
    if (out.length >= 80) break
  }
  return out
}

interface Kept {
  range: Range | null
  page: number
  text: string
  occ: number
}
/* Ranges of the passages annotated from this view, found again from their text when a page is redrawn. */
const kept = new Map<string, Kept>()

function spansOf(page: number): HTMLElement[] {
  const layer = rootEl.value?.querySelector(`[data-pdf-page="${page}"] .textLayer`)
  return layer ? [...layer.querySelectorAll<HTMLElement>("span")].filter((span) => span.firstChild?.nodeType === Node.TEXT_NODE) : []
}

/* A snippet's place across a page's text spans: whitespace folded to single spaces between words, exact first, then ignoring case. */
function findInSpans(texts: string[], snippet: string, occ = 1): { start: { span: number; offset: number }; end: { span: number; offset: number } } | null {
  const wanted = snippet.replace(/\s+/g, " ").trim()
  if (!wanted) return null
  let text = ""
  const positions: { span: number; offset: number }[] = []
  let inSpace = false
  let spaceAt: { span: number; offset: number } | null = null
  texts.forEach((value, span) => {
    for (let offset = 0; offset < value.length; offset++) {
      const char = value.charAt(offset)
      if (/\s/.test(char)) {
        if (!inSpace) {
          inSpace = true
          spaceAt = { span, offset }
        }
        continue
      }
      if (inSpace && text.length > 0) {
        text += " "
        positions.push(spaceAt ?? { span, offset })
      }
      inSpace = false
      spaceAt = null
      text += char
      positions.push({ span, offset })
    }
    if (!inSpace) {
      inSpace = true
      spaceAt = null
    }
  })
  if (!text) return null
  let found: number[] = []
  for (let at = text.indexOf(wanted); at >= 0; at = text.indexOf(wanted, at + 1)) found.push(at)
  if (!found.length) {
    const lower = text.toLowerCase()
    const needle = wanted.toLowerCase()
    found = []
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) found.push(at)
  }
  if (!found.length) return null
  const at = found[Math.min(Math.max(Math.floor(occ), 1), found.length) - 1]
  const start = positions[at]
  const end = positions[at + wanted.length - 1]
  return start && end ? { start, end } : null
}

function rangeFromSpans(page: number, snippet: string, occ: number): Range | null | "pending" {
  const spans = spansOf(page)
  if (!spans.length) return "pending"
  const place = findInSpans(
    spans.map((span) => (span.firstChild as Text).data),
    snippet,
    occ,
  )
  const first = place && spans[place.start.span]
  const last = place && spans[place.end.span]
  if (!place || !first || !last) return null
  const range = document.createRange()
  range.setStart(first.firstChild as Text, place.start.offset)
  range.setEnd(last.firstChild as Text, place.end.offset + 1)
  return range
}

function nearView(page: number) {
  const el = scroller.value
  const top = tops.value[page - 1]
  const height = heights.value[page - 1]
  return Boolean(el && top !== undefined && height !== undefined && top < el.scrollTop + 2 * el.clientHeight && top + height > el.scrollTop - el.clientHeight)
}

const marks = ref<{ id: string; num: number; rects: Box[] }[]>([])
const fxBoxes = ref<FxBox[]>([])
const flashId = ref<string | null>(null)
const markerSize = ref({ w: 0, h: 0 })
let retryTimer: ReturnType<typeof setTimeout> | undefined

const fx = useAnnotationFx(() => props.path)

function refreshMarks() {
  const waiting = annotations.list(mainAnnotationScope.value)
  const own = waiting.map((note, index) => ({ note, num: index + 1 })).filter((entry) => entry.note.path === props.path).map((entry) => ({ id: entry.note.id, num: entry.num }))
  const items = own.length ? own : (batch.byFile[props.path] ?? []).map((item) => ({ id: item.id, num: item.num }))
  let pending = false
  const resolve = (id: string): Range | null => {
    const entry = kept.get(id)
    if (!entry) return null
    let range = entry.range
    if (!range || !range.startContainer.isConnected || range.collapsed) {
      const found = rangeFromSpans(entry.page, entry.text, entry.occ)
      if (found === "pending") {
        if (nearView(entry.page)) pending = true
        return null
      }
      range = found
      kept.set(id, { ...entry, range })
      if (!range) return null
    }
    return range
  }
  const nextMarks: typeof marks.value = []
  for (const item of items) {
    const range = resolve(item.id)
    if (!range) continue
    const rects = rectsOf(range)
    if (rects.length) nextMarks.push({ id: item.id, num: item.num, rects })
  }
  const boxes: FxBox[] = []
  for (const id of fx.annotatedIds.value) {
    const range = resolve(id)
    if (!range) continue
    const rects = rectsOf(range)
    if (!rects.length) continue
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const rect of rects) {
      left = Math.min(left, rect.left)
      top = Math.min(top, rect.top)
      right = Math.max(right, rect.left + rect.w)
      bottom = Math.max(bottom, rect.top + rect.h)
    }
    const boxWidth = right - left + 8
    const boxHeight = bottom - top + 8
    boxes.push({ key: id, left: left - 4, top: top - 4, width: boxWidth, height: boxHeight, diag: Math.ceil(Math.hypot(boxWidth + 16, boxHeight + 16)) })
  }
  marks.value = nextMarks
  fxBoxes.value = boxes
  // The scroll area without its scrollbars: the frames are cut there and the badges kept inside it.
  if (scroller.value) markerSize.value = { w: scroller.value.clientWidth, h: scroller.value.clientHeight }
  if (pending && !retryTimer) {
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      refreshMarks()
    }, 600)
  }
}

/* While the working light runs, the passages it covers show no frame. */
const shownMarks = computed(() => {
  if (!fx.phase.value) return marks.value
  const lit = new Set(fx.annotatedIds.value)
  return marks.value.filter((mark) => !lit.has(mark.id))
})

watch(
  () => [annotations.byScope, batch.byFile, props.path, fx.annotatedIds.value, fx.phase.value, mainAnnotationScope.value],
  () => refreshMarks(),
  /*
   * No `deep: true`, and the reason is in the stores.
   *
   * These five sources are all replaced wholesale rather than mutated in place:
   * `byScope` and `byFile` are written as `byScope.value = { ...byScope.value, ... }`
   * in their stores, `annotatedIds` as `annotatedIds.value = [...]` in
   * annotation-fx, and the other two are props and a plain string. A reference
   * comparison catches every one of those changes.
   *
   * The deep traversal was walking every annotation in the document - on every
   * redraw of the panel - to discover what the new top-level object had already
   * announced.
   */
)

function badgeAt(rect: Box) {
  const maxLeft = Math.max(BADGE_EDGE, markerSize.value.w - BADGE - BADGE_EDGE)
  const maxTop = Math.max(BADGE_EDGE, markerSize.value.h - BADGE - BADGE_EDGE)
  return {
    left: `${Math.min(Math.max(BADGE_EDGE, rect.left - 7), maxLeft)}px`,
    top: `${Math.min(Math.max(BADGE_EDGE, rect.top - 7), maxTop)}px`,
  }
}

/* ------------------------------------------------------------ locate and flash */

let locateRange: Range | null = null
const locateRects = ref<Box[]>([])
let lastLocate = 0
let locateCancel: (() => void) | undefined

async function locateRequest() {
  const request = pdfLocate.value
  const el = scroller.value
  const pdf = doc.value
  if (!request || request.path !== props.path || !el || !count.value || !pdf || width.value <= 0 || lastLocate === request.seq) return
  lastLocate = request.seq
  locateCancel?.()
  let cancelled = false
  locateCancel = () => {
    cancelled = true
  }
  const mine = generation
  locateRange = null
  locateRects.value = []
  let page = 0
  if (request.page && Number.isFinite(request.page)) page = Math.min(Math.max(Math.round(request.page), 1), count.value)
  else {
    const wanted = request.snippet.replace(/\s+/g, " ").trim()
    for (let number = 1; number <= count.value; number++) {
      const content = await pdf
        .getPage(number)
        .then((entry) => entry.getTextContent())
        .catch(() => null)
      if (cancelled || mine !== generation) return
      const joined = content ? content.items.map((item) => ("str" in item ? item.str : "")).join(" ").replace(/\s+/g, " ") : ""
      if (wanted && (joined.includes(wanted) || joined.toLowerCase().includes(wanted.toLowerCase()))) {
        page = number
        break
      }
    }
    if (!page) return
  }
  scrollToTop(el, Math.max(0, (tops.value[page - 1] ?? 0) - 4))
  align = { page, until: Date.now() + ALIGN_MS }
  realign()
  for (let attempt = 0; attempt < 30; attempt++) {
    if (cancelled || mine !== generation) return
    realign()
    if (spansOf(page).length) {
      const found = rangeFromSpans(page, request.snippet, request.occ ?? 1)
      if (found && found !== "pending") {
        locateRange = found
        locateRects.value = rectsOf(found)
      }
      return
    }
    await new Promise((done) => setTimeout(done, 100))
  }
}

let flashTimer: ReturnType<typeof setTimeout> | undefined
let flashRefresh: ReturnType<typeof setTimeout> | undefined
function flashRequest() {
  const request = annotationFlash.value
  if (!request || !props.active) return
  const entry = kept.get(request.id)
  if (!entry) return
  scroller.value?.scrollTo({ top: Math.max(0, (tops.value[entry.page - 1] ?? 0) - 4), behavior: "smooth" })
  flashId.value = request.id
  clearTimeout(flashTimer)
  clearTimeout(flashRefresh)
  flashTimer = setTimeout(() => (flashId.value = null), 1200)
  flashRefresh = setTimeout(() => refreshMarks(), 400)
}

watch([pdfLocate, count, doc, () => width.value > 0], () => void locateRequest())
watch(annotationFlash, flashRequest)

/* ------------------------------------------------------------ the note box */

const noteOpen = ref(false)
const noteAnchor = ref<{ x: number; y: number }>({ x: 0, y: 0 })
const noteText = ref("")
let selectedText = ""
let selectedRange: Range | null = null
let selectedPage = 1

function hideNote() {
  selectedText = ""
  selectedRange = null
  noteOpen.value = false
}

function onPointerUp(event: PointerEvent) {
  if ((event.target as Element | null)?.closest?.("[data-cell-affordance]")) return
  if (locateRange) {
    locateRange = null
    locateRects.value = []
  }
  const anchor = { x: event.clientX, y: event.clientY }
  setTimeout(() => {
    const selection = window.getSelection()
    const text = (selection?.toString() || "").trim()
    if (noteOpen.value) noteText.value = ""
    if (!text) {
      hideNote()
      return
    }
    const range = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null
    const start = range?.startContainer
    const pageEl = (start instanceof Element ? start : start?.parentElement)?.closest?.("[data-pdf-page]")
    selectedPage = (pageEl && Number(pageEl.getAttribute("data-pdf-page"))) || current.value
    selectedText = text
    selectedRange = range
    noteAnchor.value = anchor
    noteOpen.value = true
  }, 0)
}

function onWheel() {
  if (noteOpen.value) hideNote()
}

/* The selection's place on its page: which occurrence there, and its box in PDF points from the bottom-left corner. */
function anchorOfSelection(): { occ: number; occTotal: number; rect?: NonNullable<Annotation["rect"]> } {
  const range = selectedRange
  const start = range?.startContainer
  const pageEl = (start instanceof Element ? start : start?.parentElement)?.closest?.<HTMLElement>("[data-pdf-page]")
  if (!range || !pageEl) return { occ: 1, occTotal: 0 }
  const text = normalize(pageEl)
  let index = -1
  for (let at = 0; at < text.map.length; at++) {
    const probe = document.createRange()
    probe.setStart(text.map[at].node, text.map[at].offset)
    if (probe.compareBoundaryPoints(Range.START_TO_START, range) >= 0) {
      index = at
      break
    }
  }
  const wanted = compact(selectedText)
  const found: number[] = []
  if (wanted) for (let at = text.norm.indexOf(wanted); at >= 0; at = text.norm.indexOf(wanted, at + 1)) found.push(at)
  let occurrence = { occ: 1, occTotal: found.length }
  if (found.length && index >= 0) {
    let occ = 1
    for (let at = 0; at < found.length && found[at] <= index; at++) occ = at + 1
    occurrence = { occ, occTotal: found.length }
  }
  const size = sizes[selectedPage]
  if (!size) return occurrence
  const box = range.getBoundingClientRect()
  const pageBox = pageEl.getBoundingClientRect()
  if (pageBox.width <= 0 || pageBox.height <= 0 || size.w <= 0 || size.h <= 0) return occurrence
  const across = size.w / pageBox.width
  const down = size.h / pageBox.height
  const y = box.top - pageBox.top
  return {
    ...occurrence,
    rect: { x: (box.left - pageBox.left) * across, y: size.h - (y + box.height) * down, w: box.width * across, h: box.height * down, pageW: size.w, pageH: size.h },
  }
}

function buildNote(userText: string): Annotation {
  const where = anchorOfSelection()
  // Folded and cut with an ellipsis, as the Word and slide views fold theirs: a selection across lines reaches the model as one passage.
  const folded = collapse(selectedText)
  const quote = folded ? (folded.length > 400 ? `${folded.slice(0, 400)}…` : folded) : "(空)"
  return {
    id: annotationId(),
    kind: "pdf",
    path: props.path,
    name: props.name,
    page: selectedPage,
    quote,
    occ: where.occ,
    occTotal: where.occTotal,
    ...(where.rect ? { rect: where.rect } : {}),
    text: userText.trim(),
  }
}

async function sendNote() {
  const userText = noteText.value.trim()
  if (!userText || !selectedText) {
    noteText.value = ""
    hideNote()
    return
  }
  const page = selectedPage
  const text = selectedText
  const range = selectedRange
  const note = buildNote(userText)
  const result = await sendAnnotationNow(note, props.path, `${t("annotations.pdfPrefix", { page })}${userText}`, { origin: props.origin, directory: props.root })
  if (!result.ok) {
    if (result.reason) notifyFailure(result.reason)
    return
  }
  if (range) kept.set(note.id, { range: range.cloneRange(), page, text, occ: note.occ ?? 1 })
  batch.setBatch([{ id: note.id, num: 0, kind: note.kind, path: props.path, name: props.name }])
  noteText.value = ""
  hideNote()
}

function stashNote() {
  if (!selectedText) {
    noteText.value = ""
    hideNote()
    return
  }
  const page = selectedPage
  const text = selectedText
  const range = selectedRange
  const note = buildNote(noteText.value)
  if (!annotations.add(mainAnnotationScope.value, note)) return
  if (range) kept.set(note.id, { range: range.cloneRange(), page, text, occ: note.occ ?? 1 })
  noteText.value = ""
  hideNote()
}

/* Escape clears what this file sent, unless a layer on top took it or a dialog covers the page. */
function onEscape(event: KeyboardEvent) {
  if (!props.active || event.key !== "Escape" || event.defaultPrevented || event.isComposing || dialogOpen()) return
  batch.clearFile(props.path)
}

/* ------------------------------------------------------------ lifecycle */

let stopWatching: (() => void) | undefined
let diskTimer: ReturnType<typeof setTimeout> | undefined

/* A press in a page's text marks that layer as selecting until the button is let go anywhere, as react-pdf does. */
function onTextPress(event: PointerEvent) {
  const layer = (event.target as Element | null)?.closest?.(".textLayer")
  if (layer) layer.classList.add("selecting")
}

function onTextRelease() {
  for (const layer of rootEl.value?.querySelectorAll(".textLayer.selecting") ?? []) layer.classList.remove("selecting")
}

onMounted(() => {
  const el = scroller.value
  if (el) {
    resizer.observe(el)
    width.value = Math.max(0, el.clientWidth - PAD * 2)
    el.addEventListener("wheel", stopAlign, { passive: true })
    el.addEventListener("pointerdown", stopAlign, { passive: true })
    el.addEventListener("pointerdown", onTextPress, { passive: true })
    el.addEventListener("click", onLinkClick, true)
  }
  document.addEventListener("pointerup", onTextRelease, true)
  document.addEventListener("pointercancel", onTextRelease, true)
  window.addEventListener("keydown", stopAlign)
  document.addEventListener("keydown", onEscape)
  void window.mcode.watchFile(props.path)
  stopWatching = window.mcode.onFileChanged((changed) => {
    // Several spellings of one file arrive together; one look at the disk is enough.
    if (!samePath(changed, props.path) || diskTimer) return
    diskTimer = setTimeout(() => {
      diskTimer = undefined
      void onDiskChange()
    }, 0)
  })
  void load()
})

onBeforeUnmount(() => {
  const el = scroller.value
  resizer.disconnect()
  el?.removeEventListener("wheel", stopAlign)
  el?.removeEventListener("pointerdown", stopAlign)
  el?.removeEventListener("pointerdown", onTextPress)
  el?.removeEventListener("click", onLinkClick, true)
  document.removeEventListener("pointerup", onTextRelease, true)
  document.removeEventListener("pointercancel", onTextRelease, true)
  window.removeEventListener("keydown", stopAlign)
  document.removeEventListener("keydown", onEscape)
  stopWatching?.()
  clearTimeout(diskTimer)
  void window.mcode.unwatchFile(props.path)
  stopRestore?.()
  locateCancel?.()
  generation += 1
  clearTimeout(drawTimer)
  clearTimeout(scrollTimer)
  clearTimeout(retryTimer)
  clearTimeout(flashTimer)
  clearTimeout(flashRefresh)
  release()
})

function setLayer(index: number, el: unknown) {
  layerEls[index] = (el as HTMLElement | null) ?? undefined
  if (el) scheduleDraw()
}

const noteHost = () => rootEl.value?.getBoundingClientRect()
const noteInside = (target: Node) => Boolean(rootEl.value?.contains(target))
</script>

<template>
  <div ref="rootEl" class="pdf-view" data-pdf-view @pointerup="onPointerUp" @wheel.passive="onWheel">
    <!-- The pages are content, as MiMo marks them: Ctrl+A takes the document, not the whole window. -->
    <div ref="scroller" class="office-sel" data-selectable="content" data-pdf-scroll @scroll="onScroll">
      <div v-if="count > 0" ref="pagesEl" class="pdf-pages">
        <div
          v-for="(height, index) in heights"
          :key="index"
          class="pdf-page"
          :data-pdf-page="index + 1"
          :style="{ width: `${pageWidth}px`, height: `${height}px`, marginBottom: index < count - 1 ? `${GAP}px` : '0' }"
        >
          <div v-if="index >= visible[0] && index <= visible[1]" :ref="(el) => setLayer(index, el)" class="pdf-layers" />
        </div>
      </div>
    </div>

    <!--
      The frames over the pages, cut at the scroll area's edges: a passage
      scrolled past the foot never paints over the footer line under it.
    -->
    <div class="pdf-overlay" data-pdf-overlay :style="{ width: `${markerSize.w}px`, height: `${markerSize.h}px` }">
      <div
        v-for="(rect, at) in locateRects"
        :key="`locate-${at}`"
        class="pdf-locate"
        data-locate-rect
        :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.w}px`, height: `${rect.h}px` }"
      />

      <div class="pdf-marks">
        <template v-for="mark in shownMarks" :key="mark.id">
          <div
            v-for="(rect, at) in mark.rects"
            :key="`${mark.id}-${at}`"
            class="pdf-mark"
            :class="{ flash: mark.id === flashId }"
            :data-ann-marker="mark.num"
            :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.w}px`, height: `${rect.h}px` }"
          />
        </template>
        <template v-if="markerSize.w > 0">
          <template v-for="mark in shownMarks" :key="`${mark.id}-badge`">
            <span v-if="mark.rects[0] && mark.num > 0" class="pdf-badge" :class="{ flash: mark.id === flashId }" :data-ann-marker-badge="mark.num" :style="badgeAt(mark.rects[0])">
              {{ mark.num }}
            </span>
          </template>
        </template>
      </div>

      <template v-if="fx.phase.value">
        <AnnotationFx v-for="box in fxBoxes" :key="box.key" :box="box" :phase="fx.phase.value" absolute />
      </template>
    </div>

    <div v-if="!loading && !failure && count > 0" class="pdf-toolbar" data-pdf-toolbar>
      <button type="button" class="pdf-tool" data-pdf-zoom-out :title="t('rp.pdf.zoomOut')" :aria-label="t('rp.pdf.zoomOut')" @click="setZoom(zoom - 0.1)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35M8 11h6" /></svg>
      </button>
      <span class="pdf-zoom" data-pdf-zoom>{{ Math.round(zoom * 100) }}%</span>
      <button type="button" class="pdf-tool" data-pdf-zoom-in :title="t('rp.pdf.zoomIn')" :aria-label="t('rp.pdf.zoomIn')" @click="setZoom(zoom + 0.1)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35M11 8v6M8 11h6" /></svg>
      </button>
      <button type="button" class="pdf-tool" data-pdf-fit :title="t('rp.pdf.fitWidth')" :aria-label="t('rp.pdf.fitWidth')" @click="zoom = 1">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12h20M18 8l4 4-4 4M6 8l-4 4 4 4" /></svg>
      </button>
      <span class="pdf-rule" aria-hidden="true" />
      <span data-pdf-page-indicator role="status">{{ current }} / {{ count }}</span>
    </div>

    <CellAffordance
      v-if="noteOpen"
      v-model="noteText"
      :anchor="noteAnchor"
      :host="noteHost"
      :inside="noteInside"
      @send="sendNote"
      @stash="stashNote"
      @close="hideNote"
    />

    <!-- MiMo 26.920's footer line under every document view. -->
    <ViewerAiNote viewer="pdf" />
    <div v-if="(loading && !restoring) || failure" class="pdf-note" :data-pdf-failed="failure ? '' : undefined">
      {{ failure || t("rp.pdf.loading") }}
    </div>
  </div>
</template>

<style scoped>
.pdf-view {
  position: relative;
  isolation: isolate;
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

/* MiMo's document ground: the side colour, scrolling both ways, over the footer line. */
.office-sel {
  position: relative;
  isolation: isolate;
  flex: 1 1 0;
  width: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--surface-base);
}

.pdf-pages {
  width: fit-content;
  margin: 0 auto;
  padding: 16px;
}

/* A sheet: white, a soft shadow. */
.pdf-page {
  position: relative;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}

/* pdf.js's layers take their size through --total-scale-factor; the drawing sets the page's scale and user unit. */
.pdf-layers {
  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
  --scale-round-x: 1px;
  --scale-round-y: 1px;
  position: absolute;
  inset: 0;
}

/* Over the scroll area only, physical like the frames' own coordinates, and under the zoom pill. */
.pdf-overlay {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 5;
  overflow: hidden;
  pointer-events: none;
}

/* A sent message's passage, found again: MiMo's amber. */
.pdf-locate {
  position: absolute;
  z-index: 5;
  box-sizing: border-box;
  background: rgba(250, 173, 20, 0.25);
  border: 1px solid #d48806;
  border-radius: 2px;
  pointer-events: none;
}

.pdf-marks {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}

/* A waiting annotation: a 2px editable-blue frame on a faint fill per line, its number on the first line's corner. */
.pdf-mark {
  position: absolute;
  box-sizing: border-box;
  background: rgba(50, 149, 251, 0.08);
  border: 2px solid #3295fb;
  border-radius: 3px;
  pointer-events: none;
}

.pdf-mark.flash {
  background: rgba(50, 149, 251, 0.22);
}

.pdf-badge {
  position: absolute;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  color: #fff;
  background: #3295fb;
  border-radius: 999px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
}

.pdf-badge.flash {
  transform: scale(1.25);
  box-shadow: 0 0 0 4px rgba(50, 149, 251, 0.35);
}

/* MiMo's floating pill: bottom end 14 / 12, 4 by 10, 6 apart, a 1px line. */
.pdf-toolbar {
  position: absolute;
  right: 14px;
  bottom: 12px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 999px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.14);
  font-size: 12px;
}

.pdf-tool {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-strong);
  background: transparent;
  border: none;
  border-radius: 6px;
}

.pdf-tool:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: -2px;
}

.pdf-zoom {
  min-width: 38px;
  text-align: center;
}

.pdf-rule {
  align-self: stretch;
  border-inline-start: 1px solid var(--border-weak);
}

/* Loading, or why it failed: over the whole view, muted 13px. */
.pdf-note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  color: var(--text-base);
  background: var(--surface-raised);
  font-size: 13px;
  text-align: center;
  pointer-events: none;
}
</style>

<style>
/* pdf.js's own text and link layers, built outside the template. */
.pdf-view .pdf-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.pdf-view .textLayer {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: clip;
  line-height: 1;
  text-align: initial;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
}

.pdf-view .textLayer :is(span, br) {
  position: absolute;
  color: transparent;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
}

.pdf-view .textLayer span.markedContent {
  top: 0;
  height: 0;
}

/* MiMo's fixed 25% blue in both themes, not the system accent. */
.pdf-view .textLayer ::selection {
  color: transparent;
  background: #2f6fed40;
}

.pdf-view .textLayer br::selection {
  background: transparent;
}

.pdf-view .textLayer .endOfContent {
  position: absolute;
  inset: 100% 0 0;
  z-index: -1;
  display: block;
  cursor: default;
  user-select: none;
}

.pdf-view .textLayer.selecting .endOfContent {
  top: 0;
}

/*
 * pdf.js 5.4.296's annotation layer (web/pdf_viewer.css), the version whose
 * elements these are. Its custom properties are written out as their values,
 * and the rules for HTML form fields are left out: with renderForms off, as
 * in MiMo, fields are painted on the canvas and no input is ever built.
 * pdf.js sizes the layer and places every section in percentages of the page,
 * so a redraw at a new zoom moves them with the canvas.
 */
.pdf-view .annotationLayer {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  pointer-events: none;
  transform-origin: 0 0;
  color-scheme: only light;
}

/*
 * pdf.js lays the text and annotation layers out as the page is stored and
 * marks them with its /Rotate; as its own viewer and react-pdf (MiMo's) do,
 * each is turned about its corner onto the page the canvas drew rotated.
 */
.pdf-view [data-main-rotation="90"] {
  transform: rotate(90deg) translateY(-100%);
}

.pdf-view [data-main-rotation="180"] {
  transform: rotate(180deg) translate(-100%, -100%);
}

.pdf-view [data-main-rotation="270"] {
  transform: rotate(270deg) translateX(-100%);
}

.pdf-view .annotationLayer[data-main-rotation="90"] .norotate {
  transform: rotate(270deg) translateX(-100%);
}

.pdf-view .annotationLayer[data-main-rotation="180"] .norotate {
  transform: rotate(180deg) translate(-100%, -100%);
}

.pdf-view .annotationLayer[data-main-rotation="270"] .norotate {
  transform: rotate(90deg) translateY(-100%);
}

.pdf-view .annotationLayer .annotationContent {
  position: absolute;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.pdf-view .annotationLayer section {
  position: absolute;
  box-sizing: border-box;
  text-align: initial;
  pointer-events: auto;
  transform-origin: 0 0;
  user-select: none;
}

.pdf-view .annotationLayer section:has(div.annotationContent) canvas.annotationContent {
  display: none;
}

.pdf-view .annotationLayer section .overlaidText {
  position: absolute;
  top: 0;
  left: 0;
  display: inline-block;
  width: 0;
  height: 0;
  overflow: hidden;
}

/* Sections stop taking the pointer while text is being drag-selected across them. */
.pdf-view .textLayer.selecting ~ .annotationLayer section {
  pointer-events: none;
}

.pdf-view .annotationLayer :is(.linkAnnotation, .buttonWidgetAnnotation.pushButton) > a {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  font-size: 1em;
}

/* pdf.js's own link hover, which MiMo keeps. */
.pdf-view .annotationLayer :is(.linkAnnotation, .buttonWidgetAnnotation.pushButton):not(.hasBorder) > a:hover {
  opacity: 0.2;
  background-color: rgb(255 255 0);
}

.pdf-view .annotationLayer .linkAnnotation.hasBorder:hover {
  background-color: rgb(255 255 0 / 0.2);
}

.pdf-view .annotationLayer .hasBorder {
  background-size: 100% 100%;
}

.pdf-view .annotationLayer .textAnnotation img {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
}

.pdf-view .annotationLayer .fileAttachmentAnnotation .popupTriggerArea {
  width: 100%;
  height: 100%;
}

.pdf-view .annotationLayer .popupAnnotation {
  position: absolute;
  width: max-content;
  max-width: 45%;
  height: auto;
  font-size: calc(9px * var(--total-scale-factor));
  pointer-events: none;
}

/* The note's popup: pdf.js's yellow card, in both themes. */
.pdf-view .annotationLayer .popup {
  padding: calc(6px * var(--total-scale-factor));
  color: black;
  background-color: rgb(255 255 153);
  border-radius: calc(2px * var(--total-scale-factor));
  outline: 1.5px solid rgb(255 255 74);
  box-shadow: 0 calc(2px * var(--total-scale-factor)) calc(5px * var(--total-scale-factor)) rgb(136 136 136);
  font: message-box;
  white-space: normal;
  word-wrap: break-word;
  cursor: pointer;
  pointer-events: auto;
  user-select: text;
}

.pdf-view .annotationLayer .popupAnnotation.focused .popup {
  outline-width: 3px;
}

.pdf-view .annotationLayer .popup * {
  font-size: calc(9px * var(--total-scale-factor));
}

.pdf-view .annotationLayer .popup > .header {
  display: inline-block;
}

.pdf-view .annotationLayer .popup > .header > .title {
  display: inline;
  font-weight: bold;
}

.pdf-view .annotationLayer .popup > .header .popupDate {
  display: inline-block;
  width: fit-content;
  margin-inline-start: calc(5px * var(--total-scale-factor));
}

.pdf-view .annotationLayer .popupContent {
  margin-top: calc(2px * var(--total-scale-factor));
  padding-top: calc(2px * var(--total-scale-factor));
  border-top: 1px solid rgb(51 51 51);
}

.pdf-view .annotationLayer .richText > * {
  white-space: pre-wrap;
  font-size: calc(9px * var(--total-scale-factor));
}

.pdf-view .annotationLayer .popupTriggerArea {
  cursor: pointer;
}

.pdf-view .annotationLayer section svg {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
}

.pdf-view .annotationLayer .annotationTextContent {
  position: absolute;
  width: 100%;
  height: 100%;
  color: transparent;
  opacity: 0;
  user-select: none;
  pointer-events: none;
}

.pdf-view .annotationLayer .annotationTextContent span {
  display: inline-block;
  width: 100%;
}

.pdf-view .annotationLayer svg.quadrilateralsContainer {
  position: absolute;
  top: 0;
  left: 0;
  z-index: -1;
  width: 0;
  height: 0;
  contain: strict;
}
</style>
