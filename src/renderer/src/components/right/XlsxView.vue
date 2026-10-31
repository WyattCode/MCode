<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { Annotation } from "@shared/protocol"
import { useApp } from "../../stores/app"
import { useAnnotations } from "../../stores/annotations"
import { useAnnotationBatch } from "../../stores/annotation-batch"
import { useOfficeVersions } from "../../stores/office-versions"
import { annotationId, mainAnnotationScope } from "../../lib/annotate"
import { sendAnnotationNow } from "../../lib/annotation-send"
import { useAnnotationFx, watchedFilesOf, type FxBox } from "../../lib/annotation-fx"
import { aiTouch } from "../../lib/ai-touch"
import { splitFilePath } from "../../lib/file-path"
import type { XlsxParsed } from "../../lib/xlsx-convert"
import { a1Of, addSheet, describeValue, editsNote, removeSheet, renameSheet, writeCellEdits, type CellEdit } from "../../lib/xlsx-writeback"
import {
  anchorBox,
  createSheetOverlays,
  layerBox,
  type ChartPick,
  type LayerBox,
  type MarkAnchor,
  type SheetLike,
  type SheetOverlays,
  type UniverLike,
  type WorkbookLike,
} from "../../lib/xlsx-overlays"
import { notice, notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"
import { dialogOpen } from "../../lib/escape-layer"
import CellAffordance from "../CellAffordance.vue"
import AnnotationFx from "../AnnotationFx.vue"
import AnnotationMarkLayer, { type MarkItem } from "../AnnotationMarkLayer.vue"
import ViewerAiNote from "./ViewerAiNote.vue"

/**
 * MiMo's spreadsheet view: the workbook in Univer (Chinese, light, only the
 * sheet tabs), converted from the file with exceljs, with MiMo's own layers
 * over the grid for what Univer does not draw - data bars, gradient fills,
 * pictures and charts.
 *
 * Cells can be edited in place: each edit is written into the file's XML
 * (formula cells excepted) 800ms later, a pill in the corner saying so, and
 * becomes a version; a new sheet, and renaming or removing a sheet added in
 * this view, are written too, while the sheets the file came with keep their
 * names. Clicking a cell offers "edit or ask", a range or a chart opens the
 * note box at once; send posts the annotation now, "add to chat" puts it in
 * the box, and numbered frames mark the cells on the sheet.
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

const SAVE_DELAY = 800
// A failed write is tried again this many times, this far apart, while the load is current
const SAVE_RETRIES = 3
const SAVE_RETRY_DELAY = 3000
const PILL_W = 116
const PILL_H = 30

interface RangeApi {
  getA1Notation(): string
  getValues(): unknown[][]
}
interface SheetApi extends SheetLike {
  getSheetName(): string
}
interface BookApi extends WorkbookLike {
  getActiveSheet(): SheetApi | null
  getActiveRange(): RangeApi | null
  getSheetByName(name: string): SheetApi | null
  setActiveSheet(sheet: SheetApi): unknown
  scrollToCell?(row: number, column: number): unknown
}
interface Command {
  id: string
  params?: unknown
}
interface CellChange {
  sheetIndex: number
  a1: string
  before: string
  after: string
}
interface SheetApiRoot extends UniverLike {
  getActiveWorkbook(): BookApi | null
  createWorkbook(data: unknown): unknown
  onCommandExecuted(callback: (command: Command) => void): { dispose(): void }
  onBeforeCommandExecute(callback: (command: Command) => void): { dispose(): void }
}

const wrap = ref<HTMLElement>()
const container = ref<HTMLElement>()

const loading = ref(true)
const restoring = ref(false)
const error = ref<string | null>(null)
const status = ref<"idle" | "saving" | "saved" | "error">("idle")
const reloadNonce = ref(0)

let generation = 0
let univer: { dispose(): void } | null = null
let api: SheetApiRoot | null = null
let parsed: XlsxParsed | null = null
let overlays: SheetOverlays | null = null
// The file the grid shows, which props.path has already left behind by the time a switch tears it down
let shownPath = ""
// The current load's pending-edit flush, run on unmount or when another file replaces it
let loaded: { path: string; flush: () => void } | null = null
let lastStat: { size: number; mtimeMs: number } | undefined
let savedView: { path: string; sheetName: string; row: number; col: number } | null = null
let cleanups: (() => void)[] = []
let links = new Map<string, string>()

const splitPath = () => splitFilePath(props.path)

function decode(base64: string) {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at)
  return out
}

function encode(data: Uint8Array) {
  let binary = ""
  for (let at = 0; at < data.length; at += 32768) binary += String.fromCharCode(...data.subarray(at, at + 32768))
  return btoa(binary)
}

function unhide() {
  if (container.value) container.value.style.visibility = ""
}

const statusText = computed(() => (status.value === "saving" ? t("office.saveSaving") : status.value === "saved" ? t("office.saved") : status.value === "error" ? t("office.saveFailed") : ""))

/* ------------------------------------------------------------ loading */

function teardown() {
  try {
    const sheet = api?.getActiveWorkbook()?.getActiveSheet()
    const scroll = sheet?.getScrollState?.()
    // The start row and column count from the freeze line, and scrollToCell takes the frozen part off again
    const freeze = sheet?.getFreeze?.()
    if (sheet && parsed) {
      savedView = {
        path: shownPath,
        sheetName: sheet.getSheetName(),
        row: (scroll?.sheetViewStartRow ?? 0) + (freeze?.ySplit ?? 0),
        col: (scroll?.sheetViewStartColumn ?? 0) + (freeze?.xSplit ?? 0),
      }
    }
  } catch {
    /* the grid is already gone */
  }
  for (const cleanup of cleanups) cleanup()
  cleanups = []
  overlays?.dispose()
  overlays = null
  try {
    univer?.dispose()
  } catch {
    /* already disposed */
  }
  univer = null
  api = null
  parsed = null
  markBox.value = null
  marks.value = []
  fxBoxes.value = []
}

async function load() {
  // Another file, not a reload of this one (AI writes, undo, restore): the edits still waiting are written first
  if (loaded && loaded.path !== props.path) loaded.flush()
  loaded = null
  const mine = ++generation
  const path = props.path
  const loadedPath = savedView?.path
  teardown()
  const view = savedView && savedView.path === props.path ? savedView : null
  if (loadedPath !== props.path) savedView = null
  if (view) {
    restoring.value = true
    if (container.value) container.value.style.visibility = "hidden"
  }
  error.value = null
  loading.value = true
  status.value = "idle"
  closeNote()
  const alive = () => mine === generation
  const [dir, base] = splitPath()
  const read = await window.mcode.readFileBytes(dir, base)
  if (!alive()) return
  if (!read.ok || read.unchanged) {
    error.value = !read.ok && read.reason === "noent" ? t("office.fileMissing") : t("office.serveFailed")
    loading.value = false
    restoring.value = false
    unhide()
    return
  }
  lastStat = { size: read.size, mtimeMs: read.mtimeMs }
  const { ai, prompt } = aiTouch(props.path, 60_000)
  void versions.init(props.path, read.base64, { assumeAi: ai, note: ai ? prompt.trim() : t("office.versionNoteExternal") })
  const edits = new Map<string, CellEdit>()
  // Keyed by sheet index and A1, so Sheet1!A1 and Sheet2!A1 stay two changes
  const changes = new Map<string, CellChange>()

  let convert: typeof import("../../lib/xlsx-convert")
  let engine: typeof import("../../lib/univer-create")
  let workbook: XlsxParsed
  try {
    ;[convert, engine] = await Promise.all([import("../../lib/xlsx-convert"), import("../../lib/univer-create")])
    workbook = await convert.parseXlsx(decode(read.base64), props.name)
  } catch (err) {
    console.error("[XlsxView] parse/load failed:", err)
    if (!alive()) return
    unhide()
    restoring.value = false
    loading.value = false
    emit("fallback")
    return
  }
  if (!alive() || !container.value || !wrap.value) return
  // MiMo raises this as a danger notice.
  if (workbook.truncated) notice.danger(t("office.tooLarge"))
  const created = engine.createSheetUniver(container.value)
  if (!alive()) {
    created.univer.dispose()
    return
  }
  univer = created.univer
  const root = created.univerAPI as unknown as SheetApiRoot
  api = root
  parsed = workbook
  shownPath = path
  root.createWorkbook(workbook.data)
  convert.applyConditionalFormats(root, workbook)
  convert.fitRowHeights(root, workbook, alive)
  links = new Map(workbook.links.map((link) => [`${workbook.sheetIds[link.sheetIndex]}!${a1Of(link.row, link.col)}`, link.target]))
  loading.value = false
  if (view) restoreView(root, view, alive)
  if (restoring.value) {
    setTimeout(() => {
      unhide()
      restoring.value = false
    }, 16)
  }

  try {
    overlays = createSheetOverlays({
      wrap: wrap.value,
      api: root,
      sheetIds: workbook.sheetIds,
      themeColors: workbook.themeColors,
      gradients: workbook.gradientFills,
      dataBars: workbook.dataBars,
      images: workbook.images,
      charts: workbook.charts,
      onPlaced: placeMarks,
    })
  } catch (err) {
    console.warn("[XlsxView] overlays failed:", err)
  }
  const resize = new ResizeObserver(() => overlays?.reposition())
  resize.observe(container.value)
  cleanups.push(() => resize.disconnect())

  /* ---------------- writing back */

  const known = [...workbook.sheetIds]
  const added = new Set<string>()
  // This load's own bytes and stat: a job never patches the bytes of a later load
  let current: Uint8Array = decode(read.base64)
  let stat = { size: read.size, mtimeMs: read.mtimeMs }
  let chain: Promise<void> = Promise.resolve()
  // Jobs that have not started yet are dropped once a reload, undo or restore has replaced this load
  const queue = (job: () => Promise<void>) => {
    chain = chain.then(() => (alive() ? job() : undefined)).catch((err) => console.error("[XlsxView] save chain error:", err))
  }
  const writeBytes = async (next: Uint8Array, note: string, live: () => boolean = alive) => {
    const base64 = encode(next)
    for (let attempt = 0; ; attempt++) {
      // Checked right before the write: a newer file may have reached the disk while this job waited
      if (!live()) return false
      const result = await window.mcode.writeFileBytes(dir, base, base64).catch((err: unknown) => ({ ok: false as const, reason: String(err) }))
      if (!live()) return false
      if (result.ok) {
        current = next
        stat = { size: result.size, mtimeMs: result.mtimeMs }
        if (alive()) {
          lastStat = stat
          status.value = "saved"
        }
        void versions.record(path, base64, "user", note)
        return true
      }
      if (alive()) status.value = "error"
      if (attempt >= SAVE_RETRIES) return false
      // A file held open elsewhere (Excel, a sync client) often frees up shortly
      await new Promise((resolve) => setTimeout(resolve, SAVE_RETRY_DELAY))
    }
  }
  const saveEdits = async (live: () => boolean = alive) => {
    if (!edits.size) return
    // A snapshot: edits made while this save runs stay pending for the next one
    const sent = [...edits.entries()]
    const noted = [...changes.entries()]
    if (alive()) status.value = "saving"
    try {
      const result = await writeCellEdits(current, sent.map(([, edit]) => edit))
      if (result.applied < sent.length) {
        // Some cells found nowhere to go in the XML: nothing is written and the edits wait
        console.error(`[XlsxView] only ${result.applied} of ${sent.length} cell edits could be placed, not saved`)
        if (alive()) status.value = "error"
        return
      }
      if (await writeBytes(result.bytes, editsNote(noted.map(([, change]) => change)), live)) {
        for (const [key, edit] of sent) if (edits.get(key) === edit) edits.delete(key)
        for (const [key, change] of noted) if (changes.get(key) === change) changes.delete(key)
      }
    } catch (err) {
      console.error("[XlsxView] save failed:", err)
      if (alive()) status.value = "error"
    }
  }
  const saveStructure = (change: (file: Uint8Array) => Promise<Uint8Array>, note: string, failed?: () => void) =>
    queue(async () => {
      status.value = "saving"
      let saved = false
      try {
        saved = await writeBytes(await change(current), note)
      } catch (err) {
        console.error("[XlsxView] sheet structural save failed:", err)
        if (alive()) status.value = "error"
      }
      if (!saved && alive()) failed?.()
    })
  // A sheet gone from the file: its pending edits and notes go, and later sheets move down one
  const dropSheet = (index: number) => {
    const moved = new Map<string, CellEdit>()
    for (const edit of edits.values()) {
      if (edit.sheetIndex === index) continue
      const next = edit.sheetIndex > index ? { ...edit, sheetIndex: edit.sheetIndex - 1 } : edit
      moved.set(`${next.sheetIndex}:${next.row0}:${next.col0}`, next)
    }
    edits.clear()
    for (const [key, edit] of moved) edits.set(key, edit)
    const notes = new Map<string, CellChange>()
    for (const change of changes.values()) {
      if (change.sheetIndex === index) continue
      const next = change.sheetIndex > index ? { ...change, sheetIndex: change.sheetIndex - 1 } : change
      notes.set(`${next.sheetIndex}!${next.a1}`, next)
    }
    changes.clear()
    for (const [key, change] of notes) changes.set(key, change)
  }

  const before = root.onBeforeCommandExecute((command) => {
    if (command.id !== "sheet.command.set-worksheet-name") return
    const sheetId = (command.params as { subUnitId?: string } | undefined)?.subUnitId ?? root.getActiveWorkbook()?.getActiveSheet()?.getSheetId()
    if (sheetId && added.has(sheetId)) return
    notice.warning(t("office.renameSheetUnsupported"))
    throw new engine.CustomCommandExecutionError("rename of pre-existing sheet is not persistable")
  })
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let valuesTimer: ReturnType<typeof setTimeout> | undefined
  let placeTimer: ReturnType<typeof setTimeout> | undefined
  const executed = root.onCommandExecuted((command) => {
    if (command.id === "sheet.mutation.set-range-values") {
      clearTimeout(valuesTimer)
      valuesTimer = setTimeout(() => overlays?.invalidate(), 180)
    } else if (!placeTimer) {
      placeTimer = setTimeout(() => {
        placeTimer = undefined
        overlays?.reposition()
      }, 16)
    }
    if (command.id === "sheet.mutation.insert-sheet") {
      const params = command.params as { sheet?: { id?: string; name?: string } } | undefined
      const id = params?.sheet?.id
      if (!id || known.includes(id)) return
      known.push(id)
      added.add(id)
      const name = params?.sheet?.name || "Sheet"
      saveStructure(
        (file) => addSheet(file, name),
        t("office.versionNoteAddSheet", { name }),
        () => {
          // The file never got this sheet: forget it, or later removes and renames would aim one index off
          const index = known.indexOf(id)
          if (index >= 0) {
            known.splice(index, 1)
            dropSheet(index)
          }
          added.delete(id)
        },
      )
      return
    }
    if (command.id === "sheet.mutation.remove-sheet") {
      const params = command.params as { subUnitId?: string; subUnitName?: string } | undefined
      const id = params?.subUnitId
      const index = id ? known.indexOf(id) : -1
      if (!id || index < 0) return
      if (!added.has(id)) {
        console.warn("[XlsxView] remove of pre-existing sheet not persisted:", params?.subUnitName)
        return
      }
      known.splice(index, 1)
      added.delete(id)
      dropSheet(index)
      const name = params?.subUnitName || ""
      saveStructure((file) => removeSheet(file, index), t("office.versionNoteRemoveSheet", { name }))
      return
    }
    if (command.id === "sheet.mutation.set-worksheet-name") {
      const params = command.params as { subUnitId?: string; name?: string } | undefined
      const id = params?.subUnitId
      const index = id ? known.indexOf(id) : -1
      if (!id || !params?.name || index < 0 || !added.has(id)) return
      const name = params.name
      saveStructure((file) => renameSheet(file, index, name), t("office.versionNoteRenameSheet", { name }))
      return
    }
    if (command.id !== "sheet.mutation.set-range-values") return
    const params = command.params as { subUnitId?: string; cellValue?: Record<string, Record<string, { v?: unknown } | null | undefined>> } | undefined
    if (!params?.subUnitId || !params.cellValue) return
    const index = known.indexOf(params.subUnitId)
    if (index < 0) return
    const original = workbook.sheetIds.indexOf(params.subUnitId)
    for (const rowKey of Object.keys(params.cellValue)) {
      const row = params.cellValue[rowKey] ?? {}
      for (const colKey of Object.keys(row)) {
        const row0 = Number(rowKey)
        const col0 = Number(colKey)
        if (original >= 0 && workbook.isFormula(original, row0, col0)) continue
        const cell = row[colKey]
        // Style only (Ctrl+B sends {s: {bl: 1}}) has no v and leaves the value be; null or v: null is a clear
        if (cell != null && !Object.prototype.hasOwnProperty.call(cell, "v")) continue
        const raw = cell == null ? null : (cell.v ?? null)
        const value = typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? raw : raw == null ? null : String(raw)
        edits.set(`${index}:${row0}:${col0}`, { sheetIndex: index, row0, col0, value })
        const a1 = a1Of(row0, col0)
        const key = `${index}!${a1}`
        const prior = changes.get(key)
        const before = prior ? prior.before : original >= 0 ? describeValue(workbook.originalValue(original, row0, col0)) : ""
        changes.set(key, { sheetIndex: index, a1, before, after: describeValue(value) })
      }
    }
    if (!edits.size) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => queue(saveEdits), SAVE_DELAY)
  })
  cleanups.push(() => {
    before.dispose()
    executed.dispose()
    clearTimeout(saveTimer)
    clearTimeout(valuesTimer)
    clearTimeout(placeTimer)
  })

  let flushed = false
  loaded = {
    path,
    // Runs after the generation has moved on, so it writes without alive(), but only over the file this load last saw.
    // The view is gone by then, so edits that could not be written are said in a notice naming the file.
    flush: () => {
      if (flushed) return
      flushed = true
      clearTimeout(saveTimer)
      const unsaved = () => notifyFailure(t("office.saveFailed"), base)
      chain = chain
        .then(async () => {
          if (!edits.size) return
          const check = await window.mcode.readFileBytes(dir, base, stat)
          if (!check.ok || !check.unchanged) {
            console.warn("[XlsxView] pending edits not written, the file changed on disk:", path)
            unsaved()
            return
          }
          await saveEdits(() => true)
          // saveEdits keeps what it could not write, and says so only on a view that is still there
          if (edits.size) unsaved()
        })
        .catch((err) => {
          console.error("[XlsxView] flush of pending edits failed:", err)
          unsaved()
        })
    },
  }
}

