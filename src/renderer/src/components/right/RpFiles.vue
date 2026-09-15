<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { DirEntry, FileHit, ResponseMap } from "@shared/protocol"
import type { MenuItem } from "../../lib/menu"
import ContextMenu from "../ContextMenu.vue"
import PdfView from "./PdfView.vue"
import { useApp } from "../../stores/app"
import { useRightPanel } from "../../stores/right-panel"
import { renderMarkdown } from "../../lib/markdown"
import { openImagePreview } from "../../lib/image-preview"
import { highlightLines, languageForFile } from "../../lib/highlight"
import { annotationId, requestAnnotation } from "../../lib/annotate"
import { projectName } from "../../lib/project"
import { fileManagerName } from "../../lib/path-open"
import { crumbsFor, editCounts, fileCategory, rowIndent, saveFailureKey, treeRows, type TreeRow } from "../../lib/files-tab"
import { centreRange, clearPaint, paintRanges, textRanges } from "../../lib/dom-find"
import { notify, notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"

/**
 * MiMo's files tab: the project's tree down the start, the chosen file beside
 * it. A bar across the top folds the tree away, says where the file is, and
 * offers what can be done with it - edit a text file in place, open a page in
 * the browser, show it in the file manager - and a refresh.
 *
 * The tree lists one folder at a time as it is opened, dot files included, and
 * searches file names across the project as the filter is typed into. With no
 * project it browses the default project location. The viewer draws code with
 * its line numbers, renders markdown, shows pictures and plays sound and video;
 * Ctrl+F anywhere in the open panel finds text in what is drawn.
 *
 * It reads again when the agent edits the open file, when the file changes on
 * disk, and when a turn's edits land or are taken back - never while editing.
 */
const props = defineProps<{ root?: string; viewFile?: string }>()
const emit = defineEmits<{ view: [file: string] }>()
const app = useApp()
const rp = useRightPanel()

/* MiMo's LLe: with no project the tab browses the default workspace directory. */
const defaultDir = ref<string>()
watch(
  () => [props.root, app.client] as const,
  async ([given, client]) => {
    if (given || defaultDir.value || !client) return
    defaultDir.value = await client
      .request({ type: "file.defaultDir" })
      .then((result) => result.directory)
      .catch(() => undefined)
  },
  { immediate: true },
)
const root = computed(() => props.root || defaultDir.value)

const revealTitle = computed(() => t("menu.revealIn", { manager: fileManagerName(app.platform) }))

function absolute(rel: string) {
  return `${(root.value ?? "").replace(/[\\/]+$/, "")}/${rel}`
}

function baseName(rel: string) {
  return rel.split("/").pop() ?? rel
}

/* ---------------------------------------------------------------- the tree */

const listing = ref<Record<string, DirEntry[]>>({})
const expanded = ref(new Set<string>())
const rootListed = ref(false)
const treeOpen = ref(true)

async function listDir(sub: string) {
  const directory = root.value
  if (!directory || !app.client) return
  const entries = await app.client
    .request({ type: "file.listDir", directory, sub, all: true })
    .then((result) => result.entries)
    .catch(() => [] as DirEntry[])
  if (root.value !== directory) return
  listing.value = { ...listing.value, [sub]: entries }
  if (!sub) rootListed.value = true
}

/* MiMo's ke: the root and every open folder, listed again. */
function relistExpanded() {
  return Promise.all(["", ...expanded.value].map((sub) => listDir(sub)))
}

watch(
  () => [root.value, app.client] as const,
  ([directory, client], previous) => {
    if (previous && previous[0] === directory && (previous[1] || !client)) return
    if (!previous || previous[0] !== directory) {
      expanded.value = new Set()
      listing.value = {}
      rootListed.value = false
    }
    void listDir("")
  },
  { immediate: true },
)

const rows = computed(() => treeRows(listing.value, expanded.value))

function toggleFolder(path: string) {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else {
    next.add(path)
    if (!listing.value[path]) void listDir(path)
  }
  expanded.value = next
}

/* ---------------------------------------------------------------- search */

const filter = ref("")
const searching = computed(() => filter.value.trim().length > 0)
/* Null while the answer is on its way: MiMo's 加载中…. */
const results = ref<FileHit[] | null>(null)
const resultsTruncated = ref(false)
const searchFailed = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchSeq = 0

watch([filter, root], ([query]) => {
  clearTimeout(searchTimer)
  const seq = ++searchSeq
  results.value = null
  resultsTruncated.value = false
  searchFailed.value = false
  if (!query.trim()) return
  searchTimer = setTimeout(async () => {
    const directory = root.value
    if (!directory || !app.client) return
    try {
      const found = await app.client.request({ type: "file.search", directory, query, nameOnly: true })
      if (seq !== searchSeq) return
      results.value = found.entries
      resultsTruncated.value = found.truncated
    } catch {
      if (seq !== searchSeq) return
      results.value = []
      searchFailed.value = true
    }
  }, 150)
})

function choose(rel: string) {
  emit("view", rel)
}

/* ---------------------------------------------------------------- the viewer */

type Read = ResponseMap["file.read"]
const opened = ref<Read>()
const readError = ref<string>()
const loadingFile = ref(false)
/* A picture, sound or video plays from a local address; a failed load says it cannot be read. */
const mediaUrl = ref<string>()
const mediaFailed = ref(false)
const mediaVersion = ref(0)
const editing = ref(false)
const draft = ref("")
const saving = ref(false)
let readSeq = 0

async function mediaAddress(file: Read): Promise<string | undefined> {
  const served = await window.mcode.officeServe(file.path).catch(() => undefined)
  if (served?.ok) return served.url
  if (file.video || !app.client) return undefined
  // A format the local server does not carry still shows from its bytes, up to the old cap.
  const bytes = await app.client.request({ type: "file.read", path: file.path }).catch(() => undefined)
  return bytes?.data && bytes.mime ? `data:${bytes.mime};base64,${bytes.data}` : undefined
}

/* `quiet` is a refresh: the file on show stays until the new reading replaces it. */
async function readFile(rel: string | undefined, quiet = false) {
  const seq = ++readSeq
  const directory = root.value
  if (!rel || !directory || !app.client) {
    opened.value = undefined
    readError.value = undefined
    loadingFile.value = false
    return
  }
  if (!quiet) {
    opened.value = undefined
    readError.value = undefined
    mediaUrl.value = undefined
    loadingFile.value = true
  }
  try {
    const file = await app.client.request({ type: "file.read", path: absolute(rel), preview: true })
    const media = file.video || file.kind === "image" || file.kind === "audio"
    const url = media ? await mediaAddress(file) : undefined
    if (seq !== readSeq) return
    opened.value = file
    readError.value = undefined
    mediaUrl.value = url
    mediaFailed.value = media && !url
    mediaVersion.value++
  } catch (err) {
    if (seq !== readSeq) return
    const message = err instanceof Error ? err.message : String(err)
    opened.value = undefined
    readError.value = /ENOENT/.test(message) ? t("rp.files.errNoEnt") : t("rp.files.errCannotRead")
  } finally {
    if (seq === readSeq) loadingFile.value = false
  }
}

watch(
  () => [root.value, props.viewFile] as const,
  ([, rel]) => {
    editing.value = false
    void readFile(rel)
  },
  { immediate: true },
)

const isMarkdown = computed(() => /\.(md|markdown)$/i.test(props.viewFile ?? ""))
const isHtml = computed(() => /\.(html?|xhtml)$/i.test(props.viewFile ?? ""))
const isText = computed(() => opened.value?.kind === "text" && !opened.value.tooBig)
const lines = computed(() => (opened.value?.content ?? "").replace(/\n+$/, "").split("\n"))

/* The same lines in MiMo's syntax colours, once the highlighter answers; plain until then. */
const colouredLines = ref<string[]>()
watch(
  () => [opened.value, props.viewFile] as const,
  async ([file, rel]) => {
    colouredLines.value = undefined
    if (!file || file.kind !== "text" || file.tooBig) return
    const text = file.content.replace(/\n+$/, "")
    const coloured = await highlightLines(text, languageForFile(rel))
    if (opened.value === file && coloured && coloured.length === lines.value.length) colouredLines.value = coloured
  },
)

/* MiMo's refresh: the listed folders again, then the open file, skipping the file while it is being edited. */
const refreshing = ref(false)
async function refresh() {
  if (!root.value || refreshing.value) return
  refreshing.value = true
  try {
    await relistExpanded()
    if (props.viewFile && !editing.value) await readFile(props.viewFile, true)
  } finally {
    refreshing.value = false
  }
}

/* ---------------------------------------------------------------- editing */

function startEdit() {
  if (!opened.value || !isText.value) return
  draft.value = opened.value.content
  editing.value = true
}

const draftLineCount = computed(() => draft.value.split("\n").length)
const gutter = ref<HTMLElement>()

function syncGutter(event: Event) {
  if (gutter.value) gutter.value.scrollTop = (event.target as HTMLTextAreaElement).scrollTop
}

async function save() {
  const rel = props.viewFile
  if (!rel || !root.value || !app.client || saving.value) return
  saving.value = true
  try {
    await app.client.request({ type: "file.write", path: absolute(rel), content: draft.value })
    if (opened.value && props.viewFile === rel) opened.value = { ...opened.value, content: draft.value }
    editing.value = false
    notify(t("rp.files.saved"))
  } catch (err) {
    notifyFailure(t("rp.files.saveFailed", { reason: t(saveFailureKey(err instanceof Error ? err.message : String(err))) }))
  } finally {
    saving.value = false
  }
}

/* ---------------------------------------------------------------- actions */

async function reveal(rel: string | undefined) {
  if (!root.value || !rel) return
  const result = await window.mcode.revealPath(absolute(rel)).catch((err: unknown) => ({ ok: false, error: String(err) }))
  if (result.ok) notify(t("menu.revealedIn", { manager: fileManagerName(app.platform) }))
  else {
    const error = result.error && result.error !== "not found" ? result.error : t("rp.files.pathNotExist")
    notifyFailure(t("rp.files.revealFailed", { error }))
  }
}

function openInBrowser(rel: string | undefined) {
  if (!root.value || !rel) return
  void window.mcode.openFile(root.value, rel).then((failure) => {
    if (failure) notifyFailure(t("rp.files.openInBrowserFailed", { error: failure }))
  })
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    notify(t("rp.files.pathCopied"))
  } catch {
    notifyFailure(t("rp.files.copyPathFailed"))
  }
}

