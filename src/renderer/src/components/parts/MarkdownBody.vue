<script setup lang="ts">
import "katex/dist/katex.min.css"
import { computed, getCurrentInstance, h, nextTick, onBeforeUnmount, onMounted, ref, render, watch } from "vue"
import { mathReady, renderReply, type ReplyBlock } from "../../lib/markdown"
import { cachedHighlight, highlight, languageOf } from "../../lib/highlight"
import { openImagePreview, openVideoPreview } from "../../lib/image-preview"
import { useApp } from "../../stores/app"
import { t } from "../../lib/i18n"
import { notifyFailure } from "../../lib/toast"
import { useEscapeLayerWhile } from "../../lib/escape-layer"
import type { MenuItem } from "../../lib/menu"
import { localPathOf, openPathLink, pathMenuItems, resolvePathTarget, runPathMenu, type PathTarget } from "../../lib/path-open"
import ContextMenu from "../ContextMenu.vue"
import AbcBlock from "./AbcBlock.vue"
import DiagramBlock from "./DiagramBlock.vue"
import WidgetBlock from "./WidgetBlock.vue"
import LocalMedia from "./LocalMedia.vue"
import { mediaPath } from "../../lib/delivered"
import { allowRemoteImage, showAllowedRemoteImages } from "../../lib/remote-images"
import { writeText } from "./../../lib/clipboard"

/**
 * A body of markdown drawn the way a reply is drawn.
 *
 * MiMo has one markdown component and hangs it wherever a document is read - a
 * reply, and the files tab's view of a .md file, which is why a README opened
 * in the panel there has its links, its pictures, its coloured fences, its copy
 * buttons, its diagrams, its scores and its maths. This is that component: the
 * renderer's blocks, the components the blocks that are not markup need, and
 * every control in the markup caught on the way up.
 *
 * `live` is a reply still being written: MiMo keeps diagrams as code, the last
 * line plain and footnotes back until it has ended, and its stylesheet fades
 * each finished block in. Text arrives as the store holds it, with no
 * per-character pacing.
 */
defineOptions({ inheritAttrs: false })
const props = defineProps<{
  text: string
  live?: boolean
  /** The folder a relative picture, video or path is read from: a markdown file's own; a reply's is its conversation's. */
  baseDir?: string
}>()
const app = useApp()
const baseDir = computed(() => props.baseDir ?? app.current?.directory)
const instance = getCurrentInstance()

/*
 * MiMo's syntax colours, put into the markup before it is bound, from the
 * highlighter's cache, so a block redrawn every frame never flashes plain.
 * What is not cached yet is asked for and drawn plain until it arrives. While
 * a block is live only the lines before its last newline are coloured; the
 * unfinished line follows them plain, and a live block past 20,000 characters
 * is not coloured until the reply ends.
 */
const CODE_BLOCK = /<pre class="md-code( md-lined)?" data-lang="([^"]*)"><code>([\s\S]*?)<\/code><\/pre>/g
const LIVE_COLOUR_LIMIT = 20_000
const colourRound = ref(0)
const wanted = new Map<string, { code: string; lang: string }>()

const plainText = (html: string) =>
  html.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function colourCode(html: string, liveBlock: boolean): string {
  if (!html.includes('<pre class="md-code')) return html
  return html.replace(CODE_BLOCK, (whole, lined: string | undefined, lang: string, inner: string) => {
    if (!languageOf(lang)) return whole
    const text = plainText(inner)
    let code = text
    let rest = ""
    if (liveBlock) {
      const cut = text.lastIndexOf("\n")
      if (cut <= 0 || cut > LIVE_COLOUR_LIMIT) return whole
      code = text.slice(0, cut)
      rest = `\n<span class="line">${escapeText(text.slice(cut + 1))}</span>`
    }
    const coloured = cachedHighlight(code, lang)
    if (coloured === undefined) {
      wanted.set(`${lang}\n${code}`, { code, lang })
      return whole
    }
    return `<pre class="md-code${lined ?? ""} shiki" data-lang="${lang}"><code>${coloured}${rest}</code></pre>`
  })
}