/*
 * Back to the sheet and scroll position the grid was left at, tried until it
 * holds or the reader moves.
 *
 * The retries watch the scroll state they themselves produced (R17-V7): the
 * only thing that used to stop them was the active sheet changing, so for the
 * first second after a reload - after the assistant wrote the file, after an
 * undo, after an outside change - a reader who scrolled was dragged back.
 */
function restoreView(root: SheetApiRoot, view: { sheetName: string; row: number; col: number }, alive: () => boolean) {
  // Nothing to put back: the grid opens at the first cell anyway.
  if (view.row <= 0 && view.col <= 0) return
  let done = false
  let ours: { row: number; col: number } | undefined
  for (const delay of [0, 120, 400, 900]) {
    setTimeout(() => {
      if (done || !alive()) return
      try {
        const book = root.getActiveWorkbook()
        const sheet = book?.getSheetByName(view.sheetName)
        if (!book || !sheet) return
        if (delay > 0 && book.getActiveSheet()?.getSheetName() !== view.sheetName) {
          done = true
          return
        }
        if (ours) {
          // Where the grid sits now is not where the last try left it, so it was the reader who moved it.
          const now = book.getActiveSheet()?.getScrollState?.()
          if (now && (now.sheetViewStartRow !== ours.row || now.sheetViewStartColumn !== ours.col)) {
            done = true
            return
          }
        }
        book.setActiveSheet(sheet)
        book.scrollToCell?.(view.row, view.col)
        const active = book.getActiveSheet()
        const scroll = active?.getScrollState?.()
        // view.row and view.col include the frozen part, the scroll state does not
        const freeze = active?.getFreeze?.()
        const row = scroll?.sheetViewStartRow
        const col = scroll?.sheetViewStartColumn
        if (row !== undefined && col !== undefined) ours = { row, col }
        if (row !== undefined && col !== undefined && row + (freeze?.ySplit ?? 0) === view.row && col + (freeze?.xSplit ?? 0) === view.col) done = true
      } catch (err) {
        // The early tries can come before the grid has drawn; only the last one's failure is worth a word.
        if (delay === 900) console.warn("[XlsxView] restore view failed:", err)
      }
    }, delay)
  }
}

