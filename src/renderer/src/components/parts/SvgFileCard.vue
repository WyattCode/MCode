<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import ContextMenu from "../ContextMenu.vue"
import type { MenuItem } from "../../lib/menu"
import { t } from "../../lib/i18n"
import { savePng, saveText } from "../../lib/native-pick"
import { notifyFailure } from "../../lib/toast"
import { openImagePreview } from "../../lib/image-preview"
import { copyImageFile, openNative } from "../../lib/path-open"
import { blobToBase64, exportableSvg, isDarkTheme, rasterise, sanitizeSvgFence, themeBackground } from "../../lib/diagram"

/**
 * MiMo's card for an .svg file named in a reply: the code block's frame with
 * the file name, 图/代码 tabs, copy image (the file itself, through the main
 * process), copy code, and a "…" menu to download it, download it as a PNG,
 * copy or view its code.
 *
 * The picture is drawn by an <img> from the preview server, where an SVG
 * cannot run anything; the code tab is text. The one place the file's markup
 * is parsed - the PNG - goes through the same sanitising as a reply's SVG fence.
 */
const props = defineProps<{ text: string; url: string; file: string; name: string }>()
const emit = defineEmits<{ loaded: []; missing: [] }>()

const tab = ref<"diagram" | "code">("diagram")
const image = ref<"loading" | "ok" | "error">("loading")
const copiedImage = ref(false)
const copiedCode = ref(false)
const menu = ref<{ x: number; y: number }>()
const lines = computed(() => props.text.replace(/\n+$/, "").split("\n"))

let imageTimer: ReturnType<typeof setTimeout> | undefined
let codeTimer: ReturnType<typeof setTimeout> | undefined

// Another file in the same place starts over, as MiMo resets its card.
watch(
  () => props.url,
  () => {
    tab.value = "diagram"
    image.value = "loading"
  },
)

onBeforeUnmount(() => {
  clearTimeout(imageTimer)
  clearTimeout(codeTimer)
})

function loaded() {
  image.value = "ok"
  emit("loaded")
}

/* A picture that will not load is checked again: a deleted file becomes plain code, anything else the open button. */
async function failed() {
  const found = await window.mcode.resolveExistingPath([props.file]).catch(() => null)
  if (!found) emit("missing")
  else image.value = "error"
}

function preview(event: Event) {
  if (image.value !== "ok") return
  openImagePreview(props.url, { name: props.name, rect: (event.currentTarget as HTMLElement).getBoundingClientRect() })
}

function openWithDefault() {
  void openNative(props.file)
}

async function copyImage() {
  try {
    await copyImageFile(props.file)
    copiedImage.value = true
    clearTimeout(imageTimer)
    imageTimer = setTimeout(() => (copiedImage.value = false), 2000)
  } catch {
    notifyFailure(t("officeCard.copyImageFailed"))
  }
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.text)
    copiedCode.value = true
    clearTimeout(codeTimer)
    codeTimer = setTimeout(() => (copiedCode.value = false), 2000)
  } catch {
    notifyFailure(t("code.copyFailed"))
  }
}

/* A PNG at twice the file's own size, on the theme's ground. */
async function picture(): Promise<Blob> {
  const background = themeBackground(isDarkTheme())
  const out = exportableSvg(sanitizeSvgFence(props.text), background)
  if (!out) throw new Error("not an svg")
  return rasterise(out.xml, out.w, out.h, background, 2)
}

/* The menu's glyphs, on its 16px grid. */
const menuItems = computed<MenuItem[]>(() => [
  { key: "downloadSvg", label: t("svgMenu.downloadSvg"), icon: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" },
  { key: "downloadImage", label: t("svgMenu.downloadImage"), icon: "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM2.5 10.5l3-3 3 3 2-2 3 3" },
  { key: "copyCode", label: t("svgMenu.copyCode"), icon: "M6 5.5h6.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1ZM10.5 5.5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" },
  { key: "viewCode", label: t("svgMenu.viewCode"), icon: "M6 4.5 2.5 8 6 11.5M10 4.5l3.5 3.5-3.5 3.5" },
])

/* Under the button, its end against the button's end, 4px down. */
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
    await copyCode()
    return
  }
  if (key === "downloadSvg") {
    await saveText(props.name, props.text)
    return
  }
  if (key === "downloadImage") {
    try {
      const png = await picture()
      await savePng(`${props.name.replace(/\.svg$/i, "")}.png`, await blobToBase64(png))
    } catch {
      notifyFailure(t("mermaid.copyImageFailed"))
    }
  }
}

