<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { Annotation } from "@shared/protocol"
import { useApp } from "../../stores/app"
import { useAnnotations } from "../../stores/annotations"
import { useAnnotationBatch } from "../../stores/annotation-batch"
import { useOfficeVersions } from "../../stores/office-versions"
import { annotationFlash, annotationId, compact, mainAnnotationScope, normalize } from "../../lib/annotate"
import { sendAnnotationNow } from "../../lib/annotation-send"
import { useAnnotationFx, watchedFilesOf, type FxBox } from "../../lib/annotation-fx"
import { aiTouch } from "../../lib/ai-touch"
import {
  diffSummary,
  loadDocx,
  mapParagraphIndex,
  paragraphTexts,
  parseComments,
  parseRevisions,
  partOf,
  themeEastAsia,
  type DocComment,
  type Revision,
} from "../../lib/docx-parse"
import { notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"
import CellAffordance from "../CellAffordance.vue"
import AnnotationFx from "../AnnotationFx.vue"
import AnnotationMarkLayer, { type MarkItem } from "../AnnotationMarkLayer.vue"
import LucideIcon from "../LucideIcon.vue"

/**
 * MiMo's Word view: docx-preview draws the pages (tracked changes on, comments
 * highlighted where the browser can), a fidelity pass fixes fonts and symbols,
 * and pages without a size of their own get A4 and Word's margins. Zoom scales
 * the pages from a fit that never goes past 100%. Deletions and anchored
 * comments are listed in a 260px rail beside the pages once the view is 700
 * wide, each card tied to its paragraph by a bar and a dashed elbow;
 * insertions show in the text, with who and when on hover.
 *
 * Selecting text opens the note box above the selection: send posts the
 * annotation at once (the passage glows while the reply runs, and the version
 * it produces is recorded with what was asked and what changed); "add to chat"
 * puts it in the box. The file reloads when it changes on disk, keeping its
 * place, and annotations follow their paragraphs across an edit.
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

const FIT_PAD = 30
const RAIL_WIDTH = 260
const RAIL_MIN_VIEW = 700
const CARD_GAP = 8
const CARD_DEFAULT = 68

const wrap = ref<HTMLElement>()
const scroller = ref<HTMLElement>()
const docHost = ref<HTMLElement>()

const loading = ref(true)
const restoring = ref(false)
const error = ref<string | null>(null)
const reloadNonce = ref(0)
const zoom = ref(1)
const pageWidth = ref(0)

let generation = 0
let lastBase64 = ""
let lastPath = ""
let lastStat: { size: number; mtimeMs: number } | undefined
let saved: { path: string; top: number } | null = null

/* The folder keeps its trailing separator: "D:" alone resolves to the current directory on that drive, "D:\" to its root. */
const splitPath = () => {
  const cut = Math.max(props.path.lastIndexOf("/"), props.path.lastIndexOf("\\"))
  return [props.path.slice(0, cut + 1), props.path.slice(cut + 1)] as const
}

/* The watcher answers with whichever spelling it was asked with; slashes and case still name one file. */
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase()

const platform = (): "darwin" | "win32" | "linux" => (/Mac/i.test(navigator.userAgent) ? "darwin" : /Windows/i.test(navigator.userAgent) ? "win32" : "linux")

function decode(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at)
  return bytes
}

function unhide() {
  if (scroller.value) scroller.value.style.visibility = ""
}

function clearCommentHighlight() {
  if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete("docx-comments")
}

/* ------------------------------------------------------------ loading */

async function load() {
  const mine = ++generation
  if (saved && saved.path === props.path && saved.top > 0) {
    restoring.value = true
    if (scroller.value) scroller.value.style.visibility = "hidden"
  }
  error.value = null
  loading.value = true
  hideNote()
  pageWidth.value = 0
  const [dir, base] = splitPath()
  const read = await window.mcode.readFileBytes(dir, base)
  if (mine !== generation) return
  if (!read.ok || read.unchanged) {
    const reason = read.ok ? "" : read.reason
    // As MiMo, and as the slide and sheet views: a missing file is named, any other reason is the server's failure.
    error.value = reason === "noent" ? t("office.fileMissing") : t("office.serveFailed")
    loading.value = false
    restoring.value = false
    unhide()
    return
  }
  const previous = lastPath === props.path ? lastBase64 : ""
  lastBase64 = read.base64
  lastPath = props.path
  lastStat = { size: read.size, mtimeMs: read.mtimeMs }
  try {
    const docx = await import("docx-preview")
    const host = docHost.value
    if (!host || mine !== generation) return
    host.innerHTML = ""
    const bytes = decode(read.base64)
    // docx-preview sets one global comment highlight per render and never drops it; the old ranges would outlive their pages.
    clearCommentHighlight()
    await docx.renderAsync(bytes, host, undefined, {
      ignoreLastRenderedPageBreak: false,
      renderAltChunks: false,
      renderChanges: true,
      renderComments: typeof CSS !== "undefined" && "highlights" in CSS,
    })
    if (mine !== generation) return
    void readStructure(bytes, mine)
    for (const section of host.querySelectorAll<HTMLElement>(".docx-wrapper section.docx")) {
      if (!section.style.width) {
        section.style.width = "595.3pt"
        if (!section.style.minHeight) section.style.minHeight = "841.9pt"
      }
      if (!section.style.padding && !section.style.paddingTop && !section.style.paddingLeft && !section.style.paddingRight && !section.style.paddingBottom) {
        section.style.padding = "72pt 90pt"
      }
    }
    try {
      const [fidelity, zip] = await Promise.all([
        import("../../lib/docx-fidelity"),
        loadDocx(bytes),
        import("@fontsource/carlito/400.css"),
        import("@fontsource/carlito/700.css"),
        import("@fontsource/carlito/400-italic.css"),
        import("@fontsource/carlito/700-italic.css"),
        import("@fontsource/caladea/400.css"),
        import("@fontsource/caladea/700.css"),
        import("@fontsource/caladea/400-italic.css"),
        import("@fontsource/caladea/700-italic.css"),
      ])
      await fidelity.patchDocxFidelity(host, platform(), await themeEastAsia(zip))
    } catch (err) {
      console.warn("[DocxView] fidelity patch failed:", err)
    }
    if (mine !== generation) return
    const { ai, prompt } = aiTouch(props.path, 60_000)
    await versions.init(props.path, read.base64, { assumeAi: ai, note: ai ? prompt.trim() : t("office.versionNoteExternal") })
    // A newer load owns the scroll restore and the marks from here.
    if (mine !== generation) return
    loading.value = false
    const top = saved && saved.path === props.path && saved.top > 0 ? saved.top : null
    saved = null
    if (top !== null && scroller.value) stopRestore = restoreScroll(scroller.value, top)
    if (restoring.value) {
      setTimeout(() => {
        unhide()
        restoring.value = false
      }, 16)
    }
    await nextTick()
    if (mine !== generation) return
    await reresolve(previous, read.base64)
    if (mine !== generation) return
    measurePage()
    refreshMarks()
  } catch (err) {
    if (mine !== generation) return
    unhide()
    restoring.value = false
    loading.value = false
    console.error("[DocxView] render failed:", err)
    emit("fallback")
  }
}

