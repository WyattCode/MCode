<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { MessageHit, SessionArtifacts } from "@shared/protocol"
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"
import { projectName } from "../lib/project"
import { projectOf } from "../lib/session-project"
import { useEscapeLayer } from "../lib/escape-layer"
import { scoreMatch } from "@shared/search-score"
import { badgeOf } from "../lib/artifact-kind"

/**
 * MiMo's search: one field over conversations, projects and what they made.
 *
 * Empty, it lists the recent conversations. Typing matches conversation titles,
 * what was said in them (read by the server, which holds every transcript),
 * project names and paths, and the files conversations wrote; each kind gets a
 * heading, the kind with the best match first, and the words are marked where
 * they were found. As in MiMo, rows are chosen with the pointer; only Escape is
 * bound.
 */
const emit = defineEmits<{ close: []; open: [sessionID: string, messageID?: string]; project: [directory: string] }>()

const app = useApp()
const query = ref("")
const field = ref<HTMLInputElement>()
const hits = ref<MessageHit[]>([])
const artifacts = ref<SessionArtifacts[]>([])
/* Where the next page of matching files starts, and how many pages are in (S13-3). */
const artifactCursor = ref<string>()
const artifactPages = ref(1)
/*
 * The artifact search is the one part of this search that can fail, and MiMo
 * drives 正在搜索产物… and 产物搜索暂不可用 from it: conversations and projects
 * are matched here, out of what the window already holds. As MiMo's, it asks
 * the server with the typed words a moment after typing stops, and nothing is
 * asked while the box is empty.
 */
const artifactStatus = ref<"loading" | "ready" | "error">("ready")
/*
 * The transcript search can fail too since it became a query on a worker with
 * a request timeout: said with the same row and 重试, rather than read as
 * "no matching results".
 */
const messageFailed = ref(false)
/* MiMo keeps the overlay up for its 180ms exit before it goes. */
const closing = ref(false)
const CLOSE_MS = 180

interface Span {
  text: string
  ranges: { start: number; end: number }[]
}

type Kind = "convo" | "project" | "artifact"

interface Item {
  kind: Kind
  id: string
  target: string
  /** For a conversation found by what was said in it: the message to open at. */
  messageID?: string
  title: Span
  meta: string
  snippet?: Span
  score: number
  time: number
}

/* MiMo lists fifty recent conversations. */
const RECENT = 50
const plain = (text: string): Span => ({ text, ranges: [] })

/* MiMo's scoring, shared with the backend's message search so both land on one scale. */
const match = scoreMatch

const visible = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  return app.sessions.filter((session) => !session.archived && !session.sideOf && !closed.has(session.directory))
})

/* The project a hit says it belongs to, which 移动至项目 may have moved; one filed under none says nothing. */
const owner = (session: { scratch?: boolean; directory: string; group?: string }) => {
  const group = projectOf(session)
  return group ? projectName(group, app.config?.projectNames) : ""
}