function reload() {
  reloadNonce.value += 1
}

watch([() => props.path, reloadNonce, () => versions.reloadTick[props.path] ?? 0], (next, previous) => {
  if (next[0] !== previous[0]) {
    if (previous[0]) void window.mcode.unwatchFile(previous[0])
    void window.mcode.watchFile(next[0])
  }
  void load()
})

/* ------------------------------------------------------------ the note */

const mode = ref<"hidden" | "button" | "input">("hidden")
const anchor = ref<{ x: number; y: number }>({ x: 0, y: 0 })
const noteText = ref("")
let chartPick: (ChartPick & { sheetName: string }) | null = null

function closeNote() {
  chartPick = null
  overlays?.clearChartSelection()
  mode.value = "hidden"
}

/* MiMo's pill: 10 right of and below the pointer, flipped before the viewer's edge, kept 4 inside. */
const pillAt = computed(() => {
  const host = wrap.value?.getBoundingClientRect()
  if (!host || mode.value !== "button") return null
  let left = anchor.value.x + 10
  let top = anchor.value.y + 10
  if (left + PILL_W > host.right - 4) left = anchor.value.x - PILL_W - 10
  if (top + PILL_H > host.bottom - 4) top = anchor.value.y - PILL_H - 10
  left = Math.min(Math.max(left, host.left + 4), host.right - PILL_W - 4)
  top = Math.min(Math.max(top, host.top + 4), host.bottom - PILL_H - 4)
  return { left: `${left}px`, top: `${top}px` }
})

