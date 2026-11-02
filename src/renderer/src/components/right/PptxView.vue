<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import type { PptxViewer } from "@aiden0z/pptx-renderer"
import JSZip from "jszip"
import type { Annotation } from "@shared/protocol"
import { collapse } from "@shared/annotations"
import { useApp } from "../../stores/app"
import { useAnnotations } from "../../stores/annotations"
import { useAnnotationBatch } from "../../stores/annotation-batch"
import { useOfficeVersions } from "../../stores/office-versions"
import { annotationFlash, annotationId, mainAnnotationScope, occurrenceOf } from "../../lib/annotate"
import { sendAnnotationNow } from "../../lib/annotation-send"
import { useAnnotationFx, watchedFilesOf, type FxBox } from "../../lib/annotation-fx"
import { aiTouch, takeCreated } from "../../lib/ai-touch"
import { splitFilePath } from "../../lib/file-path"
import { ENTRANCE_ITEM_MS, entranceSchedule, parseFixups, type SlideFixup } from "../../lib/pptx-parse"
import {
  applyFixup,
  moduleAt,
  rectOfRegion,
  reducedMotion,
  regionOf,
  renderCharts,
  slideIndexOfNode,
  textInBox,
  topChildren,
  type ChartInstance,
  type Echarts,
  type Region,
} from "../../lib/pptx-dom"
import { notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"
import { dialogOpen } from "../../lib/escape-layer"
import CellAffordance from "../CellAffordance.vue"
import AnnotationFx from "../AnnotationFx.vue"
import AnnotationMarkLayer, { type MarkItem } from "../AnnotationMarkLayer.vue"
import PptxPresent from "./PptxPresent.vue"
import ViewerAiNote from "./ViewerAiNote.vue"

/**
 * MiMo's slides view: every slide down the pane at its width, 20 apart, drawn
 * by the pptx renderer and then corrected (cropped full-bleed pictures, stray
 * right alignment, charts drawn again from their data). No toolbar and no
 * zoom; a deck the assistant has just made comes in piece by piece on its
 * first open.
 *
 * Pointing picks a piece of a slide (outlined on hover); dragging on empty
 * slide draws a box; selecting text works as in a page. Each opens the note
 * box - send posts the annotation at once and the place glows while the reply
 * runs; "add to chat" puts it in the box. The places are kept as fractions of
 * their slide, so their numbered frames follow the layout, and snap to the
 * piece now under them after a reload. The file reloads when it changes,
 * keeping its place.
 */
const props = withDefaults(defineProps<{ path: string; name: string; origin?: string; active?: boolean }>(), {
  origin: undefined,
  active: true,
})
const emit = defineEmits<{ fallback: [] }>()

const app = useApp()
const annotations = useAnnotations()
const batch = useAnnotationBatch()
const versions = useOfficeVersions()

const DRAG_MIN = 6

const wrap = ref<HTMLElement>()
const host = ref<HTMLElement>()

const loading = ref(true)
const restoring = ref(false)
const error = ref<string | null>(null)
const reloadNonce = ref(0)

let generation = 0
let viewer: PptxViewer | null = null
let bytes: Uint8Array | null = null
let fixups: SlideFixup[] = []
let echarts: Echarts | null = null
let charts: ChartInstance[] = []
let chartTimers: ReturnType<typeof setTimeout>[] = []
let settleTimers: ReturnType<typeof setTimeout>[] = []
let stopEntrance: (() => void) | undefined
let stopRestore: (() => void) | undefined
let lastStat: { size: number; mtimeMs: number } | undefined
let saved: { path: string; top: number } | null = null
let shownPath = ""

const present = shallowRef<{ viewer: PptxViewer; bytes: Uint8Array; startIndex: number } | null>(null)

const splitPath = () => splitFilePath(props.path)

function decode(base64: string) {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at)
  return out
}

function unhide() {
  if (host.value) host.value.style.visibility = ""
}

/* ------------------------------------------------------------ loading */

function teardown() {
  stopEntrance?.()
  stopEntrance = undefined
  settleTimers.forEach(clearTimeout)
  settleTimers = []
  chartTimers.forEach(clearTimeout)
  chartTimers = []
  for (const chart of charts) {
    try {
      chart.dispose()
    } catch {
      /* already disposed */
    }
  }
  charts = []
  try {
    viewer?.destroy()
  } catch {
    /* already destroyed */
  }
  viewer = null
  present.value = null
}