/* The tree's width: MiMo's 160 to start and at least, remembered per machine. */
const TREE_KEY = "mcode.ftw"
const TREE_MIN = 160
const treeWidth = ref(readTreeWidth())
const body = ref<HTMLElement>()

function readTreeWidth(): number {
  try {
    const stored = Number(localStorage.getItem(TREE_KEY))
    return Number.isFinite(stored) && stored >= TREE_MIN ? Math.round(stored) : TREE_MIN
  } catch {
    return TREE_MIN
  }
}

function beginTreeResize(event: PointerEvent) {
  const target = event.currentTarget as HTMLElement
  const startX = event.clientX
  const start = treeWidth.value
  const sign = getComputedStyle(target).direction === "rtl" ? -1 : 1
  target.setPointerCapture(event.pointerId)
  const move = (moved: PointerEvent) => {
    const room = (body.value?.getBoundingClientRect().width ?? 600) - 200
    treeWidth.value = Math.round(Math.min(Math.max(TREE_MIN, room), Math.max(TREE_MIN, start + sign * (moved.clientX - startX))))
  }
  const done = () => {
    target.removeEventListener("pointermove", move)
    target.removeEventListener("pointerup", done)
    try {
      localStorage.setItem(TREE_KEY, String(treeWidth.value))
    } catch {
      /* Kept for this run only. */
    }
  }
  target.addEventListener("pointermove", move)
  target.addEventListener("pointerup", done)
}