let stopRestore: (() => void) | undefined
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
  stopRestore?.()
  reloadNonce.value += 1
}

watch([() => props.path, reloadNonce, () => versions.reloadTick[props.path] ?? 0], (next, before) => {
  if (next[0] !== before[0]) {
    zoom.value = 1
    if (before[0]) void window.mcode.unwatchFile(before[0])
    void window.mcode.watchFile(next[0])
  } else if (next[2] !== before[2] && scroller.value) saved = { path: props.path, top: scroller.value.scrollTop }
  void load()
})

/* ------------------------------------------------------------ zoom */

function measurePage() {
  const wrapper = docHost.value?.querySelector<HTMLElement>(".docx-wrapper")
  const section = wrapper?.querySelector<HTMLElement>("section.docx")
  if (!wrapper || !section) return
  wrapper.style.zoom = "1"
  pageWidth.value = section.getBoundingClientRect().width
  applyZoom()
}

/* A scrollbar coming and going moves the width by its own thickness; refitting on that flickers between two zooms. */
const FIT_SLACK = 20
let fitWidth = 0
const hostWidth = () => docHost.value?.clientWidth || scroller.value?.clientWidth || 0
const refits = (width: number) => !fitWidth || Math.abs(width - fitWidth) > FIT_SLACK

function applyZoom() {
  const wrapper = docHost.value?.querySelector<HTMLElement>(".docx-wrapper")
  if (!wrapper) return
  const width = hostWidth()
  if (refits(width)) fitWidth = width
  const fit = pageWidth.value > 0 && fitWidth > 0 ? Math.min(1, fitWidth / (pageWidth.value + 2 * FIT_PAD)) : 1
  wrapper.style.zoom = String(fit * zoom.value)
  void nextTick(() => {
    measureRail()
    refreshMarks()
  })
}

function setZoom(next: number) {
  const value = Math.round(next * 10) / 10
  zoom.value = Number.isFinite(value) ? Math.min(Math.max(value, 0.5), 3) : 1
}

watch(zoom, applyZoom)

/* ------------------------------------------------------------ revisions and comments */

const revisions = ref<Revision[]>([])
const comments = ref<DocComment[]>([])
const anchored = ref<Map<string, HTMLElement>>(new Map())
const railOpen = ref(false)
const expanded = ref<Set<string>>(new Set())

async function readStructure(bytes: Uint8Array, mine: number) {
  try {
    const zip = await loadDocx(bytes)
    const documentXml = await partOf(zip, "word/document.xml")
    const commentsXml = await partOf(zip, "word/comments.xml")
    if (mine !== generation) return
    const parsed = parseRevisions(documentXml)
    const dom = [...(docHost.value?.querySelectorAll<HTMLElement>(".docx-wrapper ins, .docx-wrapper del") ?? [])]
    const tagged = Math.min(parsed.length, dom.length)
    if (parsed.length !== dom.length) console.warn(`[DocxView] revision count mismatch: xml ${parsed.length}, dom ${dom.length}`)
    for (let at = 0; at < tagged; at++) dom[at].dataset.revIdx = String(at)
    revisions.value = parsed
    comments.value = commentsXml ? parseComments(commentsXml, documentXml) : []
    await nextTick()
    anchorRevisions()
  } catch (err) {
    console.warn("[DocxView] revisions parse failed:", err)
  }
}

/* Paragraphs holding a change or a comment, and where each comment hangs. */
function anchorRevisions() {
  const host = docHost.value
  if (!host) return
  host.querySelectorAll(".docx-revision-line").forEach((element) => element.classList.remove("docx-revision-line"))
  host.querySelectorAll<HTMLElement>(".docx-wrapper ins, .docx-wrapper del").forEach((element) => element.closest("p")?.classList.add("docx-revision-line"))
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_COMMENT)
  const refs = new Map<string, HTMLElement>()
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const id = (node.nodeValue ?? "").match(/comment #(\S+) by/)?.[1]
    if (!id) continue
    let sibling = node.nextSibling
    while (sibling && sibling.nodeType !== Node.ELEMENT_NODE) sibling = sibling.nextSibling
    const element = sibling as HTMLElement | null
    if (element?.classList.contains("docx-comment-ref")) {
      element.dataset.commentId = id
      if (!refs.has(id)) refs.set(id, element)
    }
  }
  const paragraphs = [...host.querySelectorAll<HTMLElement>(".docx-wrapper section.docx p")]
  const allRefs = [...host.querySelectorAll<HTMLElement>(".docx-comment-ref")]
  const found = new Map<string, HTMLElement>()
  for (const comment of comments.value) {
    let paragraph: HTMLElement | undefined
    const needle = comment.rangeText.slice(0, 30).replace(/\s+/g, "")
    if (needle.length >= 4) paragraph = paragraphs.find((p) => (p.textContent ?? "").replace(/\s+/g, "").includes(needle))
    paragraph ??= refs.get(comment.id)?.closest("p") ?? undefined
    if (!paragraph && comment.referenceIndex >= 0) paragraph = allRefs[comment.referenceIndex]?.closest("p") ?? undefined
    if (!paragraph && comment.paragraphIndex >= 0) paragraph = paragraphs[comment.paragraphIndex]
    if (paragraph) {
      paragraph.classList.add("docx-revision-line")
      found.set(comment.id, paragraph)
    }
  }
  anchored.value = found
  updateRailOpen()
  void nextTick(measureRail)
}