function followLink(target: string, book: BookApi) {
  if (/^(https?:|mailto:|tel:)/i.test(target)) {
    window.mcode.openExternal(target)
    return
  }
  if (!target.startsWith("#")) return
  const cut = target.lastIndexOf("!")
  let name = (cut > 0 ? target.slice(1, cut) : target.slice(1)).trim()
  if (name.startsWith("'") && name.endsWith("'")) name = name.slice(1, -1).replace(/''/g, "'")
  const sheet = book.getSheetByName(name)
  if (sheet) book.setActiveSheet(sheet)
}

function onPointerUp(event: PointerEvent) {
  if ((event.target as Element | null)?.closest?.("[data-cell-affordance]")) return
  const point = { x: event.clientX, y: event.clientY }
  const pick = overlays?.selectChartAt(point.x, point.y)
  if (pick && parsed) {
    chartPick = { ...pick, sheetName: parsed.sheetNames[pick.sheetIndex] ?? "" }
    noteText.value = ""
    anchor.value = point
    mode.value = "input"
    return
  }
  chartPick = null
  overlays?.clearChartSelection()
  const wasInput = mode.value === "input"
  setTimeout(() => {
    if (wasInput) noteText.value = ""
    const book = api?.getActiveWorkbook()
    const range = book?.getActiveRange()
    if (!book || !range) {
      mode.value = "hidden"
      return
    }
    const a1 = range.getA1Notation()
    const sheetId = book.getActiveSheet()?.getSheetId()
    const link = sheetId && !a1.includes(":") ? links.get(`${sheetId}!${a1}`) : undefined
    if (link) followLink(link, book)
    anchor.value = point
    mode.value = a1.includes(":") ? "input" : "button"
  }, 16)
}