async function load() {
  const mine = ++generation
  if (viewer && host.value && shownPath) saved = { path: shownPath, top: host.value.scrollTop }
  stopRestore?.()
  teardown()
  // Taken only once this load has opened: a load overtaken by a newer one must leave the place for it.
  const top = saved && saved.path === props.path && saved.top > 0 ? saved.top : null
  if (top !== null) {
    restoring.value = true
    if (host.value) host.value.style.visibility = "hidden"
  }
  error.value = null
  loading.value = true
  closeNote()
  const file = props.path
  const [dir, base] = splitFilePath(file)
  const read = await window.mcode.readFileBytes(dir, base)
  if (mine !== generation) return
  if (!read.ok || read.unchanged) {
    error.value = !read.ok && read.reason === "noent" ? t("office.fileMissing") : t("office.serveFailed")
    loading.value = false
    restoring.value = false
    unhide()
    return
  }
  if (props.path !== file) return
  lastStat = { size: read.size, mtimeMs: read.mtimeMs }
  const { ai, prompt } = aiTouch(file, 60_000)
  void versions.init(file, read.base64, { assumeAi: ai, note: ai ? prompt.trim() : t("office.versionNoteExternal") })
  try {
    const { PptxViewer: Viewer } = await import("@aiden0z/pptx-renderer")
    if (mine !== generation || !host.value) return
    const data = decode(read.base64)
    let loaded: SlideFixup[] = []
    try {
      loaded = await parseFixups(await JSZip.loadAsync(data))
    } catch (err) {
      console.warn("[PptxView] fixup parse failed:", err)
    }
    if (mine !== generation || !host.value) return
    if (!echarts && loaded.some((fixup) => fixup.charts.length)) {
      try {
        echarts = (await import("echarts")) as unknown as Echarts
      } catch (err) {
        console.warn("[PptxView] echarts import failed:", err)
      }
    }
    if (mine !== generation || !host.value) return
    const el = host.value
    /*
     * Each load draws into an element of its own: an older load that finishes
     * after a newer one began destroys its viewer, and the renderer's destroy
     * empties the element it was given - which must not be the newer deck's.
     */
    const deck = document.createElement("div")
    deck.className = "pptx-deck"
    el.replaceChildren(deck)
    const animate = takeCreated(props.path) && !reducedMotion()
    const opened = await Viewer.open(data.buffer as ArrayBuffer, deck, {
      fitMode: "contain",
      renderMode: "list",
      scrollContainer: el,
      listOptions: { windowed: !animate },
      onSlideRendered: (index, element) => onSlideRendered(index, element, loaded),
    })
    if (mine !== generation) {
      opened.destroy()
      return
    }
    viewer = opened
    bytes = data
    fixups = loaded
    saved = null
    shownPath = props.path
    ;(opened as unknown as { teardownAdaptiveResize?: () => void }).teardownAdaptiveResize?.()
    loading.value = false
    if (animate) stopEntrance = runEntrance(el)
    if (top !== null) stopRestore = restoreScroll(el, top)
    if (restoring.value) {
      setTimeout(() => {
        unhide()
        restoring.value = false
      }, 16)
    }
    for (const delay of [16, 150, 450]) {
      settleTimers.push(
        setTimeout(() => {
          reanchor()
          refreshMarks()
        }, delay),
      )
    }
  } catch (err) {
    if (mine !== generation) return
    console.error("[PptxView] render failed:", err)
    unhide()
    restoring.value = false
    loading.value = false
    emit("fallback")
  }
}

function onSlideRendered(index: number, element: HTMLElement, list: SlideFixup[]) {
  const fixup = list[index]
  if (fixup) {
    try {
      applyFixup(element, fixup)
    } catch (err) {
      console.warn("[PptxView] applyFixup failed:", err)
    }
  }
  const engine = echarts
  if (!engine || !fixup?.charts.length) return
  const attempt = () => {
    try {
      charts = charts.filter((chart) => {
        if (chart.getDom()?.isConnected) return true
        try {
          chart.dispose()
        } catch {
          /* already disposed */
        }
        return false
      })
      const { made, allDone } = renderCharts(engine, element, fixup.charts)
      charts.push(...made)
      return allDone
    } catch (err) {
      console.warn("[PptxView] renderCharts failed:", err)
      return false
    }
  }
  if (!attempt()) for (const delay of [200, 600, 1400]) chartTimers.push(setTimeout(() => element.isConnected && attempt(), delay))
}

