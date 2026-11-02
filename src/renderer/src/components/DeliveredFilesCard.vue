<script setup lang="ts">
import { computed, ref } from "vue"
import type { AssistantPart } from "@shared/protocol"
import { fileManagerLabel } from "@shared/open-app"
import { useApp } from "../stores/app"
import { deliveredCard, deliveredFiles, mediaPath, relativeInside, sizeLabel, type Delivered } from "../lib/delivered"
import { mediaOf } from "../lib/markdown"
import LocalMedia from "./parts/LocalMedia.vue"
import { openDocument, officeTypeOf } from "../lib/office-open"
import type { MenuItem } from "../lib/menu"
import { notify, notifyFailure } from "../lib/toast"
import { t } from "../lib/i18n"
import ContextMenu from "./ContextMenu.vue"
import LucideIcon from "./LucideIcon.vue"

/*
 * MiMo's delivered-file cards under a finished reply: one per file a
 * present_files call handed over. A document gets the Office card - its kind's
 * tile, "表格 · XLSX · 12 KB" and 打开方式 (that kind's installed document apps -
 * macOS only, as MiMo looks for app bundles - then the file manager and
 * 下载副本); a web page gets the web card; anything else the plain file card.
 * A click previews it in the right panel, as the automatic open did.
 */
const props = defineProps<{ parts: AssistantPart[]; directory?: string }>()

const app = useApp()
const items = computed(() => deliveredFiles(props.parts))

/* MiMo's tiles: each document kind's own colour on a 14% ground. */
const OFFICE_TONE = {
  xlsx: { icon: "file-spreadsheet", fg: "#21a366", bg: "rgba(33, 163, 102, 0.14)" },
  docx: { icon: "file-text", fg: "#2b6cb0", bg: "rgba(43, 108, 176, 0.14)" },
  pptx: { icon: "presentation", fg: "#c43e1c", bg: "rgba(196, 62, 28, 0.14)" },
  pdf: { icon: "file-type", fg: "#d93831", bg: "rgba(217, 56, 49, 0.14)" },
} as const
const WEB_TONE = { fg: "#2f6fed", bg: "rgba(47, 111, 237, 0.14)" }
const FILE_TONE = { fg: "#6b7280", bg: "rgba(120, 120, 128, 0.14)" }

/*
 * A delivered picture, video or sound is previewed wherever it is: present_files
 * may hand over a file outside the project (T10-24), and the card reads it
 * through the main process as a path in a reply is read.
 */
function mediaPreview(item: Delivered): { kind: "image" | "video" | "audio"; path: string } | undefined {
  if (item.kind !== "file" || deliveredCard(item) !== "media") return undefined
  const kind = mediaOf(item.path)
  const path = mediaPath(item.path, props.directory)
  return kind && path ? { kind, path } : undefined
}

function officeType(item: Delivered) {
  return item.kind === "file" ? (officeTypeOf(item.name) ?? officeTypeOf(item.path)) : null
}

/* The line under the name: kind word, extension and size for a document; 网页 · HTML · size; a size or an address. */
function meta(item: Delivered): string {
  if (item.kind === "url") return item.url
  const card = deliveredCard(item)
  const size = sizeLabel(item.size)
  if (card === "office") {
    const type = officeType(item) ?? "pdf"
    return [t(`officeCard.type.${type}`), type.toUpperCase(), size].filter((word, at, all) => word && all.indexOf(word) === at).join(" · ")
  }
  if (card === "html") return [t("webCard.web"), "HTML", size].join(" · ")
  return size
}

async function preview(item: Delivered) {
  if (item.kind === "url") {
    window.mcode.openExternal(item.url)
    return
  }
  // Hold the turn's directory and the right panel's session across the awaits:
  // a conversation switch mid-resolve must not open this file into the new panel.
  const heldDirectory = props.directory
  const heldSession = app.currentID
  try {
    const found = await window.mcode.resolveExistingPath([item.path]).catch(() => null)
    if (props.directory !== heldDirectory || app.currentID !== heldSession) return
    if (!found || found.directory) throw new Error(t("harnessRow.pathNotExist"))
    await openDocument({ path: found.path, name: item.name }, heldDirectory)
  } catch (failure) {
    if (props.directory !== heldDirectory || app.currentID !== heldSession) return
    notifyFailure(t("webCard.previewFailed", { err: failure instanceof Error ? failure.message : String(failure) }))
  }
}

/* ------------------------------------------------------------ menus */

const FOLDER_ICON = "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z"
const DOWNLOAD_ICON = "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"

const menu = ref<{ x: number; y: number; item: Delivered & { kind: "file" }; kind: "openWith" | "context" }>()

/*
 * The installed apps for the open document's kind (Keynote, Pages, Numbers,
 * Preview and the like), asked when the menu opens; the file manager is its own
 * row below them. MiMo finds none of them away from a Mac.
 */
