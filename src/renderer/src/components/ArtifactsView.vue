<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { ArtifactFacets, SessionArtifacts } from "@shared/protocol"
import { useApp } from "../stores/app"
import { calendarDate, t, tn } from "../lib/i18n"
import { notifyFailure } from "../lib/toast"
import { ARTIFACT_PAGE, artifactAbsolute, artifactAge, artifactCategory, badgeOf, type ArtifactCategory, type BadgeStyle } from "../lib/artifact-kind"
import { previewArtifact } from "../lib/artifact-open"

/**
 * Everything the sessions have produced, in one page - MiMo's 产物中心, built
 * on what this app actually knows: the files each stored session wrote.
 *
 * The server answers from its artifact store, fifty files at a time, and asks
 * the disk about each file it hands over. A file that has since been moved or
 * deleted is left out, as MiMo's page leaves it out: there is nothing to
 * preview or download.
 */
const app = useApp()
const emit = defineEmits<{ open: [sessionID: string] }>()

const loaded = ref(false)
const failed = ref(false)
/** Every page loaded so far for the current search and tab, in order. */
const groups = ref<SessionArtifacts[]>([])
/** Where the next page starts; none once the last one is here. */
const nextCursor = ref<string>()
/** The server's counts for the tabs, which cover files not loaded yet. */
const facets = ref<ArtifactFacets>()
/** The store is still being filled (a first run or an upgrade): what is here is what is ready. */
const building = ref(false)
const query = ref("")
const kind = ref<ArtifactCategory | "all">("all")

/* MiMo waits 150ms after the last key before searching; switching a tab applies at once. */
const needle = ref("")
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(query, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  // Drop previous search tiles/counts during debounce — same idea as RpFiles / SearchOverlay.
  if (value !== needle.value) clearStaleResults()
  searchTimer = setTimeout(() => (needle.value = value), 150)
})
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

interface Row {
  key: string
  path: string
  name: string
  at: number
  kind: ArtifactCategory
  badge: BadgeStyle
  session: SessionArtifacts
}

/** Every file from every session, newest write first. */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  for (const group of groups.value) {
    for (const file of group.files) {
      if (!file.exists) continue
      const cut = Math.max(file.path.lastIndexOf("/"), file.path.lastIndexOf("\\"))
      out.push({
        key: `${group.sessionID}:${file.path}`,
        path: file.path,
        name: cut === -1 ? file.path : file.path.slice(cut + 1),
        at: file.at,
        kind: artifactCategory(file.path),
        badge: badgeOf(file.path),
        session: group,
      })
    }
  }
  return out.sort((a, b) => b.at - a.at)
})

/*
 * The server does the matching and the tab (MiMo's: the file's name, through
 * the store's trigram index), so the rows are what is shown. The tab is
 * checked here again only for an answer from a server that could not filter.
 */
const visible = computed(() => (kind.value === "all" ? rows.value : rows.value.filter((row) => row.kind === kind.value)))

/*
 * The counts are the server's, over everything the search matches in every
 * tab; worked out from the rows only when it sent none.
 */
const counts = computed(() => {
  if (facets.value) return { all: facets.value.total, doc: facets.value.doc, app: facets.value.app, other: facets.value.other }
  return {
    all: rows.value.length,
    doc: rows.value.filter((row) => row.kind === "doc").length,
    app: rows.value.filter((row) => row.kind === "app").length,
    other: rows.value.filter((row) => row.kind === "other").length,
  }
})

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

const FILTERS = [
  { id: "all", label: "art.all" },
  { id: "doc", label: "art.docs" },
  { id: "app", label: "art.apps" },
  { id: "other", label: "art.other" },
] as const

/* A load that fails says so and offers 重试, rather than claiming there is nothing. */
let generation = 0
/** The search the shown rows answer - the typed one may be ahead of it. */
const answered = ref("")

/** Wipe shown rows so a new query/tab cannot look matched by the previous answer. Not used by building refresh `load()`. */
function clearStaleResults() {
  groups.value = []
  nextCursor.value = undefined
  facets.value = undefined
  answered.value = ""
  failed.value = false
}

/** What the page asks the server for: the search and the tab. */
const asking = () => ({ type: "artifact.list" as const, query: needle.value, limit: ARTIFACT_PAGE, ...(kind.value === "all" ? {} : { category: kind.value }) })