/* A new deck's first open: slides fade in one after another, each piece rising into place; any wheel, press or key ends it. */
function runEntrance(el: HTMLElement): () => void {
  const slides = [...el.querySelectorAll<HTMLElement>("[data-slide-index]")]
  const pieces = slides.map((slide) => topChildren(slide))
  const plan = entranceSchedule(pieces.map((list) => list.length))
  const timers: ReturnType<typeof setTimeout>[] = []
  let live = true
  const stop = () => {
    if (!live) return
    live = false
    timers.forEach(clearTimeout)
    el.removeEventListener("wheel", stop)
    el.removeEventListener("pointerdown", stop)
    el.removeEventListener("keydown", stop)
    slides.forEach((slide, at) => {
      slide.style.opacity = ""
      slide.style.transition = ""
      for (const piece of pieces[at]) {
        piece.style.opacity = ""
        piece.style.transform = ""
        piece.style.transition = ""
      }
    })
  }
  el.addEventListener("wheel", stop, { once: true, passive: true })
  el.addEventListener("pointerdown", stop, { once: true })
  el.addEventListener("keydown", stop, { once: true })
  slides.forEach((slide, at) => {
    slide.style.opacity = "0"
    for (const piece of pieces[at]) {
      piece.style.opacity = "0"
      piece.style.transform = "translateY(8px) scale(0.97)"
    }
  })
  const ease = "cubic-bezier(0.2, 0.7, 0.2, 1)"
  slides.forEach((slide, at) => {
    const delays = plan.delays[at] ?? []
    const first = delays[0] ?? 0
    timers.push(
      setTimeout(() => {
        if (!live) return
        slide.style.transition = `opacity 0.18s ${ease}`
        slide.style.opacity = "1"
        if (at > 0) slide.scrollIntoView({ behavior: "smooth", block: "center" })
      }, first),
    )
    pieces[at].forEach((piece, k) => {
      timers.push(
        setTimeout(() => {
          if (!live) return
          piece.style.transition = `opacity ${ENTRANCE_ITEM_MS}ms ${ease}, transform ${ENTRANCE_ITEM_MS}ms ${ease}`
          piece.style.opacity = "1"
          piece.style.transform = ""
        }, delays[k] ?? first),
      )
    })
  })
  timers.push(setTimeout(stop, plan.totalMs + 200))
  return stop
}

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
  reloadNonce.value += 1
}

watch([() => props.path, reloadNonce, () => versions.reloadTick[props.path] ?? 0], (next, before) => {
  if (next[0] !== before[0]) {
    if (before[0]) void window.mcode.unwatchFile(before[0])
    void window.mcode.watchFile(next[0])
  }
  void load()
})

/* ------------------------------------------------------------ picking */

interface Pick {
  text: string
  slideIndex: number
  /** Set for a drawn box: where on the slide it was drawn. */
  regionNote?: string
}

type Box = { left: number; top: number; w: number; h: number }

const highlight = ref<Box | null>(null)
const selRects = ref<Box[]>([])
const noteOpen = ref(false)
const noteAnchor = ref<{ x: number; y: number }>({ x: 0, y: 0 })
const noteRect = ref<{ top: number; bottom: number; right: number } | null>(null)
const noteText = ref("")
const autofocus = ref(false)

let picked: Pick | null = null
let pickedRange: Range | null = null
let pickedRegion: Region | null = null
let hovered: HTMLElement | null = null
let dragStart: { x: number; y: number } | null = null

function localOf(rect: DOMRect): Box {
  const origin = wrap.value?.getBoundingClientRect()
  return origin ? { left: rect.left - origin.left, top: rect.top - origin.top, w: rect.width, h: rect.height } : { left: rect.left, top: rect.top, w: rect.width, h: rect.height }
}

function rectsOf(range: Range): Box[] {
  const origin = wrap.value?.getBoundingClientRect()
  if (!origin) return []
  const out: Box[] = []
  for (const rect of range.getClientRects()) {
    if (rect.width < 2 || rect.height < 2) continue
    out.push({ left: rect.left - origin.left, top: rect.top - origin.top, w: rect.width, h: rect.height })
    if (out.length >= 80) break
  }
  return out
}

function closeNote() {
  picked = null
  pickedRange = null
  pickedRegion = null
  hovered = null
  selRects.value = []
  highlight.value = null
  noteOpen.value = false
}