const eligible = computed(
  () =>
    revisions.value.some((revision) => revision.type === "del") ||
    (comments.value.length > 0 && (anchored.value.size > 0 || comments.value.some((comment) => comment.rangeText || comment.paragraphIndex >= 0))),
)

function updateRailOpen() {
  if (eligible.value) railOpen.value = (wrap.value?.clientWidth ?? 0) >= RAIL_MIN_VIEW
}

interface RailItem {
  key: string
  type: "del" | "cmt"
  author: string
  date: string
  text: string
  top: number
  anchor?: HTMLElement
  source?: HTMLElement
  range?: Range
}

const railItems = ref<RailItem[]>([])
const railShown = computed(() => railOpen.value && railItems.value.length > 0)
const placed = ref<Record<string, number>>({})
const bars = ref<{ key: string; x: number; y1: number; y2: number }[]>([])
const elbows = ref<{ key: string; d: string }[]>([])
const cardEls = new Map<string, HTMLElement>()

function contentTop(element: Element) {
  const el = scroller.value
  if (!el) return 0
  return element.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
}

function measureRail() {
  const host = docHost.value
  if (!host) return
  const items: RailItem[] = []
  revisions.value.forEach((revision, index) => {
    if (revision.type !== "del") return
    const del = host.querySelector<HTMLElement>(`del[data-rev-idx="${index}"]`)
    const anchor = (del?.closest("p") as HTMLElement | null) ?? del ?? undefined
    const rect = anchor?.getBoundingClientRect()
    items.push({
      key: `del:${revision.domIndex}`,
      type: "del",
      author: revision.author,
      date: revision.date,
      text: revision.text,
      top: anchor && rect && (rect.width || rect.height) ? contentTop(anchor) : Number.POSITIVE_INFINITY,
      anchor,
      source: del ?? undefined,
    })
  })
  for (const comment of comments.value) {
    const paragraph = anchored.value.get(comment.id)
    if (!paragraph) continue
    let range: Range | undefined
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_COMMENT)
    let start: Node | null = null
    let end: Node | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue?.includes(`start of comment #${comment.id}`)) start = node
      if (node.nodeValue?.includes(`end of comment #${comment.id}`)) end = node
    }
    if (start && end) {
      range = document.createRange()
      range.setStartAfter(start)
      range.setEndBefore(end)
    }
    items.push({
      key: `cmt:${comment.id}`,
      type: "cmt",
      author: comment.author,
      date: comment.date,
      text: comment.text,
      top: contentTop(paragraph),
      anchor: paragraph,
      source: host.querySelector<HTMLElement>(`.docx-comment-ref[data-comment-id="${comment.id}"]`) ?? paragraph,
      range,
    })
  }
  items.sort((a, b) => a.top - b.top)
  railItems.value = items
  void nextTick(layoutRail)
}

function layoutRail() {
  const el = scroller.value
  const host = docHost.value
  if (!el || !host || !railShown.value) {
    bars.value = []
    elbows.value = []
    return
  }
  const box = el.getBoundingClientRect()
  const next: Record<string, number> = {}
  const nextBars: typeof bars.value = []
  const nextElbows: typeof elbows.value = []
  const hostRect = host.getBoundingClientRect()
  const corridor = hostRect.width > 0 ? hostRect.right - box.left + el.scrollLeft - 1 : el.clientWidth - RAIL_WIDTH + el.scrollLeft
  let bottom = -Infinity
  for (const item of railItems.value) {
    const height = cardEls.get(item.key)?.offsetHeight || CARD_DEFAULT
    const desired = Number.isFinite(item.top) ? item.top : bottom + CARD_GAP
    const top = Math.max(desired, bottom + CARD_GAP)
    next[item.key] = top
    bottom = top + height
    const anchorRect = item.anchor?.getBoundingClientRect()
    if (!anchorRect || (!anchorRect.width && !anchorRect.height)) continue
    nextBars.push({ key: item.key, x: corridor, y1: top, y2: top + height })
    const lastRect = (rects: DOMRectList | DOMRect[] | undefined) => [...(rects ?? [])].filter((rect) => rect.width || rect.height).at(-1)
    const contents = item.anchor ? (() => {
      const range = document.createRange()
      range.selectNodeContents(item.anchor)
      return range
    })() : undefined
    const start = lastRect(item.range?.getClientRects()) ?? lastRect(contents?.getClientRects()) ?? lastRect(item.source?.getClientRects()) ?? anchorRect
    const sx = start.right - box.left + el.scrollLeft
    const sy = start.bottom - box.top + el.scrollTop
    nextElbows.push({ key: item.key, d: `M ${sx} ${sy} H ${Math.max(sx + 8, corridor - 20)} L ${corridor} ${top}` })
  }
  const same = (a: number, b: number) => Math.abs(a - b) <= 0.5
  const changed =
    Object.keys(next).some((key) => !same(next[key], placed.value[key] ?? Number.NaN)) ||
    nextBars.length !== bars.value.length ||
    nextBars.some((bar, at) => !same(bar.x, bars.value[at]?.x ?? Number.NaN) || !same(bar.y1, bars.value[at]?.y1 ?? Number.NaN)) ||
    nextElbows.some((elbow, at) => elbow.d !== elbows.value[at]?.d)
  if (!changed) return
  placed.value = next
  bars.value = nextBars
  elbows.value = nextElbows
}