const lineEnd = (index: number) => (index < lines.value.length - 1 ? "\n" : "")
</script>

<template>
  <div class="md-codeblock md-diagram md-svg-card" data-svg-card>
    <div class="md-code-head md-diagram-head">
      <span class="md-diagram-file" :title="name" data-svg-name>{{ name }}</span>
      <div class="md-diagram-tools">
        <div class="md-diagram-tabs" role="tablist">
          <button type="button" role="tab" data-diagram-tab="diagram" :aria-selected="tab === 'diagram'" :class="{ on: tab === 'diagram' }" @click="tab = 'diagram'">
            {{ t("mermaid.diagram") }}
          </button>
          <button type="button" role="tab" data-diagram-tab="code" :aria-selected="tab === 'code'" :class="{ on: tab === 'code' }" @click="tab = 'code'">
            {{ t("mermaid.code") }}
          </button>
        </div>
        <button v-if="tab === 'diagram'" type="button" class="md-code-copy" :class="{ copied: copiedImage }" data-svg-copy-image :aria-label="t('mermaid.copyImageAria')" @click="copyImage">
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
        <button type="button" class="md-code-copy" :class="{ copied: copiedCode }" data-svg-copy-code :aria-label="t('code.copyLabel')" @click="copyCode">
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
        <button v-if="tab === 'diagram'" type="button" class="md-diagram-more" data-svg-more aria-haspopup="menu" :aria-expanded="Boolean(menu)" :aria-label="t('svgMenu.actions')" @click="openMenu">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
        </button>
      </div>
    </div>

    <div v-if="tab === 'diagram'" class="md-svg-body" data-svg-body>
      <div v-if="image === 'loading'" class="md-svg-wait" data-svg-wait>{{ t("markdown.imageLoading") }}</div>
      <button v-if="image === 'error'" type="button" class="md-svg-failed" :title="t('markdown.openWithDefaultTip')" data-svg-failed @click="openWithDefault">
        {{ t("markdown.imageLoadFailed") }}
      </button>
      <img
        v-else
        v-show="image === 'ok'"
        :src="url"
        :alt="name"
        :title="t('markdown.previewImageTip')"
        role="button"
        tabindex="0"
        :data-path="file"
        data-path-kind="open"
        data-path-image=""
        data-svg-image
        @load="loaded"
        @error="failed"
        @click="preview"
        @keydown.enter.prevent="preview"
        @keydown.space.prevent="preview"
      />
    </div>
    <pre v-else class="md-code md-lined md-diagram-source" data-svg-source><code><template v-for="(line, index) in lines" :key="index"><span class="line">{{ line }}</span>{{ lineEnd(index) }}</template></code></pre>

    <Teleport to="body">
      <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menuItems" :min-width="160" end @pick="pick" @close="menu = undefined" />
    </Teleport>
  </div>
</template>

<style>
/* Not scoped: the card is mounted into the reply's rendered markup, beside the code block rules it shares. */
.text .md-svg-card {
  max-width: 100%;
  margin: 12px 0;
}

/* MiMo's picture well: at least 120 high, at most 60% of the window or 560, on the side column's ground. */
.text .md-svg-body {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  max-height: min(60vh, 560px);
  padding: 2px;
  overflow: auto;
  background: #f8f7f5;
}

.text .md-svg-body img {
  display: block;
  max-width: 100%;
  max-height: min(60vh, 556px);
  object-fit: contain;
  cursor: zoom-in;
}

.text .md-svg-body img:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: -2px;
}

.text .md-svg-wait {
  display: grid;
  place-items: center;
  width: 180px;
  height: 120px;
  color: #151c1399;
  font-size: calc(12px * var(--ui-font-scale, 1));
  animation: md-media-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.text .md-svg-failed {
  padding: 10px 12px;
  color: #151c1399;
  background: transparent;
  border: 0;
  font: inherit;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.text .md-svg-failed:hover {
  color: #151c13cc;
}

:root[data-theme="dark"] .text .md-svg-body {
  background: #141414;
}

:root[data-theme="dark"] .text .md-svg-wait,
:root[data-theme="dark"] .text .md-svg-failed {
  color: #b8b8b8;
}

:root[data-theme="dark"] .text .md-svg-failed:hover {
  color: #f4f4f5;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .text .md-svg-body {
    background: #141414;
  }

  :root:not([data-theme="light"]) .text .md-svg-wait,
  :root:not([data-theme="light"]) .text .md-svg-failed {
    color: #b8b8b8;
  }

  :root:not([data-theme="light"]) .text .md-svg-failed:hover {
    color: #f4f4f5;
  }
}
</style>
