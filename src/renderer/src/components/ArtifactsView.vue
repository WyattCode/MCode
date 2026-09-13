<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import type { SessionArtifacts } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notifyFailure } from "../lib/toast"
import { fileKind, type FileKind } from "../lib/session-info"
import ArtifactPreview from "./ArtifactPreview.vue"

/**
 * Everything the sessions have produced, in one page - MiMo's 产物中心, built
 * on what this app actually knows: the files each stored session wrote.
 *
 * The server reads the transcripts and stats each file, so a file that has
 * since been deleted is listed as gone rather than silently dropped: the
 * session did write it, and that is worth knowing.
 */
const app = useApp()
const emit = defineEmits<{ open: [sessionID: string] }>()

const loaded = ref(false)
const groups = ref<SessionArtifacts[]>([])
const query = ref("")
const kind = ref<FileKind | "all">("all")

interface Row {
  key: string
  path: string
  name: string
  folder: string
  at: number
  exists: boolean
  size?: number
  kind: FileKind
  session: SessionArtifacts
}

/** Every file from every session, newest write first. */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  for (const group of groups.value) {
    for (const file of group.files) {
      const cut = file.path.lastIndexOf("/")
      out.push({
        key: `${group.sessionID}:${file.path}`,
        path: file.path,
        name: cut === -1 ? file.path : file.path.slice(cut + 1),
        folder: cut === -1 ? "" : file.path.slice(0, cut),
        at: file.at,
        exists: file.exists,
        size: file.size,
        kind: fileKind(file.path),
        session: group,
      })
    }
  }
  return out.sort((a, b) => b.at - a.at)
})

/** What the search leaves, before the bucket is chosen - the counts are of this. */
const found = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  if (!needle) return rows.value
  return rows.value.filter(
    (row) => row.path.toLocaleLowerCase().includes(needle) || row.session.title.toLocaleLowerCase().includes(needle),
  )
})

const shown = computed(() => (kind.value === "all" ? found.value : found.value.filter((row) => row.kind === kind.value)))

const counts = computed(() => ({
  all: found.value.length,
  doc: found.value.filter((row) => row.kind === "doc").length,
  code: found.value.filter((row) => row.kind === "code").length,
  other: found.value.filter((row) => row.kind === "other").length,
}))

/*
 * Grid or list, as MiMo offers both and remembers which was last used. Grid is
 * where it starts; a window with storage switched off simply always starts there.
 */
const LAYOUT_KEY = "mcode.artifactsViewMode"
const layout = ref<"grid" | "list">(
  (() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid"
    } catch {
      return "grid"
    }
  })(),
)

function setLayout(mode: "grid" | "list") {
  layout.value = mode
  try {
    localStorage.setItem(LAYOUT_KEY, mode)
  } catch {}
}

/* The bucket a file falls in, named the way its filter chip names it. */
const KIND_LABEL: Record<FileKind, string> = { doc: "art.docs", code: "art.code", other: "art.other" }

const FILTERS = [
  { id: "all", label: "art.all" },
  { id: "doc", label: "art.docs" },
  { id: "code", label: "art.code" },
  { id: "other", label: "art.other" },
] as const

onMounted(async () => {
  const result = await app.client?.request({ type: "artifact.list" }).catch(() => undefined)
  groups.value = result?.artifacts ?? []
  loaded.value = true
})