/* ---------------------------------------------------------------- the row menu */

/* MiMo's menu glyphs, redrawn on the menu's 16px grid. */
const GLYPH = {
  file: "M8.67 1.33H4a1.33 1.33 0 0 0-1.33 1.34v10.66A1.33 1.33 0 0 0 4 14.67h8a1.33 1.33 0 0 0 1.33-1.34V6zM8.67 1.33V6h4.66",
  comment: "M14 10a1.33 1.33 0 0 1-1.33 1.33H4.67L2 14V3.33A1.33 1.33 0 0 1 3.33 2h9.34A1.33 1.33 0 0 1 14 3.33zM8 5.33v4M6 7.33h4",
  globe: "M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0zM2 8h12M8 2a10 10 0 0 1 0 12 10 10 0 0 1 0-12",
  folder: "M2 4.67a1.33 1.33 0 0 1 1.33-1.34H6l1.33 1.34h5.34A1.33 1.33 0 0 1 14 6v5.33a1.33 1.33 0 0 1-1.33 1.34H3.33A1.33 1.33 0 0 1 2 11.33z",
  copy: "M7.33 6h5.34A1.33 1.33 0 0 1 14 7.33v5.34A1.33 1.33 0 0 1 12.67 14H7.33A1.33 1.33 0 0 1 6 12.67V7.33A1.33 1.33 0 0 1 7.33 6zM3.33 10V3.33A1.33 1.33 0 0 1 4.67 2h6.66",
}

interface MenuTarget {
  path: string
  name: string
  directory: boolean
}

const menu = ref<{ x: number; y: number; node: MenuTarget }>()

/* MiMo's _Le: a folder can only be shown or copied; a page can also go to the browser. */
const menuItems = computed<MenuItem[]>(() => {
  const node = menu.value?.node
  if (!node) return []
  const tail: MenuItem[] = [
    { key: "reveal", label: revealTitle.value, icon: GLYPH.folder },
    { key: "copyPath", label: t("rp.files.copyPath"), icon: GLYPH.copy },
    { key: "copyRelPath", label: t("rp.files.copyRelPath"), icon: GLYPH.copy },
  ]
  if (node.directory) return tail
  const head: MenuItem[] = [
    { key: "open", label: t("rp.files.open"), icon: GLYPH.file },
    { key: "annotate", label: t("rp.files.annotate"), icon: GLYPH.comment },
  ]
  if (/\.(html?|xhtml)$/i.test(node.name)) head.push({ key: "openBrowser", label: t("rp.files.openInBrowser"), icon: GLYPH.globe })
  return [...head, ...tail]
})

function openMenu(event: MouseEvent, node: MenuTarget) {
  if (!root.value) return
  menu.value = { x: event.clientX, y: event.clientY, node }
}

/* MiMo's 添加批注: the whole file, with a note written in the annotation box at the pointer. */
function annotateFile(rel: string, x: number, y: number) {
  const path = absolute(rel)
  const name = baseName(rel)
  requestAnnotation({
    rect: { left: x, right: x, top: y, bottom: y },
    make: (text) => ({ id: annotationId(), kind: "file", path, name, text }),
  })
}