function onWheel() {
  if (mode.value !== "hidden") closeNote()
}

watch(
  () => props.active,
  (active) => {
    if (active) return
    mode.value = "hidden"
    noteText.value = ""
  },
)

/* MiMo's cell preview: the first 40 filled values, " | " between, and how many cells when there were more. */
function cellsPreview(values: unknown[][]) {
  const kept: string[] = []
  let total = 0
  for (const row of values) {
    for (const value of row ?? []) {
      total += 1
      if (kept.length >= 40 || value == null || value === "") continue
      kept.push(String(value).replace(/\s+/g, " ").trim())
    }
  }
  let out = kept.join(" | ")
  if (total > 40) out += `(共 ${total} 个单元格,已截断)`
  if (out.length > 400) out = `${out.slice(0, 400)}…`
  return out || "(空)"
}

function build(userText: string): { note: Annotation; anchor: MarkAnchor; prompt: string } | null {
  const text = userText.trim()
  if (chartPick && parsed) {
    const pick = chartPick
    const dataRef = [pick.catRef, pick.valRef].filter(Boolean).join(" / ")
    return {
      note: {
        id: annotationId(),
        kind: "chart",
        path: props.path,
        name: props.name,
        sheet: pick.sheetName,
        sheetId: parsed.sheetIds[pick.sheetIndex],
        ...(pick.title ? { chartTitle: pick.title } : {}),
        chartKind: pick.kind,
        ...(dataRef ? { dataRef } : {}),
        text,
      },
      anchor: { type: "chart", sheetIndex: pick.sheetIndex, fromRow: pick.fromRow, fromCol: pick.fromCol, width: pick.width, height: pick.height },
      prompt: `【${pick.title ? `图表「${pick.title}」` : "图表"}】${text}`,
    }
  }
  const book = api?.getActiveWorkbook()
  const range = book?.getActiveRange()
  const sheet = book?.getActiveSheet()
  if (!range || !sheet) return null
  const a1 = range.getA1Notation()
  const sheetName = sheet.getSheetName() || ""
  return {
    note: { id: annotationId(), kind: "xlsx", path: props.path, name: props.name, sheet: sheetName, sheetId: sheet.getSheetId(), a1, quote: cellsPreview(range.getValues() ?? []), text },
    anchor: { type: "cell", sheetName, a1 },
    prompt: `【表格 ${a1}】${text}`,
  }
}

