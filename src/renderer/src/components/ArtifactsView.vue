<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import type { SessionArtifacts } from "@shared/protocol"
import { useApp } from "../stores/app"
import { t } from "../lib/i18n"
import { notifyFailure } from "../lib/toast"
import { fileKind, type FileKind } from "../lib/session-info"

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

      <div v-if="shown.length" class="card">
        <div v-for="row in shown" :key="row.key" class="row" :class="{ gone: !row.exists }">
          <button class="file" :title="row.path" :disabled="!row.exists" @click="open(row)">
            <svg class="file-mark" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 1.8h5.2L12.5 5v9.2H4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              <path d="M9 1.8V5.2h3.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
            <span class="file-text">
              <span class="file-name">{{ row.name }}</span>
              <span class="file-meta">
                <span v-if="row.folder" class="file-dir">{{ row.folder }}</span>
                <span v-if="!row.exists" class="gone-tag">{{ t("art.missing") }}</span>
                <span v-else-if="row.size !== undefined" class="file-size">{{ size(row.size) }}</span>
              </span>
            </span>
          </button>
          <span class="when">{{ when(row.at) }}</span>
          <button class="back" @click="emit('open', row.session.sessionID)">
            <span class="back-title">{{ row.session.title }}</span>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      <p v-else-if="loaded" class="empty">{{ t("art.empty") }}</p>
    </div>
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
  font-size: 24px;
  font-weight: 500;
  line-height: 30px;
}

.subtitle {
  margin: 4px 0 0;
  color: var(--text-base);
  font-size: 13px;
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
  font-size: 14px;
  line-height: 22.4px;
}

.search input::placeholder {
  color: var(--text-weak);
}

.filters {
  display: flex;
  gap: 5px;
  margin-top: 11px;
}

.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  color: var(--text-base);
  border-radius: 10px;
  font-size: 14px;
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
  font-size: 12px;
  font-weight: 500;
}

.chip.on .chip-count {
  color: var(--text-base);
}

.card {
  margin-top: 18px;
  background: color-mix(in srgb, var(--text-strong) 4%, var(--surface-raised));
  border: 1px solid color-mix(in srgb, var(--text-strong) 10%, var(--surface-raised));
  border-radius: 16px;
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 17px;
  border-bottom: 1px solid color-mix(in srgb, var(--text-strong) 8%, transparent);
}

.row:last-child {
  border-bottom: none;
}

.file {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 10px;
  min-width: 0;
  height: 60px;
  color: var(--text-strong);
  text-align: start;
}

.file:disabled {
  cursor: default;
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
  font-size: 14px;
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
  font-size: 12px;
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
  font-size: 12px;
  line-height: 18px;
}

/* The way back to the conversation that wrote the file. */
.back {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  height: 28px;
  padding: 0 8px;
  color: var(--text-base);
  border-radius: 8px;
  font-size: 13px;
  transition: background 0.12s, color 0.12s;
}

.back:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.back-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  margin: 96px 0 0;
  color: var(--text-base);
  font-size: 14px;
  line-height: 22.4px;
  text-align: center;
}
</style>