watch(railShown, () => void nextTick(layoutRail))

function setCard(key: string, el: unknown) {
  if (el) cardEls.set(key, el as HTMLElement)
  else cardEls.delete(key)
}

function toggleCard(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
  void nextTick(layoutRail)
}

function dateText(raw: string) {
  if (!raw) return ""
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* Who inserted a passage, and when, on hover. */
const insTip = ref<{ left: number; top: number; author: string; date: string; text: string } | null>(null)

function onOver(event: MouseEvent) {
  const ins = (event.target as Element | null)?.closest?.<HTMLElement>("ins[data-rev-idx]")
  const el = scroller.value
  if (!ins || !el) return
  const revision = revisions.value[Number(ins.dataset.revIdx)]
  const rect = ins.getBoundingClientRect()
  if (!revision || revision.type !== "ins" || (!rect.width && !rect.height)) return
  const box = el.getBoundingClientRect()
  let left = rect.right - box.left + 10
  if (left + 320 > box.width) left = Math.max(0, rect.left - box.left - 330)
  insTip.value = { left, top: Math.max(4, rect.top - box.top), author: revision.author, date: dateText(revision.date), text: revision.text }
}

function onOut(event: MouseEvent) {
  const next = (event.relatedTarget as Element | null)?.closest?.("ins[data-rev-idx]")
  if (!next) insTip.value = null
}

/* ------------------------------------------------------------ the note box */

const noteOpen = ref(false)
const noteAnchor = ref<{ x: number; y: number }>({ x: 0, y: 0 })
const noteRect = ref<{ top: number; bottom: number; right: number } | null>(null)
const noteText = ref("")
const editing = ref(false)
let selectedText = ""
let selectedRange: Range | null = null
let dragPointer: number | null = null

function hideNote() {
  selectedText = ""
  selectedRange = null
  editing.value = false
  noteText.value = ""
  noteOpen.value = false
}

function openFromSelection(anchor: { x: number; y: number } | null) {
  setTimeout(() => {
    const selection = window.getSelection()
    const text = (selection?.toString() || "").trim()
    if (noteOpen.value) noteText.value = ""
    if (!text || !selection?.rangeCount) {
      hideNote()
      return
    }
    selectedText = text
    editing.value = false
    selectedRange = selection.getRangeAt(0).cloneRange()
    const rect = selectedRange.getBoundingClientRect()
    noteRect.value = { top: rect.top, bottom: rect.bottom, right: rect.right }
    noteAnchor.value = anchor ?? { x: rect.right, y: rect.top }
    noteOpen.value = true
  }, 0)
}

function onPointerUp(event: PointerEvent) {
  if ((event.target as Element | null)?.closest?.("[data-cell-affordance]")) return
  dragPointer = null
  openFromSelection({ x: event.clientX, y: event.clientY })
}

function onDocDown(event: PointerEvent) {
  if (!noteOpen.value) return
  const target = event.target as Element | null
  if (target?.closest?.("[data-cell-affordance]")) return
  if (wrap.value?.contains(target)) {
    dragPointer = event.pointerId
    editing.value = false
  } else hideNote()
}

function onDocUp(event: PointerEvent) {
  if (dragPointer !== event.pointerId) return
  dragPointer = null
  if (!wrap.value?.contains(event.target as Node)) openFromSelection(null)
}

function onDocCancel(event: PointerEvent) {
  if (dragPointer === event.pointerId) {
    dragPointer = null
    hideNote()
  }
}

/* While the note has focus, the passage stays lit though the selection goes. */
watch([editing, noteOpen], ([isEditing, open]) => {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return
  if (isEditing && open && selectedRange) {
    CSS.highlights.set("docx-editing", new Highlight(selectedRange))
    window.getSelection()?.removeAllRanges()
  } else CSS.highlights.delete("docx-editing")
})

function onWheel() {
  if (noteOpen.value) hideNote()
}

interface Kept {
  range: Range | null
  selectedText: string
  paraIndex: number
  paraText: string
  occ: number
}
const kept = new Map<string, Kept>()

const sections = () => [...(docHost.value?.querySelectorAll<HTMLElement>(".docx-wrapper section.docx") ?? [])]
const textParagraphs = () => [...(scroller.value?.querySelectorAll<HTMLElement>("p") ?? [])].filter((p) => (p.innerText ?? "").trim())
const elementOf = (node: Node | null | undefined) => (node instanceof Element ? node : node?.parentElement ?? null)

function anchorOfSelection(): { occ: number; occTotal: number; page?: number; rect?: NonNullable<Annotation["rect"]> } {
  const range = selectedRange
  const root = scroller.value
  if (!range || !root) return { occ: 1, occTotal: 0 }
  const text = normalize(root)
  let index = -1
  for (let at = 0; at < text.map.length; at++) {
    const probe = document.createRange()
    probe.setStart(text.map[at].node, text.map[at].offset)
    if (probe.compareBoundaryPoints(Range.START_TO_START, range) >= 0) {
      index = at
      break
    }
  }
  const needle = compact(selectedText)
  const found: number[] = []
  if (needle) for (let at = text.norm.indexOf(needle); at >= 0; at = text.norm.indexOf(needle, at + 1)) found.push(at)
  let occurrence = { occ: 1, occTotal: found.length }
  if (found.length && index >= 0) {
    let occ = 1
    for (let at = 0; at < found.length && found[at] <= index; at++) occ = at + 1
    occurrence = { occ, occTotal: found.length }
  }
  const pages = sections()
  const section = elementOf(range.startContainer)?.closest<HTMLElement>("section.docx")
  const page = section ? pages.indexOf(section) + 1 : 0
  if (!section || page <= 0) return occurrence
  const box = range.getBoundingClientRect()
  const pageBox = section.getBoundingClientRect()
  return {
    ...occurrence,
    page,
    rect: { x: box.left - pageBox.left, y: box.top - pageBox.top, w: box.width, h: box.height, pageW: pageBox.width, pageH: pageBox.height },
  }
}

function paragraphRecord(range: Range, text: string, occ: number): Kept {
  const paragraph = elementOf(range.startContainer)?.closest("p") as HTMLElement | null
  const list = textParagraphs()
  const paraIndex = paragraph ? list.indexOf(paragraph) : -1
  let within = occ
  if (paragraph) {
    const lead = document.createRange()
    lead.setStart(paragraph, 0)
    lead.setEnd(range.startContainer, range.startOffset)
    const offset = lead.toString().length
    const full = paragraph.textContent ?? ""
    const needle = text.trim()
    let last = 0
    let count = 0
    for (let at = full.indexOf(needle); at >= 0 && at <= offset; at = full.indexOf(needle, at + 1)) {
      count += 1
      last = count
    }
    within = Math.max(1, last)
  }
  return { range: range.cloneRange(), selectedText: text, paraIndex, paraText: paragraph?.innerText.trim() ?? "", occ: within }
}

function buildNote(userText: string): Annotation {
  const where = anchorOfSelection()
  const folded = selectedText.replace(/\s+/g, " ").trim()
  return {
    id: annotationId(),
    kind: "docx",
    path: props.path,
    name: props.name,
    quote: folded ? (folded.length > 400 ? `${folded.slice(0, 400)}…` : folded) : "(空)",
    occ: where.occ,
    occTotal: where.occTotal,
    ...(where.page ? { page: where.page } : {}),
    ...(where.rect ? { rect: where.rect } : {}),
    text: userText.trim(),
  }
}

let localConvo: string | null = null
let localNote = ""
let deferReload = false

async function sendNote() {
  const comment = noteText.value.trim()
  // Copied before the send: hideNote() (a click away, a reload) may clear the module's selection while it is out.
  const text = selectedText
  const range = selectedRange
  if (!comment || !text || !range) {
    hideNote()
    return
  }
  const note = buildNote(comment)
  const result = await sendAnnotationNow(note, props.path, `【Word 文档】${comment}`, { origin: props.origin })
  if (!result.ok) {
    if (result.reason) notifyFailure(result.reason)
    return
  }
  localNote = `【选中文本】${comment}`
  localConvo = result.convoId ?? null
  if (range.startContainer.isConnected) kept.set(note.id, paragraphRecord(range, text, note.occ ?? 1))
  batch.setBatch([{ id: note.id, num: 0, kind: note.kind, path: props.path, name: props.name }])
  hideNote()
}

function stashNote() {
  if (!selectedText || !selectedRange) {
    hideNote()
    return
  }
  const note = buildNote(noteText.value)
  if (!annotations.add(mainAnnotationScope.value, note)) return
  kept.set(note.id, paragraphRecord(selectedRange, selectedText, note.occ ?? 1))
  hideNote()
}

/* After a reload, each passage is found again: its paragraph followed across the edit, then its text within it. */
async function reresolve(previous: string, next: string) {
  const ids = new Set([
    ...annotations.list(mainAnnotationScope.value).filter((note) => note.path === props.path).map((note) => note.id),
    ...(batch.byFile[props.path] ?? []).map((item) => item.id),
  ])
  let before: string[] | null = null
  let after: string[] | null = null
  if (previous && next && previous !== next) {
    try {
      const [oldZip, newZip] = await Promise.all([loadDocx(decode(previous)), loadDocx(decode(next))])
      before = paragraphTexts(await partOf(oldZip, "word/document.xml"))
      after = paragraphTexts(await partOf(newZip, "word/document.xml"))
    } catch {
      before = after = null
    }
  }
  const list = textParagraphs()
  for (const [id, record] of kept) {
    if (!ids.has(id)) continue
    const mapped = record.paraIndex < 0 ? null : before && after ? mapParagraphIndex(before, after, record.paraIndex) : record.paraIndex
    const paragraph = mapped === null ? undefined : list[mapped]
    if (!paragraph || mapped === null) {
      kept.set(id, { ...record, range: null })
      continue
    }
    const nodes: Text[] = []
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
    const full = nodes.map((node) => node.data).join("")
    const needle = record.selectedText.trim()
    const found: number[] = []
    if (needle) for (let at = full.indexOf(needle); at >= 0; at = full.indexOf(needle, at + 1)) found.push(at)
    let range: Range
    if (found.length) {
      const start = found[Math.min(Math.max(record.occ, 1), found.length) - 1]
      const end = start + needle.length
      range = document.createRange()
      let offset = 0
      for (const node of nodes) {
        const next = offset + node.data.length
        if (start >= offset && start <= next && range.startContainer === document) range.setStart(node, start - offset)
        if (end >= offset && end <= next) {
          range.setEnd(node, end - offset)
          break
        }
        offset = next
      }
    } else {
      range = document.createRange()
      range.selectNodeContents(paragraph)
    }
    kept.set(id, { ...record, range, paraIndex: mapped })
  }
}

/* ------------------------------------------------------------ marks, flash, working light */

const fx = useAnnotationFx(() => props.path)
const marks = ref<MarkItem[]>([])
const fxBoxes = ref<FxBox[]>([])
const flashId = ref<string | null>(null)

function rectsOf(range: Range) {
  const origin = wrap.value?.getBoundingClientRect()
  if (!origin) return []
  const out: MarkItem["rects"] = []
  for (const rect of range.getClientRects()) {
    if (rect.width < 2 || rect.height < 2) continue
    out.push({ left: rect.left - origin.left, top: rect.top - origin.top, w: rect.width, h: rect.height })
    if (out.length >= 80) break
  }
  return out
}

function refreshMarks() {
  const waiting = annotations.list(mainAnnotationScope.value)
  const own = waiting.map((note, index) => ({ note, num: index + 1 })).filter((entry) => entry.note.path === props.path).map((entry) => ({ id: entry.note.id, num: entry.num }))
  const items = own.length ? own : (batch.byFile[props.path] ?? []).map((item) => ({ id: item.id, num: item.num }))
  const lit = fx.phase.value ? new Set(fx.annotatedIds.value) : new Set<string>()
  const nextMarks: MarkItem[] = []
  for (const item of items) {
    if (lit.has(item.id)) continue
    const range = kept.get(item.id)?.range
    if (!range || !range.startContainer.isConnected) continue
    const rects = rectsOf(range)
    if (rects.length) nextMarks.push({ ...item, rects })
  }
  const boxes: FxBox[] = []
  for (const id of fx.annotatedIds.value) {
    const range = kept.get(id)?.range
    if (!range) continue
    const rects = rectsOf(range)
    if (!rects.length) continue
    const left = Math.min(...rects.map((rect) => rect.left))
    const top = Math.min(...rects.map((rect) => rect.top))
    const right = Math.max(...rects.map((rect) => rect.left + rect.w))
    const bottom = Math.max(...rects.map((rect) => rect.top + rect.h))
    const width = right - left + 8
    const height = bottom - top + 8
    boxes.push({ key: id, left: left - 4, top: top - 4, width, height, diag: Math.ceil(Math.hypot(width + 16, height + 16)) })
  }
  marks.value = nextMarks
  fxBoxes.value = boxes
}

watch(() => [annotations.byScope, batch.byFile, props.path, fx.annotatedIds.value, fx.phase.value, mainAnnotationScope.value], refreshMarks, { deep: true })

let flashTimer: ReturnType<typeof setTimeout> | undefined
watch(annotationFlash, (request) => {
  if (!request || !props.active) return
  const range = kept.get(request.id)?.range
  const el = scroller.value
  if (!range || !el) return
  const rect = range.getBoundingClientRect()
  if (rect.width || rect.height) {
    const box = el.getBoundingClientRect()
    el.scrollBy({ top: rect.top - box.top - box.height / 2 + rect.height / 2, behavior: "smooth" })
  }
  flashId.value = request.id
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashId.value = null), 1200)
  setTimeout(refreshMarks, 16)
})