const anchors = new Map<string, MarkAnchor>()
let localConvo: string | null = null
let localNote = ""
let localPending = false
let deferReload = false

async function sendNote() {
  if (!noteText.value.trim()) return
  const built = build(noteText.value)
  if (!built) {
    noteText.value = ""
    mode.value = "hidden"
    return
  }
  const result = await sendAnnotationNow(built.note, props.path, built.prompt, { origin: props.origin })
  if (!result.ok) {
    if (result.reason) notifyFailure(result.reason)
    return
  }
  localNote = built.prompt
  localConvo = result.convoId ?? null
  localPending = true
  anchors.set(built.note.id, built.anchor)
  batch.setBatch([{ id: built.note.id, num: 0, kind: built.note.kind, path: props.path, name: props.name }])
  noteText.value = ""
  closeNote()
}

function stashNote() {
  const built = build(noteText.value)
  if (!built) {
    noteText.value = ""
    mode.value = "hidden"
    return
  }
  if (!annotations.add(mainAnnotationScope.value, built.note)) return
  anchors.set(built.note.id, built.anchor)
  noteText.value = ""
  closeNote()
}

/* ------------------------------------------------------------ marks and working light */

const fx = useAnnotationFx(() => props.path)
const markBox = ref<LayerBox | null>(null)
const marks = ref<MarkItem[]>([])
const fxBoxes = ref<FxBox[]>([])

