<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"
import { projectName } from "../lib/project"
import { badgeStyle, fileBadge } from "../lib/filetype"

/**
 * What this picker is for: one surface opened on one kind of thing, which is
 * how the reference offers its file, session and project pickers rather than
 * building three dialogs. MiMo has no command list, so there is no mixed mode.
 */
export type PaletteMode = "files" | "sessions" | "projects"

const props = withDefaults(defineProps<{ mode: PaletteMode; projects?: string[] }>(), { projects: () => [] })
const emit = defineEmits<{
  close: []
  file: [path: string]
  project: [directory: string]
}>()

const app = useApp()
const query = ref("")
const active = ref(0)
const input = ref<HTMLInputElement>()
const files = ref<string[]>([])

/**
 * Subsequence match, the usual fuzzy-finder contract: every character of the
 * query must appear in order. The score favours earlier and tighter matches so
 * "nse" ranks "New session" above a scattered coincidence.
 */
function score(text: string, needle: string): number | undefined {
  if (!needle) return 0
  const haystack = text.toLowerCase()
  let index = 0
  let total = 0
  let previous = -1
  for (const char of needle.toLowerCase()) {
    const found = haystack.indexOf(char, index)
    if (found === -1) return undefined
    total += found - previous === 1 ? 0 : found
    previous = found
    index = found + 1
  }
  return total
}

/**
 * What the picker shows before anything is typed: the first files of the
 * project, fetched once per open.
 */
async function loadFiles() {
  const directory = app.current?.directory
  if (!directory || !app.client) return
  const result = await app.client.request({ type: "file.list", directory })
  files.value = result.files.map((file) => file.path)
}

/*
 * N11-23: once something is typed, the project is searched for it, as MiMo's
 * picker asks its searchFiles on every keystroke. Filtering the list fetched on
 * open only ever reached the first 500 files in breadth-first order - on a large
 * project, almost none of them. The answers are ranked here as before.
 */
const searched = ref<string[]>()
let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchTicket = 0

watch(query, (next) => {
  if (searchTimer) clearTimeout(searchTimer)
  const needle = next.trim()
  if (!needle || props.mode !== "files") {
    searched.value = undefined
    return
  }
  searchTimer = setTimeout(() => void searchFiles(needle), SEARCH_DEBOUNCE_MS)
})

async function searchFiles(needle: string) {
  const directory = app.current?.directory
  if (!directory || !app.client) return
  const ticket = ++searchTicket
  const result = await app.client.request({ type: "file.search", directory, query: needle, limit: SCOPED_LIMIT }).catch(() => undefined)
  // A slower answer to an older query never replaces a newer one.
  if (ticket !== searchTicket || !result) return
  searched.value = result.entries.map((entry) => entry.rel)
}

const SEARCH_DEBOUNCE_MS = 120

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

type Row =
  | { kind: "file"; id: string; path: string; rank: number }
  | { kind: "session"; id: string; sessionID: string; title: string; hint?: string; rank: number }
  | { kind: "project"; id: string; directory: string; title: string; rank: number }

/**
 * How many of one kind to show. Nothing else competes for the room, so the
 * file picker opens with its files rather than eight of them.
 */
const SCOPED_LIMIT = 200

/** Says what is being searched, so the picker explains itself. */
const placeholder = computed(() => t(`search.in.${props.mode}`))

/** One flat, ranked list - the sections are only a rendering detail. */
const rows = computed<Row[]>(() => {
  const needle = query.value.trim()

  // Typed: the backend's search, while its answer is on the way the first files as before.
  const fileRows = (needle && searched.value ? searched.value : files.value)
    .map((path) => ({ path, rank: score(path, needle) }))
    .filter((entry): entry is { path: string; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, SCOPED_LIMIT)
    .map<Row>((entry) => ({ kind: "file", id: `file:${entry.path}`, path: entry.path, rank: entry.rank }))

  // Closing a project hides it everywhere else, so its sessions have no
  // business still being reachable from here.
  const closed = new Set(app.config?.closedProjects ?? [])
  const sessionRows = app.sessions
    .filter((session) => session.id !== app.currentID && !closed.has(session.directory) && !session.archived)
    .map((session) => ({ session, rank: score(sessionTitle(session.title), needle) }))
    .filter((entry): entry is { session: (typeof app.sessions)[number]; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, SCOPED_LIMIT)
    .map<Row>((entry) => ({
      kind: "session",
      id: `open:${entry.session.id}`,
      sessionID: entry.session.id,
      title: sessionTitle(entry.session.title),
      hint: projectName(entry.session.directory, app.config?.projectNames),
      rank: entry.rank,
    }))

  const projectRows =
    props.mode === "projects"
      ? props.projects
          .map((directory) => ({
            directory,
            title: projectName(directory, app.config?.projectNames),
          }))
          .map((entry) => ({ ...entry, rank: score(entry.title, needle) }))
          .filter((entry): entry is typeof entry & { rank: number } => entry.rank !== undefined)
          .sort((a, b) => a.rank - b.rank)
          .map<Row>((entry) => ({
            kind: "project",
            id: `project:${entry.directory}`,
            directory: entry.directory,
            title: entry.title,
            rank: entry.rank,
          }))
      : []

  // Only what it was opened for.
  if (props.mode === "files") return fileRows
  if (props.mode === "sessions") return sessionRows
  return projectRows
})

/** Heading to draw above each row, if any: one per kind, and nothing finer. */
const headers = computed(() => {
  const labels = new Map<number, string>()
  const seenKind = new Set<string>()

  rows.value.forEach((row, index) => {
    if (seenKind.has(row.kind)) return
    seenKind.add(row.kind)
    labels.set(index, LABELS[row.kind])
  })

  return labels
})

const LABELS: Record<Row["kind"], string> = {
  file: "search.files",
  project: "search.projects",
  session: "searchOverlay.convos",
}

async function choose(index: number) {
  const row = rows.value[index]
  if (!row) return
  // Emit the result before closing: closing unmounts this component, and a
  // listener on an unmounted component never fires.
  if (row.kind === "project") {
    emit("project", row.directory)
    emit("close")
    return
  }
  if (row.kind === "file") emit("file", row.path)
  emit("close")
  await nextTick()
  if (row.kind === "session") await app.open(row.sessionID)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault()
    emit("close")
  } else if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
    event.preventDefault()
    active.value = (active.value + 1) % Math.max(1, rows.value.length)
  } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
    event.preventDefault()
    active.value = (active.value - 1 + rows.value.length) % Math.max(1, rows.value.length)
  } else if (event.key === "Enter") {
    event.preventDefault()
    void choose(active.value)
  }
}

