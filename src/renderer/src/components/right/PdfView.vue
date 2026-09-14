<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist"
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import type { Annotation } from "@shared/protocol"
import { collapse } from "@shared/annotations"
import { useApp } from "../../stores/app"
import { HOME_SCOPE, useAnnotations } from "../../stores/annotations"
import { annotationId, locate, occurrenceOf, pdfJump, requestAnnotation } from "../../lib/annotate"
import { notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"

/**
 * MiMo's PDF view, as the files tab shows it in place.
 *
 * Pages are white sheets 12 apart on the panel's ground, all as wide as the
 * view less 16 either side times the zoom (0.5 to 3, in tenths), and only the
 * ones within a screen of what is on show are drawn. A pill at the bottom end
 * holds zoom out, the percentage, zoom in, fit width and "page / pages".
 *
 * Selecting text brings up the annotation box at the pointer: its arrow sends
 * the note at once, prefixed with the page, carrying the annotation; its other
 * button only adds it to the box. Waiting annotations are framed on their page
 * with their number; a chip click flashes the frame, and a sent message's chip
 * opens the file and finds the passage again.
 */
const props = defineProps<{ data: string; path: string; name: string }>()
const app = useApp()
const store = useAnnotations()

const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.1
const GAP = 12
const PAD = 16
const QUOTE_MAX = 400
const BADGE = 15

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

interface Size {
  width: number
  height: number
}

const doc = shallowRef<PDFDocumentProxy>()
const sizes = ref<Size[]>([])
const loading = ref(true)
const failed = ref<string>()
const zoom = ref(1)
const hostWidth = ref(0)
const scrollTop = ref(0)
const viewHeight = ref(0)
const scroller = ref<HTMLElement>()
const pageEls: (HTMLElement | undefined)[] = []
const layerEls: (HTMLElement | undefined)[] = []

const pageWidth = computed(() => Math.max(60, (hostWidth.value - PAD * 2) * zoom.value))
function scaleOf(index: number) {
  const size = sizes.value[index]
  return size ? pageWidth.value / size.width : 1
}

const layout = computed(() => {
  let top = PAD
  return sizes.value.map((size, index) => {
    const height = size.height * scaleOf(index)
    const box = { top, height }
    top += height + GAP
    return box
  })
})

/* The page on show: the first whose foot is past a third of the view. */
const currentPage = computed(() => {
  const line = scrollTop.value + viewHeight.value / 3
  const index = layout.value.findIndex((box) => box.top + box.height > line)
  return index < 0 ? layout.value.length : index + 1
})

/* Drawn: the pages within a screen above and below what is on show. */
const near = computed(() => {
  const from = scrollTop.value - viewHeight.value
  const to = scrollTop.value + viewHeight.value * 2
  const out: number[] = []
  layout.value.forEach((box, index) => {
    if (box.top + box.height >= from && box.top <= to) out.push(index)
  })
  return out
})

let task: PDFDocumentLoadingTask | undefined

async function load() {
  loading.value = true
  failed.value = undefined
  release()
  const mine = {}
  loadToken = mine
  try {
    const lib = await library()
    const binary = atob(props.data)
    const bytes = new Uint8Array(binary.length)
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at)
    task = lib.getDocument({
      data: bytes,
      cMapUrl: assets("cmaps"),
      cMapPacked: true,
      standardFontDataUrl: assets("standard_fonts"),
      wasmUrl: assets("wasm"),
      iccUrl: assets("iccs"),
      isEvalSupported: false,
    })
    const pdf = await task.promise
    if (loadToken !== mine) return void pdf.destroy()
    const next: Size[] = []
    for (let number = 1; number <= pdf.numPages; number++) {
      const viewport = (await pdf.getPage(number)).getViewport({ scale: 1 })
      next.push({ width: viewport.width, height: viewport.height })
    }
    if (loadToken !== mine) return void pdf.destroy()
    doc.value = pdf
    sizes.value = next
  } catch (err) {
    if (loadToken === mine) failed.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (loadToken === mine) loading.value = false
  }
  await nextTick()
  measure()
  schedule()
  void handleJump()
}
let loadToken: object | undefined