function placeMarks() {
  const sheet = api?.getActiveWorkbook()?.getActiveSheet()
  if (!sheet || !wrap.value || !parsed) {
    markBox.value = null
    return
  }
  markBox.value = layerBox(wrap.value, sheet)
  const waiting = annotations.list(mainAnnotationScope.value)
  const own = waiting.map((note, index) => ({ note, num: index + 1 })).filter((entry) => entry.note.path === props.path).map((entry) => ({ id: entry.note.id, num: entry.num }))
  const items = own.length ? own : (batch.byFile[props.path] ?? []).map((item) => ({ id: item.id, num: item.num }))
  const lit = fx.phase.value ? new Set(fx.annotatedIds.value) : new Set<string>()
  const next: MarkItem[] = []
  for (const item of items) {
    const where = anchors.get(item.id)
    const box = where && !lit.has(item.id) ? anchorBox(sheet, parsed.sheetIds, where) : null
    if (box) next.push({ ...item, rects: [box] })
  }
  const boxes: FxBox[] = []
  if (fx.phase.value) {
    for (const id of fx.annotatedIds.value) {
      const where = anchors.get(id)
      const box = where ? anchorBox(sheet, parsed.sheetIds, where) : null
      if (!box) continue
      const width = box.w + 8
      const height = box.h + 8
      boxes.push({ key: id, left: box.left - 4, top: box.top - 4, width, height, diag: Math.ceil(Math.hypot(width + 16, height + 16)) })
    }
  }
  marks.value = next
  fxBoxes.value = boxes
}

/*
 * No `deep: true`: every source is replaced wholesale, never mutated in place
 * (the stores write `byScope.value = { ...byScope.value, ... }` and
 * `annotatedIds.value = [...]`). A reference comparison catches all of them; the
 * deep walk was traversing every annotation in the document to learn what the
 * new top-level object already said.
 */
watch(() => [annotations.byScope, batch.byFile, props.path, fx.annotatedIds.value, fx.phase.value, mainAnnotationScope.value], placeMarks)

const layerStyle = (z: number) => {
  const box = markBox.value
  if (!box) return {}
  return {
    left: `${Math.round(box.left)}px`,
    top: `${Math.round(box.top)}px`,
    width: `${Math.round(box.width)}px`,
    height: `${Math.round(box.height)}px`,
    clipPath: `inset(${Math.round(box.clipTop)}px 0 0 ${Math.round(box.clipLeft)}px)`,
    zIndex: String(z),
  }
}

/* ------------------------------------------------------------ disk and runs */

