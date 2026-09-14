<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import type { FileEntry, ResponseMap } from "@shared/protocol"
import type { MenuItem } from "../../lib/menu"
import ContextMenu from "../ContextMenu.vue"
import { useApp } from "../../stores/app"
import { renderMarkdown } from "../../lib/markdown"
import { openImagePreview } from "../../lib/image-preview"
import { highlightLines, languageForFile } from "../../lib/highlight"
import { annotationId, requestAnnotation } from "../../lib/annotate"
import PdfView from "./PdfView.vue"
import { notify, notifyFailure } from "../../lib/toast"
import { t } from "../../lib/i18n"

/**
 * MiMo's files tab: the project's tree down the start, the chosen file beside
 * it. A bar across the top folds the tree away, says where the file is, and
 * offers what can be done with it - edit a text file in place, open a page in
 * the browser, show it in the file manager - and a refresh.
 *
 * The tree filters by name as it is typed into, across the whole project. The
 * viewer draws code with its line numbers, renders markdown, shows pictures and
 * plays sound; Ctrl+F while it has focus finds text in it.
 */
const props = defineProps<{ root?: string; viewFile?: string }>()
const emit = defineEmits<{ view: [file: string] }>()
const app = useApp()

const files = ref<FileEntry[]>([])
const expanded = ref(new Set<string>())
const filter = ref("")
const results = ref<FileEntry[]>()
const searchFailed = ref(false)
const treeOpen = ref(true)

type Read = ResponseMap["file.read"]
const opened = ref<Read>()
const readError = ref<string>()
const loadingFile = ref(false)
const editing = ref(false)
const draft = ref("")
const saving = ref(false)

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

function absolute(rel: string) {
  const root = props.root ?? ""
  return `${root.replace(/[\\/]+$/, "")}/${rel}`
}

function baseName(rel: string) {
  return rel.split("/").pop() ?? rel
}

async function loadTree() {
  const root = props.root
  if (!root || !app.client) {
    files.value = []
    return
  }
  files.value = await app.client
    .request({ type: "file.list", directory: root })
    .then((result) => result.files)
    .catch(() => [])
}

watch(() => props.root, () => {
  expanded.value = new Set()
  void loadTree()
}, { immediate: true })

/* The paths as a tree: each folder's folders first, then its files, by name. */
interface Node {
  path: string
  name: string
  directory: boolean
  depth: number
}

const children = computed(() => {
  const map = new Map<string, Map<string, boolean>>()
  const ensure = (dir: string) => {
    let entry = map.get(dir)
    if (!entry) map.set(dir, (entry = new Map()))
    return entry
  }
  for (const file of files.value) {
    const parts = file.path.split("/")
    let parent = ""
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/")
      const directory = i < parts.length - 1
      ensure(parent).set(path, directory || ensure(parent).get(path) === true)
      parent = path
    }
  }
  return map
})

const rows = computed<Node[]>(() => {
  const out: Node[] = []
  const walk = (dir: string, depth: number) => {
    const entries = [...(children.value.get(dir) ?? new Map()).entries()].sort(([a, aDir], [b, bDir]) =>
      aDir === bDir ? baseName(a).localeCompare(baseName(b)) : aDir ? -1 : 1,
    )
    for (const [path, directory] of entries) {
      out.push({ path, name: baseName(path), directory, depth })
      if (directory && expanded.value.has(path)) walk(path, depth + 1)
    }
  }
  walk("", 0)
  return out
})