const items = computed<Item[]>(() => {
  const needle = query.value.trim().toLowerCase()
  const pinned = new Set(app.config?.pinnedTabs ?? [])
  if (!needle) {
    return [...visible.value]
      .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || b.updated - a.updated)
      .slice(0, RECENT)
      .map((session) => ({
        kind: "convo" as const,
        id: session.id,
        target: session.id,
        title: plain(sessionTitle(session.title)),
        meta: owner(session),
        score: 0,
        time: session.updated,
      }))
  }

  const found: Item[] = []
  const said = new Map(hits.value.map((hit) => [hit.sessionID, hit]))
  for (const session of visible.value) {
    const title = sessionTitle(session.title)
    const titled = match(title, needle)
    const hit = said.get(session.id)
    const snippet = hit ? { text: hit.text, ranges: hit.ranges } : undefined
    const bonus = pinned.has(session.id) ? 50 : 0
    if (!titled && !hit) continue
    found.push({
      kind: "convo",
      id: session.id,
      target: session.id,
      // MiMo jumps to the message only when that message is what found the conversation; a title match opens it at its end.
      messageID: titled ? undefined : hit?.messageID,
      title: titled ? { text: title, ranges: titled.ranges } : plain(title),
      meta: owner(session),
      snippet,
      // MiMo: a title match gains 300 over its own score; a conversation found only by what was said scores as that message did.
      score: (titled ? titled.score + 300 : hit!.score) + bonus,
      time: session.updated,
    })
  }

  /*
   * The projects themselves, not the projects the conversations happen to be
   * in: MiMo searches its own project list, so a project that has never been
   * worked in is still found. Their time is 0, as MiMo leaves it - among
   * equal scores the conversations, which carry a real time, come first.
   */
  for (const directory of app.projects) {
    const name = projectName(directory, app.config?.projectNames)
    const named = match(name, needle)
    if (named) {
      found.push({ kind: "project", id: directory, target: directory, title: { text: name, ranges: named.ranges }, meta: directory, score: named.score + 200, time: 0 })
      continue
    }
    // A project found by its path ranks 100 under what the path match scored, as MiMo ranks it.
    const pathed = match(directory, needle)
    if (pathed) found.push({ kind: "project", id: directory, target: directory, title: plain(name), meta: directory, score: pathed.score - 100, time: 0 })
  }

  const shown = new Set(visible.value.map((session) => session.id))
  for (const entry of artifacts.value) {
    if (!shown.has(entry.sessionID)) continue
    for (const file of entry.files) {
      const name = file.path.split(/[\\/]/).pop() ?? file.path
      const named = match(name, needle)
      if (!named) continue
      found.push({
        kind: "artifact",
        id: `${entry.sessionID}:${file.path}`,
        target: entry.sessionID,
        title: { text: name, ranges: named.ranges },
        // MiMo's row carries the file's type badge on the right, not the conversation's title.
        meta: t(badgeOf(name).key),
        score: named.score + 100,
        time: file.at,
      })
    }
  }
  // Fifty, as MiMo caps them, and fifty more for each further page of files scrolled to.
  return found.sort((a, b) => b.score - a.score || b.time - a.time).slice(0, RECENT * artifactPages.value)
})

const ORDER: Kind[] = ["convo", "project", "artifact"]
const HEAD: Record<Kind | "recent", string> = {
  recent: "searchOverlay.recent",
  convo: "searchOverlay.convos",
  project: "searchOverlay.projects",
  artifact: "searchOverlay.artifacts",
}

const groups = computed(() => {
  if (!query.value.trim()) return items.value.length ? [{ kind: "recent" as const, items: items.value }] : []
  return ORDER.map((kind) => ({ kind, items: items.value.filter((item) => item.kind === kind) }))
    .filter((group) => group.items.length > 0)
    .sort((a, b) => b.items[0].score - a.items[0].score)
})

const flat = computed(() => groups.value.flatMap((group) => group.items))

/** A span cut into plain runs and marked ones. */
function pieces(span: Span) {
  const out: { text: string; mark: boolean }[] = []
  let at = 0
  for (const range of [...span.ranges].sort((a, b) => a.start - b.start)) {
    if (range.start > at) out.push({ text: span.text.slice(at, range.start), mark: false })
    out.push({ text: span.text.slice(Math.max(at, range.start), range.end), mark: true })
    at = Math.max(at, range.end)
  }
  if (at < span.text.length) out.push({ text: span.text.slice(at), mark: false })
  return out
}

/* The server reads the transcripts a moment after typing stops; an older answer never replaces a newer one. */
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0

function runSearch(needle: string) {
  const run = ++generation
  artifactStatus.value = "loading"
  timer = setTimeout(() => {
    void (async () => {
      try {
        const result = await app.client?.request({ type: "search.messages", query: needle, limit: RECENT })
        if (!result) throw new Error("not connected")
        if (run !== generation) return
        hits.value = result.hits
        messageFailed.value = false
      } catch {
        // What was said is one source among three; losing it leaves the titles and the files, and says so.
        if (run !== generation) return
        hits.value = []
        messageFailed.value = true
      }
    })()
    void (async () => {
      // The files conversations wrote whose names match, fifty as MiMo asks for, and MiMo's 重试 when that cannot be had.
      try {
        const result = await app.client?.request({ type: "artifact.list", query: needle, limit: RECENT })
        if (!result) throw new Error("not connected")
        if (run !== generation) return
        artifacts.value = result.artifacts
        artifactCursor.value = result.nextCursor
        artifactPages.value = 1
        artifactStatus.value = "ready"
      } catch {
        if (run !== generation) return
        artifacts.value = []
        artifactStatus.value = "error"
      }
    })()
  }, 150)
}

