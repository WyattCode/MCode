<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { MessageHit, SessionArtifacts } from "@shared/protocol"
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"
import { projectName } from "../lib/project"

/**
 * MiMo's search: one field over conversations, projects and what they made.
 *
 * Empty, it lists the recent conversations. Typing matches conversation titles,
 * what was said in them (read by the server, which holds every transcript),
 * project names and paths, and the files conversations wrote; each kind gets a
 * heading, the kind with the best match first, and the words are marked where
 * they were found.
 */
const emit = defineEmits<{ close: []; open: [sessionID: string]; project: [directory: string] }>()

const app = useApp()
const query = ref("")
const field = ref<HTMLInputElement>()
const list = ref<HTMLElement>()
const sel = ref(0)
const hits = ref<MessageHit[]>([])
const artifacts = ref<SessionArtifacts[]>([])

interface Span {
  text: string
  ranges: { start: number; end: number }[]
}

type Kind = "convo" | "project" | "artifact"

interface Item {
  kind: Kind
  id: string
  target: string
  title: Span
  meta: string
  snippet?: Span
  score: number
  time: number
}

/* MiMo lists fifty recent conversations. */
const RECENT = 50
const plain = (text: string): Span => ({ text, ranges: [] })

/**
 * Where the query occurs: as typed, anywhere in the text; failing that, each of
 * its letters in order. A match as typed always ranks above a scattered one.
 */
function match(text: string, needle: string): { score: number; ranges: Span["ranges"] } | undefined {
  const hay = text.toLowerCase()
  const at = hay.indexOf(needle)
  if (at >= 0) return { score: 1000 - at, ranges: [{ start: at, end: at + needle.length }] }
  const ranges: Span["ranges"] = []
  let from = 0
  for (const char of needle) {
    if (char === " ") continue
    const found = hay.indexOf(char, from)
    if (found < 0) return undefined
    const last = ranges[ranges.length - 1]
    if (last && last.end === found) last.end = found + 1
    else ranges.push({ start: found, end: found + 1 })
    from = found + 1
  }
  return { score: 100 - ranges.length * 10, ranges }
}

const visible = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  return app.sessions.filter((session) => !session.archived && !session.sideOf && !closed.has(session.directory))
})

const owner = (session: { scratch?: boolean; directory: string }) =>
  session.scratch ? "" : projectName(session.directory, app.config?.projectNames)

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
      title: titled ? { text: title, ranges: titled.ranges } : plain(title),
      meta: owner(session),
      snippet,
      score: (titled ? titled.score + 300 : 600) + bonus,
      time: session.updated,
    })
  }

  const latest = new Map<string, number>()
  for (const session of visible.value) {
    if (session.scratch) continue
    latest.set(session.directory, Math.max(latest.get(session.directory) ?? 0, session.updated))
  }
  for (const [directory, time] of latest) {
    const name = projectName(directory, app.config?.projectNames)
    const named = match(name, needle)
    if (named) {
      found.push({ kind: "project", id: directory, target: directory, title: { text: name, ranges: named.ranges }, meta: directory, score: named.score + 200, time })
    } else if (directory.toLowerCase().includes(needle)) {
      found.push({ kind: "project", id: directory, target: directory, title: plain(name), meta: directory, score: 0, time })
    }
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
        meta: sessionTitle(entry.title),
        score: named.score + 100,
        time: file.at,
      })
    }
  }
  return found.sort((a, b) => b.score - a.score || b.time - a.time).slice(0, RECENT)
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
watch(query, (value) => {
  sel.value = 0
  if (timer) clearTimeout(timer)
  const needle = value.trim()
  const run = ++generation
  if (!needle) {
    hits.value = []
    return
  }
  timer = setTimeout(async () => {
    const result = await app.client?.request({ type: "search.messages", query: needle, limit: RECENT }).catch(() => undefined)
    if (run === generation) hits.value = result?.hits ?? []
  }, 150)
})

function choose(item?: Item) {
  if (!item) return
  if (item.kind === "project") emit("project", item.target)
  else emit("open", item.target)
  emit("close")
}

function onKeydown(event: KeyboardEvent) {
  const count = flat.value.length
  if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    emit("close")
  } else if (event.key === "ArrowDown" && count) {
    event.preventDefault()
    sel.value = (sel.value + 1) % count
  } else if (event.key === "ArrowUp" && count) {
    event.preventDefault()
    sel.value = (sel.value - 1 + count) % count
  } else if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault()
    choose(flat.value[sel.value])
  }
}

watch(sel, async () => {
  await nextTick()
  list.value?.querySelector(".sr-item.sel")?.scrollIntoView({ block: "nearest" })
})

onMounted(async () => {
  field.value?.focus()
  const result = await app.client?.request({ type: "artifact.list" }).catch(() => undefined)
  artifacts.value = result?.artifacts ?? []
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="search-overlay" @mousedown.self="emit('close')">
    <div v-modal class="search-card" role="dialog" :aria-label="t('searchOverlay.placeholder')">
      <div class="search-bar">
        <svg class="i" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M7.2 2.8a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8z" />
          <path d="M13.2 13.2l-2.8-2.8" />
        </svg>
        <input
          ref="field"
          v-model="query"
          :placeholder="t('searchOverlay.placeholder')"
          spellcheck="false"
          autocomplete="off"
          @keydown="onKeydown"
        />
      </div>
      <div ref="list" class="search-results">
        <div v-if="!flat.length" class="sr-empty">{{ t("searchOverlay.empty") }}</div>
        <div v-for="group in groups" :key="group.kind" class="sr-group">
          <div class="sr-head">{{ t(HEAD[group.kind]) }}</div>
          <button
            v-for="item in group.items"
            :key="item.kind + item.id"
            class="sr-item"
            :class="{ sel: flat.indexOf(item) === sel }"
            :data-kind="item.kind"
            @mousemove="sel = flat.indexOf(item)"
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
  background: rgb(0 0 0 / 0.34);
  backdrop-filter: blur(8px);
  animation: search-fade 0.16s ease-out;
}

.search-card {
  width: 560px;
  max-width: 92vw;
  margin-top: 13vh;
  overflow: hidden;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 14px;
  box-shadow: 0 18px 52px rgb(0 0 0 / 0.2);
  animation: search-card 0.16s ease-out;
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
  color: var(--text-weaker);
}

.search-bar .i path {
  stroke: currentColor;
  stroke-width: 1.3;
  stroke-linecap: round;
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
  color: var(--text-weaker);
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
  color: var(--text-weaker);
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

.sr-item.sel {
  background: var(--surface-selected);
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
  color: var(--text-weaker);
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sr-snippet {
  width: 100%;
  overflow: hidden;
  padding-inline-start: 1px;
  color: var(--text-weak);
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
  color: var(--text-weaker);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-align: center;
}

@keyframes search-fade {
  from {
    opacity: 0;
  }
}

@keyframes search-card {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.99);
  }
}

@media (prefers-reduced-motion: reduce) {
  .search-overlay,
  .search-card {
    animation: none;
  }
}
</style>