function openFor(pick: Pick, rect: DOMRect, slide: HTMLElement, point: { x: number; y: number }) {
  picked = pick
  // A piece or box replaces any text selection picked before it, with its marks.
  pickedRange = null
  selRects.value = []
  pickedRegion = regionOf(rect, slide)
  highlight.value = localOf(rect)
  autofocus.value = true
  noteAnchor.value = point
  noteRect.value = { top: rect.top, bottom: rect.bottom, right: rect.right }
  noteOpen.value = true
}

/* A drawn box: the slide under its middle, where on it in whole percent, and the text of what it touches. */
function boxSelection(box: DOMRect, el: HTMLElement): { slide: HTMLElement; pick: Pick } | null {
  const middle = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  const slide = (middle && el.contains(middle) ? middle : document.elementFromPoint(box.left + 4, box.top + 4))?.closest<HTMLElement>("[data-slide-index]")
  if (!slide) return null
  const index = Number.parseInt(slide.getAttribute("data-slide-index") ?? "", 10)
  const frame = slide.getBoundingClientRect()
  const pct = (offset: number, total: number) => Math.max(0, Math.min(100, Math.round((offset * 100) / total)))
  const x1 = pct(box.left - frame.left, frame.width)
  const y1 = pct(box.top - frame.top, frame.height)
  const x2 = pct(box.right - frame.left, frame.width)
  const y2 = pct(box.bottom - frame.top, frame.height)
  return {
    slide,
    pick: { text: textInBox(slide, box), slideIndex: Number.isFinite(index) ? index : 0, regionNote: `(${x1}%, ${y1}%)–(${x2}%, ${y2}%)` },
  }
}

