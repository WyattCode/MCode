<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import ContextMenu from "../ContextMenu.vue"
import type { MenuItem } from "../../lib/menu"
import { t } from "../../lib/i18n"
import { notifyFailure } from "../../lib/toast"
import { openImagePreview } from "../../lib/image-preview"
import { svgSize } from "../../lib/svg-safe"
import {
  blobToBase64,
  exportableSvg,
  isDarkTheme,
  rasterise,
  renderMermaid,
  sanitizeMermaidSvg,
  sanitizeSvgFence,
  svgDataUrl,
  themeBackground,
  watchTheme,
} from "../../lib/diagram"

/**
 * MiMo's diagram block in a reply: a mermaid fence drawn as a diagram, or an
 * SVG fence (or raw <svg>) shown as a picture, in the code block's frame with
 * 图/代码 tabs, and for mermaid a zoom pill, 放大 and 复制图片. Both keep the
 * copy button and a "…" menu to download, copy or view the source.
 *
 * Nothing the model wrote reaches the page unsanitised: mermaid renders with
 * securityLevel "strict", and its output and any SVG go through DOMPurify.
 */
const props = defineProps<{ mode: "mermaid" | "svg"; code: string; fileName?: string }>()

const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25

const tab = ref<"diagram" | "code">("diagram")
const dark = ref(isDarkTheme())
const svg = ref<string>()
const failed = ref(false)
const zoom = ref(1)
const copiedImage = ref(false)
const copiedCode = ref(false)
const menu = ref<{ x: number; y: number }>()
const scroller = ref<HTMLElement>()

const source = computed(() => props.code.replace(/\n+$/, ""))
const lines = computed(() => source.value.split("\n"))
const showingDiagram = computed(() => tab.value === "diagram" && !failed.value)
const size = computed(() => (svg.value ? svgSize(svg.value) : undefined))
const canvasStyle = computed(() => (size.value ? { width: `${size.value.w * zoom.value}px`, height: `${size.value.h * zoom.value}px` } : undefined))
const downloadName = computed(() => (props.fileName && /\.svg$/i.test(props.fileName) ? props.fileName : "diagram.svg"))

let generation = 0
let stopTheme: (() => void) | undefined
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function draw() {
  const mine = ++generation
  if (props.mode === "svg") {
    let clean = ""
    try {
      clean = sanitizeSvgFence(source.value)
    } catch {
      clean = ""
    }
    svg.value = clean || undefined
    failed.value = !clean
    if (!clean) tab.value = "code"
    return
  }
  failed.value = false
  try {
    const raw = await renderMermaid(source.value, dark.value)
    if (mine !== generation) return
    svg.value = sanitizeMermaidSvg(raw)
  } catch {
    if (mine !== generation) return
    svg.value = undefined
    failed.value = true
    tab.value = "code"
  }
}

watch(source, () => {
  zoom.value = 1
  void draw()
})

onMounted(() => {
  void draw()
  // MiMo draws mermaid again in the new theme's colours.
  stopTheme = watchTheme(() => {
    const next = isDarkTheme()
    if (next === dark.value) return
    dark.value = next
    if (props.mode === "mermaid") void draw()
  })
})

onBeforeUnmount(() => {
  generation += 1
  stopTheme?.()
  clearTimeout(copiedTimer)
})

/* Zooming keeps the point at the middle of the view where it was. */
function setZoom(next: number) {
  const value = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(next * 100) / 100))
  if (value === zoom.value) return
  const box = scroller.value
  const centre = box ? { x: (box.scrollLeft + box.clientWidth / 2) / zoom.value, y: (box.scrollTop + box.clientHeight / 2) / zoom.value } : undefined
  zoom.value = value
  if (box && centre) {
    requestAnimationFrame(() => {
      box.scrollLeft = centre.x * value - box.clientWidth / 2
      box.scrollTop = centre.y * value - box.clientHeight / 2
    })
  }
}

function exported() {
  return svg.value ? exportableSvg(svg.value, themeBackground(dark.value)) : undefined
}

function enlarge() {
  const out = exported()
  // MiMo zooms the preview out of the drawn diagram itself, not the scroller around it.
  const rect = scroller.value?.querySelector("svg")?.getBoundingClientRect()
  if (out) openImagePreview(svgDataUrl(out.xml), { name: props.mode === "mermaid" ? "mermaid.svg" : downloadName.value, rect })
}

async function picture(): Promise<Blob> {
  const out = exported()
  if (!out) throw new Error("no diagram")
  return rasterise(out.xml, out.w, out.h, themeBackground(dark.value), 2)
}

async function copyImage() {
  try {
    const png = await picture()
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
    copiedImage.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copiedImage.value = false), 2000)
  } catch {
    notifyFailure(t("mermaid.copyImageFailed"))
  }
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(source.value)
    copiedCode.value = true
    setTimeout(() => (copiedCode.value = false), 2000)
  } catch {
    notifyFailure(t("code.copyFailed"))
  }
}