function pickMenu(key: string) {
  const at = menu.value
  const node = at?.node
  menu.value = undefined
  if (!node || !at) return
  if (key === "open") choose(node.path)
  else if (key === "annotate") annotateFile(node.path, at.x, at.y)
  else if (key === "openBrowser") openInBrowser(node.path)
  else if (key === "reveal") void reveal(node.path)
  else if (key === "copyPath") void copyText(absolute(node.path))
  else if (key === "copyRelPath") void copyText(node.path)
}

/* ---------------------------------------------------------------- find */

const FIND_ALL = "mcode-ft-find"
const FIND_CURRENT = "mcode-ft-find-cur"
const findOpen = ref(false)
const query = ref("")
const findIndex = ref(0)
const findTotal = ref(0)
const findInput = ref<HTMLInputElement>()
const viewer = ref<HTMLElement>()
const wrapper = ref<HTMLElement>()
let found: Range[] = []
let findObserver: MutationObserver | undefined
let findFrame = 0

/* MiMo's domFind over what is drawn: every run starts again at the first match and centres it. */
function runFind() {
  const view = viewer.value
  if (!findOpen.value || !view || !query.value.trim()) {
    found = []
    findTotal.value = 0
    findIndex.value = 0
    clearPaint(FIND_ALL, FIND_CURRENT)
    return
  }
  found = textRanges(view, query.value)
  findTotal.value = found.length
  findIndex.value = 0
  paintRanges(FIND_ALL, FIND_CURRENT, found, 0)
  if (found[0]) centreRange(found[0])
}

function stepFind(by: number) {
  if (!found.length) return
  findIndex.value = (findIndex.value + by + found.length) % found.length
  paintRanges(FIND_ALL, FIND_CURRENT, found, findIndex.value)
  const range = found[findIndex.value]
  if (range) centreRange(range)
}

function openFind() {
  findOpen.value = true
  void nextTick(() => {
    findInput.value?.focus()
    findInput.value?.select()
  })
}

function closeFind() {
  findOpen.value = false
}

watch([query, findOpen], () => runFind())
watch(findOpen, (open) => {
  findObserver?.disconnect()
  cancelAnimationFrame(findFrame)
  if (!open || !viewer.value) return
  // A re-render under the bar - a refresh, the colours arriving - finds again.
  findObserver = new MutationObserver(() => {
    cancelAnimationFrame(findFrame)
    findFrame = requestAnimationFrame(runFind)
  })
  findObserver.observe(viewer.value, { childList: true, subtree: true, characterData: true })
})

function onFindKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault()
    closeFind()
    return
  }
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  stepFind(event.shiftKey ? -1 : 1)
}

const findCount = computed(() =>
  findTotal.value === 0 && query.value.trim()
    ? t("rp.files.findEmpty")
    : t("rp.files.findCount", { cur: findTotal.value ? findIndex.value + 1 : 0, total: findTotal.value }),
)

/*
 * MiMo's global Ctrl+F: whenever the panel is open on this tab and focus is not
 * in the conversation, the chord toggles this bar - from the tree, the filter or
 * anywhere else in the panel. Taken in the capture phase, before the window's
 * own shortcuts see it.
 */
function onWindowKey(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return
  const element = wrapper.value
  if (!rp.open || !element || !element.offsetParent) return
  if (document.querySelector("[aria-modal='true']")) return
  const active = document.activeElement
  if (active instanceof Element && active.closest("main.main")) return
  event.preventDefault()
  event.stopImmediatePropagation()
  if (findOpen.value) closeFind()
  else openFind()
}

/* Find closes when the conversation changes, as MiMo's does on a switch. */
watch(() => app.currentID, () => closeFind())

/* ---------------------------------------------------------------- reading again */

/* The agent's edits: one to the open file reads it again, any finished edit re-lists the tree. */
const counts = computed(() => editCounts(app.messages, root.value, props.viewFile))
/* Numbers of their own, so a streamed token that changes no count wakes nothing. */
const editsOnFile = computed(() => counts.value.onFile)
const editsTotal = computed(() => counts.value.total)
const turnsReverted = computed(() => counts.value.reverted)
let seenOnFile = { file: props.viewFile, count: editsOnFile.value }
watch(
  () => [props.viewFile, editsOnFile.value] as const,
  ([file, count]) => {
    const before = seenOnFile
    seenOnFile = { file, count }
    if (before.file !== file || count <= before.count || !file || editing.value) return
    void refresh()
  },
)
watch(editsTotal, (now, before) => {
  if (now > before && root.value) void relistExpanded()
})
watch(
  () => [turnsReverted.value, app.history.undo, app.history.redo] as const,
  () => void refresh(),
)

