<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue"
import { useApp } from "../stores/app"
import { sessionTitle, t } from "../lib/i18n"
import { projectName } from "../lib/project"
import { badgeStyle, fileBadge } from "../lib/filetype"

interface Command {
  id: string
  title: string
  /**
   * i18n key for the category this command belongs to. Not drawn here - the
   * palette heads the whole run with one "Commands" title - but it orders the
   * list and names the section the shortcuts page files it under.
   */
  group?: string
  hint?: string
  danger?: boolean
  /**
   * Kept out of the palette while staying bindable. Opening the palette from
   * within the palette is the case this exists for.
   */
  hidden?: boolean
  run: () => unknown
}

/**
 * What this palette is for.
 *
 * "all" is the command palette proper; the rest are the same surface opened on
 * one kind of thing, which is how the reference offers its file, session and
 * project pickers rather than building three dialogs.
 */
export type PaletteMode = "all" | "files" | "sessions" | "projects" | "messages"

const props = withDefaults(
  defineProps<{ commands: Command[]; mode?: PaletteMode; projects?: string[] }>(),
  { mode: "all", projects: () => [] },
)
const emit = defineEmits<{
  close: []
  file: [path: string]
  project: [directory: string]
  message: [messageID: string]
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
 * The project file list is fetched once per open and filtered locally. Asking
 * the backend on every keystroke would walk the tree again for no benefit -
 * the list is already capped server-side.
 */
async function loadFiles() {
  const directory = app.current?.directory
  if (!directory || !app.client) return
  const result = await app.client.request({ type: "file.list", directory })
  files.value = result.files.map((file) => file.path)
}

type Row =
  | { kind: "file"; id: string; path: string; rank: number }
  | { kind: "command"; id: string; command: Command; rank: number }
  | { kind: "session"; id: string; sessionID: string; title: string; hint?: string; rank: number }
  | { kind: "project"; id: string; directory: string; title: string; rank: number }
  | { kind: "message"; id: string; messageID: string; text: string; title: string; rank: number }

const FILE_LIMIT = 8

/**
 * How many of one kind to show when the palette is opened for that kind alone.
 *
 * Higher than the mixed list allows, because nothing else is competing for the
 * room - opening the file picker to eight entries would be a worse file picker
 * than the one it replaced.
 */
const SCOPED_LIMIT = 200

const scoped = computed(() => props.mode !== "all")

/** Says what is being searched, so a scoped palette explains itself. */
const placeholder = computed(() =>
  props.mode === "all" ? t("search.placeholder") : t(`search.in.${props.mode}`),
)

/** One flat, ranked list - the sections are only a rendering detail. */
const rows = computed<Row[]>(() => {
  const needle = query.value.trim()

  const fileRows = files.value
    .map((path) => ({ path, rank: score(path, needle) }))
    .filter((entry): entry is { path: string; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
    /*
     * Files are the long tail; in the mixed list they would bury everything
     * else, so they wait for a query. Asked for on their own, they are the
     * whole point and show straight away.
     */
    .slice(0, props.mode === "files" ? SCOPED_LIMIT : needle ? FILE_LIMIT : 0)
    .map<Row>((entry) => ({ kind: "file", id: `file:${entry.path}`, path: entry.path, rank: entry.rank }))

  const commandRows = props.commands
    .filter((command) => !command.hidden)
    .map((command) => ({ command, rank: score(command.title, needle) }))
    .filter((entry): entry is { command: Command; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .map<Row>((entry) => ({ kind: "command", id: entry.command.id, command: entry.command, rank: entry.rank }))

  // Closing a project hides it everywhere else, so its sessions have no
  // business still being reachable from here.
  const closed = new Set(app.config?.closedProjects ?? [])
  const sessionRows = app.sessions
    .filter((session) => session.id !== app.currentID && !closed.has(session.directory) && !session.archived)
    .map((session) => ({ session, rank: score(sessionTitle(session.title), needle) }))
    .filter((entry): entry is { session: (typeof app.sessions)[number]; rank: number } => entry.rank !== undefined)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, props.mode === "sessions" ? SCOPED_LIMIT : 8)
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

  /*
   * Only the questions, not the answers: forking replays a message, and an
   * assistant turn is not something that can be sent again.
   */
  const messageRows =
    props.mode === "messages"
      ? app.messages
          // The id travels with the text: a fork is made at a point in the
          // conversation, and the text alone cannot say which point.
          .flatMap((message) =>
            message.role === "user" && message.text.trim()
              ? [{ messageID: message.id, text: message.text.trim() }]
              : [],
          )
          .map((entry) => ({ ...entry, rank: score(entry.text, needle) }))
          .filter((entry): entry is { messageID: string; text: string; rank: number } => entry.rank !== undefined)
          .sort((a, b) => a.rank - b.rank)
          .slice(0, SCOPED_LIMIT)
          .map<Row>((entry, at) => ({
            kind: "message",
            id: `message:${at}`,
            messageID: entry.messageID,
            text: entry.text,
            title: entry.text.replace(/\s+/g, " ").slice(0, 120),
            rank: entry.rank,
          }))
      : []

  /*
   * A scoped palette shows only what it was opened for. The commands stay in
   * the mixed list, which is the one a bare Ctrl+K opens.
   */
  if (props.mode === "messages") return messageRows
  if (props.mode === "files") return fileRows
  if (props.mode === "sessions") return sessionRows
  if (props.mode === "projects") return projectRows
  return [...fileRows, ...commandRows, ...sessionRows]
})

/**
 * Heading to draw above each row, if any.
 *
 * One heading per kind, and nothing finer. Commands used to be broken into
 * their own sub-groups while browsing, but the reference draws a single
 * "Commands" heading over the whole run - measured with its palette open, where
 * five commands spanning five different categories sat under one title. The
 * category a command belongs to still matters; it just is not shown here.
 */
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
  command: "search.commands",
  session: "search.sessions",
  message: "search.messages",
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
  if (row.kind === "message") {
    emit("message", row.messageID)
    emit("close")
    return
  }
  if (row.kind === "file") emit("file", row.path)
  emit("close")
  await nextTick()
  if (row.kind === "command") await row.command.run()
  else if (row.kind === "session") await app.open(row.sessionID)
}

function onKeydown(event: KeyboardEvent) {
  /*
   * The same guard the composer carries, and for the same reason: this dialog
   * has a text field, and while an IME is composing, Enter picks a candidate
   * and the arrows walk the candidate list. Without it the first Enter of every
   * pinyin word ran whichever row happened to be highlighted, and Escape closed
   * the palette instead of cancelling the composition. Chromium reports keyCode
   * 229 for the same state on some layouts.
   */
  if (event.isComposing || event.keyCode === 229) return

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
    <div v-modal class="dialog palette" @keydown="onKeydown">
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
            :class="{ sel: index === active, danger: row.kind === 'command' && row.command.danger }"
            @mousemove="active = index"
            @click="choose(index)"
          >
            <template v-if="row.kind === 'file'">
              <span class="badge" :style="badgeStyle(fileBadge(row.path))">
                {{ fileBadge(row.path).label }}
              </span>
              <span class="title mono">{{ row.path }}</span>
            </template>

            <template v-else-if="row.kind === 'command'">
              <span class="title">{{ row.command.title }}</span>
              <span v-if="row.command.hint" class="hint">{{ row.command.hint }}</span>
            </template>

            <template v-else-if="row.kind === 'session'">
              <span class="title">{{ row.title }}</span>
              <span v-if="row.hint" class="hint">{{ row.hint }}</span>
            </template>

            <!-- A project is named once; the path underneath is the hint. -->
            <template v-else-if="row.kind === 'project'">
              <span class="title">{{ row.title }}</span>
              <span class="hint">{{ row.directory }}</span>
            </template>

            <!-- A question, trimmed to a line; the fork starts by asking it again. -->
            <template v-else>
              <span class="title">{{ row.title }}</span>
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
  font-size: 13px;
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
  font-size: 12.5px;
  text-align: center;
}

.group {
  padding: 8px 12px 4px;
  color: var(--text-base);
  font-size: 13px;
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

.row.danger .title {
  color: var(--error);
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
  font-size: 8.5px;
  font-weight: 500;
}

.title {
  flex: 1;
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title.mono {
  color: var(--text-base);
  font-family: var(--font-mono);
  font-size: 12.5px;
}

.hint {
  flex-shrink: 0;
  color: var(--text-weak);
  font-size: 13px;
}

.foot {
  display: flex;
  gap: 14px;
  padding: 7px 12px;
  color: var(--text-weak);
  background: var(--surface-raised-hover);
  border-top: 1px solid var(--border-weak);
  font-size: 10.5px;
}

.foot .kbd {
  margin-inline-end: 2px;
}
</style>