// Safe to bind as HTML: renderReply escapes every piece of source it places, and hands diagrams over as source.
const rendered = computed<ReplyBlock[]>(() => {
  void colourRound.value
  // A formula drawn before KaTeX arrived showed its source; drawn again once it has.
  void mathReady.value
  const isLive = props.live === true
  const list = renderReply(props.text, {
    codeActions: { copy: t("code.copy"), copied: t("code.copied"), label: t("code.copyLabel") },
    tableActions: { label: t("table.actions"), preview: t("table.preview"), copy: t("table.copy") },
    videoCards: { tip: t("markdown.previewAnnotateTip"), fallback: t("markdown.videoFallbackLabel") },
    math: true,
    links: { imageTip: t("markdown.previewAnnotateTip"), remoteImage: t("markdown.remoteImageLoad") },
    paths: { tip: t("markdown.openWithDefaultTip") },
    diagrams: { streaming: isLive },
    lineNumbers: true,
    live: isLive,
  })
  const last = list.length - 1
  return list.map((block, index) => (block.kind === "html" ? { kind: "html", html: colourCode(block.html, isLive && index === last) } : block))
})

/* A block keeps its element while it is unchanged, so only the one being written is redrawn. */
const blockKey = (block: ReplyBlock, index: number) =>
  `${block.kind === "diagram" ? "d" : block.kind === "abc" ? "a" : block.kind === "widget" ? "w" : block.kind === "html" ? "h" : "s"}${index}`

/*
 * MiMo's video card: a web, data or blob address plays as it is; a file on
 * this machine (a file: address, or an image path) is handed to the local
 * preview server first, since the window cannot read the disk, and the
 * preview then knows its path for the annotation.
 */
async function openVideoCard(url: string, label: string) {
  if (/^(https?:|data:|blob:)/i.test(url)) {
    openVideoPreview(url, { name: label })
    return
  }
  const file = localPathOf(url, baseDir.value)
  const served = file ? await window.mcode.officeServe(file) : null
  if (!served?.ok) {
    notifyFailure(t("office.fileMissing"))
    return
  }
  openVideoPreview(served.url, { path: file, name: file.split(/[\\/]/).pop() || label })
}

const root = ref<HTMLElement>()

/*
 * The colour pass, as MiMo throttles it: at most once per six times the last
 * pass's cost, between 120ms and a second, so colour keeps up with a block
 * that is still streaming instead of waiting for the stream to pause.
 */
let colourTimer: ReturnType<typeof setTimeout> | undefined
let lastColour = 0
let colourCost = 0
let unmounted = false

function scheduleColour() {
  if (colourTimer !== undefined || !wanted.size || unmounted) return
  const gap = Math.min(1000, Math.max(120, 6 * colourCost))
  colourTimer = setTimeout(() => void runColour(), Math.max(0, lastColour + gap - performance.now()))
}

async function runColour() {
  colourTimer = undefined
  lastColour = performance.now()
  const jobs = [...wanted.values()]
  wanted.clear()
  let fresh = false
  for (const job of jobs) if ((await highlight(job.code, job.lang)) !== undefined) fresh = true
  colourCost = performance.now() - lastColour
  if (unmounted) return
  if (fresh) colourRound.value += 1
  scheduleColour()
}

watch(rendered, scheduleColour, { immediate: true, flush: "post" })

/*
 * The cards for pictures, videos and sounds named by path are components,
 * mounted into the placeholders the renderer left. A block that is redrawn
 * drops its placeholders, and their cards are unmounted with them.
 */
const mounted = new Set<HTMLElement>()

function mountMedia() {
  const host = root.value
  if (!host) return
  // A web picture the reader already asked for stays shown when its block is redrawn.
  showAllowedRemoteImages(host, t("markdown.previewAnnotateTip"))
  for (const holder of [...mounted]) {
    if (holder.isConnected) continue
    render(null, holder)
    mounted.delete(holder)
  }
  for (const holder of host.querySelectorAll<HTMLElement>(".md-media:not([data-mounted])")) {
    const kind = holder.dataset.media
    const path = holder.dataset.mediaPath
    if ((kind !== "image" && kind !== "video" && kind !== "audio") || !path) continue
    // A picture, video or sound is shown wherever it lives, as MiMo shows it (the user's 2026-09-16 decision).
    const target = mediaPath(path, baseDir.value)
    if (!target) continue
    holder.dataset.mounted = "true"
    holder.textContent = ""
    const vnode = h(LocalMedia, { kind, path: target, directory: baseDir.value })
    vnode.appContext = instance?.appContext ?? null
    render(vnode, holder)
    mounted.add(holder)
  }
}

watch(rendered, () => void nextTick(mountMedia), { flush: "post" })
onMounted(mountMedia)

/*
 * MiMo's table copy: the model's own markdown for plain text and the bare
 * table for anything that pastes HTML; a table without its source is written
 * out as a pipe table instead.
 */