/* The menu's glyphs, on its 16px grid. */
const menuItems = computed<MenuItem[]>(() => [
  { key: "downloadSvg", label: t("svgMenu.downloadSvg"), icon: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" },
  { key: "downloadImage", label: t("svgMenu.downloadImage"), icon: "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM2.5 10.5l3-3 3 3 2-2 3 3" },
  { key: "copyCode", label: t("svgMenu.copyCode"), icon: "M6 5.5h6.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1ZM10.5 5.5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" },
  { key: "viewCode", label: t("svgMenu.viewCode"), icon: "M6 4.5 2.5 8 6 11.5M10 4.5l3.5 3.5-3.5 3.5" },
])

function openMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  menu.value = { x: rect.right, y: rect.bottom + 4 }
}

async function pick(key: string) {
  menu.value = undefined
  if (key === "viewCode") {
    tab.value = "code"
    return
  }
  if (key === "copyCode") {
    await navigator.clipboard.writeText(source.value).catch(() => notifyFailure(t("code.copyFailed")))
    return
  }
  if (key === "downloadSvg") {
    // Mermaid's picture as drawn; an SVG fence as the model wrote it, which is what MiMo saves.
    const text = props.mode === "mermaid" ? exported()?.xml : source.value
    if (text) await window.mcode.saveText(downloadName.value, text)
    return
  }
  if (key === "downloadImage") {
    try {
      const png = await picture()
      await window.mcode.savePng(downloadName.value.replace(/\.svg$/i, ".png"), await blobToBase64(png))
    } catch {
      notifyFailure(t("mermaid.copyImageFailed"))
    }
  }
}

const lineEnd = (index: number) => (index < lines.value.length - 1 ? "\n" : "")
</script>

<template>
  <div class="md-codeblock md-diagram" :data-diagram="mode">
    <div class="md-code-head md-diagram-head">
      <span v-if="fileName" class="md-diagram-file" :title="fileName">{{ fileName }}</span>
      <span v-else class="md-code-lang">{{ mode }}</span>
      <div class="md-diagram-tools">
        <div class="md-diagram-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            data-diagram-tab="diagram"
            :aria-selected="showingDiagram"
            :class="{ on: showingDiagram }"
            :disabled="failed"
            @click="tab = 'diagram'"
          >
            {{ t("mermaid.diagram") }}
          </button>
          <button type="button" role="tab" data-diagram-tab="code" :aria-selected="!showingDiagram" :class="{ on: !showingDiagram }" @click="tab = 'code'">
            {{ t("mermaid.code") }}
          </button>
        </div>
        <div v-if="mode === 'mermaid' && showingDiagram && svg" class="md-diagram-zoom" data-diagram-zoom>
          <button v-tip="{ label: t('imagePreview.zoomOut'), placement: 'bottom' }" type="button" :aria-label="t('imagePreview.zoomOut')" :disabled="zoom <= ZOOM_MIN" data-zoom="out" @click="setZoom(zoom - ZOOM_STEP)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
          </button>
          <span class="md-diagram-percent" aria-live="polite" data-zoom-percent>{{ Math.round(zoom * 100) }}%</span>
          <button v-tip="{ label: t('imagePreview.zoomIn'), placement: 'bottom' }" type="button" :aria-label="t('imagePreview.zoomIn')" :disabled="zoom >= ZOOM_MAX" data-zoom="in" @click="setZoom(zoom + ZOOM_STEP)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button v-tip="{ label: t('imagePreview.reset'), placement: 'bottom' }" type="button" :aria-label="t('imagePreview.reset')" :disabled="zoom === 1" data-zoom="reset" @click="setZoom(1)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></svg>
          </button>
        </div>
        <button v-if="mode === 'mermaid' && showingDiagram && svg" type="button" class="md-code-copy" data-diagram-enlarge :aria-label="t('mermaid.enlargeAria')" @click="enlarge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
          </svg>
          <span>{{ t("mermaid.enlarge") }}</span>
        </button>
        <button v-if="mode === 'mermaid' && showingDiagram && svg" type="button" class="md-code-copy" :class="{ copied: copiedImage }" data-diagram-copy-image :aria-label="t('mermaid.copyImageAria')" @click="copyImage">
          <svg class="md-code-icon idle" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
            <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.2" />
          </svg>
          <svg class="md-code-icon done" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="md-code-word idle">{{ t("mermaid.copyImage") }}</span>
          <span class="md-code-word done">{{ t("mermaid.copiedImage") }}</span>
        </button>
        <button type="button" class="md-code-copy" :class="{ copied: copiedCode }" data-diagram-copy-code :aria-label="t('code.copyLabel')" @click="copyCode">
          <svg class="md-code-icon idle" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
            <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.2" />
          </svg>
          <svg class="md-code-icon done" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="md-code-word idle">{{ t("code.copy") }}</span>
          <span class="md-code-word done">{{ t("code.copied") }}</span>
        </button>
        <button v-if="showingDiagram && svg" type="button" class="md-diagram-more" data-diagram-more aria-haspopup="menu" :aria-expanded="Boolean(menu)" @click="openMenu">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
        </button>
      </div>
    </div>

    <template v-if="showingDiagram">
      <div v-if="!svg" class="md-diagram-rendering" data-diagram-rendering>{{ t("mermaid.rendering") }}</div>
      <!-- Sanitised by DOMPurify in lib/diagram before it is bound. -->
      <div
        v-else-if="mode === 'mermaid'"
        ref="scroller"
        class="md-diagram-scroll"
        role="button"
        tabindex="0"
        data-diagram-body
        :aria-label="t('markdown.previewImageTip')"
        @click="enlarge"
        @keydown.enter.prevent="enlarge"
        @keydown.space.prevent="enlarge"
      >
        <div class="md-diagram-canvas" :style="canvasStyle" v-html="svg" />
      </div>
      <div v-else class="md-diagram-inline" data-diagram-body v-html="svg" />
    </template>
    <template v-else>
      <div v-if="failed && mode === 'mermaid'" class="md-diagram-error" data-diagram-error>{{ t("mermaid.parseError") }}</div>
      <pre class="md-code md-lined md-diagram-source"><code><template v-for="(line, index) in lines" :key="index"><span class="line">{{ line }}</span>{{ lineEnd(index) }}</template></code></pre>
    </template>

    <Teleport to="body">
      <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" :min-width="160" end @pick="pick" @close="menu = undefined" />
    </Teleport>
  </div>