interface Drawn {
  scale: number
  canvas?: RenderTask
  text?: TextLayer
}
const drawn = new Map<number, Drawn>()

function release() {
  for (const state of drawn.values()) {
    state.canvas?.cancel()
    state.text?.cancel()
  }
  drawn.clear()
  for (const layer of layerEls) layer?.replaceChildren()
  const old = doc.value
  doc.value = undefined
  sizes.value = []
  void task?.destroy()
  task = undefined
  void old?.destroy()
}

async function draw(index: number) {
  const pdf = doc.value
  const layer = layerEls[index]
  if (!pdf || !layer) return
  const scale = scaleOf(index)
  const previous = drawn.get(index)
  if (previous && Math.abs(previous.scale - scale) < 1e-6) return
  previous?.canvas?.cancel()
  previous?.text?.cancel()
  const state: Drawn = { scale }
  drawn.set(index, state)
  const lib = await library()
  const page = await pdf.getPage(index + 1)
  if (drawn.get(index) !== state) return
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
  const links = document.createElement("div")
  links.className = "pdf-links"
  try {
    await Promise.all([state.canvas.promise, state.text.render()])
    for (const item of await page.getAnnotations({ intent: "display" })) {
      if (item.subtype !== "Link" || typeof item.url !== "string") continue
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(item.rect)
      const link = document.createElement("a")
      link.className = "pdf-link"
      link.dataset.url = item.url
      link.style.left = `${Math.min(x1, x2)}px`
      link.style.top = `${Math.min(y1, y2)}px`
      link.style.width = `${Math.abs(x2 - x1)}px`
      link.style.height = `${Math.abs(y2 - y1)}px`
      links.append(link)
    }
  } catch {
    return // cancelled by a newer drawing, or the document went away
  }
  if (drawn.get(index) !== state) return
  layer.replaceChildren(canvas, text, links)
}

/* Pages far from the view give their drawing back. */
function forget(keep: Set<number>) {
  const from = scrollTop.value - viewHeight.value * 3
  const to = scrollTop.value + viewHeight.value * 4
  for (const index of [...drawn.keys()]) {
    const box = layout.value[index]
    if (keep.has(index) || (box && box.top + box.height >= from && box.top <= to)) continue
    const state = drawn.get(index)
    state?.canvas?.cancel()
    state?.text?.cancel()
    drawn.delete(index)
    layerEls[index]?.replaceChildren()
  }
}

let drawTimer: ReturnType<typeof setTimeout> | undefined
function schedule() {
  clearTimeout(drawTimer)
  drawTimer = setTimeout(() => {
    const indexes = near.value
    forget(new Set(indexes))
    for (const index of indexes) void draw(index)
  }, 30)
}

function measure() {
  const el = scroller.value
  if (!el) return
  hostWidth.value = el.clientWidth
  viewHeight.value = el.clientHeight
  scrollTop.value = el.scrollTop
}

const observer = new ResizeObserver(() => {
  measure()
  schedule()
})

function onScroll() {
  measure()
  schedule()
}

watch(pageWidth, () => {
  locateMarks.value = undefined
  schedule()
})

/* Zooming keeps the same place in the document on show. */
function setZoom(next: number) {
  const el = scroller.value
  const clamped = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) * 10) / 10
  if (!el || clamped === zoom.value) return
  const total = el.scrollHeight || 1
  const at = el.scrollTop / total
  zoom.value = clamped
  void nextTick(() => {
    el.scrollTop = at * el.scrollHeight
    measure()
  })
}

/* Links go out only to the web, mail and phone. */
function onClick(event: MouseEvent) {
  const link = (event.target as Element | null)?.closest<HTMLElement>(".pdf-link")
  if (!link) return
  event.preventDefault()
  const url = link.dataset.url ?? ""
  if (/^(https?:|mailto:|tel:)/i.test(url)) window.mcode.openExternal(url)
}