/* ------------------------------------------------------------ disk and runs */

async function onDiskChange() {
  const { ai, prompt } = aiTouch(props.path)
  const aiRunning = ai && app.running.size > 0
  // A send from here is out: its run-end record carries the note and the diff, and recording these bytes first would make that one a duplicate by hash.
  const pending = localConvo !== null
  if (aiRunning || pending) deferReload = true
  const [dir, base] = splitPath()
  const read = await window.mcode.readFileBytes(dir, base, lastStat)
  if (!read.ok) return
  if (read.unchanged) {
    deferReload = false
    return
  }
  const changed = read.base64 !== lastBase64
  if (changed && !pending) await versions.record(props.path, read.base64, ai ? "ai_local" : "external", ai ? prompt : t("office.versionNoteExternal"))
  if (!aiRunning && !pending) {
    lastStat = { size: read.size, mtimeMs: read.mtimeMs }
    reload()
  }
}

async function paragraphsOf(base64: string) {
  try {
    return paragraphTexts(await partOf(await loadDocx(decode(base64)), "word/document.xml"))
  } catch {
    return []
  }
}

let runningBefore = new Set<string>()
watch(
  () => [...app.running].join("|"),
  async () => {
    const now = new Set(app.running)
    const ended = [...runningBefore].filter((id) => !now.has(id))
    runningBefore = now
    if (!ended.length) return
    const [dir, base] = splitPath()
    if (localConvo && ended.includes(localConvo)) {
      localConvo = null
      // The reload below is the one that was deferred.
      deferReload = false
      const read = await window.mcode.readFileBytes(dir, base)
      if (read.ok && !read.unchanged && read.base64 !== lastBase64) {
        const summary = diffSummary(await paragraphsOf(lastBase64), await paragraphsOf(read.base64))
        await versions.record(props.path, read.base64, "ai_local", summary ? `${localNote};${summary}` : localNote)
      }
      reload()
      return
    }
    const watching = ended.some((id) => id === props.origin || watchedFilesOf(id).includes(props.path))
    if (watching) {
      const read = await window.mcode.readFileBytes(dir, base, lastStat)
      if (read.ok && !read.unchanged) reload()
      return
    }
    if (deferReload) {
      deferReload = false
      reload()
    }
  },
)