</template>

<style>
/* Not scoped: the block sits inside the reply's .text, beside the code block rules it shares. */
.text .md-diagram-head {
  position: sticky;
  top: 0;
  z-index: 10;
  gap: 12px;
}

.text .md-diagram-file {
  min-width: 0;
  overflow: hidden;
  color: var(--text-weak);
  font-family: var(--font-mono);
  font-size: calc(11px * var(--code-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.text .md-diagram-tools {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

/* MiMo's segmented tabs: a 7px tray with 2px of padding, the active tab lifted onto the code ground. */
.text .md-diagram-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 7px;
}

.text .md-diagram-tabs button {
  padding: 1px 8px;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 5px;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
  transition: color 0.12s;
}

.text .md-diagram-tabs button:hover {
  color: var(--text-strong);
}

.text .md-diagram-tabs button.on {
  color: var(--text-strong);
  background: var(--surface-raised);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.text .md-diagram-tabs button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

/* The zoom pill: 28 high, 24px buttons, the percentage 38 wide in tabular figures. */
.text .md-diagram-zoom {
  display: flex;
  align-items: center;
  gap: 1px;
  height: 28px;
  padding-inline: 2px;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 7px;
}

.text .md-diagram-zoom button {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 5px;
}

.text .md-diagram-zoom button:hover:not(:disabled) {
  color: var(--text-strong);
  background: rgba(0, 0, 0, 0.08);
}

.text .md-diagram-zoom button:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

.text .md-diagram-percent {
  width: 38px;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.text .md-diagram-more {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 6px;
  opacity: 0;
  transition: opacity 0.12s;
}

.text .md-diagram:hover .md-diagram-more,
.text .md-diagram-more:focus-visible,
.text .md-diagram-more[aria-expanded="true"] {
  opacity: 1;
}

.text .md-diagram-more:hover {
  background: rgba(0, 0, 0, 0.08);
}

.text .md-diagram-rendering {
  padding: 12px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.text .md-diagram-error {
  padding: 8px 12px 0;
  color: #ef4444;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.text .md-diagram-scroll {
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  max-height: min(60vh, 560px);
  padding: 12px;
  overflow: auto;
  cursor: zoom-in;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.text .md-diagram-scroll:focus-visible {
  outline: 2px solid var(--border-focus, #2f6fed);
  outline-offset: -2px;
}

.text .md-diagram-canvas {
  flex-shrink: 0;
}

.text .md-diagram-canvas svg {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none !important;
}

.text .md-diagram-inline {
  display: flex;
  justify-content: center;
  padding: 12px;
  overflow-x: auto;
}

.text .md-diagram-inline svg {
  width: 100%;
  height: auto;
}

:root[data-theme="dark"] .text .md-diagram-tabs,
:root[data-theme="dark"] .text .md-diagram-zoom {
  background: rgba(255, 255, 255, 0.08);
}

:root[data-theme="dark"] .text .md-diagram-zoom button:hover:not(:disabled),
:root[data-theme="dark"] .text .md-diagram-more:hover {
  background: rgba(255, 255, 255, 0.1);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-diagram-tabs,
  :root:not([data-theme="light"]) .text .md-diagram-zoom {
    background: rgba(255, 255, 255, 0.08);
  }

  :root:not([data-theme="light"]) .text .md-diagram-zoom button:hover:not(:disabled),
  :root:not([data-theme="light"]) .text .md-diagram-more:hover {
    background: rgba(255, 255, 255, 0.1);
  }
}
</style>