function onPointerDown(event: PointerEvent) {
  const target = event.target as Element | null
  if (target?.closest?.("[data-cell-affordance]")) return
  const el = host.value
  if (!el || !target?.closest?.("[data-slide-index]") || moduleAt(event.clientX, event.clientY, el)) return
  event.preventDefault()
  closeNote()
  dragStart = { x: event.clientX, y: event.clientY }
  wrap.value?.setPointerCapture?.(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  const el = host.value
  if (!el) return
  if (dragStart) {
    const dx = Math.abs(event.clientX - dragStart.x)
    const dy = Math.abs(event.clientY - dragStart.y)
    if (dx < DRAG_MIN && dy < DRAG_MIN) return
    const origin = wrap.value?.getBoundingClientRect()
    highlight.value = { left: Math.min(dragStart.x, event.clientX) - (origin?.left ?? 0), top: Math.min(dragStart.y, event.clientY) - (origin?.top ?? 0), w: dx, h: dy }
    el.style.cursor = "crosshair"
    return
  }
  if (noteOpen.value) return
  const hit = moduleAt(event.clientX, event.clientY, el)
  if (!hit) {
    if (hovered) {
      hovered = null
      highlight.value = null
    }
    return
  }
  if (hit.el !== hovered) {
    hovered = hit.el
    highlight.value = localOf(hit.rect)
  }
}

function onPointerLeave() {
  hovered = null
  if (!noteOpen.value && !dragStart) highlight.value = null
}

function onPointerUp(event: PointerEvent) {
  if ((event.target as Element | null)?.closest?.("[data-cell-affordance]")) return
  const el = host.value
  if (!el) return
  const point = { x: event.clientX, y: event.clientY }
  if (dragStart) {
    const start = dragStart
    dragStart = null
    el.style.cursor = "default"
    const box = new DOMRect(Math.min(start.x, point.x), Math.min(start.y, point.y), Math.abs(point.x - start.x), Math.abs(point.y - start.y))
    if (box.width >= DRAG_MIN || box.height >= DRAG_MIN) {
      const found = boxSelection(box, el)
      if (!found) {
        highlight.value = null
        return
      }
      openFor(found.pick, box, found.slide, point)
      return
    }
    closeNote()
    batch.clearFile(props.path)
    return
  }
  setTimeout(() => {
    const selection = window.getSelection()
    const text = (selection?.toString() || "").trim()
    if (noteOpen.value) noteText.value = ""
    if (text && selection) {
      const range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null
      picked = { text, slideIndex: slideIndexOfNode(selection.anchorNode, viewer?.currentSlideIndex ?? 0) }
      pickedRegion = null
      pickedRange = range
      selRects.value = range ? rectsOf(range) : []
      highlight.value = null
      autofocus.value = false
      const rect = range?.getBoundingClientRect()
      noteAnchor.value = point
      noteRect.value = rect && rect.width > 1 && rect.height > 1 ? { top: rect.top, bottom: rect.bottom, right: rect.right } : null
      noteOpen.value = true
      return
    }
    const hit = moduleAt(point.x, point.y, el)
    if (hit) openFor({ text: hit.el.innerText?.trim() ?? "", slideIndex: hit.slideIndex }, hit.rect, hit.slide, point)
  }, 0)
}

function onPointerCancel() {
  if (!dragStart) return
  dragStart = null
  highlight.value = null
  if (host.value) host.value.style.cursor = "default"
}

function onWheel() {
  if (dragStart) onPointerCancel()
  if (noteOpen.value || highlight.value) closeNote()
}

/* After a resize the picked place is found again on its slide. */
function reproject() {
  if (pickedRange) selRects.value = rectsOf(pickedRange)
  const el = host.value
  if (!pickedRegion || !el) return
  const rect = rectOfRegion(pickedRegion, el)
  if (!rect) return
  highlight.value = localOf(rect)
  if (!noteOpen.value) return
  noteAnchor.value = { x: rect.right, y: rect.top + rect.height / 2 }
  noteRect.value = { top: rect.top, bottom: rect.bottom, right: rect.right }
}

watch(
  () => props.active,
  (active) => {
    if (active) return
    noteOpen.value = false
    noteText.value = ""
    highlight.value = null
  },
)

/* ------------------------------------------------------------ the annotation */

const regions = new Map<string, Region>()
const elementOf = (node: Node | null | undefined) => (node instanceof Element ? node : node?.parentElement ?? null)

/** The picked place as a region: the piece or box, else the selected text's box. */
function storedRegion(): Region | null {
  if (pickedRegion) return pickedRegion
  if (!pickedRange) return null
  const rect = pickedRange.getBoundingClientRect()
  const slide = elementOf(pickedRange.startContainer)?.closest<HTMLElement>("[data-slide-index]")
  return slide && rect.width > 1 && rect.height > 1 ? regionOf(rect, slide) : null
}

function buildNote(pick: Pick, userText: string): Annotation {
  const slide = pickedRange ? elementOf(pickedRange.startContainer)?.closest<HTMLElement>("[data-slide-index]") : null
  const occurrence = pickedRange && slide && pick.text ? occurrenceOf(slide, pickedRange, pick.text) : undefined
  const region = storedRegion()
  const fixup = fixups[pick.slideIndex]
  const folded = collapse(pick.text)
  const shape = folded.length >= 2 ? fixup?.shapes.find((entry) => entry.textNorm && (entry.textNorm.includes(folded) || folded.includes(entry.textNorm))) : undefined
  return {
    id: annotationId(),
    kind: "pptx",
    path: props.path,
    name: props.name,
    slide: pick.slideIndex,
    ...(fixup?.slideId ? { slideId: fixup.slideId } : {}),
    ...(shape ? { shapeId: shape.id, shapeName: shape.name } : {}),
    ...(folded ? { quote: folded.length > 400 ? `${folded.slice(0, 400)}…` : folded } : {}),
    ...(occurrence ?? {}),
    ...(region ? { region: { fx: region.fx, fy: region.fy, fw: region.fw, fh: region.fh } } : {}),
    ...(pick.regionNote ? { boxed: true } : {}),
    text: userText.trim(),
  }
}

let localConvo: string | null = null
let localNote = ""
let localPending = false
let deferReload = false

async function sendNote() {
  const comment = noteText.value.trim()
  const pick = picked
  if (!comment || !pick) {
    noteText.value = ""
    closeNote()
    return
  }
  const note = buildNote(pick, comment)
  const region = storedRegion()
  const path = props.path
  const name = props.name
  const result = await sendAnnotationNow(note, path, `【PPT 第${pick.slideIndex + 1}页】${comment}`, { origin: props.origin })
  if (!result.ok) {
    if (result.reason) notifyFailure(result.reason)
    return
  }
  if (props.path !== path) {
    if (region) batch.setBatch([{ id: note.id, num: 0, kind: note.kind, path, name }])
    return
  }
  localNote = `【第${pick.slideIndex + 1}页·${pick.regionNote ? "框选范围" : "选中模块"}】${comment}`
  localConvo = result.convoId ?? null
  localPending = true
  if (region) {
    regions.set(note.id, region)
    batch.setBatch([{ id: note.id, num: 0, kind: note.kind, path, name }])
  }
  noteText.value = ""
  closeNote()
}

function stashNote() {
  const pick = picked
  if (!pick) {
    noteText.value = ""
    closeNote()
    return
  }
  const region = storedRegion()
  const note = buildNote(pick, noteText.value)
  if (!annotations.add(mainAnnotationScope.value, note)) return
  if (region) regions.set(note.id, region)
  noteText.value = ""
  closeNote()
}

/* ------------------------------------------------------------ marks, flash, working light */

const fx = useAnnotationFx(() => props.path)
const marks = ref<MarkItem[]>([])
const fxBoxes = ref<FxBox[]>([])
const flashId = ref<string | null>(null)

function clamped(region: Region): Region {
  const count = fixups.length
  return count > 0 && region.slideIndex >= count ? { ...region, slideIndex: count - 1 } : region
}

function refreshMarks() {
  const el = host.value
  if (!el) {
    marks.value = []
    fxBoxes.value = []
    return
  }
  const waiting = annotations.list(mainAnnotationScope.value)
  const own = waiting.map((note, index) => ({ note, num: index + 1 })).filter((entry) => entry.note.path === props.path).map((entry) => ({ id: entry.note.id, num: entry.num }))
  const items = own.length ? own : (batch.byFile[props.path] ?? []).map((item) => ({ id: item.id, num: item.num }))
  const lit = fx.phase.value ? new Set(fx.annotatedIds.value) : new Set<string>()
  const nextMarks: MarkItem[] = []
  for (const item of items) {
    const region = regions.get(item.id)
    const rect = region ? rectOfRegion(clamped(region), el) : null
    if (rect && !lit.has(item.id)) nextMarks.push({ ...item, rects: [localOf(rect)] })
  }
  const boxes: FxBox[] = []
  for (const id of fx.annotatedIds.value) {
    const region = regions.get(id)
    const rect = region ? rectOfRegion(clamped(region), el) : null
    if (!rect) continue
    const box = localOf(rect)
    const width = box.w + 8
    const height = box.h + 8
    boxes.push({ key: id, left: box.left - 4, top: box.top - 4, width, height, diag: Math.ceil(Math.hypot(width + 16, height + 16)) })
  }
  marks.value = nextMarks
  fxBoxes.value = boxes
}

/* Each kept place snaps to the piece now under its middle, when that piece is on the same slide. */
function reanchor() {
  const el = host.value
  if (!el) return
  for (const id of new Set([...regions.keys(), ...fx.annotatedIds.value])) {
    const stored = regions.get(id)
    if (!stored) continue
    const region = clamped(stored)
    const rect = rectOfRegion(region, el)
    if (!rect) continue
    const hit = moduleAt(rect.left + rect.width / 2, rect.top + rect.height / 2, el)
    if (hit && hit.slideIndex === region.slideIndex) regions.set(id, regionOf(hit.rect, hit.slide))
  }
}

/*
 * No `deep: true`: every source is replaced wholesale, never mutated in place
 * (the stores write `byScope.value = { ...byScope.value, ... }` and
 * `annotatedIds.value = [...]`). A reference comparison catches all of them; the
 * deep walk was traversing every annotation in the document to learn what the
 * new top-level object already said.
 */
watch(() => [annotations.byScope, batch.byFile, props.path, fx.annotatedIds.value, fx.phase.value, mainAnnotationScope.value], refreshMarks)

let flashTimer: ReturnType<typeof setTimeout> | undefined
watch(annotationFlash, (request) => {
  if (!request || !props.active) return
  const region = regions.get(request.id)
  const el = host.value
  if (!region || !el) return
  const slide = el.querySelector(`[data-slide-index="${region.slideIndex}"]`)
  if (slide) {
    const box = slide.getBoundingClientRect()
    const frame = el.getBoundingClientRect()
    el.scrollBy({ top: box.top - frame.top + region.fy * box.height - frame.height / 2, behavior: "smooth" })
  }
  flashId.value = request.id
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashId.value = null), 1200)
  setTimeout(refreshMarks, 16)
  setTimeout(refreshMarks, 350)
})