/* The open file on disk: MiMo's watcher, the same one the document viewers use. */
let watchedPath: string | undefined
watch(
  () => (root.value && props.viewFile ? absolute(props.viewFile) : undefined),
  (next, previous) => {
    if (previous) void window.mcode.unwatchFile(previous)
    if (next) void window.mcode.watchFile(next)
    watchedPath = next
  },
  { immediate: true },
)
const stopWatching = window.mcode.onFileChanged((changed) => {
  if (watchedPath && changed === watchedPath && !editing.value) void refresh()
})

onMounted(() => window.addEventListener("keydown", onWindowKey, true))
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWindowKey, true)
  clearTimeout(searchTimer)
  findObserver?.disconnect()
  cancelAnimationFrame(findFrame)
  clearPaint(FIND_ALL, FIND_CURRENT)
  stopWatching()
  if (watchedPath) void window.mcode.unwatchFile(watchedPath)
})

/* ---------------------------------------------------------------- the head */

const rootLabel = computed(() => (root.value ? projectName(root.value, app.config?.projectNames) : ""))
const crumbs = computed(() => crumbsFor(root.value, rootLabel.value, props.viewFile))

function iconClass(name: string, directory: boolean) {
  return `cat-${directory ? "dir" : fileCategory(name)}`
}

function searchMenuTarget(hit: FileHit): MenuTarget {
  return { path: hit.rel, name: hit.name, directory: false }
}

function rowMenuTarget(row: TreeRow): MenuTarget {
  return { path: row.path, name: row.name, directory: row.directory }
}
</script>