function pipeTable(table: HTMLTableElement): string {
  const rows = [...table.rows]
  if (!rows.length) return ""
  const width = Math.max(...rows.map((row) => row.cells.length))
  const cell = (text: string) => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()
  const line = (row: HTMLTableRowElement) =>
    `| ${Array.from({ length: width }, (_, at) => cell(row.cells[at]?.textContent ?? "")).join(" | ")} |`
  return [line(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n")
}

function bareTable(table: HTMLTableElement): string {
  const copy = table.cloneNode(true) as HTMLTableElement
  copy.removeAttribute("class")
  copy.querySelectorAll("[class]").forEach((node) => node.removeAttribute("class"))
  return copy.outerHTML
}

async function copyTable(button: HTMLElement) {
  const container = button.closest<HTMLElement>(".md-table-container")
  const table = container?.querySelector("table")
  if (!container || !table) return
  const text = container.dataset.mdSource?.trim() || pipeTable(table)
  try {
    const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
    let written = false
    if (navigator.clipboard?.write && Item) {
      try {
        await navigator.clipboard.write([
          new Item({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([bareTable(table)], { type: "text/html" }) }),
        ])
        written = true
      } catch {
        // Some clipboards take only text; that is tried next.
      }
    }
    if (!written) await writeText(text)
    button.classList.add("copied")
    window.setTimeout(() => button.classList.remove("copied"), 2000)
  } catch {
    notifyFailure(t("table.copyFailed"))
  }
}

/* MiMo's table preview: the same table, wide, in a dialog of its own. */
const previewing = ref<string>()

function closePreview() {
  previewing.value = undefined
}

useEscapeLayerWhile(() => previewing.value, closePreview)

/* The right-click menu on a path: open, copy the picture, copy the path, show it in the file manager. */
const pathMenu = ref<{ x: number; y: number; items: MenuItem[]; target: PathTarget }>()

async function onContextMenu(event: MouseEvent) {
  const holder = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-path]")
  if (!holder) return
  event.preventDefault()
  const at = { x: event.clientX, y: event.clientY }
  const target = await resolvePathTarget(holder.dataset.path ?? "", holder.dataset.pathKind ?? "", baseDir.value, holder.hasAttribute("data-path-image"))
  if (target) pathMenu.value = { ...at, items: pathMenuItems(target, app.platform), target }
}

function pickPathMenu(key: string) {
  const menu = pathMenu.value
  pathMenu.value = undefined
  if (menu) void runPathMenu(key, menu.target, app.platform)
}

onBeforeUnmount(() => {
  unmounted = true
  clearTimeout(colourTimer)
  for (const holder of mounted) render(null, holder)
  mounted.clear()
})

function scrollToFootnote(selector: string) {
  root.value?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "center", behavior: "smooth" })
}

function openChip(chip: HTMLElement) {
  void openPathLink(chip.dataset.path ?? "", chip.dataset.pathKind ?? "", baseDir.value, app.platform)
}

/*
 * Every control in the rendered markup is caught here on the way up, since the
 * markup is bound as HTML: code and table buttons, video cards, links (which go
 * to the system browser), pictures (to the preview), footnotes and path chips.
 */
async function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (!target) return
  const videoCard = target.closest<HTMLElement>("[data-video-url]")
  if (videoCard) {
    await openVideoCard(videoCard.dataset.videoUrl ?? "", videoCard.dataset.videoLabel ?? "")
    return
  }
  const tableCopy = target.closest<HTMLElement>("[data-table-copy]")
  if (tableCopy) {
    await copyTable(tableCopy)
    return
  }
  const tablePreview = target.closest<HTMLElement>("[data-table-preview]")
  if (tablePreview) {
    previewing.value = tablePreview.closest(".md-table-container")?.querySelector("table")?.outerHTML
    return
  }
  const footnoteRef = target.closest<HTMLElement>("[data-footnote-ref]")
  if (footnoteRef) {
    event.preventDefault()
    scrollToFootnote(`[data-footnote="${footnoteRef.dataset.footnoteRef}"]`)
    return
  }
  const footnoteBack = target.closest<HTMLElement>("[data-footnote-back]")
  if (footnoteBack) {
    event.preventDefault()
    scrollToFootnote(`[data-footnote-ref="${footnoteBack.dataset.footnoteBack}"]`)
    return
  }
  const link = target.closest<HTMLAnchorElement>("a[href]")
  if (link) {
    // Never a navigation of this window: a web address goes to the system browser, anything else nowhere.
    event.preventDefault()
    const href = link.getAttribute("href") ?? ""
    if (/^https?:\/\//i.test(href)) window.mcode.openExternal(href)
    return
  }
  const remote = target.closest<HTMLElement>("[data-remote-src]")
  if (remote && root.value) {
    // The reader asked for this web picture: it loads now, and wherever else this reply names it.
    allowRemoteImage(remote.dataset.remoteSrc ?? "")
    showAllowedRemoteImages(root.value, t("markdown.previewAnnotateTip"))
    return
  }
  const image = target.closest<HTMLImageElement>("img[data-preview-src]")
  if (image) {
    const group = [...(root.value?.querySelectorAll<HTMLImageElement>("img[data-preview-src]") ?? [])].map((each) => each.dataset.previewSrc ?? "")
    openImagePreview(image.dataset.previewSrc ?? "", { name: image.alt || undefined, group, rect: image.getBoundingClientRect() })
    return
  }
  const chip = target.closest<HTMLElement>("code.md-path[role='button']")
  if (chip) {
    openChip(chip)
    return
  }
  const button = target.closest<HTMLButtonElement>("[data-copy-code]")
  if (!button) return
  const code = button.closest(".md-codeblock")?.querySelector("pre code")?.textContent ?? ""
  try {
    await writeText(code)
    button.classList.add("copied")
    window.setTimeout(() => button.classList.remove("copied"), 2000)
  } catch {
    notifyFailure(t("code.copyFailed"))
  }
}