type DocApp = Awaited<ReturnType<typeof window.mcode.docApps>>[number]
const apps = ref<DocApp[]>([])
/* Only the latest menu takes its answer. */
let appsAsked = 0

const menuItems = computed<MenuItem[]>(() => {
  if (!menu.value) return []
  if (menu.value.kind === "context") {
    return [
      { key: "open", label: t("rp.files.open") },
      { key: "reveal", label: t("files.reveal") },
      { key: "copyPath", label: t("rp.files.copyPath") },
    ]
  }
  return [
    ...apps.value.map((entry) => ({
      key: `app.${entry.id}`,
      label: entry.name,
      ...(entry.icon ? { image: entry.icon } : { letter: entry.name.slice(0, 1) }),
    })),
    { key: "reveal", label: t(fileManagerLabel(app.platform)), icon: FOLDER_ICON, divided: apps.value.length > 0 },
    { key: "saveCopy", label: t("officeCard.saveCopy"), icon: DOWNLOAD_ICON },
  ]
})

/* Under the button, its end against the button's end, 4px down, as MiMo's dropdown sits. */
function openWith(event: MouseEvent, item: Delivered) {
  if (item.kind !== "file") return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const kind = officeType(item)
  const asked = ++appsAsked
  apps.value = []
  menu.value = { x: rect.right, y: rect.bottom + 4, item, kind: "openWith" }
  if (!kind) return
  void window.mcode
    .docApps(kind)
    .then((found) => {
      if (asked === appsAsked) apps.value = found
    })
    .catch(() => undefined)
}

function contextMenu(event: MouseEvent, item: Delivered) {
  if (item.kind !== "file") return
  event.preventDefault()
  menu.value = { x: event.clientX, y: event.clientY, item, kind: "context" }
}

async function pick(key: string) {
  const target = menu.value?.item
  menu.value = undefined
  if (!target) return
  if (key === "open") {
    await preview(target)
  } else if (key === "copyPath") {
    window.mcode.setClipboardText(target.path)
    notify(t("rp.files.pathCopied"))
  } else if (key === "reveal") {
    const result = await window.mcode.revealPath(target.path).catch((error: unknown) => ({ ok: false, error: String(error) }))
    if (!result.ok) notifyFailure(t("officeCard.revealFailed", { error: result.error ?? "" }))
  } else if (key === "saveCopy") {
    const result = await window.mcode.saveCopy(target.path).catch((error: unknown) => ({ ok: false as const, error: String(error) }))
    if (result.ok) notify(t("officeCard.savedTo", { path: result.savedPath }))
    else notifyFailure(t("officeCard.saveFailed", { error: result.error }))
  } else if (key.startsWith("app.")) {
    const id = key.slice("app.".length)
    const entry = apps.value.find((candidate) => candidate.id === id)
    // A file outside the project is opened from its own folder.
    const inside = props.directory ? relativeInside(props.directory, target.path) : ""
    const cut = Math.max(target.path.lastIndexOf("/"), target.path.lastIndexOf("\\"))
    const folder = inside ? props.directory : cut > 0 ? target.path.slice(0, cut) : undefined
    const relative = inside || target.path.slice(cut + 1)
    if (!entry || !folder || !relative) {
      notifyFailure(t("officeCard.openFailed", { error: t("harnessRow.pathNotExist") }))
      return
    }
    const reason = await window.mcode.openFile(folder, relative, entry.openWith).catch((error: unknown) => String(error))
    if (reason) notifyFailure(t("officeCard.openFailed", { error: reason }))
    else notify(t("officeCard.openedWith", { name: entry.name }))
  }
}
</script>