/*
 * The next fifty matching files, when the results are scrolled to their end
 * (S13-3): the server answers a page at a time, and the list grows by what
 * came back.
 */
let loadingArtifacts = false
async function moreArtifacts() {
  const cursor = artifactCursor.value
  const needle = query.value.trim()
  if (loadingArtifacts || !cursor || !needle) return
  const run = generation
  loadingArtifacts = true
  try {
    const result = await app.client?.request({ type: "artifact.list", query: needle, limit: RECENT, cursor })
    if (!result || run !== generation) return
    artifacts.value = [...artifacts.value, ...result.artifacts]
    artifactCursor.value = result.nextCursor
    artifactPages.value += 1
  } catch {
    // What is shown stays; the end of the list is asked for again on the next scroll.
  } finally {
    loadingArtifacts = false
  }
}

const LOAD_AHEAD_PX = 120
function onResultsScroll(event: Event) {
  const pane = event.target as HTMLElement
  if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - LOAD_AHEAD_PX) void moreArtifacts()
}

function search() {
  if (timer) clearTimeout(timer)
  const needle = query.value.trim()
  artifactCursor.value = undefined
  artifactPages.value = 1
  if (!needle) {
    generation += 1
    hits.value = []
    artifacts.value = []
    artifactStatus.value = "ready"
    messageFailed.value = false
    return
  }
  runSearch(needle)
}

watch(query, search)

/** Plays MiMo's exit, then tells the owner to unmount. */
function close() {
  if (closing.value) return
  closing.value = true
  setTimeout(() => emit("close"), CLOSE_MS)
}

function choose(item?: Item) {
  if (!item) return
  if (item.kind === "project") emit("project", item.target)
  else emit("open", item.target, item.messageID)
  close()
}

/* Escape closes it wherever focus is - the field, or a result that Tab reached - as MiMo's document-wide binding does. */
useEscapeLayer(close)

onMounted(() => {
  field.value?.focus()
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

defineExpose({ close })
</script>

<template>
  <!-- MiMo closes on the click, not on the press: a drag out of the card never closes it. -->
  <div class="search-overlay" :class="{ closing }" @click.self="close">
    <div v-modal class="search-card" role="dialog" aria-modal="true" data-new-task-clears :aria-label="t('searchOverlay.placeholder')">
      <div class="search-bar">
        <svg class="i" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          id="search-overlay-query"
          ref="field"
          v-model="query"
          :placeholder="t('searchOverlay.placeholder')"
          :aria-label="t('searchOverlay.placeholder')"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      <div class="search-results" @scroll.passive="onResultsScroll">
        <div v-if="messageFailed" class="sr-artifact-error" data-search-error="messages">
          <span>{{ t("searchOverlay.messageError") }}</span>
          <button type="button" @click="search">{{ t("searchOverlay.retry") }}</button>
        </div>
        <div v-if="artifactStatus === 'error'" class="sr-artifact-error" data-search-error="artifacts">
          <span>{{ t("searchOverlay.error") }}</span>
          <button type="button" @click="search">{{ t("searchOverlay.retry") }}</button>
        </div>
        <div v-if="!flat.length && artifactStatus === 'loading'" class="sr-empty" role="status" aria-live="polite" data-search-loading>{{ t("searchOverlay.loading") }}</div>
        <div v-else-if="!flat.length && artifactStatus !== 'error' && !messageFailed" class="sr-empty">{{ t("searchOverlay.empty") }}</div>
        <div v-for="group in groups" :key="group.kind" class="sr-group">
          <div class="sr-head">{{ t(HEAD[group.kind]) }}</div>
          <button
            v-for="item in group.items"
            :key="item.kind + item.id"
            class="sr-item"
            :data-kind="item.kind"
            @click="choose(item)"
          >
            <span class="sr-line">
              <span class="sr-title">
                <template v-for="(piece, index) in pieces(item.title)" :key="index">
                  <mark v-if="piece.mark" class="sr-mark">{{ piece.text }}</mark>
                  <template v-else>{{ piece.text }}</template>
                </template>
              </span>
              <span v-if="item.meta" class="sr-owner">{{ item.meta }}</span>
            </span>
            <span v-if="item.snippet" class="sr-snippet">
              <template v-for="(piece, index) in pieces(item.snippet)" :key="index">
                <mark v-if="piece.mark" class="sr-mark">{{ piece.text }}</mark>
                <template v-else>{{ piece.text }}</template>
              </template>
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* MiMo's overlay: the window blurred behind a light scrim, the card high up in it. */
.search-overlay {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: grid;
  place-items: start center;
  background: #00000057;
  backdrop-filter: blur(8px);
  /* MiMo's --motion-base with --ease-enter. */
  animation: search-fade-in 0.18s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.search-card {
  width: 560px;
  max-width: 92vw;
  margin-top: 13vh;
  overflow: hidden;
  background: #fffefd;
  border: 1px solid var(--border-weak);
  border-radius: 14px;
  box-shadow: 0 18px 52px rgb(0 0 0 / 0.2);
  animation: search-card-in 0.18s cubic-bezier(0.2, 0.7, 0.2, 1);
}

/* MiMo's exit: both fade over --motion-fast with --ease-exit, and stay faded. */
.search-overlay.closing {
  animation: search-fade-out 0.12s cubic-bezier(0.4, 0, 1, 1) forwards;
}

.search-overlay.closing .search-card {
  animation: search-card-out 0.12s cubic-bezier(0.4, 0, 1, 1) forwards;
}

.search-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border-weak);
}

.search-bar .i {
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--text-weak);
}