/* Escape clears what this file sent. */
function onEscape(event: KeyboardEvent) {
  if (!props.active || event.key !== "Escape" || event.defaultPrevented || event.isComposing) return
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
function onScroll() {
  if (scrollTimer) return
  scrollTimer = setTimeout(() => {
    scrollTimer = undefined
    refreshMarks()
  }, 16)
}

const resizer = new ResizeObserver(() => {
  if (refits(hostWidth())) applyZoom()
  else
    void nextTick(() => {
      measureRail()
      refreshMarks()
    })
  updateRailOpen()
})

let stopWatching: (() => void) | undefined
let diskTimer: ReturnType<typeof setTimeout> | undefined

onMounted(() => {
  if (scroller.value) {
    resizer.observe(scroller.value)
    scroller.value.addEventListener("click", onLinkClick, true)
  }
  if (wrap.value) resizer.observe(wrap.value)
  document.addEventListener("pointerdown", onDocDown, true)
  document.addEventListener("pointerup", onDocUp, true)
  document.addEventListener("pointercancel", onDocCancel, true)
  document.addEventListener("keydown", onEscape)
  runningBefore = new Set(app.running)
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
  generation += 1
  resizer.disconnect()
  scroller.value?.removeEventListener("click", onLinkClick, true)
  document.removeEventListener("pointerdown", onDocDown, true)
  document.removeEventListener("pointerup", onDocUp, true)
  document.removeEventListener("pointercancel", onDocCancel, true)
  document.removeEventListener("keydown", onEscape)
  stopWatching?.()
  clearTimeout(diskTimer)
  void window.mcode.unwatchFile(props.path)
  stopRestore?.()
  clearTimeout(flashTimer)
  clearTimeout(scrollTimer)
  if (typeof CSS !== "undefined" && "highlights" in CSS) CSS.highlights.delete("docx-editing")
  // The highlight is global: another Word view still on the page keeps it.
  if (document.querySelectorAll("[data-docx-view]").length <= 1) clearCommentHighlight()
})

const noteHost = () => wrap.value?.getBoundingClientRect()
const noteInside = (target: Node) => Boolean(wrap.value?.contains(target))
</script>

<template>
  <div ref="wrap" class="docx-view" data-docx-view :data-reload-nonce="reloadNonce" @pointerup="onPointerUp" @wheel.passive="onWheel">
    <div
      ref="scroller"
      class="office-sel"
      data-preview-host="docx"
      :data-docx-sidebar-open="railShown ? 'true' : undefined"
      data-selectable="content"
      @scroll="onScroll"
      @mouseover="onOver"
      @mouseout="onOut"
    >
      <div ref="docHost" class="docx-host" />
      <aside v-if="railShown" class="docx-rail" data-docx-revisions>
        <div class="rail-head">
          <span>{{ t("office.revisions", { count: railItems.length }) }}</span>
          <button type="button" class="rail-close" :title="t('office.revisionsHide')" @click="railOpen = false">×</button>
        </div>
        <div
          v-for="item in railItems"
          :key="item.key"
          :ref="(el) => setCard(item.key, el)"
          class="rail-card"
          :data-docx-rev-card="item.key"
          :data-expanded="expanded.has(item.key) ? 'true' : 'false'"
          :class="{ expanded: expanded.has(item.key) }"
          :style="placed[item.key] !== undefined ? { position: 'absolute', left: '8px', right: '8px', top: `${placed[item.key]}px` } : undefined"
          @click="toggleCard(item.key)"
        >
          <div class="card-row">
            <span class="card-badge" :class="item.type">{{ item.type === "del" ? t("office.revisionDeleted") : t("office.revisionComment") }}</span>
            <span class="card-author" :title="item.author">{{ item.author }}</span>
            <LucideIcon :name="expanded.has(item.key) ? 'chevron-up' : 'chevron-down'" :size="12" class="card-chevron" />
          </div>
          <div v-if="item.date" class="card-date">{{ dateText(item.date) }}</div>
          <div class="card-text">{{ item.text }}</div>
        </div>
      </aside>
      <svg v-if="railShown && (bars.length || elbows.length)" class="rail-lines" aria-hidden="true">
        <line v-for="bar in bars" :key="`bar-${bar.key}`" :x1="bar.x" :y1="bar.y1" :x2="bar.x" :y2="bar.y2" class="rail-bar" />
        <path v-for="elbow in elbows" :key="`elbow-${elbow.key}`" :d="elbow.d" class="rail-elbow" />
      </svg>
    </div>

    <AnnotationMarkLayer :items="marks" :flash-id="flashId" />

    <template v-if="fx.phase.value">
      <AnnotationFx v-for="box in fxBoxes" :key="box.key" :box="box" :phase="fx.phase.value" absolute />
    </template>

    <div v-if="!loading && !error && pageWidth > 0" class="docx-toolbar" data-docx-toolbar>
      <button type="button" class="docx-tool" data-docx-zoom-out :title="t('rp.pdf.zoomOut')" @click="setZoom(zoom - 0.1)">
        <LucideIcon name="zoom-out" :size="14" />
      </button>
      <span class="docx-zoom" data-docx-zoom>{{ Math.round(zoom * 100) }}%</span>
      <button type="button" class="docx-tool" data-docx-zoom-in :title="t('rp.pdf.zoomIn')" @click="setZoom(zoom + 0.1)">
        <LucideIcon name="zoom-in" :size="14" />
      </button>
      <button type="button" class="docx-tool" data-docx-fit :title="t('rp.pdf.fitWidth')" @click="zoom = 1">
        <LucideIcon name="move-horizontal" :size="14" />
      </button>
    </div>

    <CellAffordance
      v-if="noteOpen"
      v-model="noteText"
      :anchor="noteAnchor"
      :selection-rect="noteRect"
      :host="noteHost"
      :inside="noteInside"
      @send="sendNote"
      @stash="stashNote"
      @close="hideNote"
      @focus="(focused: boolean) => focused && (editing = true)"
    />

    <div v-if="(loading && !restoring) || error" class="docx-note" :data-docx-failed="error ? '' : undefined">{{ error || t("rp.pdf.loading") }}</div>

    <div v-if="insTip" class="ins-tip" :style="{ left: `${insTip.left}px`, top: `${insTip.top}px` }">
      <div class="ins-tip-head">
        <span>{{ insTip.author || t("office.revisionUnknownAuthor") }}</span>
        <span v-if="insTip.date" class="ins-tip-date">{{ insTip.date }}</span>
        <span class="ins-tip-kind">{{ t("office.revisionInserted") }}</span>
      </div>
      <div class="ins-tip-text">{{ insTip.text }}</div>
    </div>

    <button v-if="railItems.length && !railShown" type="button" class="rail-pill" :title="t('office.revisionsShow')" @click="railOpen = true">
      {{ t("office.revisions", { count: railItems.length }) }}
    </button>
  </div>
</template>

<style scoped>
.docx-view {
  position: relative;
  isolation: isolate;
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.office-sel {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  width: 100%;
  height: 100%;
  overflow: auto;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  user-select: text;
}

.docx-host {
  position: relative;
  isolation: isolate;
  flex: 1 1 0;
  min-width: 0;
}

/* MiMo's rail: 260 wide beside the pages, a sticky head, cards placed at their paragraphs. */
.docx-rail {
  position: relative;
  flex-shrink: 0;
  width: 260px;
  background: var(--surface-base);
  border-left: 1px solid var(--border-weak);
  box-shadow: -2px 0 8px rgba(0, 0, 0, 0.06);
}

.rail-head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border-bottom: 1px solid var(--border-weak);
  font-size: 12px;
  font-weight: 500;
}

.rail-close {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: none;
  border-radius: 4px;
  font-size: 16px;
  line-height: 1;
}

.rail-card {
  box-sizing: border-box;
  padding: 8px 10px;
  overflow-y: hidden;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}

.rail-card.expanded {
  max-height: 260px;
  overflow-y: auto;
}

.card-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.card-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
}