/* A selection in one page's text brings up the annotation box at the pointer. */
function onPointerUp(event: PointerEvent) {
  if (event.button !== 0) return
  const x = event.clientX
  const y = event.clientY
  setTimeout(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const selected = selection.toString()
    if (!selected.trim()) return
    const range = selection.getRangeAt(0)
    const within = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest<HTMLElement>(".textLayer")
    const layer = within(range.startContainer)
    if (!layer || layer !== within(range.endContainer)) return
    const pageEl = layer.closest<HTMLElement>("[data-pdf-page]")
    const index = Number(pageEl?.dataset.pdfPage ?? 0) - 1
    const size = sizes.value[index]
    if (!pageEl || !size) return
    const whole = collapse(selected)
    const { occ, occTotal } = occurrenceOf(layer, range, whole)
    const scale = scaleOf(index)
    const pageBox = pageEl.getBoundingClientRect()
    const box = range.getBoundingClientRect()
    const rect = {
      x: (box.left - pageBox.left) / scale,
      y: size.height - (box.bottom - pageBox.top) / scale,
      w: box.width / scale,
      h: box.height / scale,
      pageW: size.width,
      pageH: size.height,
    }
    const page = index + 1
    const make = (text: string): Annotation => ({
      id: annotationId(),
      kind: "pdf",
      path: props.path,
      name: props.name,
      page,
      quote: whole.slice(0, QUOTE_MAX),
      occ,
      occTotal,
      rect,
      text,
    })
    requestAnnotation({
      rect: { left: x, right: x, top: y, bottom: y },
      range: range.cloneRange(),
      make,
      sendNow: (text) => sendNow(make(text), page, text),
    })
  }, 0)
}

/* MiMo's send from a document: the note goes out now, marked with its page, with just this annotation. */
async function sendNow(note: Annotation, page: number, text: string): Promise<boolean> {
  const target = app.currentID
  if (!target) return store.add(HOME_SCOPE, note)
  if (app.busy) {
    notifyFailure(t("annotations.busy"))
    return false
  }
  const sent = await app.send(`${t("annotations.pdfPrefix", { page })}${text}`, [], undefined, [note])
  if (sent) {
    working.value = [...working.value, { id: note.id, page, rect: note.rect! }]
  }
  return sent
}

/* What was just sent keeps a soft pulse on its page until the reply is done. */
const working = ref<{ id: string; page: number; rect: NonNullable<Annotation["rect"]> }[]>([])
watch(
  () => app.busy,
  (busy) => {
    if (!busy) working.value = []
  },
)

/* Annotations waiting in any box that point into this file. */
const marks = computed(() => {
  const out: { id: string; n: number; page: number; rect: NonNullable<Annotation["rect"]> }[] = []
  for (const list of Object.values(store.byScope)) {
    list.forEach((note, index) => {
      if (note.kind === "pdf" && note.path === props.path && note.page && note.rect) {
        out.push({ id: note.id, n: index + 1, page: note.page, rect: note.rect })
      }
    })
  }
  return out
})

function boxOf(rect: NonNullable<Annotation["rect"]>, index: number) {
  const scale = scaleOf(index)
  const size = sizes.value[index]
  return {
    left: rect.x * scale,
    top: ((size?.height ?? rect.pageH) - rect.y - rect.h) * scale,
    width: rect.w * scale,
    height: rect.h * scale,
  }
}

function frameStyle(rect: NonNullable<Annotation["rect"]>, index: number) {
  const box = boxOf(rect, index)
  return { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }
}

/* The number sits on the frame's top-left corner, kept 6px inside the page. */
function badgeStyle(rect: NonNullable<Annotation["rect"]>, index: number) {
  const box = boxOf(rect, index)
  const width = pageWidth.value
  const height = layout.value[index]?.height ?? 0
  const left = Math.min(Math.max(box.left - 7, 6), Math.max(6, width - BADGE - 6))
  const top = Math.min(Math.max(box.top - 7, 6), Math.max(6, height - BADGE - 6))
  return { left: `${left}px`, top: `${top}px` }
}

const flashing = ref<string>()
let flashTimer: ReturnType<typeof setTimeout> | undefined
function flash(id: string) {
  flashing.value = id
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashing.value = undefined), 1200)
}