function toggleFolder(path: string) {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(filter, (query) => {
  clearTimeout(searchTimer)
  if (!query.trim()) {
    results.value = undefined
    return
  }
  searchTimer = setTimeout(async () => {
    const root = props.root
    if (!root || !app.client) return
    try {
      results.value = (await app.client.request({ type: "file.list", directory: root, query: query.trim() })).files
      searchFailed.value = false
    } catch {
      searchFailed.value = true
      results.value = []
    }
  }, 150)
})

function choose(rel: string) {
  emit("view", rel)
}

async function readFile(rel: string | undefined) {
  editing.value = false
  opened.value = undefined
  readError.value = undefined
  if (!rel || !props.root || !app.client) return
  loadingFile.value = true
  try {
    opened.value = await app.client.request({ type: "file.read", path: absolute(rel) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    readError.value = /ENOENT/.test(message) ? t("rp.files.errNoEnt") : t("rp.files.errCannotRead")
  } finally {
    loadingFile.value = false
  }
}

watch(() => [props.root, props.viewFile] as const, ([, rel]) => void readFile(rel), { immediate: true })

const extension = computed(() => (props.viewFile?.split(".").pop() ?? "").toLowerCase())
const isMarkdown = computed(() => ["md", "markdown", "mdx"].includes(extension.value))
const isHtml = computed(() => ["html", "htm"].includes(extension.value))
const isText = computed(() => opened.value?.kind === "text")
const lines = computed(() => (opened.value?.content ?? "").split("\n"))

/* The same lines in MiMo's syntax colours, once the highlighter answers; plain until then, and while finding. */
const colouredLines = ref<string[]>()
watch(
  () => [opened.value, props.viewFile] as const,
  async ([file, rel]) => {
    colouredLines.value = undefined
    if (!file || file.kind !== "text") return
    const coloured = await highlightLines(file.content, languageForFile(rel))
    if (opened.value === file && coloured && coloured.length === lines.value.length) colouredLines.value = coloured
  },
)
const showColoured = computed(() => Boolean(colouredLines.value) && !(findOpen.value && query.value))

function refresh() {
  void loadTree()
  void readFile(props.viewFile)
}

/* Edit in place: MiMo's for markdown and code, which is every text file here. */
function startEdit() {
  if (!opened.value || !isText.value) return
  draft.value = opened.value.content
  editing.value = true
}

async function save() {
  if (!props.viewFile || !app.client || saving.value) return
  saving.value = true
  try {
    await app.client.request({ type: "file.write", path: absolute(props.viewFile), content: draft.value })
    if (opened.value) opened.value = { ...opened.value, content: draft.value }
    editing.value = false
    notify(t("rp.files.saved"))
  } catch (err) {
    notifyFailure(t("rp.files.saveFailed", { reason: err instanceof Error ? err.message : String(err) }))
  } finally {
    saving.value = false
  }
}

function reveal(rel: string | undefined) {
  if (!props.root || !rel) return
  void window.mcode.revealFile(props.root, rel).catch((err: unknown) => {
    notifyFailure(t("rp.files.revealFailed", { error: err instanceof Error ? err.message : String(err) }))
  })
}

function openInBrowser() {
  if (!props.root || !props.viewFile) return
  void window.mcode.openFile(props.root, props.viewFile).then((failure) => {
    if (failure) notifyFailure(t("rp.files.openInBrowserFailed", { error: failure }))
  })
}

function copyPath(rel: string, relative: boolean) {
  window.mcode.setClipboardText(relative ? rel : absolute(rel))
  notify(t("rp.files.pathCopied"))
}

/* The tree's drag edge. */
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

/* The row menu. */
const menu = ref<{ x: number; y: number; node: Node }>()
const menuItems = computed<MenuItem[]>(() => {
  const node = menu.value?.node
  if (!node) return []
  const items: MenuItem[] = []
  if (!node.directory) items.push({ key: "open", label: t("rp.files.open") }, { key: "annotate", label: t("rp.files.annotate") })
  items.push(
    { key: "reveal", label: t("files.reveal") },
    { key: "copyPath", label: t("rp.files.copyPath") },
    { key: "copyRelPath", label: t("rp.files.copyRelPath") },
  )
  return items
})

/* MiMo's 添加批注: the whole file, with a note written in the annotation box at the pointer. */
function annotateFile(rel: string, x: number, y: number) {
  const path = absolute(rel)
  const name = rel.split("/").pop() ?? rel
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
  else if (key === "reveal") reveal(node.path)
  else if (key === "copyPath") copyPath(node.path, false)
  else if (key === "copyRelPath") copyPath(node.path, true)
}

/* Find, in the file on show. */
const findOpen = ref(false)
const query = ref("")
const current = ref(0)
const findInput = ref<HTMLInputElement>()
const viewer = ref<HTMLElement>()

const matches = computed(() => {
  const needle = query.value.toLowerCase()
  if (!findOpen.value || !needle || !isText.value) return [] as { line: number; start: number }[]
  const found: { line: number; start: number }[] = []
  lines.value.forEach((text, line) => {
    const hay = text.toLowerCase()
    let at = hay.indexOf(needle)
    while (at >= 0) {
      found.push({ line, start: at })
      at = hay.indexOf(needle, at + needle.length)
    }
  })
  return found
})

watch(matches, () => {
  current.value = 0
  void reveal_match()
})

async function reveal_match() {
  await nextTick()
  viewer.value?.querySelector(".fv-mark.current")?.scrollIntoView({ block: "center" })
}

function step(by: number) {
  if (!matches.value.length) return
  current.value = (current.value + by + matches.value.length) % matches.value.length
  void reveal_match()
}

function segments(text: string, line: number) {
  const hits = matches.value.map((match, index) => ({ ...match, index })).filter((match) => match.line === line)
  if (!hits.length) return [{ text, mark: false, current: false }]
  const out: { text: string; mark: boolean; current: boolean }[] = []
  let at = 0
  for (const hit of hits) {
    out.push({ text: text.slice(at, hit.start), mark: false, current: false })
    out.push({ text: text.slice(hit.start, hit.start + query.value.length), mark: true, current: hit.index === current.value })
    at = hit.start + query.value.length
  }
  out.push({ text: text.slice(at), mark: false, current: false })
  return out
}

function onViewerKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && isText.value && !editing.value) {
    event.preventDefault()
    event.stopPropagation()
    findOpen.value = true
    void nextTick(() => findInput.value?.focus())
  }
}

onBeforeUnmount(() => clearTimeout(searchTimer))

const crumbs = computed(() => (props.viewFile ? props.viewFile.split("/") : []))
const rootName = computed(() => (props.root ? baseName(props.root.replace(/\\/g, "/").replace(/\/+$/, "")) : ""))
</script>

<template>
  <div class="rp-files" data-rp-files>
    <div class="fv-head">
      <button
        type="button"
        class="fv-icon"
        :aria-pressed="treeOpen"
        :aria-label="t(treeOpen ? 'rp.files.collapseTree' : 'rp.files.expandTree')"
        v-tip="{ label: t(treeOpen ? 'rp.files.collapseTree' : 'rp.files.expandTree'), placement: 'bottom' }"
        @click="treeOpen = !treeOpen"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" />
        </svg>
      </button>
      <span class="fv-crumbs" :title="viewFile ? absolute(viewFile) : root">
        <span>{{ rootName }}</span>
        <template v-for="(part, index) in crumbs" :key="index">
          <span class="fv-sep">›</span>
          <span :class="{ last: index === crumbs.length - 1 }">{{ part }}</span>
        </template>
      </span>
      <span class="fv-spacer" />
      <template v-if="editing">
        <button type="button" class="fc-btn" :disabled="saving" @click="save">{{ saving ? t("rp.files.saving") : t("rp.files.save") }}</button>
        <button type="button" class="fc-btn" :disabled="saving" @click="editing = false">{{ t("rp.files.cancel") }}</button>
      </template>
      <template v-else-if="viewFile && opened">
        <button v-if="isText" type="button" class="fv-icon" :aria-label="t('rp.files.edit')" v-tip="{ label: t('rp.files.edit'), placement: 'bottom' }" @click="startEdit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.9 3.9a2.1 2.1 0 0 1 3 3L8 17.8l-4 1 1-4z" /></svg>
        </button>
        <button v-if="isHtml" type="button" class="fv-icon" :aria-label="t('rp.files.openInBrowser')" v-tip="{ label: t('rp.files.openInBrowser'), placement: 'bottom' }" @click="openInBrowser">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.6 5.5 3.6 9s-1.1 6.5-3.6 9c-2.5-2.5-3.6-5.5-3.6-9S9.5 5.5 12 3z" /></svg>
        </button>
        <button type="button" class="fv-icon" :aria-label="t('files.reveal')" v-tip="{ label: t('files.reveal'), placement: 'bottom' }" @click="reveal(viewFile)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
        </button>
      </template>
      <button type="button" class="fv-icon" :aria-label="t('rp.files.refresh')" v-tip="{ label: t('rp.files.refresh'), placement: 'bottom' }" @click="refresh">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg>
      </button>
    </div>

    <div ref="body" class="fv-body">
      <aside v-if="treeOpen" class="fv-tree" :style="{ width: `${treeWidth}px` }">
        <input v-model="filter" class="fv-filter" spellcheck="false" :placeholder="t('rp.files.filterPlaceholder')" />
        <div class="fv-rows">
          <div v-if="!root" class="fv-note">{{ t("rp.files.noProject") }}</div>
          <template v-else-if="results">
            <div v-if="searchFailed" class="fv-note">{{ t("rp.files.searchFailed") }}</div>
            <div v-else-if="!results.length" class="fv-note">{{ t("rp.files.searchNoMatch") }}</div>
            <button
              v-for="entry in results"
              :key="entry.path"
              type="button"
              class="fv-row"
              :class="{ on: entry.path === viewFile }"
              :title="entry.path"
              @click="choose(entry.path)"
              @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, node: { path: entry.path, name: entry.name, directory: false, depth: 0 } }"
            >
              <span class="fv-name">{{ entry.name }}</span>
              <span class="fv-dir">{{ entry.path.slice(0, -entry.name.length).replace(/\/$/, "") }}</span>
            </button>
          </template>
          <template v-else>
            <button
              v-for="node in rows"
              :key="node.path"
              type="button"
              class="fv-row"
              :class="{ on: node.path === viewFile }"
              :style="{ paddingInlineStart: `${8 + node.depth * 12}px` }"
              :title="node.path"
              @click="node.directory ? toggleFolder(node.path) : choose(node.path)"
              @contextmenu.prevent="menu = { x: $event.clientX, y: $event.clientY, node }"
            >
              <svg v-if="node.directory" class="fv-chev" :class="{ open: expanded.has(node.path) }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
              <span v-else class="fv-chev-space" />
              <svg class="fv-ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path v-if="node.directory" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                <path v-else d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />
              </svg>
              <span class="fv-name">{{ node.name }}</span>
            </button>
          </template>
        </div>
        <div class="fv-grip" v-tip="{ label: t('rp.files.resizeTree'), placement: 'right' }" @pointerdown.prevent="beginTreeResize" />
      </aside>

      <div ref="viewer" class="fv-view" tabindex="-1" @keydown="onViewerKey">
        <div v-if="findOpen" class="fv-find">
          <input
            ref="findInput"
            v-model="query"
            class="fv-find-input"
            :placeholder="t('rp.files.findPlaceholder')"
            @keydown.enter.prevent="step($event.shiftKey ? -1 : 1)"
            @keydown.esc.prevent="findOpen = false"
          />
          <span class="fv-find-count">{{ query && !matches.length ? t("rp.files.findEmpty") : matches.length ? t("rp.files.findCount", { cur: current + 1, total: matches.length }) : "" }}</span>
          <button type="button" class="fv-icon small" :aria-label="t('rp.files.findPrev')" @click="step(-1)">‹</button>
          <button type="button" class="fv-icon small" :aria-label="t('rp.files.findNext')" @click="step(1)">›</button>
          <button type="button" class="fv-icon small" :aria-label="t('rp.files.findClose')" @click="findOpen = false">×</button>
        </div>

        <div v-if="!viewFile" class="fv-empty">
          <div class="fv-empty-title">{{ t("rp.files.openFileTitle") }}</div>
          <div class="fv-empty-desc">{{ root ? t("rp.files.openFileDescNoFile") : t("rp.files.openFileDescNoProject") }}</div>
        </div>
        <div v-else-if="loadingFile" class="fv-empty"><div class="fv-empty-desc">{{ t("rp.files.loading") }}</div></div>
        <div v-else-if="readError" class="fv-empty"><div class="fv-empty-desc">{{ readError }}</div></div>
        <template v-else-if="opened">
          <div v-if="editing" class="fv-code editing">
            <div class="fv-gutter" aria-hidden="true"><div v-for="(_, index) in draft.split('\n')" :key="index">{{ index + 1 }}</div></div>
            <textarea v-model="draft" class="fv-edit" spellcheck="false" />
          </div>
          <PdfView v-else-if="opened.kind === 'pdf' && opened.data" :data="opened.data" :path="absolute(viewFile ?? '')" :name="(viewFile ?? '').split('/').pop() ?? ''" />
          <div v-else-if="opened.kind === 'image' && opened.data" class="fv-media">
            <img :src="`data:${opened.mime};base64,${opened.data}`" :alt="viewFile" @click="openImagePreview(`data:${opened.mime};base64,${opened.data}`, { name: viewFile })" />
          </div>
          <div v-else-if="opened.kind === 'audio' && opened.data" class="fv-media">
            <audio controls :src="`data:${opened.mime};base64,${opened.data}`" />
          </div>
          <div v-else-if="opened.kind === 'binary'" class="fv-empty"><div class="fv-empty-desc">{{ t("rp.files.errBinary") }}</div></div>
          <div v-else-if="isMarkdown && !findOpen" class="fv-doc text" v-html="renderMarkdown(opened.content)" />
          <div v-else class="fv-code" :class="{ shiki: showColoured }" data-annotate="code" :data-annotate-path="viewFile ? absolute(viewFile) : undefined">
            <div v-for="(text, line) in lines" :key="line" class="fv-line">
              <span class="fv-num">{{ line + 1 }}</span>
              <span v-if="showColoured" class="fv-text" v-html="colouredLines?.[line]" />
              <span v-else class="fv-text"><template v-for="(part, index) in segments(text, line)" :key="index"><mark v-if="part.mark" class="fv-mark" :class="{ current: part.current }">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
            </div>
            <div v-if="opened.truncated" class="fv-note">{{ t("rp.files.errTooBig") }}</div>
          </div>
        </template>
      </div>
    </div>

    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" @pick="pickMenu" @close="menu = undefined" />
  </div>