/** The first page for the current search and tab, replacing whatever was shown. */
async function load() {
  const run = ++generation
  const asked = needle.value
  failed.value = false
  try {
    const result = await app.client?.request(asking())
    if (!result) throw new Error("not connected")
    // An older answer never replaces a newer search's.
    if (run !== generation) return
    groups.value = result.artifacts
    nextCursor.value = result.nextCursor
    facets.value = result.facets
    building.value = result.building === true
    answered.value = asked
    loaded.value = true
  } catch {
    if (run === generation) failed.value = true
  }
}

/* MiMo's 加载更多: the next fifty from the server, where the last page ended. */
const loadingMore = ref(false)
async function loadMore() {
  const cursor = nextCursor.value
  if (loadingMore.value || !cursor || failed.value) return
  const run = generation
  loadingMore.value = true
  try {
    const result = await app.client?.request({ ...asking(), cursor })
    if (!result) throw new Error("not connected")
    // A new search or tab since: this page belongs to the old one.
    if (run !== generation) return
    groups.value = [...groups.value, ...result.artifacts]
    nextCursor.value = result.nextCursor
    if (result.facets) facets.value = result.facets
    building.value = result.building === true
  } catch {
    if (run === generation) notifyFailure(t("art.loadError"))
  } finally {
    // MiMo's 加载中…: the button is off, and says so, until the next fifty are drawn.
    await nextTick()
    loadingMore.value = false
  }
}

/* Near the bottom of the page, the next fifty are asked for without waiting for the button. */
const LOAD_AHEAD_PX = 240
function onScroll(event: Event) {
  const pane = event.target as HTMLElement
  if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - LOAD_AHEAD_PX) void loadMore()
}

/*
 * While the store is still being filled, the first page is asked for again
 * every few seconds, so files appear as they are reached - unless more pages
 * have been loaded, which a refresh would take away.
 */
const BUILDING_REFRESH_MS = 2000
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let gone = false
watch(building, (now) => {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = undefined
  if (!now) return
  const again = () => {
    refreshTimer = setTimeout(async () => {
      if (!nextCursor.value || groups.value.reduce((n, group) => n + group.files.length, 0) <= ARTIFACT_PAGE) {
        if (!loadingMore.value) await load()
      }
      if (building.value && !gone) again()
    }, BUILDING_REFRESH_MS)
  }
  again()
})
onBeforeUnmount(() => {
  gone = true
  if (refreshTimer) clearTimeout(refreshTimer)
})

/*
 * Switching a tab applies at once, as MiMo's does: it asks with the text in
 * the box rather than with the debounced copy, which could still be a
 * keystroke behind. Typing alone waits for `needle`.
 */
watch(kind, () => {
  if (searchTimer) clearTimeout(searchTimer)
  clearStaleResults()
  needle.value = query.value
})
watch([needle, kind], () => void load())

/** The newest store revision this page has answered for. */
let seenRevision = 0
let offChanged: (() => void) | undefined

/*
 * The store tells the window when what the conversations produced changes
 * (R21-F4-35), so the page fills in while it is open rather than only while
 * the store is being built. Only the first page is read again, and only while
 * nothing more has been paged in - a refresh would take those pages away.
 */
onMounted(() => {
  void load()
  offChanged = app.client?.on((event) => {
    if (event.type !== "artifact.changed" || event.revision <= seenRevision) return
    seenRevision = event.revision
    if (loadingMore.value) return
    if (groups.value.reduce((n, group) => n + group.files.length, 0) > ARTIFACT_PAGE) return
    void load()
  })
})
onBeforeUnmount(() => offChanged?.())

/* The time is read against a clock that moves, so "just now" does not stay just now. */
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30000)
onBeforeUnmount(() => clearInterval(clock))

function when(at: number): string {
  const age = artifactAge(at, now.value)
  if (age.unit === "just") return t("time.justNow")
  if (age.unit === "date") return calendarDate(at)
  return tn(age.unit === "m" ? "time.minutesAgo" : age.unit === "h" ? "time.hoursAgo" : "time.daysAgo", age.n)
}

/*
 * MiMo's three actions on every file: preview it in the right panel, download
 * it, or go to the conversation that wrote it. Pressing the file previews it.
 */
function preview(row: Row) {
  void previewArtifact(
    { sessionID: row.session.sessionID, directory: row.session.directory, path: row.path, name: row.name },
    (sessionID) => emit("open", sessionID),
  )
}