/* Where a sent message's passage was found again, in the page's own pixels. */
const locateMarks = ref<{ index: number; rects: { left: number; top: number; width: number; height: number }[] }>()

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function handleJump() {
  const jump = pdfJump.value
  const el = scroller.value
  if (!jump || !doc.value || !el || jump.seq <= handledJump || jump.note.path !== props.path) return
  handledJump = jump.seq
  const note = jump.note
  const index = Math.min(Math.max((note.page ?? 1) - 1, 0), sizes.value.length - 1)
  const box = layout.value[index]
  if (box) el.scrollTo({ top: box.top - 4, behavior: "smooth" })
  if (!jump.locate) {
    flash(note.id)
    return
  }
  // The page may still be drawing its text: look again for up to three seconds.
  for (let attempt = 0; attempt < 30; attempt++) {
    const layer = layerEls[index]?.querySelector<HTMLElement>(".textLayer")
    const range = layer && note.quote ? locate(layer, note.quote, note.occ) : null
    const pageEl = pageEls[index]
    if (range && pageEl) {
      const origin = pageEl.getBoundingClientRect()
      locateMarks.value = {
        index,
        rects: [...range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => ({ left: rect.left - origin.left, top: rect.top - origin.top, width: rect.width, height: rect.height })),
      }
      return
    }
    await sleep(100)
  }
}

watch(pdfJump, () => void handleJump())
watch(
  () => props.data,
  () => void load(),
)

onMounted(() => {
  if (scroller.value) observer.observe(scroller.value)
  measure()
  void load()
})

onBeforeUnmount(() => {
  observer.disconnect()
  clearTimeout(drawTimer)
  clearTimeout(flashTimer)
  loadToken = undefined
  release()
})

function setPage(index: number, el: unknown) {
  pageEls[index] = (el as HTMLElement | null) ?? undefined
}

function setLayer(index: number, el: unknown) {
  layerEls[index] = (el as HTMLElement | null) ?? undefined
  if (el) schedule()
}
</script>

<script lang="ts">
/* Shared by every view, so a chip click answered by one view is not answered again by the next one opened. */
let handledJump = 0
</script>

<template>
  <div class="pdf-view" data-pdf-view>
    <div ref="scroller" class="pdf-scroll" @scroll="onScroll" @click="onClick" @pointerup="onPointerUp">
      <div v-if="loading" class="pdf-note">{{ t("rp.pdf.loading") }}</div>
      <div v-else-if="failed" class="pdf-note" data-pdf-failed>{{ t("rp.pdf.failed", { err: failed }) }}</div>
      <div v-else class="pdf-pages">
        <div
          v-for="(size, index) in sizes"
          :key="index"
          :ref="(el) => setPage(index, el)"
          class="pdf-page"
          :data-pdf-page="index + 1"
          :style="{
            width: `${pageWidth}px`,
            height: `${layout[index]?.height ?? 0}px`,
            '--scale-factor': scaleOf(index),
          }"
        >
          <div :ref="(el) => setLayer(index, el)" class="pdf-layers" />
          <template v-for="mark in marks" :key="mark.id">
            <template v-if="mark.page === index + 1">
              <div class="pdf-mark" :class="{ flash: flashing === mark.id }" data-pdf-mark :style="frameStyle(mark.rect, index)" />
              <div class="pdf-badge" :class="{ flash: flashing === mark.id }" data-pdf-badge :style="badgeStyle(mark.rect, index)">{{ mark.n }}</div>
            </template>
          </template>
          <template v-for="item in working" :key="item.id">
            <div v-if="item.page === index + 1" class="pdf-mark working" data-pdf-working :style="frameStyle(item.rect, index)" />
          </template>
          <template v-if="locateMarks?.index === index">
            <div v-for="(rect, at) in locateMarks.rects" :key="at" class="pdf-locate" data-pdf-locate :style="{ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }" />
          </template>
        </div>
      </div>
    </div>

    <div v-if="!loading && !failed" class="pdf-toolbar" data-pdf-toolbar>
      <button type="button" class="pdf-tool" data-pdf-zoom-out :aria-label="t('rp.pdf.zoomOut')" v-tip="{ label: t('rp.pdf.zoomOut'), placement: 'top' }" @click="setZoom(zoom - ZOOM_STEP)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M20 20l-4-4" /></svg>
      </button>
      <span class="pdf-zoom" data-pdf-zoom>{{ Math.round(zoom * 100) }}%</span>
      <button type="button" class="pdf-tool" data-pdf-zoom-in :aria-label="t('rp.pdf.zoomIn')" v-tip="{ label: t('rp.pdf.zoomIn'), placement: 'top' }" @click="setZoom(zoom + ZOOM_STEP)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M8 11h6M11 8v6M20 20l-4-4" /></svg>
      </button>
      <button type="button" class="pdf-tool" data-pdf-fit :aria-label="t('rp.pdf.fitWidth')" v-tip="{ label: t('rp.pdf.fitWidth'), placement: 'top' }" @click="setZoom(1)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4" /></svg>
      </button>
      <span class="pdf-rule" aria-hidden="true" />
      <span class="pdf-indicator" data-pdf-page-indicator>{{ currentPage }} / {{ sizes.length }}</span>
    </div>
  </div>