<template>
  <div ref="wrapper" class="rp-files" data-rp-files>
    <div class="fv-head">
      <button
        type="button"
        class="fv-icon"
        data-ft-tree-toggle
        :aria-pressed="treeOpen"
        :aria-label="t(treeOpen ? 'rp.files.collapseTree' : 'rp.files.expandTree')"
        :title="t(treeOpen ? 'rp.files.collapseTree' : 'rp.files.expandTree')"
        @click="treeOpen = !treeOpen"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path v-if="!treeOpen" d="m6 9 3 3-3 3" />
        </svg>
      </button>
      <span class="fv-crumbs" data-ft-crumb :title="viewFile ? absolute(viewFile) : root">
        <span v-for="(part, index) in crumbs" :key="index"><span v-if="index > 0" class="fv-sep"> › </span>{{ part }}</span>
      </span>
      <span class="fv-spacer" />
      <template v-if="editing">
        <button type="button" class="fc-btn" data-ft-save :disabled="saving" @click="save">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 3h11l3 3v15H5z" /><path d="M8 3v6h7V3" /><path d="M8 21v-7h8v7" />
          </svg>
          {{ saving ? t("rp.files.saving") : t("rp.files.save") }}
        </button>
        <button type="button" class="fc-btn" data-ft-cancel @click="editing = false">{{ t("rp.files.cancel") }}</button>
      </template>
      <template v-else>
        <button v-if="viewFile && isText" type="button" class="fc-btn" data-ft-edit :title="t('rp.files.edit')" @click="startEdit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
          <span class="fc-tx">{{ t("rp.files.edit") }}</span>
        </button>
        <button v-if="viewFile && isHtml" type="button" class="fc-btn" data-ft-open-browser :title="t('rp.files.openInBrowser')" @click="openInBrowser(viewFile)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
          </svg>
          <span class="fc-tx">{{ t("rp.files.openInBrowser") }}</span>
        </button>
        <button v-if="viewFile" type="button" class="fc-btn" data-ft-reveal :title="revealTitle" @click="reveal(viewFile)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span class="fc-tx">{{ revealTitle }}</span>
        </button>
      </template>
      <button
        v-if="root"
        type="button"
        class="fv-icon"
        data-ft-refresh
        :disabled="refreshing"
        :aria-label="t('rp.files.refresh')"
        :title="t('rp.files.refresh')"
        @click="refresh"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
        </svg>
      </button>
    </div>

    <div ref="body" class="fv-body">
      <aside v-if="treeOpen" class="fv-tree" :style="{ width: `${treeWidth}px` }">
        <div class="fv-filter">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input v-model="filter" data-ft-filter spellcheck="false" :placeholder="t('rp.files.filterPlaceholder')" />
        </div>
        <div class="fv-rows">
          <div v-if="!root" class="fv-note">{{ t("rp.files.noProject") }}</div>
          <template v-else-if="searching">
            <div v-if="searchFailed" class="fv-note">{{ t("rp.files.searchFailed") }}</div>
            <div v-else-if="results === null" class="fv-note">{{ t("rp.files.loading") }}</div>
            <div v-else-if="!results.length" class="fv-note">{{ t("rp.files.searchNoMatch") }}</div>
            <template v-else>
              <button
                v-for="hit in results"
                :key="hit.rel"
                type="button"
                class="fv-row"
                :class="{ on: hit.rel === viewFile }"
                :data-ft-file="hit.rel"
                :style="{ paddingInlineStart: '10px' }"
                @click="choose(hit.rel)"
                @contextmenu.prevent="openMenu($event, searchMenuTarget(hit))"
              >
                <svg class="fv-ic" :class="iconClass(hit.name, false)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M13 2v7h7" />
                </svg>
                <span class="fv-name">{{ hit.name }}</span>
                <span v-if="hit.dir" class="fv-search-dir">{{ hit.dir }}</span>
              </button>
              <div v-if="resultsTruncated" class="fv-note truncated">{{ t("rp.files.searchTruncated", { count: results.length }) }}</div>
            </template>
          </template>
          <template v-else-if="rows.length">
            <button
              v-for="row in rows"
              :key="row.path"
              type="button"
              class="fv-row"
              :class="{ on: !row.directory && row.path === viewFile, open: row.open }"
              :data-ft-dir="row.directory ? row.path : undefined"
              :data-ft-file="row.directory ? undefined : row.path"
              :style="{ paddingInlineStart: `${rowIndent(row)}px` }"
              @click="row.directory ? toggleFolder(row.path) : choose(row.path)"
              @contextmenu.prevent="openMenu($event, rowMenuTarget(row))"
            >
              <svg v-if="row.directory" class="fv-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
              <svg class="fv-ic" :class="iconClass(row.name, row.directory)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path v-if="row.directory" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <template v-else><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M13 2v7h7" /></template>
              </svg>
              <span class="fv-name" :title="row.name">{{ row.name }}</span>
            </button>
          </template>
          <div v-else-if="rootListed" class="fv-note" data-ft-empty-dir>{{ t("rp.files.emptyDir") }}</div>
        </div>
        <div class="fv-grip" :title="t('rp.files.resizeTree')" @pointerdown.prevent="beginTreeResize" />
      </aside>

      <div class="fv-main">
        <div v-if="findOpen" class="fv-find" data-ft-find-bar>
          <svg class="fv-find-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input ref="findInput" v-model="query" class="fv-find-input" :placeholder="t('rp.files.findPlaceholder')" @keydown="onFindKey" />
          <span class="fv-find-count" data-ft-find-count>{{ findCount }}</span>
          <button type="button" class="fv-find-btn" :aria-label="t('rp.files.findPrev')" :disabled="findTotal === 0" @click="stepFind(-1)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
          </button>
          <button type="button" class="fv-find-btn" :aria-label="t('rp.files.findNext')" :disabled="findTotal === 0" @click="stepFind(1)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          <button type="button" class="fv-find-btn" :aria-label="t('rp.files.findClose')" @click="closeFind">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div ref="viewer" class="fv-view" :class="{ editing }" tabindex="-1">
          <div v-if="!root" class="fv-empty">
            <svg class="fv-empty-ic" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <div class="fv-empty-title">{{ t("rp.files.openFileTitle") }}</div>
            <div class="fv-empty-desc">{{ t("rp.files.openFileDescNoProject") }}</div>
          </div>
          <div v-else-if="!viewFile" class="fv-empty">
            <svg class="fv-empty-ic" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M13 2v7h7" />
            </svg>
            <div class="fv-empty-title">{{ t("rp.files.openFileTitle") }}</div>
            <div class="fv-empty-desc">{{ t("rp.files.openFileDescNoFile") }}</div>
          </div>
          <div v-else-if="editing" class="fv-editor-wrap">
            <div ref="gutter" class="fv-editor-ln" data-ft-editor-ln aria-hidden="true">
              <div v-for="n in draftLineCount" :key="n">{{ n }}</div>
            </div>
            <textarea v-model="draft" class="fv-editor" data-ft-editor spellcheck="false" wrap="off" @scroll="syncGutter" />
          </div>
          <div v-else-if="loadingFile || (!opened && !readError)" class="fv-empty"><div class="fv-empty-desc">{{ t("rp.files.loading") }}</div></div>
          <div v-else-if="readError" class="fv-empty"><div class="fv-empty-desc">{{ readError }}</div></div>
          <template v-else-if="opened">
            <div v-if="opened.tooBig" class="fv-empty"><div class="fv-empty-desc">{{ t("rp.files.errTooBig") }}</div></div>
            <div v-else-if="mediaFailed" class="fv-empty"><div class="fv-empty-desc">{{ t("rp.files.errCannotRead") }}</div></div>
            <PdfView v-else-if="opened.kind === 'pdf'" :path="absolute(viewFile)" :name="baseName(viewFile)" :root="root" />
            <div v-else-if="opened.kind === 'image' && mediaUrl" class="fv-media">
              <img
                :key="mediaVersion"
                class="fv-img"
                :src="mediaUrl"
                :alt="baseName(viewFile)"
                @error="mediaFailed = true"
                @click="openImagePreview(mediaUrl, { name: baseName(viewFile), path: absolute(viewFile) })"
              />
            </div>
            <div v-else-if="opened.video && mediaUrl" class="fv-media">
              <video :key="mediaVersion" class="fv-video" data-ft-video :src="mediaUrl" controls preload="metadata" @error="mediaFailed = true" />
            </div>
            <div v-else-if="opened.kind === 'audio' && mediaUrl" class="fv-media" data-ft-audio>
              <audio :key="mediaVersion" class="fv-audio" :src="mediaUrl" controls preload="metadata" @error="mediaFailed = true" />
            </div>
            <div v-else-if="opened.kind === 'binary'" class="fv-empty"><div class="fv-empty-desc">{{ t("rp.files.errBinary") }}</div></div>
            <div v-else-if="isMarkdown" class="fv-doc text" data-selectable="content" v-html="renderMarkdown(opened.content)" />
            <div
              v-else
              class="fv-code"
              :class="{ shiki: Boolean(colouredLines) }"
              data-selectable="content"
              data-annotate="code"
              :data-annotate-path="absolute(viewFile)"
            >
              <div v-for="(text, line) in lines" :key="line" class="fv-line">
                <span class="fv-num" data-find-skip>{{ line + 1 }}</span>
                <span v-if="colouredLines" class="fv-text" v-html="colouredLines[line]" />
                <span v-else class="fv-text">{{ text }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" @pick="pickMenu" @close="menu = undefined" />
  </div>
</template>

<style scoped>
/*
 * MiMo's files colours: a dim grey for chevrons, separators and line numbers,
 * and one hue per kind of file for the tree's icons, lighter under the dark
 * theme.
 */
.rp-files {
  --ft-dim: #151c1366;
  --ft-dir: #e0a63b;
  --ft-code: #2f6fed;
  --ft-web: #ff6a2b;
  --ft-data: #0d9488;
  --ft-doc: #16a34a;
  --ft-media: #ec4899;
  --ft-shell: #a855f7;
  --ft-archive: #b45309;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

:global(:root[data-theme="dark"]) .rp-files {
  --ft-dim: #777;
  --ft-dir: #f0b850;
  --ft-code: #5a9cff;
  --ft-web: #ff8a52;
  --ft-data: #2dd4bf;
  --ft-doc: #4ade80;
  --ft-media: #f472b6;
  --ft-shell: #c084fc;
  --ft-archive: #d9822b;
}

@media (prefers-color-scheme: dark) {
  :global(:root:not([data-theme="light"])) .rp-files {
    --ft-dim: #777;
    --ft-dir: #f0b850;
    --ft-code: #5a9cff;
    --ft-web: #ff8a52;
    --ft-data: #2dd4bf;
    --ft-doc: #4ade80;
    --ft-media: #f472b6;
    --ft-shell: #c084fc;
    --ft-archive: #d9822b;
  }
}

/* MiMo's head: at least 36 tall, 8 by 12, a rule under it, 12px muted, and a container for the narrow rule. */
.fv-head {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 8px 12px;
  color: var(--text-weak);
  border-bottom: 1px solid var(--border-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  container: fthead / inline-size;
}

/* The crumb ellipsizes as one line; separators in the dim grey, 2px either side. */
.fv-crumbs {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fv-sep {
  margin: 0 2px;
  color: var(--ft-dim);
}

.fv-spacer {
  flex: 1;
}

/* MiMo's icon-btn xs. */
.fv-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 7px;
}

.fv-icon:hover:not(:disabled) {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.fv-icon:disabled {
  opacity: 0.5;
}

/* MiMo's fc-btn: a 14px muted icon and a label, 1px line on the page colour, 5 by 13 on an 8px corner. */
.fc-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 5px 13px;
  color: var(--text-base);
  white-space: nowrap;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.fc-btn svg {
  flex: none;
  color: var(--text-weak);
}

.fc-btn:hover:not(:disabled) {
  background: var(--surface-hover);
}

.fc-btn:disabled {
  opacity: 0.55;
}

@container fthead (max-width: 340px) {
  .fc-btn {
    padding: 5px 8px;
  }

  .fc-tx {
    display: none;
  }
}

.fv-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.fv-tree {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  min-height: 0;
  border-inline-end: 1px solid var(--border-weak);
}

/* MiMo's filter: the line on the wrapper, a 14px dim magnifier 7 before the input. */
.fv-filter {
  display: flex;
  flex: none;
  align-items: center;
  gap: 7px;
  margin: 10px 10px 6px;
  padding: 6px 10px;
  border: 1px solid var(--border-weak);
  border-radius: 9px;
}

.fv-filter svg {
  flex: none;
  color: var(--ft-dim);
}

.fv-filter input {
  flex: 1;
  min-width: 0;
  padding: 0;
  color: var(--text-base);
  background: transparent;
  border: 0;
  outline: none;
  font-family: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.fv-rows {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding: 0 6px 10px;
  overflow: auto;
}

/* MiMo's ft-row: 4 by 8, 5 between the parts, 2 under each row. */
.fv-row {
  display: flex;
  flex: none;
  align-items: center;
  gap: 5px;
  margin-bottom: 2px;
  padding: 4px 8px;
  color: var(--text-base);
  text-align: start;
  white-space: nowrap;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.fv-row:hover {
  background: var(--surface-hover);
}

.fv-row.on {
  background: var(--surface-selected);
}

.fv-chev {
  flex: none;
  color: var(--ft-dim);
  transition: transform 0.12s;
}

.fv-row.open .fv-chev {
  transform: rotate(90deg);
}

:global([dir="rtl"]) .fv-row:not(.open) .fv-chev {
  transform: scaleX(-1);
}

.fv-ic {
  flex: none;
  color: var(--text-weak);
}

.fv-ic.cat-dir {
  color: var(--ft-dir);
}

.fv-ic.cat-code {
  color: var(--ft-code);
}

.fv-ic.cat-web {
  color: var(--ft-web);
}

.fv-ic.cat-data {
  color: var(--ft-data);
}

.fv-ic.cat-doc {
  color: var(--ft-doc);
}

.fv-ic.cat-media {
  color: var(--ft-media);
}

.fv-ic.cat-shell {
  color: var(--ft-shell);
}

.fv-ic.cat-archive {
  color: var(--ft-archive);
}

.fv-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* A search hit's folder, pushed to the end at 11px. */
.fv-search-dir {
  flex: 0 1 auto;
  min-width: 0;
  margin-inline-start: auto;
  padding-inline-start: 8px;
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fv-grip {
  position: absolute;
  inset-block: 0;
  inset-inline-end: -3px;
  z-index: 2;
  width: 6px;
  cursor: col-resize;
}

/* MiMo's ft-empty-d with its 10px padding, used for the tree's notes. */
.fv-note {
  padding: 10px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.fv-note.truncated {
  padding: 6px 10px;
}

/* The viewer's frame: the find bar floats over it without scrolling away. */
.fv-main {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.fv-view {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  outline: none;
}

.fv-view.editing {
  overflow: hidden;
}

/* Expanded, the floating chat stands over the foot: MiMo leaves its height and 8 more below. */
:global(.right-panel.fullscreen) .fv-view {
  padding-bottom: calc(var(--fc-h, 96px) + 8px);
}

/* MiMo's find bar: 42 down, 14 in from the end, 6 by 10 on a 10px corner. */
.fv-find {
  position: absolute;
  top: 42px;
  inset-inline-end: 14px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.14);
}

.fv-find-ic {
  flex: none;
  color: var(--text-weak);
}

.fv-find-input {
  width: 150px;
  padding: 0;
  color: var(--text-base);
  background: transparent;
  border: 0;
  outline: none;
  font-family: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.fv-find-input::placeholder {
  color: var(--ft-dim);
}

.fv-find-count {
  min-width: 42px;
  color: var(--ft-dim);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.fv-find-btn {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
}

.fv-find-btn:hover:not(:disabled) {
  background: var(--surface-hover);
}

.fv-find-btn:disabled {
  opacity: 0.4;
}

/* Code: 12px mono on a 1.6 line, 10 above and below, scrolling sideways rather than wrapping. */
.fv-code {
  box-sizing: border-box;
  width: max-content;
  min-width: 100%;
  padding: 10px 0;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  line-height: 1.6;
}

.fv-line {
  display: flex;
}

.fv-num {
  box-sizing: border-box;
  flex: none;
  width: 44px;
  padding-inline-end: 14px;
  color: var(--ft-dim);
  text-align: end;
  user-select: none;
}

.fv-text {
  padding-inline-end: 14px;
  color: var(--text-base);
  white-space: pre;
}

/* MiMo's editor: a frame that does not scroll, the textarea scrolling and the gutter following it. */
.fv-editor-wrap {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.fv-editor-ln {
  box-sizing: border-box;
  flex: none;
  width: 44px;
  padding: 10px 14px 10px 0;
  overflow: hidden;
  color: var(--ft-dim);
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  line-height: 1.6;
  text-align: end;
  white-space: pre;
  user-select: none;
}

.fv-editor {
  box-sizing: border-box;
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 10px 14px 10px 4px;
  overflow: auto;
  color: var(--text-base);
  white-space: pre;
  background: transparent;
  border: 0;
  outline: none;
  resize: none;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  line-height: 1.6;
}

/* Markdown as a document: 18 by 22. */
.fv-doc {
  padding: 18px 22px;
}

/* MiMo's ft-img-view: centred, 18 in, at least the viewer's height. */
.fv-media {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: 18px;
}

.fv-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  cursor: zoom-in;
}

.fv-video {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
  outline: none;
}

.fv-audio {
  width: min(100%, 480px);
  max-width: 100%;
  outline: none;
}

/* MiMo's ft-empty: over the whole viewer, a 40px icon, a 14px title, a 12px line, 8 apart. */
.fv-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-align: center;
}

.fv-empty-ic {
  color: var(--text-weak);
}

.fv-empty-title {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.fv-empty-desc {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}
</style>

<style>
/* The find marks, registered by name: the highlight API's pseudo-elements cannot be scoped. */
::highlight(mcode-ft-find) {
  background: color-mix(in srgb, var(--text-interactive) 25%, transparent);
}

::highlight(mcode-ft-find-cur) {
  background: color-mix(in srgb, var(--text-interactive) 55%, transparent);
}
</style>