/** MiMo's download hands the file over where it lies: its folder opens with it selected. */
async function download(row: Row) {
  const absolute = /^([A-Za-z]:)?[\\/]/.test(row.path)
  if (absolute) {
    const result = await window.mcode.revealPath(artifactAbsolute(row.session.directory, row.path)).catch(() => ({ ok: false }))
    if (!result.ok) notifyFailure(t("art.revealMissing"))
    return
  }
  const result = await window.mcode
    .revealFile(row.session.directory, row.path)
    .catch((failure: unknown) => ({ ok: false, missing: false, error: String(failure) }))
  if (result.ok) return
  if (result.missing) notifyFailure(t("art.revealMissing"))
  else notifyFailure(t("art.revealFailed", { error: result.error ?? "" }))
}

function enter(row: Row) {
  if (!app.sessions.some((session) => session.id === row.session.sessionID)) {
    notifyFailure(t("art.convoNotFound"))
    return
  }
  emit("open", row.session.sessionID)
}

const badgeStyle = (badge: BadgeStyle) => ({ color: badge.fg, background: `color-mix(in srgb, ${badge.fg} 12%, transparent)` })
</script>

<template>
  <div class="artifacts" @scroll.passive="onScroll">
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
            <!-- MiMo leaves the counts blank until they are known. -->
            <span class="chip-count">{{ loaded ? counts[filter.id] : "" }}</span>
          </button>
        </div>
        <!-- MiMo's two layouts, at the end of the filter row. -->
        <div class="view-toggle" role="group" :aria-label="t('art.viewMode')">
          <button
            class="view-btn"
            data-view="grid"
            :aria-pressed="layout === 'grid'"
            :aria-label="t('art.viewGrid')"
            :title="t('art.viewGrid')"
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
            :title="t('art.viewList')"
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

      <div v-if="failed" class="notice failed" data-empty="error">
        <span>{{ t("art.loadError") }}</span>
        <button type="button" class="page-btn" data-act="retry" @click="load">{{ t("art.retry") }}</button>
      </div>

      <!--
        The grid: one tile per file, a well with the file's mark and its kind
        above the name, and the three actions on hover.
      -->
      <div v-else-if="visible.length && layout === 'grid'" class="grid">
        <div
          v-for="row in visible"
          :key="row.key"
          class="tile"
          :title="row.name"
          role="button"
          tabindex="0"
          @click="preview(row)"
          @keydown.enter="preview(row)"
        >
          <div class="well">
            <svg class="well-mark" width="38" height="38" viewBox="0 0 24 24" fill="none" :stroke="row.badge.fg" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path v-for="d in row.badge.glyph" :key="d" :d="d" />
            </svg>
            <span class="badge" :data-badge="row.badge.kind" :style="badgeStyle(row.badge)">
              <span class="badge-dot" :style="{ background: row.badge.fg }" />{{ t(row.badge.key) }}
            </span>
            <div class="acts">
              <button class="act" data-act="preview" :aria-label="t('art.preview')" :title="t('art.preview')" @click.stop="preview(row)">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8zM8 6.2a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                </svg>
              </button>
              <button class="act" data-act="download" :aria-label="t('art.download')" :title="t('art.download')" @click.stop="download(row)">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 2.5v7M5 6.8l3 3 3-3M3 11.5v2h10v-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button class="act" data-act="enter" :aria-label="t('art.back')" :title="t('art.back')" @click.stop="enter(row)">
                <!-- MiMo's 进入对话 is an arrow leaving to the top right, not a speech bubble. -->
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M7 7h10v10M7 17 17 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          <div class="tile-body">
            <span class="file-name">{{ row.name }}</span>
            <span class="file-when">{{ when(row.at) }}</span>
          </div>
        </div>
      </div>

      <!-- The list: the kind's box, its badge in a column of its own, the name, the time, the actions. -->
      <div v-else-if="visible.length" class="list">
        <div
          v-for="row in visible"
          :key="row.key"
          class="row"
          :title="row.name"
          role="button"
          tabindex="0"
          @click="preview(row)"
          @keydown.enter="preview(row)"
        >
          <span class="file-box">
            <svg class="file-mark" width="18" height="18" viewBox="0 0 24 24" fill="none" :stroke="row.badge.fg" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path v-for="d in row.badge.glyph" :key="d" :d="d" />
            </svg>
          </span>
          <span class="badge-cell">
            <span class="badge" :data-badge="row.badge.kind" :style="badgeStyle(row.badge)">
              <span class="badge-dot" :style="{ background: row.badge.fg }" />{{ t(row.badge.key) }}
            </span>
          </span>
          <span class="file-name">{{ row.name }}</span>
          <span class="when">{{ when(row.at) }}</span>
          <div class="acts">
            <button class="act" data-act="preview" :aria-label="t('art.preview')" :title="t('art.preview')" @click.stop="preview(row)">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8zM8 6.2a1.8 1.8 0 1 1 0 3.6a1.8 1.8 0 1 1 0-3.6" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
            </button>
            <button class="act" data-act="download" :aria-label="t('art.download')" :title="t('art.download')" @click.stop="download(row)">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2.5v7M5 6.8l3 3 3-3M3 11.5v2h10v-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button class="act" data-act="enter" :aria-label="t('art.back')" :title="t('art.back')" @click.stop="enter(row)">
              <!-- MiMo's 进入对话 is an arrow leaving to the top right, not a speech bubble. -->
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M7 7h10v10M7 17 17 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- A search that found nothing says so, rather than claiming there is nothing at all. -->
      <p v-else-if="loaded && answered.trim()" class="notice" data-empty="no-match">{{ t("art.noMatch") }}</p>

      <div v-else-if="loaded && !query.trim()" class="none" data-empty="none">
        <!-- MCode's own drawing: two sheets, the front one with a folded corner and a spark. -->
        <svg class="illo" width="168" height="120" viewBox="0 0 168 120" fill="none" aria-hidden="true">
          <rect class="illo-back" x="46" y="18" width="62" height="80" rx="8" transform="rotate(-8 77 58)" />
          <path class="illo-front" d="M68 22h34l18 18v58a8 8 0 0 1-8 8H68a8 8 0 0 1-8-8V30a8 8 0 0 1 8-8z" />
          <path class="illo-fold" d="M102 22v12a6 6 0 0 0 6 6h12" />
          <path class="illo-line" d="M73 56h32M73 68h32M73 80h20" />
          <path class="illo-spark" d="M132 20v14M125 27h14M36 84v8M32 88h8" />
        </svg>
        <span>{{ t("art.empty") }}</span>
      </div>

      <!-- MiMo shows 加载更多 only when there is something above it. -->
      <div v-if="!failed && nextCursor && visible.length" class="more">
        <button type="button" class="page-btn" data-act="load-more" :disabled="loadingMore" @click="loadMore">
          {{ t(loadingMore ? "art.loadingMore" : "art.loadMore") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * MiMo's artifacts page: a 900 column inset 54 from the top of the pane, a
 * 24/500 title 6 above a 13/400 line, 18 to a 36px search box, 16 to a row of
 * filter tabs, and 18 to the files.
 */
.artifacts {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  container-type: inline-size;
}

/* No header on this page, so the top strip is what drags the window. */
.drag {
  position: absolute;
  inset: 0 0 auto;
  height: 44px;
  -webkit-app-region: drag;
}

/*
 * MiMo's feature-page shell: 54 above and 40 below, 40 either side - 20 once
 * the pane is 680 or narrower - with the 900 column centred inside that.
 */
.column {
  box-sizing: border-box;
  width: 100%;
  max-width: 980px;
  margin: 0 auto;
  padding: 54px 40px 40px;
}

@container (max-width: 680px) {
  .column {
    padding-inline: 20px;
  }
}

.title {
  margin: 0 0 2px;
  color: var(--text-strong);
  font-size: calc(24px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(30px * var(--ui-font-scale, 1));
}

.subtitle {
  margin: 4px 0 0;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 400;
  line-height: calc(20px * var(--ui-font-scale, 1));
}

/* MiMo's CSS gives 36px; an older measurement here said 38, so recheck on a live window. */
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  margin-top: 18px;
  padding: 0 12px;
  color: var(--text-weak);
  background: #fff;
  border: 1px solid var(--border-weak);
  border-radius: 8px;
}

/*
 * MiMo's --color-bg on the dark scheme. Its own dark border for the toggle is
 * --color-set-line, which resolves to a near-white #f1f1f1c7 there - its
 * oversight - so MCode's --border-weak stays.
 */
:root[data-theme="dark"] .search,
:root[data-theme="dark"] .view-toggle {
  background: #181818;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .search,
  :root:not([data-theme="light"]) .view-toggle {
    background: #181818;
  }
}

.search input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(22.4px * var(--ui-font-scale, 1));
}

.search input:not(:placeholder-shown) {
  font-weight: 500;
}

.search input::placeholder {
  color: var(--text-weak);
}

/*
 * The filter tabs take the row; the layout toggle sits at its end, as MiMo's
 * does. The 18 below it belongs to this row rather than to the grid, so the
 * empty, no-match and failed notices start where the files would (R21-F4-33).
 */
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  margin-bottom: 18px;
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
  background: #fffefd;
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

/* MiMo's tabs: muted, hover only darkens the word, the chosen one on the menu's hover colour. */
.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: calc(26px * var(--ui-font-scale, 1));
  padding: 0 10px;
  color: var(--text-base);
  border-radius: 10px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  transition: background 0.12s, color 0.12s;
}