/* ------------------------------------------------------------ disk and runs */

async function onDiskChange() {
  const path = props.path
  const { ai, prompt } = aiTouch(path)
  const aiRunning = ai && app.running.size > 0
  if (aiRunning) deferReload = true
  const [dir, base] = splitFilePath(path)
  const read = await window.mcode.readFileBytes(dir, base, lastStat)
  if (props.path !== path) {
    deferReload = false
    return
  }
  if (!read.ok) return
  if (read.unchanged) {
    if (aiRunning) deferReload = false
    return
  }
  await versions.record(path, read.base64, ai ? "ai_local" : "external", ai ? prompt.trim() : t("office.versionNoteExternal"))
  if (props.path !== path) {
    deferReload = false
    return
  }
  if (!aiRunning) lastStat = { size: read.size, mtimeMs: read.mtimeMs }
  if (!aiRunning) reload()
}

let runningBefore = new Set<string>()
watch(
  () => [...app.running].join("|"),
  async () => {
    const now = new Set(app.running)
    const ended = [...runningBefore].filter((id) => !now.has(id))
    runningBefore = now
    if (!ended.length) return
    const path = props.path
    const origin = props.origin
    const [dir, base] = splitFilePath(path)
    if (localPending && localConvo && ended.includes(localConvo)) {
      localPending = false
      deferReload = false
      localConvo = null
      const note = localNote
      localNote = ""
      try {
        const read = await window.mcode.readFileBytes(dir, base)
        if (props.path !== path) return
        if (read.ok && !read.unchanged) {
          await versions.record(path, read.base64, "ai_local", note)
          if (props.path !== path) return
          lastStat = { size: read.size, mtimeMs: read.mtimeMs }
        } else console.error("[PptxView] read bytes for AI version record failed:", read.ok ? "unchanged" : read.reason)
      } catch (err) {
        console.error("[PptxView] record AI version error:", err)
      } finally {
        if (props.path === path) reload()
      }
      return
    }
    if (ended.some((id) => id === origin || watchedFilesOf(id).includes(path))) {
      deferReload = false
      const read = await window.mcode.readFileBytes(dir, base, lastStat)
      if (props.path !== path) return
      if (!read.ok || read.unchanged) return
      lastStat = { size: read.size, mtimeMs: read.mtimeMs }
      reload()
      return
    }
    if (deferReload) {
      deferReload = false
      reload()
    }
  },
)