/* MiMo's 24-grid glyph: a 1.7 stroke with round ends, the same drawing the side column carries. */
.search-bar .i circle,
.search-bar .i path {
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.search-bar input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: transparent;
  border: 0;
  outline: none;
  font: inherit;
  font-size: calc(14px * var(--ui-font-scale, 1));
}

.search-bar input::placeholder {
  color: var(--text-weak);
}

.search-bar input:not(:placeholder-shown) {
  font-weight: 500;
}

.search-results {
  max-height: 430px;
  padding: 6px;
  overflow-y: auto;
}

.sr-head {
  padding: 9px 10px 4px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.sr-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  margin-bottom: 2px;
  padding: 8px 10px;
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: 8px;
  font: inherit;
  cursor: default;
}

.sr-item:hover {
  background: var(--surface-hover);
}

.sr-item:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: -2px;
}

.sr-line {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.sr-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-owner {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-snippet {
  width: 100%;
  overflow: hidden;
  padding-inline-start: 1px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The words found, in MiMo's warm tint. */
.sr-mark {
  padding: 0 1px;
  color: inherit;
  background: rgb(255 106 43 / 0.18);
  border-radius: 3px;
  font-weight: 600;
}

.sr-empty {
  padding: 26px;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
}

/* MiMo's failed artifact search: the reason in its --color-del, which is #e5484d on both schemes, and a small 重试. */
.sr-artifact-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 6px 10px;
  color: #e5484d;
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.sr-artifact-error button {
  flex: none;
  padding: 4px 9px;
  color: var(--text-body);
  background: #fffefd;
  border: 1px solid var(--border-weak);
  border-radius: 7px;
  font: inherit;
  cursor: pointer;
}

.sr-artifact-error button:focus-visible {
  outline: 2px solid var(--text-interactive);
  outline-offset: 2px;
}

/*
 * MiMo's --color-bg on the dark scheme (#181818) and its --color-txt for the
 * 重试 button.
 */
:root[data-theme="dark"] .search-card,
:root[data-theme="dark"] .sr-artifact-error button {
  background: #181818;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .search-card,
  :root:not([data-theme="light"]) .sr-artifact-error button {
    background: #181818;
  }

}

/* MiMo's search-card-in and overlay-fade-in move nothing: opacity only. */
@keyframes search-fade-in {
  from {
    opacity: 0;
  }
}

@keyframes search-card-in {
  from {
    opacity: 0;
  }
}

@keyframes search-fade-out {
  to {
    opacity: 0;
  }
}

@keyframes search-card-out {
  to {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .search-overlay,
  .search-card,
  .search-overlay.closing,
  .search-overlay.closing .search-card {
    animation: none;
  }
}

html[data-motion="on"] .search-overlay,
html[data-motion="on"] .search-card {
  animation: none;
}
</style>