.chip:hover {
  color: var(--text-strong);
}

.chip.on {
  color: var(--text-strong);
  background: #f1f0ec;
}

:root[data-theme="dark"] .chip.on {
  background: rgba(255, 255, 255, 0.06);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .chip.on {
    background: rgba(255, 255, 255, 0.06);
  }
}

.chip-count {
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
}

.chip.on .chip-count {
  color: var(--text-base);
}

/* Three across with 14 between, as MiMo lays its grid. */
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
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

/* MiMo's hover:shadow-sm, which is a lift rather than a ring over the border it already carries. */
.tile:hover,
.row:hover,
.act:hover {
  box-shadow: 0 1px 3px 0 #0000001a, 0 1px 2px -1px #0000001a;
}

/* The 96px well the file's mark sits in, with its kind top left and its actions top right. */
.well {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 96px;
  background: var(--surface-base);
}

.well > .badge {
  position: absolute;
  top: 10px;
  inset-inline-start: 10px;
}

/* MiMo's badge: the kind's colour on its 12% tint, led by a 6px dot. */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: calc(11px * var(--ui-font-scale, 1));
  font-weight: 600;
  line-height: calc(16px * var(--ui-font-scale, 1));
  white-space: nowrap;
}

.badge-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 9999px;
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
  inset-inline-end: 10px;
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
}