</template>

<style scoped>
.rp-files {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* MiMo's head: at least 36 tall, 8 by 12, a rule under it, 12px muted. */
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
}

.fv-crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.fv-crumbs .last {
  color: var(--text-strong);
}

.fv-sep {
  opacity: 0.6;
}

.fv-spacer {
  flex: 1;
}

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

.fv-icon:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.fv-icon.small {
  width: 22px;
  height: 22px;
}

/* MiMo's text buttons: 1px line, the page colour, 12px, 5 by 13 on an 8px corner. */
.fc-btn {
  flex: none;
  padding: 5px 13px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.fc-btn:hover:not(:disabled) {
  background: var(--surface-hover);
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

/* MiMo's filter: a 9px corner, 10 / 10 / 6 around it, 6 by 10 inside. */
.fv-filter {
  flex: none;
  margin: 10px 10px 6px;
  padding: 6px 10px;
  color: var(--text-strong);
  background: transparent;
  border: 1px solid var(--border-weak);
  border-radius: 9px;
  outline: none;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.fv-rows {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  padding: 0 6px 8px;
  overflow: auto;
}

.fv-row {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  color: var(--text-strong);
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

.fv-row:hover {
  background: var(--surface-hover);
}

.fv-row.on {
  background: var(--surface-selected);
}

.fv-chev {
  flex: none;
  color: var(--text-weak);
  transition: transform 0.12s;
}

.fv-chev.open {
  transform: rotate(90deg);
}

.fv-chev-space {
  flex: none;
  width: 12px;
}

.fv-ic {
  flex: none;
  color: var(--text-weak);
}

.fv-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fv-dir {
  min-width: 0;
  margin-inline-start: 6px;
  overflow: hidden;
  color: var(--text-weaker);
  text-overflow: ellipsis;
}

.fv-grip {
  position: absolute;
  inset-block: 0;
  inset-inline-end: -3px;
  z-index: 2;
  width: 6px;
  cursor: col-resize;
}

.fv-note {
  padding: 8px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.fv-view {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  outline: none;
}

/* Expanded, the floating chat stands over the foot: MiMo leaves its height and 8 more below. */
:global(.right-panel.fullscreen) .fv-view {
  padding-bottom: calc(var(--fc-h, 96px) + 8px);
}

/* MiMo's find bar: 42 down, 14 in from the end. */
.fv-find {
  position: absolute;
  top: 8px;
  inset-inline-end: 14px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  background: var(--surface-menu);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  box-shadow: var(--shadow-md);
}

.fv-find-input {
  width: 160px;
  padding: 2px 6px;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.fv-find-count {
  min-width: 42px;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  text-align: center;
}

/* Code: a 44px gutter of numbers, 12px mono on a 1.6 line. */
.fv-code {
  padding: 8px 0;
  font-family: var(--font-mono);
  font-size: calc(12px * var(--code-font-scale, 1));
  line-height: 1.6;
}

.fv-line {
  display: flex;
}

.fv-num {
  flex: none;
  width: 44px;
  padding-inline-end: 10px;
  color: var(--text-weaker);
  text-align: end;
  user-select: none;
}

.fv-text {
  min-width: 0;
  padding-inline-end: 12px;
  color: var(--text-strong);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.fv-mark {
  color: inherit;
  background: color-mix(in srgb, var(--text-warning) 30%, transparent);
  border-radius: 2px;
}

.fv-mark.current {
  background: color-mix(in srgb, var(--text-warning) 60%, transparent);
}

.fv-code.editing {
  display: flex;
  flex: 1;
  min-height: 0;
}

.fv-gutter {
  flex: none;
  width: 44px;
  padding-inline-end: 10px;
  color: var(--text-weaker);
  text-align: end;
  user-select: none;
}

.fv-edit {
  flex: 1;
  min-height: 100%;
  padding: 0 12px 0 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  resize: none;
  font: inherit;
  line-height: inherit;
  white-space: pre;
}

/* Markdown as a document: 18 by 22. */
.fv-doc {
  padding: 18px 22px;
}

.fv-media {
  display: grid;
  flex: 1;
  place-items: center;
  padding: 16px;
}

.fv-media img {
  max-width: 100%;
  max-height: 100%;
  cursor: zoom-in;
}

.fv-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  text-align: center;
}

.fv-empty-title {
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.fv-empty-desc {
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}
</style>