// Keep the highlight in view as it moves past the fold.
watch(active, async () => {
  await nextTick()
  document.querySelector(".palette .row.sel")?.scrollIntoView({ block: "nearest" })
})

onMounted(() => {
  input.value?.focus()
  void loadFiles()
})
</script>

<template>
  <div class="overlay palette-overlay" @mousedown.self="emit('close')">
    <div v-modal class="dialog palette" data-new-task-clears @keydown="onKeydown">
      <div class="search">
        <input
          ref="input"
          v-model="query"
          class="search-in"
          :placeholder="placeholder"
          spellcheck="false"
          @input="active = 0"
        />
      </div>

      <div class="list">
        <div v-if="rows.length === 0" class="empty">{{ t("palette.empty") }}</div>

        <template v-for="(row, index) in rows" :key="row.id">
          <div v-if="headers.get(index)" class="group">{{ t(headers.get(index)!) }}</div>

          <button
            class="row"
            :class="{ sel: index === active }"
            @mousemove="active = index"
            @click="choose(index)"
          >
            <template v-if="row.kind === 'file'">
              <span class="badge" :style="badgeStyle(fileBadge(row.path))">
                {{ fileBadge(row.path).label }}
              </span>
              <span class="title mono">{{ row.path }}</span>
            </template>

            <template v-else-if="row.kind === 'session'">
              <span class="title">{{ row.title }}</span>
              <span v-if="row.hint" class="hint">{{ row.hint }}</span>
            </template>

            <!-- A project is named once; the path underneath is the hint. -->
            <template v-else>
              <span class="title">{{ row.title }}</span>
              <span class="hint">{{ row.directory }}</span>
            </template>
          </button>
        </template>
      </div>

      <div class="foot">
        <span><span class="kbd">↑</span><span class="kbd">↓</span> {{ t("palette.navigate") }}</span>
        <span><span class="kbd">Enter</span> {{ t("palette.run") }}</span>
        <span><span class="kbd">Esc</span> {{ t("palette.cancel") }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.palette-overlay {
  align-items: flex-start;
  padding-top: 12vh;
}

.palette {
  display: flex;
  flex-direction: column;
  width: min(640px, 92vw);
  max-height: 66vh;
  /* Wider corners than the shared 6px: opencode's palette card measures 12. */
  border-radius: 12px;
}

.search {
  padding: 6px;
}

.search-in {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  color: var(--text-strong);
  /*
   * A fill, not a box. opencode's `text-input-v2` draws no border at all:
   * `background: color-mix(in srgb, var(--v2-background-bg-layer-02) 60%, transparent)`
   * at rest and the same colour solid once it has focus, `border-radius: 6px`,
   * `outline: 0`. bg-layer-02 is `--surface-layer` here. This was a 1px border
   * over `--surface-base` at `--radius-lg`, which is 8.
   */
  background: color-mix(in srgb, var(--surface-layer) 60%, transparent);
  border: 0;
  border-radius: 6px;
  outline: none;
  transition: background-color 0.12s ease-in-out;
  /* 13, which is what opencode's palette field measures - and what its rows use. */
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.search-in:focus {
  background: var(--surface-layer);
}

.search-in::placeholder {
  color: var(--text-weaker);
}

.list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 1px;
  padding: 0 6px 6px;
  overflow-y: auto;
}

.empty {
  padding: 22px;
  color: var(--text-weak);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
  text-align: center;
}

.group {
  padding: 8px 12px 4px;
  color: var(--text-base);
  font-size: calc(13px * var(--ui-font-scale, 1));
  font-weight: 440;
}

.row {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 12px;
  text-align: start;
  border-radius: 6px;
}

/* Six per cent of white, the same overlay every selected row in the app uses,
   and no border - the row has none to colour now. */
.row.sel {
  background: rgb(255 255 255 / 0.06);
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 15px;
  flex-shrink: 0;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: calc(8.5px * var(--ui-font-scale, 1));
  font-weight: 530;
}

.title {
  flex: 1;
  overflow: hidden;
  color: var(--text-strong);
  font-size: calc(13px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title.mono {
  color: var(--text-base);
  font-family: var(--font-mono);
  font-size: calc(12.5px * var(--ui-font-scale, 1));
}

.hint {
  flex-shrink: 0;
  color: var(--text-weak);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.foot {
  display: flex;
  gap: 14px;
  padding: 7px 12px;
  color: var(--text-weak);
  background: var(--surface-raised-hover);
  border-top: 1px solid var(--border-weak);
  font-size: calc(10.5px * var(--ui-font-scale, 1));
}

.foot .kbd {
  margin-inline-end: 2px;
}
</style>