/** Sizes the way a file manager says them, not to three decimal places. */
function size(bytes?: number): string {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function when(at: number): string {
  return new Date(at).toLocaleString()
}

/** Handed to the desktop's own choice of app, the way the file tree's Open is. */
async function open(row: Row) {
  if (!row.exists) return
  const refused = await window.mcode.openFile(row.session.directory, row.path)
  if (refused) notifyFailure(t("info.openFailed"), refused)
}

/*
 * MiMo's three actions on every file: preview it here, download it, or go to
 * the conversation that wrote it. Pressing the file itself previews it, and a
 * file that is gone has nothing to preview, so it opens the conversation instead.
 */
const previewing = ref<Row>()

function activate(row: Row) {
  if (row.exists) previewing.value = row
  else emit("open", row.session.sessionID)
}

function preview(row: Row) {
  if (!row.exists) {
    notifyFailure(t("art.revealMissing"))
    return
  }
  previewing.value = row
}

/** MiMo's download hands the file over where it lies: its folder opens with it selected. */
async function download(row: Row) {
  if (!row.exists) {
    notifyFailure(t("art.revealMissing"))
    return
  }
  await window.mcode.revealFile(row.session.directory, row.path)
}

function enter(row: Row) {
  previewing.value = undefined
  emit("open", row.session.sessionID)
}
</script>

<template>
  <div class="artifacts">
    <div class="drag" aria-hidden="true" />
    <div class="column">
      <h1 class="title">{{ t("art.title") }}</h1>
      <p class="subtitle">{{ t("art.subtitle") }}</p>

      <div class="search">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.3" stroke="currentColor" stroke-width="1.2" />
          <path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
        <input
          v-model="query"
          :placeholder="t('art.search')"
          :aria-label="t('art.search')"
          spellcheck="false"
          autocomplete="off"
        />
      </div>

      <div class="bar">
        <div class="filters">
          <button
            v-for="filter in FILTERS"
            :key="filter.id"
            class="chip"
            :class="{ on: kind === filter.id }"
            @click="kind = filter.id"
          >
            <span class="chip-label">{{ t(filter.label) }}</span>
            <span class="chip-count">{{ counts[filter.id] }}</span>
          </button>
        </div>
        <!-- MiMo's two layouts, at the end of the filter row. -->
        <div class="view-toggle" role="group" :aria-label="t('art.viewMode')">
          <button
            class="view-btn"
            data-view="grid"
            :aria-pressed="layout === 'grid'"
            :aria-label="t('art.viewGrid')"
            v-tip="{ label: t('art.viewGrid') }"
            @click="setLayout('grid')"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.2" />
              <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.2" />
              <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.2" />
              <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.2" />
            </svg>
          </button>
          <button
            class="view-btn"
            data-view="list"
            :aria-pressed="layout === 'list'"
            :aria-label="t('art.viewList')"
            v-tip="{ label: t('art.viewList') }"
            @click="setLayout('list')"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              <circle cx="2.8" cy="4" r="0.8" fill="currentColor" />
              <circle cx="2.8" cy="8" r="0.8" fill="currentColor" />
              <circle cx="2.8" cy="12" r="0.8" fill="currentColor" />
            </svg>
          </button>
        </div>
      </div>

      <!--
        The grid: one tile per file, a well with the file's mark and its kind
        above the name, and the way back to its conversation on hover.
      -->
      <div v-if="shown.length && layout === 'grid'" class="grid">
        <div
          v-for="row in shown"
          :key="row.key"
          class="tile"
          :class="{ gone: !row.exists }"
          :title="row.path"
          role="button"
          tabindex="0"
          @click="activate(row)"
          @keydown.enter="activate(row)"
        >
          <div class="well">
            <svg class="well-mark" width="38" height="38" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 1.8h5.2L12.5 5v9.2H4z" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round" />
              <path d="M9 1.8V5.2h3.4" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round" />
            </svg>
            <span class="badge">{{ t(KIND_LABEL[row.kind]) }}</span>
            <div class="acts">
              <button class="act" data-act="preview" :aria-label="t('art.preview')" v-tip="{ label: t('art.preview') }" @click.stop="preview(row)">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8zM8 6.2a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                </svg>
              </button>
              <button class="act" data-act="download" :aria-label="t('art.download')" v-tip="{ label: t('art.download') }" @click.stop="download(row)">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 2.5v7M5 6.8l3 3 3-3M3 11.5v2h10v-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button class="act" data-act="enter" :aria-label="t('art.back')" v-tip="{ label: t('art.back') }" @click.stop="enter(row)">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          <div class="tile-body">
            <span class="file-name">{{ row.name }}</span>
            <span class="file-meta">
              <span v-if="!row.exists" class="gone-tag">{{ t("art.missing") }}</span>
              <span v-else-if="row.size !== undefined" class="file-size">{{ size(row.size) }}</span>
              <span class="file-when">{{ when(row.at) }}</span>
            </span>
          </div>
        </div>
      </div>

      <div v-else-if="shown.length" class="list">
        <div
          v-for="row in shown"
          :key="row.key"
          class="row"
          :class="{ gone: !row.exists }"
          role="button"
          tabindex="0"
          @click="activate(row)"
          @keydown.enter="activate(row)"
        >
          <span class="file" :title="row.path">
            <span class="file-box">
              <svg class="file-mark" width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 1.8h5.2L12.5 5v9.2H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              <path d="M9 1.8V5.2h3.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="file-text">
              <span class="file-name">{{ row.name }}</span>
              <span class="file-meta">
                <span v-if="row.folder" class="file-dir">{{ row.folder }}</span>
                <span v-if="!row.exists" class="gone-tag">{{ t("art.missing") }}</span>
                <span v-else-if="row.size !== undefined" class="file-size">{{ size(row.size) }}</span>
              </span>
            </span>
          </span>
          <span class="when">{{ when(row.at) }}</span>
          <div class="acts">
            <button class="act" data-act="preview" :aria-label="t('art.preview')" v-tip="{ label: t('art.preview') }" @click.stop="preview(row)">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8zM8 6.2a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
            </button>
            <button class="act" data-act="download" :aria-label="t('art.download')" v-tip="{ label: t('art.download') }" @click.stop="download(row)">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2.5v7M5 6.8l3 3 3-3M3 11.5v2h10v-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button class="act" data-act="enter" :aria-label="t('art.back')" v-tip="{ label: t('art.back') }" @click.stop="enter(row)">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <p v-else-if="loaded" class="empty">{{ t("art.empty") }}</p>
    </div>
    <ArtifactPreview
      v-if="previewing"
      :directory="previewing.session.directory"
      :path="previewing.path"
      :name="previewing.name"
      @close="previewing = undefined"
      @download="download(previewing)"
      @enter="enter(previewing)"
      @open-default="open(previewing)"
    />
  </div>
</template>

<style scoped>
/*
 * MiMo's artifacts page, measured: a 900 column inset 54 from the top of the
 * pane, a 24/500 title with a 13/400 line under it, a 38px search box, and a
 * row of 26px filter chips on a 10px corner where the chosen one carries a
 * six-percent wash. The list below is this app's own: MiMo shows previews of
 * things it generated; what a session here produces is files in a project.
 */
.artifacts {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable both-edges;
}

/* No header on this page, so the top strip is what drags the window. */
.drag {
  position: absolute;
  inset: 0 0 auto;
  height: 44px;
  -webkit-app-region: drag;
}

.column {
  max-width: 900px;
  margin: 0 auto;
  padding: 54px 0 40px;
}

.title {
  margin: 0;
  color: var(--text-strong);
  font-size: calc(24px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 30px;
}

.subtitle {
  margin: 4px 0 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: 20px;
}

.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  margin-top: 22px;
  padding: 0 12px;
  color: var(--text-weak);
  background: color-mix(in srgb, var(--text-strong) 4%, var(--surface-raised));
  border: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-raised));
  border-radius: 10px;
}