.card-badge.del {
  color: #d93025;
  background: #fdecea;
}

.card-badge.cmt {
  color: #6b46c1;
  background: #f3ecff;
}

.card-author {
  flex: 1;
  overflow: hidden;
  color: var(--text-weak);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-chevron {
  flex-shrink: 0;
  color: var(--text-weak);
}

.card-date {
  margin-bottom: 4px;
  color: var(--text-weak);
  font-size: 10px;
}

.card-text {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}

.rail-card.expanded .card-text {
  display: block;
  white-space: pre-wrap;
  -webkit-line-clamp: unset;
}

.rail-lines {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 4;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.rail-bar {
  stroke: #7c3aed;
  stroke-width: 2.5;
  stroke-linecap: butt;
}

.rail-elbow {
  fill: none;
  stroke: #7c3aed;
  stroke-width: 1;
  stroke-dasharray: 4 4;
}

.rail-pill {
  position: absolute;
  top: 12px;
  right: 14px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  color: #2b6cb0;
  background: #e6f0fa;
  border: 1px solid #2b6cb0;
  border-radius: 14px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  font-size: 12px;
  font-weight: 500;
}

.docx-toolbar {
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

.docx-tool {
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

.docx-zoom {
  min-width: 38px;
  text-align: center;
}

.docx-note {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  color: var(--text-weak);
  background: var(--surface-raised);
  font-size: 13px;
  text-align: center;
  pointer-events: none;
}

.ins-tip {
  position: absolute;
  z-index: 20;
  box-sizing: border-box;
  width: 320px;
  padding: 8px 10px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
  font-size: 12px;
  pointer-events: none;
}

.ins-tip-head {
  display: flex;
  flex-wrap: wrap;
  margin-bottom: 4px;
  font-size: 11px;
}

.ins-tip-date {
  margin-left: 8px;
  color: var(--text-weak);
}

.ins-tip-kind {
  margin-left: 8px;
  color: #ff6a2b;
}

.ins-tip-text {
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: break-word;
}

:root[data-theme="dark"] .card-badge.del {
  color: #ff9b7f;
  background: #3a2320;
}

:root[data-theme="dark"] .card-badge.cmt {
  color: #c4b5fd;
  background: #2a2140;
}

:root[data-theme="dark"] .rail-bar,
:root[data-theme="dark"] .rail-elbow {
  stroke: #a78bfa;
}

:root[data-theme="dark"] .rail-pill {
  color: #7ab5e8;
  background: #1c2b3d;
  border-color: #7ab5e8;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .card-badge.del {
    color: #ff9b7f;
    background: #3a2320;
  }

  :root:not([data-theme="light"]) .card-badge.cmt {
    color: #c4b5fd;
    background: #2a2140;
  }

  :root:not([data-theme="light"]) .rail-bar,
  :root:not([data-theme="light"]) .rail-elbow {
    stroke: #a78bfa;
  }

  :root:not([data-theme="light"]) .rail-pill {
    color: #7ab5e8;
    background: #1c2b3d;
    border-color: #7ab5e8;
  }
}
</style>

<style>
/* docx-preview's pages on MiMo's ground; deletions only in the rail; comment markers hidden. */
.docx-view .docx-wrapper {
  box-sizing: border-box;
  width: fit-content;
  min-width: 100%;
  background: var(--surface-base);
}

.docx-view .docx span {
  overflow-wrap: anywhere;
}

.docx-view .docx ins,
.docx-view .docx ins span {
  color: #2b6cb0;
  text-decoration: underline;
  text-decoration-color: #2b6cb0;
  cursor: help;
}

.docx-view .docx del {
  display: none;
}

.docx-view .docx-wrapper .docx-comment-ref {
  visibility: hidden;
  font-size: 0;
}

.docx-view .docx-wrapper .docx-comment-popover {
  display: none;
}

::highlight(docx-editing) {
  background-color: #b3d7ff;
}

::highlight(docx-comments) {
  background-color: color-mix(in srgb, #7c3aed 22%, transparent);
}

:root[data-theme="dark"] .docx-view .docx ins,
:root[data-theme="dark"] .docx-view .docx ins span {
  color: #7ab5e8;
  text-decoration-color: #7ab5e8;
}

:root[data-theme="dark"] ::highlight(docx-editing) {
  background-color: #33518a;
}

:root[data-theme="dark"] ::highlight(docx-comments) {
  background-color: color-mix(in srgb, #a78bfa 22%, transparent);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .docx-view .docx ins,
  :root:not([data-theme="light"]) .docx-view .docx ins span {
    color: #7ab5e8;
    text-decoration-color: #7ab5e8;
  }

  :root:not([data-theme="light"]) ::highlight(docx-editing) {
    background-color: #33518a;
  }

  :root:not([data-theme="light"]) ::highlight(docx-comments) {
    background-color: color-mix(in srgb, #a78bfa 22%, transparent);
  }
}
</style>