<template>
  <div v-if="items.length" class="delivered" data-delivered-files>
    <template v-for="item in items" :key="item.kind === 'file' ? item.path : item.url">
    <!-- MiMo previews a delivered picture, video or sound in place; `.text` is where the media card's own styles apply. -->
    <div v-if="mediaPreview(item)" class="text dl-media" data-delivered-card="media">
      <LocalMedia :kind="mediaPreview(item)!.kind" :path="mediaPreview(item)!.path" :directory="directory" />
    </div>
    <div
      v-else
      role="button"
      tabindex="0"
      class="dl-card"
      :aria-label="meta(item) ? `${item.name} · ${meta(item)}` : item.name"
      :data-delivered-card="deliveredCard(item)"
      :data-office-artifact-card="deliveredCard(item) === 'office' ? '' : undefined"
      :data-html-file-card="deliveredCard(item) === 'html' ? '' : undefined"
      @click="preview(item)"
      @keydown.enter.prevent="preview(item)"
      @keydown.space.prevent="preview(item)"
      @contextmenu="contextMenu($event, item)"
    >
      <span
        class="dl-tile"
        data-dl-tile
        :style="
          officeType(item)
            ? { color: OFFICE_TONE[officeType(item)!].fg, background: OFFICE_TONE[officeType(item)!].bg }
            : deliveredCard(item) === 'html'
              ? { color: WEB_TONE.fg, background: WEB_TONE.bg }
              : { color: FILE_TONE.fg, background: FILE_TONE.bg }
        "
      >
        <LucideIcon v-if="officeType(item)" :name="OFFICE_TONE[officeType(item)!].icon" :size="20" />
        <LucideIcon v-else-if="deliveredCard(item) === 'html'" name="globe" :size="20" />
        <svg v-else-if="item.kind === 'url'" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          <path d="M14 2v6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="dl-info">
        <span class="dl-name" data-dl-name>{{ item.name }}</span>
        <span v-if="meta(item)" class="dl-meta" data-dl-meta>{{ meta(item) }}</span>
      </span>
      <button
        v-if="deliveredCard(item) === 'office'"
        type="button"
        class="dl-open-with"
        data-office-openwith
        aria-haspopup="menu"
        :aria-expanded="menu?.item === item && menu?.kind === 'openWith'"
        @click.stop="openWith($event, item)"
        @keydown.stop
      >
        {{ t("officeCard.openWith") }}
        <LucideIcon name="chevron-down" :size="14" class="dl-chev" />
      </button>
      <svg v-else class="dl-arrow" width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7 17 17 7M7 7h10v10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </div>
    </template>
    <Teleport to="body">
      <ContextMenu
        v-if="menu"
        :x="menu.x"
        :y="menu.y"
        :items="menuItems"
        :min-width="menu.kind === 'openWith' ? 208 : 160"
        :end="menu.kind === 'openWith'"
        @pick="pick"
        @close="menu = undefined"
      />
    </Teleport>
  </div>
</template>

<style scoped>
/* MiMo's card: 12 apart from what is above, 11/14 inside, a 12 corner, the side column's ground and line; the link colour on hover. */
.dl-card {
  display: flex;
  box-sizing: border-box;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin-top: 10px;
  padding: 11px 14px;
  text-align: start;
  background: #f8f7f5;
  border: 1px solid #f0ebe5;
  border-radius: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.dl-card:hover {
  border-color: #2f6fed;
}

.dl-card:focus-visible {
  border-color: #2f6fed;
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

/* A preview sits where a card would, the same distance under what is above. */
.dl-media {
  margin-top: 10px;
}

.dl-tile {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 9px;
}

.dl-info {
  flex: 1;
  min-width: 0;
}

.dl-name,
.dl-meta {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dl-name {
  color: var(--text-strong);
  font-weight: 600;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(20px * var(--ui-font-scale, 1));
}

.dl-meta {
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(18px * var(--ui-font-scale, 1));
}

/* 打开方式: a 9-cornered outline button, 6/12 inside, 13px, its chevron dim. */
.dl-open-with {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  color: var(--text-base);
  font: inherit;
  font-size: calc(13px * var(--ui-font-scale, 1));
  line-height: calc(18px * var(--ui-font-scale, 1));
  background: transparent;
  border: 1px solid #f0ebe5;
  border-radius: 9px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.dl-open-with:hover {
  background: #f0f0f2;
}

.dl-open-with:focus-visible {
  background: #f0f0f2;
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.dl-chev,
.dl-arrow {
  flex: none;
  color: var(--text-weak);
}

.dl-arrow {
  transition: color 0.15s ease;
}

.dl-card:hover .dl-arrow {
  color: #2f6fed;
}

:root[data-theme="dark"] .dl-card {
  background: #141414;
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .dl-card:hover,
:root[data-theme="dark"] .dl-card:focus-visible {
  border-color: #5b8def;
}

:root[data-theme="dark"] .dl-open-with {
  border-color: #2e2e2e;
}

:root[data-theme="dark"] .dl-open-with:hover,
:root[data-theme="dark"] .dl-open-with:focus-visible {
  background: #2e2e2e;
}

:root[data-theme="dark"] .dl-card:hover .dl-arrow {
  color: #5b8def;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .dl-card {
    background: #141414;
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .dl-card:hover,
  :root:not([data-theme="light"]) .dl-card:focus-visible {
    border-color: #5b8def;
  }

  :root:not([data-theme="light"]) .dl-open-with {
    border-color: #2e2e2e;
  }

  :root:not([data-theme="light"]) .dl-open-with:hover,
  :root:not([data-theme="light"]) .dl-open-with:focus-visible {
    background: #2e2e2e;
  }

  :root:not([data-theme="light"]) .dl-card:hover .dl-arrow {
    color: #5b8def;
  }
}
</style>