/* Escape clears what this file sent, unless a layer on top took it or a dialog covers the page. */
function onEscape(event: KeyboardEvent) {
  // Escape while presenting ends the show; it must not also drop what was sent.
  if (!props.active || present.value || event.key !== "Escape" || event.defaultPrevented || event.isComposing || dialogOpen()) return
  batch.clearFile(props.path)
}

/* Links go out only to the web, mail and phone. */
function onLinkClick(event: MouseEvent) {
  const link = (event.target as Element | null)?.closest?.("a[href]")
  if (!link) return
  event.preventDefault()
  event.stopPropagation()
  const href = link.getAttribute("href") || ""
  if (/^(https?:|mailto:|tel:)/i.test(href)) window.mcode.openExternal(href)
}

/* ------------------------------------------------------------ lifecycle */

let scrollTimer: ReturnType<typeof setTimeout> | undefined
let scrollTrailer: ReturnType<typeof setTimeout> | undefined
function onScroll() {
  if (!scrollTimer) {
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined
      refreshMarks()
    }, 16)
  }
  clearTimeout(scrollTrailer)
  scrollTrailer = setTimeout(refreshMarks, 200)
}

function relayout() {
  reproject()
  refreshMarks()
  for (const chart of charts) {
    try {
      chart.resize()
    } catch {
      /* disposed */
    }
  }
}

/* The slide at the top of the pane, and how far into it the pane is scrolled. */
function readingPlace(): { index: number; fraction: number } | null {
  const el = host.value
  if (!el) return null
  const frame = el.getBoundingClientRect()
  for (const slide of el.querySelectorAll<HTMLElement>("[data-slide-index]")) {
    const box = slide.getBoundingClientRect()
    if (box.bottom <= frame.top) continue
    const index = Number.parseInt(slide.getAttribute("data-slide-index") ?? "", 10)
    return Number.isFinite(index) ? { index, fraction: box.height > 0 ? (frame.top - box.top) / box.height : 0 } : null
  }
  return null
}

function returnTo(place: { index: number; fraction: number }) {
  const el = host.value
  const slide = el?.querySelector(`[data-slide-index="${place.index}"]`)
  if (!el || !slide) return
  const box = slide.getBoundingClientRect()
  if (box.height <= 0) return
  el.scrollTop += box.top - el.getBoundingClientRect().top + place.fraction * box.height
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined
const resizer = new ResizeObserver(() => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    // The renderer draws the whole list again at the new width (and would dispose the charts a slide show is using).
    if (present.value) return
    const place = readingPlace()
    ;(viewer as unknown as { handleContainerResize?: () => void } | null)?.handleContainerResize?.()
    for (const delay of [16, 120, 320, 700]) {
      setTimeout(() => {
        if (place) returnTo(place)
        relayout()
      }, delay)
    }
  }, 180)
})