</template>

<style scoped>
.pdf-view {
  position: relative;
  flex: 1;
  min-height: 0;
}

/* MiMo's document ground: the side colour, 16 in. */
.pdf-scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
  background: var(--surface-base);
}

.pdf-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: max-content;
  min-width: 100%;
  padding: 16px;
  box-sizing: border-box;
}

/* A sheet: white, a soft shadow; the pdf.js layers take its size through --scale-factor. */
.pdf-page {
  --user-unit: 1;
  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
  --scale-round-x: 1px;
  --scale-round-y: 1px;
  position: relative;
  flex: none;
  overflow: hidden;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
}

.pdf-layers {
  position: absolute;
  inset: 0;
}

.pdf-note {
  padding: 24px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
}

/* A waiting annotation: a 2px accent frame on a faint fill, its number on the corner. */
.pdf-mark {
  position: absolute;
  z-index: 3;
  box-sizing: border-box;
  background: color-mix(in srgb, var(--interactive) 8%, transparent);
  border: 2px solid var(--interactive);
  border-radius: 3px;
  pointer-events: none;
  transition: background-color 200ms ease;
}

.pdf-mark.flash {
  background: color-mix(in srgb, var(--interactive) 22%, transparent);
}

.pdf-mark.working {
  animation: pdf-working 1.6s ease-in-out infinite;
}

@keyframes pdf-working {
  0%,
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--interactive) 45%, transparent);
  }
  50% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--interactive) 0%, transparent);
  }
}

.pdf-badge {
  position: absolute;
  z-index: 4;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  color: #fff;
  background: var(--interactive);
  border-radius: 999px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  pointer-events: none;
  transition:
    transform 200ms ease,
    box-shadow 200ms ease;
}

.pdf-badge.flash {
  transform: scale(1.25);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--interactive) 35%, transparent);
}

/* A sent message's passage, found again: MiMo's amber. */
.pdf-locate {
  position: absolute;
  z-index: 3;
  background: rgba(250, 173, 20, 0.25);
  border: 1px solid #d48806;
  pointer-events: none;
}

/* MiMo's floating pill: bottom end, 4 by 10, a 1px line, 24px buttons. */
.pdf-toolbar {
  position: absolute;
  inset-inline-end: 14px;
  bottom: 12px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 10px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 999px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.14);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
}

.pdf-tool {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 6px;
}

.pdf-tool:hover {
  background: var(--surface-hover);
}

.pdf-zoom {
  min-width: 38px;
  text-align: center;
}

.pdf-rule {
  align-self: stretch;
  margin-inline: 6px;
  border-inline-start: 1px solid var(--border-weak);
}

@media (prefers-reduced-motion: reduce) {
  .pdf-mark.working {
    animation: none;
  }
}
</style>

<style>
/* pdf.js's own text and link layers, which it builds outside the template. */
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

.pdf-view .textLayer ::selection {
  background: color-mix(in srgb, AccentColor, transparent 75%);
}

.pdf-view .textLayer br::selection {
  background: transparent;
}

.pdf-view .pdf-links {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}

.pdf-view .pdf-link {
  position: absolute;
  cursor: pointer;
  pointer-events: auto;
}
</style>