/* A path chip is a button to the keyboard as well: Enter or Space opens it. */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" && event.key !== " ") return
  const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>("code.md-path[role='button']")
  if (!chip) return
  event.preventDefault()
  openChip(chip)
}

/* MiMo's picture link: when the picture will not load, it becomes the link it was. `error` does not bubble, so this listens while capturing. */
function onError(event: Event) {
  const image = event.target
  if (!(image instanceof HTMLImageElement) || !image.dataset.fallbackHref) return
  const link = document.createElement("a")
  link.className = "md-link"
  link.href = image.dataset.fallbackHref
  link.rel = "noreferrer"
  link.textContent = image.alt || image.dataset.fallbackHref
  image.replaceWith(link)
}
</script>

<template>
  <div
    ref="root"
    v-bind="$attrs"
    class="text"
    :class="{ streaming: live }"
    @click="onClick"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
    @error.capture="onError"
  >
    <template v-for="(block, index) in rendered" :key="blockKey(block, index)">
      <DiagramBlock v-if="block.kind === 'diagram'" class="md-block" :mode="block.mode" :code="block.code" />
      <AbcBlock v-else-if="block.kind === 'abc'" class="md-block" :code="block.code" />
      <WidgetBlock v-else-if="block.kind === 'widget'" class="md-block" :code="block.code" />
      <div v-else-if="block.kind === 'widget-loading'" class="md-block md-svg-loading" data-widget-loading>{{ t("widget.generating") }}</div>
      <div v-else-if="block.kind === 'svg-loading'" class="md-block md-svg-loading" data-svg-loading>{{ t("svgLoading.generating") }}</div>
      <div v-else class="md-block" v-html="block.html" />
    </template>
  </div>
  <Teleport to="body">
    <div v-if="previewing" class="md-table-preview-overlay" data-table-preview-overlay @mousedown.self="closePreview">
      <div v-modal class="md-table-preview-dialog" role="dialog" aria-modal="true" :aria-label="t('table.previewTitle')">
        <div class="md-table-preview-header">
          <span>{{ t("table.previewTitle") }}</span>
          <button
            type="button"
            class="md-table-icon-button"
            data-table-preview-close
            :aria-label="t('table.previewClose')"
            :title="t('table.previewClose')"
            @click="closePreview"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div class="md-table-preview-scroller text" v-html="previewing" />
      </div>
    </div>
    <ContextMenu v-if="pathMenu" :x="pathMenu.x" :y="pathMenu.y" :items="pathMenu.items" :min-width="196" @pick="pickPathMenu" @close="pathMenu = undefined" />
  </Teleport>
</template>

<style>
/* Not scoped: these style markup produced by the renderer at runtime. */
/*
 * Fourteen on 22.4, measured off opencode's markdown block. The chrome around
 * a reply runs at thirteen; the reply itself is the thing being read, and it
 * is set a point larger.
 */
.text {
  overflow-wrap: anywhere;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(22.4px * var(--ui-font-scale, 1));
}

/*
 * Tables, on opencode's own measurements.
 *
 * `[data-component="markdown"] table { border-collapse: collapse; width: 100%;
 * margin: 16px 0; display: block; overflow-x: auto }` with cells at
 * `padding: 12px; text-align: start; vertical-align: top` and a heavier rule
 * under the head. `display: block` is what lets a wide table scroll sideways
 * inside the reply instead of widening the whole column - a table with eight
 * columns would otherwise push the conversation off its own pane.
 */