function enterPresent() {
  if (!viewer || typeof viewer.renderSlideToContainer !== "function" || !bytes) return
  present.value = { viewer, bytes, startIndex: viewer.currentSlideIndex ?? 0 }
}

defineExpose({ enterPresent })

let stopWatching: (() => void) | undefined

onMounted(() => {
  if (host.value) {
    resizer.observe(host.value)
    host.value.addEventListener("click", onLinkClick, true)
  }
  document.addEventListener("keydown", onEscape)
  runningBefore = new Set(app.running)
  void window.mcode.watchFile(props.path)
  stopWatching = window.mcode.onFileChanged((changed) => {
    if (changed === props.path) void onDiskChange()
  })
  void load()
})

onBeforeUnmount(() => {
  generation += 1
  teardown()
  resizer.disconnect()
  host.value?.removeEventListener("click", onLinkClick, true)
  document.removeEventListener("keydown", onEscape)
  stopWatching?.()
  void window.mcode.unwatchFile(props.path)
  stopRestore?.()
  clearTimeout(flashTimer)
  clearTimeout(scrollTimer)
  clearTimeout(scrollTrailer)
  clearTimeout(resizeTimer)
})

const noteHost = () => wrap.value?.getBoundingClientRect()
const noteInside = (target: Node) => Boolean(wrap.value?.contains(target))
</script>

<template>
  <div
    ref="wrap"
    class="pptx-view"
    data-pptx-view
    role="region"
    :aria-label="name"
    :data-reload-nonce="reloadNonce"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @pointerleave="onPointerLeave"
    @wheel.passive="onWheel"
  >
    <div ref="host" class="pptx-host" data-preview-host="pptx" data-selectable="content" @scroll.passive="onScroll" />

    <div
      v-if="highlight"
      class="pptx-highlight"
      data-pptx-highlight="1"
      aria-hidden="true"
      :style="{ left: `${highlight.left}px`, top: `${highlight.top}px`, width: `${highlight.w}px`, height: `${highlight.h}px` }"
    />
    <div
      v-for="(rect, at) in selRects"
      :key="at"
      class="pptx-sel-rect"
      data-sel-rect
      aria-hidden="true"
      :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.w}px`, height: `${rect.h}px` }"
    />

    <AnnotationMarkLayer :items="marks" :flash-id="flashId" />

    <template v-if="fx.phase.value">
      <AnnotationFx v-for="box in fxBoxes" :key="box.key" :box="box" :phase="fx.phase.value" absolute />
    </template>

    <CellAffordance
      v-if="active && noteOpen"
      v-model="noteText"
      :anchor="noteAnchor"
      :selection-rect="noteRect"
      :host="noteHost"
      :inside="noteInside"
      :autofocus="autofocus"
      @send="sendNote"
      @stash="stashNote"
      @close="closeNote"
    />

    <!-- MiMo 26.920's footer line under every document view. -->
    <ViewerAiNote viewer="pptx" />
    <div v-if="(loading && !restoring) || error" class="pptx-note" :role="error ? 'alert' : 'status'" aria-live="polite" :data-pptx-failed="error ? '' : undefined">{{ error || t("office.loadingConvert") }}</div>

    <PptxPresent v-if="present" :viewer="present.viewer" :bytes="present.bytes" :start-index="present.startIndex" @close="present = null" />
  </div>
</template>

<style scoped>
.pptx-view {
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

.pptx-host {
  position: relative;
  isolation: isolate;
  flex: 1 1 0;
  width: 100%;
  min-height: 0;
  overflow: auto;
  cursor: default;
  user-select: text;
}

.pptx-highlight,
.pptx-sel-rect {
  position: absolute;
  z-index: 5;
  box-sizing: border-box;
  pointer-events: none;
}

.pptx-highlight {
  background: rgba(50, 149, 251, 0.08);
  border: 2px solid #3295fb;
  border-radius: 3px;
}

.pptx-sel-rect {
  background: rgba(50, 149, 251, 0.14);
  border: 1px solid #3295fb;
  border-radius: 2px;
}

.pptx-note {
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