.search input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 22.4px;
}

.search input::placeholder {
  color: var(--text-weak);
}

/* The filter chips take the row; the layout toggle sits at its end, as MiMo's does. */
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 11px;
}

.filters {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}

/* MiMo's toggle, measured: a 1px frame on an 8px corner around two 28x24 buttons. */
.view-toggle {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
}

.view-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  color: var(--text-weak);
  border-radius: 6px;
  transition: color 0.12s, background 0.12s;
}

.view-btn:hover {
  color: var(--text-strong);
}

.view-btn[aria-pressed="true"] {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* Three across with 14 between, as MiMo lays its grid. */
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 18px;
}

.tile {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 14px;
  cursor: pointer;
  transition: box-shadow 0.12s;
}

.tile:hover {
  box-shadow: var(--shadow-xs-border);
}

/* The 96px well the file's mark sits in, with its kind top left and its actions top right. */
.well {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 96px;
  color: var(--text-weak);
  background: var(--surface-base);
}

.badge {
  position: absolute;
  top: 10px;
  left: 10px;
  padding: 2px 8px;
  color: var(--text-base);
  background: var(--surface-hover);
  border-radius: 9999px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 600;
  line-height: 16px;
}

/*
 * MiMo's three actions: framed 7px-corner buttons around a 15px glyph, 6 apart,
 * shown while the file is hovered - top right of a tile's well, at a row's end.
 */
.acts {
  display: flex;
  flex-shrink: 0;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.12s;
}

.well .acts {
  position: absolute;
  top: 10px;
  right: 10px;
}

.tile:hover .acts,
.row:hover .acts,
.acts:focus-within {
  opacity: 1;
}

.act {
  display: grid;
  place-items: center;
  padding: 6px;
  color: var(--text-weak);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 7px;
  transition: box-shadow 0.12s, color 0.12s;
}

.act:hover {
  color: var(--text-base);
  box-shadow: var(--shadow-xs-border);
}

.tile-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 10px 12px 12px;
}

.tile .file-name {
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 600;
}

.tile.gone .file-name {
  color: var(--text-weak);
  text-decoration: line-through;
}

.file-when {
  flex-shrink: 0;
}

.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  color: var(--text-base);
  border-radius: 10px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  transition: background 0.12s, color 0.12s;
}

.chip:hover {
  background: color-mix(in srgb, var(--text-strong) 4%, transparent);
}

.chip.on {
  color: var(--text-strong);
  background: color-mix(in srgb, var(--text-strong) 6%, transparent);
}

.chip-count {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.chip.on .chip-count {
  color: var(--text-base);
}

/* The list: one framed row per file, 10 apart on a 10px corner, as MiMo's list is. */
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 18px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  cursor: pointer;
  transition: box-shadow 0.12s;
}

.row:hover {
  box-shadow: var(--shadow-xs-border);
}

/* MiMo's 32px box the file's mark sits in at the start of a row. */
.file-box {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: var(--surface-base);
  border-radius: 8px;
}

.file {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  min-width: 0;
  height: 56px;
  color: var(--text-strong);
  text-align: start;
}

.file-mark {
  flex-shrink: 0;
  color: var(--text-weak);
}

.file-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.file-name {
  overflow: hidden;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row.gone .file-name {
  color: var(--text-weak);
  text-decoration: line-through;
}

.file-meta {
  display: flex;
  gap: 8px;
  min-width: 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 18px;
}

.file-dir {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gone-tag {
  flex-shrink: 0;
  color: var(--error);
}

.file-size {
  flex-shrink: 0;
}

.when {
  flex-shrink: 0;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 18px;
}

.empty {
  margin: 96px 0 0;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: 22.4px;
  text-align: center;
}
</style>