.text .md-table {
  display: block;
  width: 100%;
  margin: 16px 0;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: calc(13.5px * var(--ui-font-scale, 1));
}

.text .md-table th,
.text .md-table td {
  padding: 12px;
  text-align: start;
  vertical-align: top;
  border-bottom: 1px solid var(--border-weaker);
}

.text .md-table th {
  color: var(--text-strong);
  font-weight: 500;
  border-bottom: 1px solid var(--border-weak);
}

/* The last row's rule would otherwise draw a line under nothing. */
.text .md-table tbody tr:last-child td {
  border-bottom: none;
}

/* Only written when the delimiter row asked for it. */
.text .md-table .md-left {
  text-align: start;
}

.text .md-table .md-center {
  text-align: center;
}

.text .md-table .md-right {
  text-align: end;
}

.text .md-p {
  margin: 0 0 12px;
}

/*
 * A reply is drawn as blocks, each in its own wrapper, so "last" means the last
 * block's last element; everywhere else (a quote, a list item, another
 * surface's plain markup) it still means the last paragraph in its parent.
 */
.text .md-p:last-child:not(.md-block > .md-p),
.text > .md-block:last-child > .md-p:last-child {
  margin-bottom: 0;
}

.text .md-code {
  margin: 8px 0;
  padding: 12px;
  overflow-x: auto;
  background: var(--surface-raised);
  border: 0.5px solid var(--border-input);
  border-radius: 6px;
  font-size: calc(13px * var(--code-font-scale, 1));
  line-height: 1.5;
}

/* MiMo's code inside a block keeps the chip's 1.5px 5px, on no fill, as a block of its own. */
.text .md-code code {
  display: block;
  padding: 1.5px 5px;
  background: none;
  border: none;
  border-radius: 0;
  font-size: calc(13px * var(--code-font-scale, 1));
}

/*
 * A reply's code block, as MiMo frames it: 8px corners; white with a 1px line
 * in light, #2e2e2e with no line in dark. The head sticks to the top of the
 * thread while a long block scrolls past - clip rather than hidden, which would
 * make the block a scroller of its own and pin the head inside it - with the
 * language at the start and a small copy button at the end. The button is
 * quiet until the block is hovered, and shows a green check for two seconds
 * after a press. The code itself scrolls sideways; it never wraps.
 */
.text .md-codeblock {
  margin: 8px 0;
  overflow: clip;
  background: #fff;
  border: 1px solid #f0ebe5;
  border-radius: 8px;
}

.text .md-codeblock .md-code {
  margin: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
}

.text .md-code-head {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  background: #fff;
  border-bottom: 1px solid #f0ebe5;
}

.text .md-code-lang {
  color: #151c1399;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(18px * var(--ui-font-scale, 1));
  text-transform: lowercase;
}

.text .md-code-copy {
  display: flex;
  align-items: center;
  gap: 4px;
  height: calc(22px * var(--ui-font-scale, 1));
  padding: 0 6px;
  color: var(--text-base);
  background: transparent;
  border: 0;
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  opacity: 0.7;
  transition: opacity 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}

.text .md-codeblock:hover .md-code-copy,
.text .md-code-copy:focus-visible {
  opacity: 1;
}

.text .md-code-copy:hover {
  background: rgb(0 0 0 / 0.08);
}

.text .md-code-copy .done,
.text .md-code-copy.copied .idle {
  display: none;
}

.text .md-code-copy.copied .done {
  display: inline;
}

.text .md-code-copy.copied .md-code-icon.done {
  color: #00c950;
}

:root[data-theme="dark"] .text .md-codeblock {
  background: #2e2e2e;
  border: 0;
}

:root[data-theme="dark"] .text .md-code-head {
  background: #2e2e2e;
  border-bottom-color: #2e2e2e;
}

:root[data-theme="dark"] .text .md-code-lang {
  color: #b8b8b8;
}