.tile-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 11px;
}

.file-name {
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 600;
  line-height: calc(20px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-when,
.when {
  flex-shrink: 0;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: calc(16px * var(--ui-font-scale, 1));
}

/* The list: one framed row per file, 10 apart on a 10px corner, as MiMo's list is. */
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
  padding: 10px 12px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  cursor: pointer;
  transition: box-shadow 0.12s;
}

.row .file-name {
  flex: 1;
  min-width: 0;
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

.file-mark {
  flex-shrink: 0;
}

.badge-cell {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  min-width: 72px;
}

/* No match, and a load that failed: MiMo's centred muted line. */
.notice {
  margin: 0;
  padding: 40px 0;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(22.4px * var(--ui-font-scale, 1));
  text-align: center;
}

.failed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.none {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  min-height: 60vh;
  color: var(--text-base);
  font-size: calc(14px * var(--ui-font-scale, 1));
  line-height: calc(22.4px * var(--ui-font-scale, 1));
  text-align: center;
}

.illo-back {
  fill: var(--surface-base);
  stroke: var(--border-weak);
  stroke-width: 1.5;
}

.illo-front {
  fill: var(--surface-raised);
  stroke: var(--text-weak);
  stroke-width: 1.5;
}

.illo-fold,
.illo-line,
.illo-spark {
  stroke: var(--text-weak);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.illo-line {
  stroke-width: 3;
  opacity: 0.5;
}

/* MiMo's page buttons: 重试 and 加载更多. */
.more {
  display: flex;
  justify-content: center;
  padding: 20px 0;
}

.page-btn {
  height: calc(34px * var(--ui-font-scale, 1));
  padding: 0 18px;
  color: var(--text-strong);
  border: 1px solid var(--border-weak);
  border-radius: 8px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  transition: background 0.12s;
}

.page-btn:hover {
  background: var(--surface-hover);
}

.page-btn:disabled {
  opacity: 0.5;
}
</style>