async function onDiskChange() {
  const { ai, prompt } = aiTouch(props.path)
  const aiRunning = ai && app.running.size > 0
  if (aiRunning) deferReload = true
  const [dir, base] = splitPath()
  const read = await window.mcode.readFileBytes(dir, base, lastStat)
  if (!read.ok) return
  if (read.unchanged) {
    if (aiRunning) deferReload = false
    return
  }
  if (!aiRunning) lastStat = { size: read.size, mtimeMs: read.mtimeMs }
  await versions.record(props.path, read.base64, ai ? "ai_local" : "external", ai ? prompt.trim() : t("office.versionNoteExternal"))
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
    const [dir, base] = splitPath()
    if (localPending && localConvo && ended.includes(localConvo)) {
      localPending = false
      deferReload = false
      localConvo = null
      const note = localNote
      localNote = ""
      try {
        const read = await window.mcode.readFileBytes(dir, base)
        if (read.ok && !read.unchanged) {
          lastStat = { size: read.size, mtimeMs: read.mtimeMs }
          await versions.record(props.path, read.base64, "ai_local", note)
        } else console.error("[XlsxView] read bytes for AI version record failed:", read.ok ? "unchanged" : read.reason)
      } catch (err) {
        console.error("[XlsxView] record AI version error:", err)
      } finally {
        reload()
      }
      return
    }
    if (ended.some((id) => id === props.origin || watchedFilesOf(id).includes(props.path))) {
      deferReload = false
      const read = await window.mcode.readFileBytes(dir, base, lastStat)
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

function onEscape(event: KeyboardEvent) {
  if (!props.active || event.key !== "Escape" || event.defaultPrevented || event.isComposing || dialogOpen()) return
  batch.clearFile(props.path)
}

/* ------------------------------------------------------------ lifecycle */

let firstResize = true
const wrapResize = new ResizeObserver(() => {
  if (firstResize) {
    firstResize = false
    return
  }
  if (mode.value !== "hidden") closeNote()
})

let stopWatching: (() => void) | undefined

onMounted(() => {
  if (wrap.value) wrapResize.observe(wrap.value)
  document.addEventListener("keydown", onEscape)
  runningBefore = new Set(app.running)
  void window.mcode.watchFile(props.path)
  stopWatching = window.mcode.onFileChanged((changed) => {
    if (changed === props.path) void onDiskChange()
  })
  void load()
})

onBeforeUnmount(() => {
  loaded?.flush()
  loaded = null
  generation += 1
  teardown()
  wrapResize.disconnect()
  document.removeEventListener("keydown", onEscape)
  stopWatching?.()
  void window.mcode.unwatchFile(props.path)
})

const noteHost = () => wrap.value?.getBoundingClientRect()
const keepOpen = () => true
</script>

<template>
  <div ref="wrap" class="xlsx-view" data-xlsx-view :data-reload-nonce="reloadNonce" @pointerup="onPointerUp" @wheel.passive="onWheel">
    <div ref="container" class="xlsx-grid" data-preview-host="xlsx" />

    <div v-if="markBox && marks.length" class="xlsx-layer" :style="layerStyle(11)">
      <AnnotationMarkLayer :items="marks" :flash-id="null" cells />
    </div>
    <div v-if="markBox && fx.phase.value && fxBoxes.length" class="xlsx-layer" :style="layerStyle(12)">
      <AnnotationFx v-for="box in fxBoxes" :key="box.key" :box="box" :phase="fx.phase.value" absolute />
    </div>

    <div v-if="statusText" class="xlsx-status" :class="{ failed: status === 'error' }" data-xlsx-status>{{ statusText }}</div>

    <Teleport to="body">
      <button v-if="active && pillAt" type="button" class="xlsx-pill" data-cell-affordance :style="pillAt" @click="mode = 'input'">{{ t("office.cellEdit") }}</button>
    </Teleport>

    <CellAffordance
      v-if="active && mode === 'input'"
      v-model="noteText"
      :anchor="anchor"
      :host="noteHost"
      :inside="keepOpen"
      autofocus
      @send="sendNote"
      @stash="stashNote"
      @close="mode = 'hidden'"
    />

    <!-- MiMo 26.920's footer line under every document view. -->
    <ViewerAiNote viewer="xlsx" />
    <div v-if="(loading && !restoring) || error" class="xlsx-note" :data-xlsx-failed="error ? '' : undefined">{{ error || t("office.loadingConvert") }}</div>
  </div>
</template>

<style scoped>
.xlsx-view {
  position: relative;
  isolation: isolate;
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* The sheet takes what the footer line leaves. */
.xlsx-grid {
  flex: 1 1 0;
  width: 100%;
  min-height: 0;
}

.xlsx-layer {
  position: absolute;
  overflow: hidden;
  pointer-events: none;
}

.xlsx-status {
  position: absolute;
  right: 10px;
  bottom: 8px;
  z-index: 2;
  padding: 2px 8px;
  color: var(--text-base);
  background: var(--surface-raised);
  border-radius: 6px;
  /* Fixed as in MiMo, which does not scale the status with the interface font. */
  font-size: 11px;
  opacity: 0.9;
  pointer-events: none;
}

.xlsx-status.failed {
  color: #e5484d;
}

.xlsx-pill {
  position: fixed;
  z-index: 4000;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  color: #fff;
  background: #3295fb;
  border: none;
  border-radius: 999px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  /* Fixed as in MiMo, so the pill keeps matching its 116 by 30 placement box. */
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.xlsx-note {
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