:root[data-theme="dark"] .text .md-code-copy:hover {
  background: rgb(255 255 255 / 0.1);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-codeblock {
    background: #2e2e2e;
    border: 0;
  }

  :root:not([data-theme="light"]) .text .md-code-head {
    background: #2e2e2e;
    border-bottom-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .text .md-code-lang {
    color: #b8b8b8;
  }

  :root:not([data-theme="light"]) .text .md-code-copy:hover {
    background: rgb(255 255 255 / 0.1);
  }
}

.text .md-url {
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: calc(11px * var(--code-font-scale, 1));
}

/* MiMo's video card in a reply: an inline plate with an orange play mark and the link's name. */
.text .md-video-card {
  display: inline-flex;
  box-sizing: border-box;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  margin: 10px 0;
  padding: 9px 12px;
  color: var(--text-strong);
  background: #f0f0f2;
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  vertical-align: middle;
}

.text .md-video-card:hover {
  background: #f1f0ec;
}

.text .md-video-play {
  flex-shrink: 0;
  color: #ff6a2b;
}

.text .md-video-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:root[data-theme="dark"] .text .md-video-card {
  background: #2e2e2e;
}

:root[data-theme="dark"] .text .md-video-card:hover {
  background: #ffffff0f;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-video-card {
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .text .md-video-card:hover {
    background: #ffffff0f;
  }
}

/*
 * 2.0: an answer set the way Xiaomi MiMo sets one, measured off its own
 * conversation view - the same system face at 14/500 on a 1.7 line, a 14px
 * step between paragraphs, 6px between list items, headings that are sized
 * like headings, and code chips that are a filled box rather than a tint.
 */
.text {
  /* MiMo's answer: txt-strong #151c13 in light, txt #f4f4f5 in dark (below); headings inherit it. */
  color: var(--text-strong);
  font-weight: 500;
  line-height: calc(23.8px * var(--ui-font-scale, 1));
}

/* MiMo's strong is semibold, not the browser's bolder 700. */
.text strong {
  font-weight: 600;
}

.text .md-p {
  margin: 0 0 14px;
}

.text .md-h {
  line-height: 1.4;
  font-weight: 600;
}

/* MiMo's six heading levels: 20, 20, 16, 16, 14, 14, the last one muted. */
.text .md-h[data-level="1"] {
  margin: 0 0 12px;
  font-size: calc(20px * var(--ui-font-scale, 1));
}

.text .md-h[data-level="2"] {
  margin: 18px 0 10px;
  font-size: calc(20px * var(--ui-font-scale, 1));
}

.text .md-h[data-level="3"] {
  margin: 16px 0 8px;
  font-size: calc(16px * var(--ui-font-scale, 1));
}

.text .md-h[data-level="4"] {
  margin: 14px 0 6px;
  font-size: calc(16px * var(--ui-font-scale, 1));
}

.text .md-h[data-level="5"] {
  margin: 12px 0 6px;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.text .md-h[data-level="6"] {
  margin: 12px 0 6px;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
}

/*
 * MiMo's lists: every one, nested or not, 22px in with discs (30 for numbers)
 * and 14 below - a nested list is not a smaller step.
 */
.text .md-list {
  margin: 0 0 14px;
  padding-inline-start: 22px;
}

.text ul.md-list {
  list-style-type: disc;
}

.text ol.md-list {
  padding-inline-start: 30px;
  list-style-type: decimal;
}

.text .md-list li,
.text .md-list li:last-child {
  margin: 6px 0;
}

/* A task list item: the box stands where the bullet was. */
.text .md-list li.md-task {
  list-style: none;
}

.text .md-task-box {
  margin-block: 0;
  margin-inline: -18px 6px;
  vertical-align: -1px;
}

/* MiMo's quote: a 3px rule down its side, 12px in, muted. */
.text .md-quote {
  margin: 0 0 14px;
  padding-inline-start: 12px;
  color: var(--text-base);
  border-inline-start: 3px solid var(--border-weak);
  font-style: normal;
}

.text .md-quote .md-p:last-child {
  margin-bottom: 0;
}

/* MiMo's rule: a hairline with 16px either side. */
.text .md-rule {
  height: 0;
  margin: 16px 0;
  border: 0;
  border-top: 1px solid var(--border-weak);
}

.text > .md-block:last-child > :last-child {
  margin-bottom: 0;
}

/* MiMo's code chip: its code-bg and code-fg (#f0f0f2 on #3a3a38 in light, #2e2e2e on #e6e6e6 in dark, below), 13px with the text scale, at the weight around it. */
.text code {
  padding: 1.5px 5px;
  color: #3a3a38;
  background: #f0f0f2;
  border-radius: 5px;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

:root[data-theme="dark"] .text code {
  color: #e6e6e6;
  background: #2e2e2e;
}

:root[data-theme="dark"] .text .md-code code {
  background: none;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text code {
    color: #e6e6e6;
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .text .md-code code {
    background: none;
  }
}

:root[data-theme="dark"] .text {
  color: #f4f4f5;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text {
    color: #f4f4f5;
  }
}

.text .md-code {
  padding: 10px 12px;
  font-size: calc(12.5px * var(--code-font-scale, 1));
  line-height: 1.7;
}

/* MiMo numbers every line of a reply's code block: 2ch, right-aligned, dim, not selectable. */
.text .md-code.md-lined code {
  counter-reset: md-line;
}

.text .md-code.md-lined .line {
  counter-increment: md-line;
}

.text .md-code.md-lined .line::before {
  display: inline-block;
  width: 2ch;
  margin-inline-end: 16px;
  color: var(--text-base);
  content: counter(md-line);
  opacity: 0.6;
  text-align: end;
  user-select: none;
}

.text .md-table {
  font-size: calc(14px * var(--ui-font-scale, 1));
}

/* MiMo's cells: the head never wraps, a cell is at least 112 wide, a number keeps together. */
.text .md-table th {
  padding: 8px 24px 8px 0;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}

.text .md-table td {
  min-width: 112px;
  padding: 10px 24px 10px 0;
}

.text .md-table td.md-num {
  min-width: calc(3ch + 24px);
  white-space: nowrap;
}

/* No wider than 30rem, broken only at a word when it has to be; the last cell of a row, not of the head, drops its 24. */
.text .md-table :is(th, td) {
  max-width: 30rem;
  overflow-wrap: break-word;
  word-break: normal;
}

.text .md-table td:last-child {
  padding-inline-end: 0;
}

/* MiMo's line-soft between rows: #0000000d in light, #ffffff12 in dark. */
.text .md-table td {
  border-bottom-color: #0000000d;
}

:root[data-theme="dark"] .text .md-table td {
  border-bottom-color: #ffffff12;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-table td {
    border-bottom-color: #ffffff12;
  }
}

/* A narrow column: a table of four or more columns keeps its width and scrolls. */
.text .md-table-scroller {
  container-type: inline-size;
}

@container (max-width: 640px) {
  .text .md-table:has(> thead > tr > th:nth-child(4)) {
    width: max-content;
  }
}

.text .md-table tbody tr:last-child td {
  padding-bottom: 16px;
}

/* Links, MiMo's blue: solid underline for a link, dotted for an address in code. */
.text .md-link {
  color: #2f6fed;
  text-decoration: underline;
  cursor: pointer;
}

.text .md-link-code {
  font-family: var(--font-mono);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}

.text .md-link-code:hover {
  text-decoration-style: solid;
}

/* A path link: the code chip, in blue with a dotted underline that turns solid on hover. */
.text code.md-path[role="button"] {
  color: #2f6fed;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
  cursor: pointer;
}

.text code.md-path[role="button"]:hover {
  text-decoration-style: solid;
}

.text code.md-path[role="button"]:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 1px;
}

/* A picture in a reply, capped at 420 (240 for a picture link); a press opens the preview. */
.text .md-img {
  display: block;
  box-sizing: border-box;
  max-width: 100%;
  max-height: 420px;
  margin: 10px 0;
  object-fit: contain;
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  cursor: zoom-in;
}

.text .md-img-link {
  max-height: 240px;
}

/* A web picture not yet asked for: the video card's shape, with where it would load from. */
.text .md-img-remote {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  margin: 10px 0;
  padding: 9px 12px;
  color: var(--text-strong);
  background: #f0f0f2;
  border: 1px dashed var(--border-weak);
  border-radius: 10px;
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: start;
  cursor: pointer;
}

.text .md-img-remote:hover {
  background: #f1f0ec;
}

.text .md-img-remote-icon {
  flex-shrink: 0;
  color: var(--text-weak);
}

.text .md-img-remote-label,
.text .md-img-remote-host {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text .md-img-remote-host {
  flex-shrink: 1;
  margin-inline-start: auto;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

:root[data-theme="dark"] .text .md-img-remote {
  background: #2e2e2e;
}

:root[data-theme="dark"] .text .md-img-remote:hover {
  background: #ffffff0f;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-img-remote {
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .text .md-img-remote:hover {
    background: #ffffff0f;
  }
}

/* KaTeX: display math is its own block; an error shows in KaTeX's red with the message as its tip. */
.text .md-math {
  margin: 0 0 14px;
}

.text .md-math .katex-display {
  margin: 0;
}

.text .katex-error {
  color: #cc0000;
}

/* Footnotes: a rule, then the notes at 13px; a reference is a small blue number. */
.text .md-fnref {
  line-height: 0;
}

.text .md-fnref-link,
.text .md-fn-back {
  color: #2f6fed;
  text-decoration: none;
}

.text .md-footnotes {
  margin-top: 16px;
  padding-top: 8px;
  color: var(--text-base);
  border-top: 1px solid var(--border-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.text .md-footnotes ol {
  margin: 0;
  padding-inline-start: 22px;
}

/* MiMo's unfinished last line while a reply streams: plain text until its newline arrives. */
.text .stream-open-line {
  margin: 0 0 14px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}

/*
 * The one thing MiMo animates while a reply streams: the block.
 *
 * Its stylesheet fades whole streamed elements in - `.answer.streaming
 * :is(p,li,h1..h6,blockquote,tr,img,hr)` over `@keyframes streamBlockIn`, from
 * opacity 0 to 1 - and there is no character-level fade, no reveal counter and
 * no pacing loop anywhere in its bundle. So a block appears by fading in, and
 * the text inside it simply arrives.
 *
 * Put on the wrapper rather than on the elements inside it: a block keeps its
 * own element while its index and kind are unchanged (see blockKey), so only a
 * block that is genuinely new plays this. The block being written has its
 * markup replaced on every flush, and an animation on those children would
 * restart from nothing each time, which is the flicker this replaced.
 */
.text.streaming > .md-block {
  animation: stream-block-in 0.32s ease-out both;
}

@keyframes stream-block-in {
  0% {
    opacity: 0;
  }

  100% {
    opacity: 1;
  }
}

.text .md-svg-loading {
  margin: 8px 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  animation: md-media-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

:root[data-theme="dark"] .text .md-link,
:root[data-theme="dark"] .text code.md-path[role="button"],
:root[data-theme="dark"] .text .md-fnref-link,
:root[data-theme="dark"] .text .md-fn-back {
  color: #5a9cff;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-link,
  :root:not([data-theme="light"]) .text code.md-path[role="button"],
  :root:not([data-theme="light"]) .text .md-fnref-link,
  :root:not([data-theme="light"]) .text .md-fn-back {
    color: #5a9cff;
  }
}

/*
 * MiMo's table in a reply: it reaches 24px past the text on each side and
 * scrolls sideways in its own strip, with its two buttons 6px above its end,
 * out of sight until the table is hovered or focused.
 */
.text .md-table-container {
  --md-table-bleed: 24px;
  position: relative;
  width: calc(100% + var(--md-table-bleed) * 2);
  margin: 0 calc(-1 * var(--md-table-bleed)) 14px;
}

.text .md-table-container:focus {
  outline: none;
}

.text .md-table-scroller {
  margin-inline: var(--md-table-bleed);
  overflow-x: auto;
}

.text .md-table-container .md-table,
.md-table-preview-scroller .md-table {
  display: table;
  width: fit-content;
  min-width: 100%;
  margin: 0;
  overflow: visible;
  border-collapse: separate;
  border-spacing: 0;
}

.text .md-table-actions {
  position: absolute;
  bottom: calc(100% + 6px);
  inset-inline-end: var(--md-table-bleed);
  z-index: 10;
  display: flex;
  gap: 4px;
  width: 56px;
  height: 26px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast, 0.12s);
}

.text .md-table-container:hover .md-table-actions,
.text .md-table-container:focus-within .md-table-actions {
  opacity: 1;
}

.md-table-icon-button {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
  pointer-events: auto;
}

.md-table-icon-button:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.md-table-icon-button:focus-visible {
  color: var(--text-strong);
  background: var(--surface-hover);
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.md-table-icon-button .md-table-copy-check,
.md-table-icon-button.copied .md-table-copy-idle {
  display: none;
}

.md-table-icon-button.copied .md-table-copy-check {
  display: block;
  color: var(--text-success);
}

/* The preview: a dim ground, and the table in a dialog up to 1120 wide under a 46px heading. */
.md-table-preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 320;
  display: grid;
  place-items: center;
  padding: 28px;
  background: rgb(0 0 0 / 0.34);
}

.md-table-preview-dialog {
  display: flex;
  flex-direction: column;
  width: min(1120px, 100vw - 56px);
  max-height: calc(100vh - 56px);
  overflow: hidden;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  box-shadow: 0 20px 60px rgb(0 0 0 / 0.2);
}

.md-table-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 46px;
  padding-block: 8px;
  padding-inline: 18px 10px;
  color: var(--text-strong);
  border-bottom: 1px solid var(--border-weaker);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.md-table-preview-scroller {
  padding: 18px 24px;
  overflow: auto;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 1.7;
}
</style>
