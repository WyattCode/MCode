<script setup lang="ts">
import type { SessionInfo } from "@shared/protocol"
import { computed, ref, watch } from "vue"
import RowTitle from "./RowTitle.vue"
import { convoCard } from "../lib/convo-card"
import { useApp } from "../stores/app"
import { language, t } from "../lib/i18n"
import type { MenuItem } from "../lib/menu"
import ContextMenu from "./ContextMenu.vue"

/**
 * The 2.0 side column.
 *
 * Laid out from Xiaomi MiMo's window, measured over its debugging port: 256
 * wide on the deepest surface, a 44px row of window controls at the top that
 * also drags the window, the name, the main destinations as 240x38 rows, then
 * two collapsible lists - projects with their tasks under them, and recent
 * tasks - and the settings row at the foot. Only the layout and the numbers
 * are theirs; the icons, the name and the wording are MCode's own.
 *
 * MCode has no task outside a project - every session is opened in a folder -
 * so "Recent" is every task by when it last changed, across projects, which
 * is the view a project-less list would otherwise give.
 */
const props = defineProps<{
  /** Which page the pane is showing, so the row that opened it stays lit. */
  page?: string
  /** Folded to MiMo's 62px rail of icons, rather than taken off the screen. */
  collapsed?: boolean
  /** The conversations ticked in selection mode; absent when not in it. */
  selecting?: string[]
  /** Whether MiMo's priority filter is on: attention first, then the week by day. */
  priority?: boolean
  /** Whether back and forward have anywhere to go; MiMo dims them when not. */
  canBack?: boolean
  canForward?: boolean
}>()

const emit = defineEmits<{
  artifacts: []
  "toggle-priority": []
  "archive-all": []
  menu: [sessionID: string, x: number, y: number]
  projectMenu: [directory: string, x: number, y: number]
  select: [sessionID: string]
  batch: [action: "archive" | "move" | "delete" | "cancel"]
  newTask: []
  search: []
  back: []
  forward: []
  toggle: []
  browse: []
  open: [sessionID: string]
  rename: [sessionID: string]
  createIn: [directory: string]
  settings: []
}>()

const app = useApp()

/* MiMo pages Recent fifty at a time. */
const RECENT_PAGE = 50
const recentShown = ref(RECENT_PAGE)

const name = (directory: string) =>
  app.config?.projectNames?.[directory] || directory.split(/[\\/]/).filter(Boolean).pop() || directory

const title = (text?: string) => (text && text.trim() ? text : t("side.newTask"))

/* What a task row's pin and menu lie over at its end, as MiMo allows for them. */
const TITLE_COVER = 55

/* Pinned conversations rise to the top of whichever list they are in. */
const byPinned = (entries: typeof app.sessions) =>
  [...entries].sort((a, b) => Number(app.isPinned(b.id)) - Number(app.isPinned(a.id)))

const picking = computed(() => Array.isArray(props.selecting))
const ticked = (sessionID: string) => Boolean(props.selecting?.includes(sessionID))

/** In selection mode a row ticks rather than opens. */
function press(sessionID: string) {
  if (picking.value) emit("select", sessionID)
  else emit("open", sessionID)
}

/** Where the row's own menu opens from: the button, or the pointer. */
function openMenu(sessionID: string, event: MouseEvent) {
  const from = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  const x = event.clientX || (from ? Math.round(from.left) : 0)
  const y = event.clientY || (from ? Math.round(from.bottom + 4) : 0)
  emit("menu", sessionID, x, y)
}

/* The project row's menu, from a right-click or from its own button. */
function openProjectMenu(directory: string, event: MouseEvent) {
  const from = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  const x = event.clientX || (from ? Math.round(from.left) : 0)
  const y = event.clientY || (from ? Math.round(from.bottom + 4) : 0)
  emit("projectMenu", directory, x, y)
}

/* Pinned from that menu: a pinned project heads the list, as a pinned conversation does. */
const pinnedProject = (directory: string) => (app.config?.pinnedProjects ?? []).includes(directory)

const projects = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  const byDirectory = new Map<string, { directory: string; updated: number; sessions: typeof app.sessions }>()
  for (const session of app.sessions) {
    // A folder made for a task with no project is not a project; Recent has it.
    if (session.archived || session.scratch || closed.has(session.directory)) continue
    const entry = byDirectory.get(session.directory) ?? { directory: session.directory, updated: 0, sessions: [] }
    entry.updated = Math.max(entry.updated, session.updated)
    entry.sessions.push(session)
    byDirectory.set(session.directory, entry)
  }
  return [...byDirectory.values()]
    .map((entry) => ({ ...entry, sessions: [...entry.sessions].sort((a, b) => b.updated - a.updated) }))
    .sort((a, b) => Number(pinnedProject(b.directory)) - Number(pinnedProject(a.directory)) || b.updated - a.updated)
})

/*
 * What is not already above it.
 *
 * Every session belongs to some directory, so listing them all here repeated
 * the whole of Projects a second time - the open task appeared twice in a
 * column short enough to see both at once. MiMo's Recent holds what its
 * project list does not, and says "no tasks" when that is nothing. A session
 * whose project has been closed still belongs here: it is the only place left
 * that can reach it.
 */
/* How Recent is ordered, chosen from its heading's menu and remembered, as MiMo does. */
const SORT_KEY = "mcode.recentSort"
const recentSort = ref<"recent" | "name">(
  (() => {
    try {
      return localStorage.getItem(SORT_KEY) === "name" ? "name" : "recent"
    } catch {
      return "recent"
    }
  })(),
)

function setRecentSort(mode: "recent" | "name") {
  recentSort.value = mode
  try {
    localStorage.setItem(SORT_KEY, mode)
  } catch {}
}

const recentAll = computed(() => {
  const listed = new Set(projects.value.map((project) => project.directory))
  const rows = app.sessions.filter((session) => !session.archived && !listed.has(session.directory))
  return recentSort.value === "name"
    ? rows.sort((a, b) => title(a.title).localeCompare(title(b.title), language.value))
    : rows.sort((a, b) => b.updated - a.updated)
})

/*
 * A page at a time, stretched as MiMo stretches it so that the open
 * conversation and any running one are never left below the fold.
 */
const recent = computed(() => {
  const all = recentAll.value
  const reach = (sessionID?: string) => {
    const at = sessionID ? all.findIndex((session) => session.id === sessionID) : -1
    return at < 0 ? 0 : Math.ceil((at + 1) / RECENT_PAGE) * RECENT_PAGE
  }
  let running = 0
  for (const sessionID of app.running) running = Math.max(running, reach(sessionID))
  return all.slice(0, Math.min(all.length, Math.max(recentShown.value, reach(app.currentID), running)))
})

const recentLeft = computed(() => recentAll.value.length - recent.value.length)

/* Recent's heading menu: archive everything, and how the list is ordered. */
const recentMenu = ref<{ x: number; y: number }>()

const recentMenuItems = computed<MenuItem[]>(() => [
  { key: "archive", label: t("side.archiveAll"), icon: "M2.2 3h11.6v2.6H2.2zM3.2 5.6h9.6V13H3.2zM6.4 8.2h3.2" },
  { key: "sort", label: t("side.sortBy"), heading: true, divided: true },
  { key: "sort-recent", label: t("side.sortRecent"), checked: recentSort.value === "recent" },
  { key: "sort-name", label: t("side.sortName"), checked: recentSort.value === "name" },
])

function openRecentMenu(event: MouseEvent) {
  const from = (event.currentTarget as HTMLElement).getBoundingClientRect()
  recentMenu.value = { x: Math.round(from.left), y: Math.round(from.bottom + 4) }
}

function pickRecentMenu(key: string) {
  recentMenu.value = undefined
  if (key === "archive") emit("archive-all")
  else if (key === "sort-recent") setRecentSort("recent")
  else if (key === "sort-name") setRecentSort("name")
}

/**
 * Every conversation by when it was last touched, in days.
 *
 * One list holding two kinds of thing - a day's heading and a conversation -
 * so the column can render it with the row markup it already has instead of a
 * fourth copy of it. The project is carried alongside because this list has no
 * tree above it to say which one a conversation came from.
 */
interface TimelineEntry {
  head?: string
  /** A section's own heading row inside the priority view. */
  section?: "priority" | "pinned"
  session?: SessionInfo
  note?: string
  /** Which part of the list it belongs to; a pinned row can be in two. */
  group?: string
}

/* Keeps an entry literal typed as an entry, so its section stays a union. */
const entry = (value: TimelineEntry) => value

const DAY = 24 * 60 * 60 * 1000

/*
 * A day's heading as MiMo words it: today, yesterday, and before that the
 * weekday's name. The list reaches back one week, so a weekday is never
 * ambiguous.
 */
function dayLabel(at: number): string {
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (at >= midnight) return t("side.today")
  if (at >= midnight - DAY) return t("side.yesterday")
  return new Intl.DateTimeFormat(language.value, { weekday: "long" }).format(new Date(at))
}

/* What a conversation is waiting on, most urgent first. */
type Attention = "waiting" | "unread" | "active"
const RANK: Record<Attention, number> = { waiting: 0, unread: 1, active: 2 }

function attentionOf(sessionID: string): Attention | undefined {
  if (app.pendingPermissions.has(sessionID)) return "waiting"
  if (app.unseen.has(sessionID) || app.failed(sessionID)) return "unread"
  if (app.running.has(sessionID)) return "active"
  return undefined
}

/*
 * The live mark at the end of a row, as MiMo keeps one: a pill when a
 * conversation is waiting for your confirmation, a spinner while its turn runs,
 * a dot when it finished (or failed) while you were elsewhere. One mark per row,
 * the most urgent. The conversation on screen never says it is waiting - its own
 * prompt is already in front of you.
 */
type RowStatus = "waiting" | "running" | "unread"
const STATUS_RANK: Record<RowStatus, number> = { waiting: 0, running: 1, unread: 2 }

function statusOf(sessionID: string): RowStatus | undefined {
  if (app.pendingPermissions.has(sessionID) && app.currentID !== sessionID) return "waiting"
  if (app.running.has(sessionID)) return "running"
  if (app.unseen.has(sessionID) || app.failed(sessionID)) return "unread"
  return undefined
}

/** A collapsed project speaks for the conversations it is hiding. */
function projectStatus(sessions: { id: string }[]): RowStatus | undefined {
  let best: RowStatus | undefined
  for (const session of sessions) {
    const status = statusOf(session.id)
    if (status && (!best || STATUS_RANK[status] < STATUS_RANK[best])) best = status
  }
  return best
}

/*
 * The priority view's first section: every conversation that wants something
 * - a question to answer, a turn that finished or failed while you were away,
 * a turn still running - the most urgent first and the newest within that.
 */
const attention = computed(() =>
  app.sessions
    .filter((session) => !session.archived && attentionOf(session.id))
    .sort((a, b) => RANK[attentionOf(a.id)!] - RANK[attentionOf(b.id)!] || b.updated - a.updated),
)

/* Whether the priority view also lists what is pinned; remembered, as MiMo does. */
const SHOW_PINNED_KEY = "mcode.priorityShowPinned"
const showPinned = ref(
  (() => {
    try {
      return localStorage.getItem(SHOW_PINNED_KEY) === "true"
    } catch {
      return false
    }
  })(),
)

function toggleShowPinned() {
  showPinned.value = !showPinned.value
  try {
    localStorage.setItem(SHOW_PINNED_KEY, String(showPinned.value))
  } catch {}
}

const pinnedSessions = computed(() =>
  app.sessions.filter((session) => !session.archived && app.isPinned(session.id)).sort((a, b) => b.updated - a.updated),
)

/* Named apart from the prop of the same idea: a local const would shadow it
   in the template, and `aria-pressed` would be handed an array. */
const byDay = computed<TimelineEntry[]>(() => {
  // What the sections above already hold is not listed a second time.
  const held = new Set(attention.value.map((session) => session.id))
  if (showPinned.value) for (const session of pinnedSessions.value) held.add(session.id)
  const since = Date.now() - 7 * DAY
  const rows: TimelineEntry[] = []
  let heading = ""
  for (const session of [...app.sessions]
    .filter((item) => !item.archived && !held.has(item.id) && item.updated >= since)
    .sort((a, b) => b.updated - a.updated)) {
    const label = dayLabel(session.updated)
    if (label !== heading) {
      heading = label
      rows.push({ head: label })
    }
    rows.push({ session, note: name(session.directory) })
  }
  return rows
})

/* The priority view, top to bottom: attention, pinned when asked for, the week. */
const priorityList = computed<TimelineEntry[]>(() => [
  entry({ section: "priority", group: "priority" }),
  ...attention.value.map((session) => entry({ session, note: name(session.directory), group: "priority" })),
  ...(showPinned.value
    ? [
        entry({ section: "pinned", group: "pinned" }),
        ...pinnedSessions.value.map((session) => entry({ session, note: name(session.directory), group: "pinned" })),
      ]
    : []),
  ...byDay.value.map((row) => ({ ...row, group: "day" })),
])

/* What the one list renders: the priority view, or Recent as it always was. */
const listed = computed<TimelineEntry[]>(() =>
  props.priority ? priorityList.value : byPinned(recent.value).map((session) => ({ session, group: "recent" })),
)

/* The priority section's menu, opened from its heading's own button. */
const priorityMenu = ref<{ x: number; y: number }>()

const priorityMenuItems = computed<MenuItem[]>(() => [
  { key: "pinned", label: t("side.priorityPinned"), checked: showPinned.value },
  { key: "read", label: t("side.markAllRead"), divided: true },
  { key: "archive", label: t("side.archiveAll") },
])

function openPriorityMenu(event: MouseEvent) {
  const from = (event.currentTarget as HTMLElement).getBoundingClientRect()
  priorityMenu.value = { x: Math.round(from.left), y: Math.round(from.bottom + 4) }
}

function pickPriorityMenu(key: string) {
  priorityMenu.value = undefined
  if (key === "pinned") toggleShowPinned()
  else if (key === "read") app.markAllRead()
  else if (key === "archive") emit("archive-all")
}

/*
 * The footer's menu, where MiMo keeps its account menu: settings, then quitting
 * the app below a rule. MCode has no account, so the profile, usage and sign-out
 * rows have nothing to stand for.
 */
const footMenu = ref<{ x: number; y: number }>()

const footMenuItems = computed<MenuItem[]>(() => [
  {
    key: "settings",
    label: t("rail.settings"),
    hint: "Ctrl+,",
    icon: "M8 6a2 2 0 1 1 0 4a2 2 0 1 1 0-4M8 2.5v1.5M8 12v1.5M2.5 8H4M12 8h1.5M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M4.1 11.9l1.1-1.1M10.8 5.2l1.1-1.1",
  },
  { key: "quit", label: t("side.quitApp"), divided: true, icon: "M8 2.5v5M4.8 4.6a4.8 4.8 0 1 0 6.4 0" },
])

/** Opens above the row, since the row sits at the bottom of the window: y is the menu's bottom edge. */
function openFootMenu(event: MouseEvent) {
  const from = (event.currentTarget as HTMLElement).getBoundingClientRect()
  footMenu.value = { x: Math.round(from.left), y: Math.round(from.top - 4) }
}

function pickFootMenu(key: string) {
  footMenu.value = undefined
  if (key === "settings") emit("settings")
  else if (key === "quit") window.mcode.quitApp()
}

/*
 * The three answers, in the order the button walks them. "Follow the machine"
 * leads because it is the default, and a reader who presses once is most
 * likely trying to pin down what the machine is currently doing.
 */
const SCHEMES = ["system", "light", "dark"] as const

const scheme = computed(() => app.config?.theme ?? "system")

const themeLabel = computed(() =>
  t(
    scheme.value === "light"
      ? "set.themeLight"
      : scheme.value === "dark"
        ? "set.themeDark"
        : "set.themeSystem",
  ),
)

function cycleTheme() {
  const next = SCHEMES[(SCHEMES.indexOf(scheme.value) + 1) % SCHEMES.length]
  app.patchConfig({ theme: next })
}

const projectsOpen = ref(true)
const recentOpen = ref(true)
/** Which projects show their tasks. The one holding the open task always does. */
const expanded = ref(new Set<string>())
const isExpanded = (directory: string) =>
  expanded.value.has(directory) || app.current?.directory === directory
function toggleProject(directory: string) {
  const next = new Set(expanded.value)
  if (next.has(directory)) next.delete(directory)
  else next.add(directory)
  expanded.value = next
  // Folding or opening a project puts its list back to the first few, as MiMo does.
  if (allTasks.value.has(directory)) {
    const shown = new Set(allTasks.value)
    shown.delete(directory)
    allTasks.value = shown
  }
}

/* MiMo lists five tasks under a project until asked for the rest. */
const PROJECT_TASKS = 5
const allTasks = ref(new Set<string>())
const tasksOf = (project: { directory: string; sessions: typeof app.sessions }) => {
  const rows = byPinned(project.sessions)
  return allTasks.value.has(project.directory) ? rows : rows.slice(0, PROJECT_TASKS)
}
function showAllTasks(directory: string) {
  allTasks.value = new Set(allTasks.value).add(directory)
}

/*
 * MiMo pages its projects: five, then ten, then ten more a press, with a way
 * back to five once past the first page. Selection shows them all.
 */
const PROJECT_PAGE = 5
const PROJECT_STEP = 10
const projectsShown = ref(PROJECT_PAGE)
const shownProjects = computed(() => (picking.value ? projects.value : projects.value.slice(0, projectsShown.value)))
const projectsLeft = computed(() => projects.value.length - shownProjects.value.length)
const projectsPaged = computed(() => !picking.value && projectsShown.value > PROJECT_PAGE && projects.value.length > PROJECT_PAGE)
function moreProjects() {
  const shown = projectsShown.value
  projectsShown.value = Math.min(projects.value.length, shown <= PROJECT_PAGE ? PROJECT_STEP : shown + PROJECT_STEP)
}
watch(picking, (on) => {
  if (on) projectsShown.value = PROJECT_PAGE
})
</script>

<template>
  <aside class="side" :class="{ rail: collapsed }">
    <!--
      Folded, MiMo keeps the column's controls just past the rail: the toggle
      three in from its edge, then back, forward and search.
    -->
    <div v-if="collapsed" class="rail-tools">
      <button class="ico" :aria-label="t('side.toggle')" v-tip="{ label: t('side.toggle'), hint: 'Ctrl+B', placement: 'bottom' }" @click="emit('toggle')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="2.5" width="19" height="19" rx="4" />
          <path d="M9 2.5v19" />
        </svg>
      </button>
      <button class="ico" :disabled="!canBack" :aria-label="t('title.back')" v-tip="{ label: t('title.back'), hint: 'Ctrl+[', placement: 'bottom' }" @click="emit('back')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19.5 12h-15M11 5.5 4.5 12l6.5 6.5" />
        </svg>
      </button>
      <button class="ico" :disabled="!canForward" :aria-label="t('title.forward')" v-tip="{ label: t('title.forward'), hint: 'Ctrl+]', placement: 'bottom' }" @click="emit('forward')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4.5 12h15M13 5.5l6.5 6.5-6.5 6.5" />
        </svg>
      </button>
      <button class="ico" :aria-label="t('side.search')" v-tip="{ label: t('side.search'), hint: 'Ctrl+K', placement: 'bottom' }" @click="emit('search')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.9" />
          <path d="m15.6 15.6 4.8 4.8" />
        </svg>
      </button>
    </div>
    <div class="top" :class="{ mac: app.platform === 'darwin' }">
      <button class="ico" :aria-label="t('side.toggle')" v-tip="{ label: t('side.toggle'), hint: 'Ctrl+B', placement: 'bottom' }" @click="emit('toggle')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="2.5" width="19" height="19" rx="4" />
          <path d="M9 2.5v19" />
        </svg>
      </button>
      <button class="ico" :disabled="!canBack" :aria-label="t('title.back')" v-tip="{ label: t('title.back'), hint: 'Ctrl+[', placement: 'bottom' }" @click="emit('back')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19.5 12h-15M11 5.5 4.5 12l6.5 6.5" />
        </svg>
      </button>
      <button class="ico" :disabled="!canForward" :aria-label="t('title.forward')" v-tip="{ label: t('title.forward'), hint: 'Ctrl+]', placement: 'bottom' }" @click="emit('forward')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4.5 12h15M13 5.5l6.5 6.5-6.5 6.5" />
        </svg>
      </button>
      <button class="ico" :aria-label="t('side.search')" v-tip="{ label: t('side.search'), hint: 'Ctrl+K', placement: 'bottom' }" @click="emit('search')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.9" />
          <path d="m15.6 15.6 4.8 4.8" />
        </svg>
      </button>
      <!--
        MiMo's priority filter, at the far end of this row as MiMo has it: the
        column led by what wants attention, then the rest of the week by day.
      -->
      <button
        class="ico bell"
        :class="{ on: priority }"
        :aria-pressed="Boolean(priority)"
        :aria-label="t(priority ? 'side.priorityOff' : 'side.priorityOn')"
        v-tip="{ label: t(priority ? 'side.priorityOff' : 'side.priorityOn'), hint: 'Ctrl+Alt+U', placement: 'bottom' }"
        @click="emit('toggle-priority')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6.2 16.6V11a5.8 5.8 0 0 1 11.6 0v5.6l1.8 1.9H4.4z" />
          <path d="M10 21.2a2.1 2.1 0 0 0 4 0" />
        </svg>
      </button>
    </div>

    <div class="brand">
      <span class="brand-name">MCode</span>
      <span class="badge">2.0</span>
    </div>

    <nav class="nav">
      <button class="row" v-tip="collapsed ? { label: t('side.newTask'), placement: 'right' } : ''" @click="emit('newTask')">
        <svg class="row-ico" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7" stroke="currentColor" />
          <path d="M10 6.5V13.5M6.5 10H13.5" stroke="currentColor" stroke-linecap="square" />
        </svg>
        <span class="row-label">{{ t("side.newTask") }}</span>
      </button>
      <!-- MiMo's plugins row sits between these two; the user asked for it hidden. -->
      <button
        class="row"
        :class="{ on: page === 'artifacts' }"
        v-tip="collapsed ? { label: t('side.artifacts'), placement: 'right' } : ''"
        @click="emit('artifacts')"
      >
        <svg class="row-ico" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M2.9 11.5h3.4l1 1.9h5.4l1-1.9h3.4M2.9 11.5 5 4.6h10l2.1 6.9M2.9 11.5v3.9h14.2v-3.9"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
        </svg>
        <span class="row-label">{{ t("side.artifacts") }}</span>
      </button>
    </nav>

    <!--
      The bar selection mode brings with it: what is chosen, and the three
      things worth doing to several conversations at once.
    -->
    <div v-if="picking" class="batch">
      <span class="batch-count">{{ t("batch.selected", { n: String(selecting?.length ?? 0) }) }}</span>
      <button class="batch-act" :disabled="!selecting?.length" @click="emit('batch', 'archive')">{{ t("common.archive") }}</button>
      <button class="batch-act" :disabled="!selecting?.length" @click="emit('batch', 'move')">{{ t("menu.moveToProject") }}</button>
      <button class="batch-act danger" :disabled="!selecting?.length" @click="emit('batch', 'delete')">{{ t("common.delete") }}</button>
      <button class="batch-act" @click="emit('batch', 'cancel')">{{ t("common.cancel") }}</button>
    </div>

    <div class="lists">
      <div v-if="!priority" class="section">
        <button class="section-head" :aria-expanded="projectsOpen" @click="projectsOpen = !projectsOpen">
          <span>{{ t("side.projects") }}</span>
          <svg class="chev" :class="{ shut: !projectsOpen }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
          </svg>
        </button>
        <button class="ico add" :aria-label="t('side.newProject')" v-tip="{ label: t('side.newProject'), hint: 'Ctrl+O' }" @click="emit('browse')">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 5V15M5 10H15" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </button>
      </div>
      <template v-if="projectsOpen && !priority">
        <template v-for="project in shownProjects" :key="project.directory">
          <div
            class="row project"
            :class="{ on: app.current?.directory === project.directory && !isExpanded(project.directory) }"
            @contextmenu.prevent="openProjectMenu(project.directory, $event)"
          >
            <button class="project-toggle" v-tip="{ label: project.directory, placement: 'right' }" @click="toggleProject(project.directory)">
              <!-- Open while its tasks are listed under it, as MiMo draws an expanded project. -->
              <svg
                v-if="isExpanded(project.directory)"
                class="row-ico"
                data-folder="open"
                width="18"
                height="18"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <path d="M3.5 15V5.5H8L9.5 7H15V9" stroke="currentColor" stroke-linejoin="round" />
                <path d="M3.5 15 5.6 9H17.4L15.3 15H3.5Z" stroke="currentColor" stroke-linejoin="round" />
              </svg>
              <svg v-else class="row-ico" data-folder="closed" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M3.5 5.5H8L9.5 7H16.5V15H3.5V5.5Z" stroke="currentColor" stroke-linejoin="round" />
              </svg>
              <span class="row-label plain">{{ name(project.directory) }}</span>
              <svg v-if="pinnedProject(project.directory)" class="pin" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
              <span
                v-if="!isExpanded(project.directory) && projectStatus(project.sessions)"
                class="row-status"
                :data-status="projectStatus(project.sessions)"
              >
                <span v-if="projectStatus(project.sessions) === 'running'" class="status-spin" aria-hidden="true" />
                <span v-else-if="projectStatus(project.sessions) === 'unread'" class="status-dot" aria-hidden="true" />
                <span v-else class="status-pill" :title="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
              </span>
            </button>
            <!--
              MiMo's pair on a project row: its menu, then a new task in it. Laid
              over the row's end on hover, as a task row's are, so the project's
              name has the whole row until then.
            -->
            <span class="row-actions">
              <button
                class="row-menu"
                :aria-label="t('side.projectOptions')"
                v-tip="{ label: t('side.projectOptions') }"
                @click.stop="openProjectMenu(project.directory, $event)"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="3" cy="8" r="1.1" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                  <circle cx="13" cy="8" r="1.1" fill="currentColor" />
                </svg>
              </button>
              <button class="ico inline" :aria-label="t('side.newTask')" v-tip="{ label: t('side.newTask') }" @click="emit('createIn', project.directory)">
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M10 5V15M5 10H15" stroke="currentColor" stroke-linecap="square" />
                </svg>
              </button>
            </span>
          </div>
          <template v-if="isExpanded(project.directory)">
            <div
              v-for="session in tasksOf(project)"
              :key="session.id"
              class="row task"
              :class="{ on: app.currentID === session.id }"
              @contextmenu.prevent="openMenu(session.id, $event)"
            >
              <button class="row-open" @click="press(session.id)">
                <span v-if="picking" class="tick" :class="{ on: ticked(session.id) }" aria-hidden="true">
                  <svg v-if="ticked(session.id)" width="11" height="11" viewBox="0 0 16 16" fill="none">
                    <path d="M3.5 8.2 6.4 11.2 12.5 4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
                <svg v-if="app.isPinned(session.id)" class="pin" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                </svg>
                <RowTitle
                  class="row-label task-label"
                  v-tip="picking ? '' : { card: convoCard(session, app.config?.projectNames), placement: 'right' }"
                  :text="title(session.title)"
                  :cover="picking ? 0 : TITLE_COVER"
                  @rename="!picking && emit('rename', session.id)"
                />
                <span v-if="statusOf(session.id)" class="row-status" :data-status="statusOf(session.id)">
                  <span v-if="statusOf(session.id) === 'running'" class="status-spin" aria-hidden="true" />
                  <span v-else-if="statusOf(session.id) === 'unread'" class="status-dot" aria-hidden="true" />
                  <span v-else class="status-pill" :title="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
                </span>
              </button>
              <span class="row-actions">
                <button class="row-menu" :aria-label="t('session.options')" @click.stop="openMenu(session.id, $event)">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="3" cy="8" r="1.1" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                    <circle cx="13" cy="8" r="1.1" fill="currentColor" />
                  </svg>
                </button>
                <button
                  class="row-pin"
                  :class="{ on: app.isPinned(session.id) }"
                  :aria-label="t(app.isPinned(session.id) ? 'menu.unpin' : 'menu.pin')"
                  @click.stop="app.togglePinned(session.id)"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                  </svg>
                </button>
              </span>
            </div>
            <button
              v-if="project.sessions.length > PROJECT_TASKS && !allTasks.has(project.directory)"
              class="project-show-all"
              :data-project-show-all="project.directory"
              aria-expanded="false"
              @click.stop="showAllTasks(project.directory)"
            >
              {{ t("side.showAllTasks") }}
            </button>
          </template>
        </template>
        <div v-if="!picking && (projectsLeft > 0 || projectsPaged)" class="projects-pages" data-projects-pagination>
          <button v-if="projectsLeft > 0" class="pages-more" data-projects-show-more :aria-expanded="projectsPaged" @click="moreProjects">
            {{ projectsPaged ? t("side.moreProjectsLeft", { count: projectsLeft }) : t("side.moreProjects") }}
          </button>
          <button v-if="projectsPaged" class="pages-collapse" data-projects-collapse @click="projectsShown = PROJECT_PAGE">
            {{ t("side.collapseProjects") }}
          </button>
        </div>
      </template>

      <div v-if="!priority" class="section recent-head" :class="{ held: Boolean(recentMenu) }">
        <button class="section-head" :aria-expanded="recentOpen" @click="recentOpen = !recentOpen">
          <span>{{ t("side.recent") }}</span>
          <svg class="chev" :class="{ shut: !recentOpen }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
          </svg>
        </button>
        <!-- MiMo's two heading actions, out of sight until the heading is hovered. -->
        <span class="sec-actions">
          <button
            class="ico add recent-more"
            :aria-label="t('side.priorityMore')"
            v-tip="{ label: t('side.priorityMore') }"
            @click.stop="openRecentMenu"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="3" cy="8" r="1.1" fill="currentColor" />
              <circle cx="8" cy="8" r="1.1" fill="currentColor" />
              <circle cx="13" cy="8" r="1.1" fill="currentColor" />
            </svg>
          </button>
          <button
            class="ico add recent-new"
            :aria-label="t('side.newTask')"
            v-tip="{ label: t('side.newTask'), hint: 'Ctrl+N' }"
            @click.stop="emit('newTask')"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 5V15M5 10H15" stroke="currentColor" stroke-linecap="square" />
            </svg>
          </button>
        </span>
      </div>
      <template v-if="priority || recentOpen">
        <div v-if="!listed.length" class="empty">{{ t("side.noTasks") }}</div>
        <template v-for="(entry, index) in listed" :key="`${entry.group}-${entry.session?.id ?? entry.section ?? entry.head ?? index}`">
        <div v-if="entry.section" class="section priority-head">
          <span class="section-head">{{ t(entry.section === "priority" ? "side.priority" : "side.priorityPinned") }}</span>
          <button
            v-if="entry.section === 'priority'"
            class="ico add more"
            :aria-label="t('side.priorityMore')"
            v-tip="{ label: t('side.priorityMore') }"
            @click.stop="openPriorityMenu"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="3" cy="8" r="1.1" fill="currentColor" />
              <circle cx="8" cy="8" r="1.1" fill="currentColor" />
              <circle cx="13" cy="8" r="1.1" fill="currentColor" />
            </svg>
          </button>
        </div>
        <div v-else-if="entry.head" class="day-head">{{ entry.head }}</div>
        <div
          v-else-if="entry.session"
          class="row task recent"
          :class="{ on: app.currentID === entry.session.id, noted: Boolean(entry.note) }"
          @contextmenu.prevent="openMenu(entry.session.id, $event)"
        >
          <button class="row-open" @click="press(entry.session.id)">
            <span v-if="picking" class="tick" :class="{ on: ticked(entry.session.id) }" aria-hidden="true">
              <svg v-if="ticked(entry.session.id)" width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M3.5 8.2 6.4 11.2 12.5 4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <svg v-if="app.isPinned(entry.session.id)" class="pin" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
            <span class="stack">
              <RowTitle
                class="row-label task-label"
                v-tip="picking ? '' : { card: convoCard(entry.session, app.config?.projectNames), placement: 'right' }"
                :text="title(entry.session.title)"
                :cover="picking ? 0 : TITLE_COVER"
                @rename="!picking && emit('rename', entry.session.id)"
              />
              <!-- Which project it is in, which the tree above would have said. -->
              <span v-if="entry.note" class="row-note">{{ entry.note }}</span>
            </span>
            <span v-if="statusOf(entry.session.id)" class="row-status" :data-status="statusOf(entry.session.id)">
              <span v-if="statusOf(entry.session.id) === 'running'" class="status-spin" aria-hidden="true" />
              <span v-else-if="statusOf(entry.session.id) === 'unread'" class="status-dot" aria-hidden="true" />
              <span v-else class="status-pill" :title="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
            </span>
          </button>
          <span class="row-actions">
            <button class="row-menu" :aria-label="t('session.options')" @click.stop="openMenu(entry.session.id, $event)">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="3" cy="8" r="1.1" fill="currentColor" />
                <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                <circle cx="13" cy="8" r="1.1" fill="currentColor" />
              </svg>
            </button>
            <button
              class="row-pin"
              :class="{ on: app.isPinned(entry.session.id) }"
              :aria-label="t(app.isPinned(entry.session.id) ? 'menu.unpin' : 'menu.pin')"
              @click.stop="app.togglePinned(entry.session.id)"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
            </button>
          </span>
        </div>
        </template>
        <button v-if="!priority && recentLeft > 0" class="show-more" @click="recentShown += RECENT_PAGE">
          {{ t("side.showMore", { count: recentLeft }) }}
        </button>
      </template>
    </div>

    <div class="foot">
      <!--
        The scheme, one press away. It is in the appearance settings too - this
        is the same choice, not a second one, and it shows which of the three
        answers is in force rather than only offering to change it.
      -->
      <button
        class="row theme"
        :aria-label="themeLabel"
        v-tip="{ label: themeLabel, placement: 'top' }"
        @click="cycleTheme"
      >
        <span class="avatar" aria-hidden="true">
          <!-- Follow the machine: half lit, half not. -->
          <svg v-if="scheme === 'system'" width="16" height="16" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="6" stroke="currentColor" />
            <path d="M10 4a6 6 0 0 0 0 12z" fill="currentColor" />
          </svg>
          <!-- Light: the sun. -->
          <svg v-else-if="scheme === 'light'" width="16" height="16" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="3.4" stroke="currentColor" />
            <path
              d="M10 3v2M10 15v2M3 10h2M15 10h2M5.05 5.05l1.4 1.4M13.55 13.55l1.4 1.4M5.05 14.95l1.4-1.4M13.55 6.45l1.4-1.4"
              stroke="currentColor"
              stroke-linecap="round"
            />
          </svg>
          <!-- Dark: the moon. -->
          <svg v-else width="16" height="16" viewBox="0 0 20 20" fill="none">
            <path
              d="M15.5 12.2A6.3 6.3 0 0 1 7.8 4.5a6.3 6.3 0 1 0 7.7 7.7z"
              stroke="currentColor"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="row-label plain">{{ themeLabel }}</span>
      </button>

      <button
        class="row foot-menu"
        :aria-expanded="Boolean(footMenu)"
        aria-haspopup="menu"
        v-tip="collapsed ? { label: t('rail.settings'), placement: 'right' } : ''"
        @click="openFootMenu"
      >
        <span class="avatar" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="2.5" stroke="currentColor" />
            <path d="M10 3.5V5.5M10 14.5V16.5M3.5 10H5.5M14.5 10H16.5M5.4 5.4L6.8 6.8M13.2 13.2L14.6 14.6M5.4 14.6L6.8 13.2M13.2 6.8L14.6 5.4" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </span>
        <span class="row-label plain">{{ t("rail.settings") }}</span>
      </button>
    </div>
    <ContextMenu
      v-if="footMenu"
      :x="footMenu.x"
      :y="footMenu.y"
      :items="footMenuItems"
      above
      @pick="pickFootMenu"
      @close="footMenu = undefined"
    />
    <ContextMenu
      v-if="priorityMenu"
      :x="priorityMenu.x"
      :y="priorityMenu.y"
      :items="priorityMenuItems"
      @pick="pickPriorityMenu"
      @close="priorityMenu = undefined"
    />
    <ContextMenu
      v-if="recentMenu"
      :x="recentMenu.x"
      :y="recentMenu.y"
      :items="recentMenuItems"
      @pick="pickRecentMenu"
      @close="recentMenu = undefined"
    />
  </aside>
</template>

<style scoped>
/* Numbers from Xiaomi MiMo's side column, measured in CSS pixels. */
.side {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 256px;
  height: 100%;
  background: var(--surface-base);
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  user-select: none;
}

/* The window-control row: 44 tall, buttons 24x24 at 32px pitch. It drags the
   window; the buttons opt out.
   MiMo starts the row at x=65; MCode keeps it to the left on purpose, the 17px
   glyphs lining up with the brand and the destination icons at x=22. Only on
   macOS does it start at 65, clear of the traffic lights. */
.top {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  gap: 8px;
  height: 44px;
  padding-block: 13px 0;
  padding-inline: 18px 8px;
  -webkit-app-region: drag;
}

.top.mac {
  padding-inline-start: 65px;
}

.ico {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--text-base);
  border-radius: 7px;
  -webkit-app-region: no-drag;
  transition: background var(--motion-fast, 0.12s), color var(--motion-fast, 0.12s);
}

.ico:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * The title-bar row in MiMo's icon colour: near the strongest text on a dark
 * ground, and that text at 60% on a light one. Its glyphs are drawn on a 24
 * grid with a 2-unit round stroke shown at 14px, the bell at 16 - about a
 * 1.2px line, where the old 17px icons on a 20 grid came out near 0.85.
 */
.top .ico,
.rail-tools .ico {
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .top .ico,
  :root:not([data-theme="light"]) .rail-tools .ico {
    color: var(--text-strong);
  }
}

:root[data-theme="dark"] .top .ico,
:root[data-theme="dark"] .rail-tools .ico {
  color: var(--text-strong);
}

/* Nowhere to go back or forward to: MiMo leaves the arrow at a third, and it does nothing. */
.ico:disabled,
.ico:disabled:hover {
  color: var(--text-base);
  background: transparent;
  cursor: default;
  opacity: 0.35;
}

/* The name row: 28 tall, 14 in from the 8px inset. */
.brand {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  height: 28px;
  /* 4px below the controls row: everything under it moves down with it. */
  margin: 4px 8px 0;
  padding-inline-start: 14px;
}

.brand-name {
  color: var(--text-strong);
  font-size: calc(19px * var(--ui-font-scale, 1));
  font-weight: 600;
  letter-spacing: 0.2px;
}

.badge {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 7px;
  color: #ffffff;
  background: #2a3f52;
  border-radius: 999px;
  font-size: calc(10px * var(--ui-font-scale, 1));
  font-weight: 600;
  letter-spacing: 0.14px;
}

.nav {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 2px;
  margin: 8px 8px 0;
}

/* A destination: 240x38, radius 8, icon 14 in, label 14 after it. */
.row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 38px;
  padding: 0 14px;
  color: var(--text-strong);
  border-radius: 8px;
  text-align: start;
  transition: background var(--motion-fast, 0.12s);
}

.row:hover {
  background: var(--surface-hover);
}

.row.on {
  background: var(--surface-selected);
}

.row-ico {
  flex-shrink: 0;
}

.row-label {
  overflow: hidden;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-label.plain {
  font-weight: 400;
  line-height: 22px;
}

.lists {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  margin: 0 8px;
  overflow-y: auto;
}

/* A list heading: 12/500 in the secondary colour, 9 in from the inset. */
.section {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  margin-top: 36px;
  padding: 0 7px 0 9px;
}

.section + .row,
.section + .empty {
  margin-top: 6px;
}

/*
 * A day's heading inside the list: MiMo's 12/500 in the secondary colour, 9 in
 * from the inset, 6 above and 3 below. Its own rule - it had been spliced into
 * the one above, which left every heading but the first unstyled and gave the
 * first row under a section a heading's padding.
 */
.day-head {
  padding: 6px 9px 3px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 16px;
}

/*
 * MiMo's compact rows for projects and conversations, unlike the 38px
 * destinations above them: 34 tall from 6 above and below a 22px line, 6 round.
 * The padding sits inside the row's button so the whole row still opens it.
 * A project is a 46px icon cell and its name, 9 from the end; a conversation
 * under it starts at 46, one in Recent at 9.
 */
.row.task,
.row.project {
  align-items: stretch;
  min-height: 0;
  padding-block: 0;
  border-radius: 6px;
}

.row.task > .row-open,
.row.project > .project-toggle {
  min-height: 34px;
  padding-block: 6px;
}

.row.project {
  gap: 0;
  padding-inline: 0 9px;
}

.row.project > .project-toggle {
  gap: 0;
}

/* The folder centred in MiMo's 46px cell, so the name starts at 46. */
.row.project > .project-toggle > .row-ico {
  margin-inline: 14px;
}

.row.task {
  padding-inline: 46px 9px;
}

.row.task.recent {
  padding-inline: 9px;
}

/* The open conversation's name, in medium as MiMo sets it. */
.row.task.on :deep(.title-txt) {
  font-weight: 500;
}

/* A row carrying a project underneath is two lines: MiMo's 22px line each, so 56 tall. */

.stack {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.row-note {
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(11px * var(--ui-font-scale, 1));
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  font-weight: 500;
  /* Normal, as MiMo's heading is: 15 tall, where the inherited 24 made it 24. */
  line-height: normal;
}

.chev {
  transition: transform var(--motion-fast, 0.12s);
}

.chev.shut {
  transform: rotate(-90deg);
}

.add {
  width: 24px;
  height: 24px;
}

.project {
  padding-inline-end: 6px;
}

.project-toggle {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 14px;
  min-width: 0;
  color: inherit;
  text-align: start;
}

.ico.inline {
  opacity: 0;
}

.project:hover .ico.inline,
.ico.inline:focus-visible {
  opacity: 1;
}

/* A task sits under its project's name, in a softer white. */
.task {
  padding-inline-start: 46px;
}

.task-label {
  color: color-mix(in srgb, var(--text-strong) 80%, transparent);
  font-weight: 400;
  line-height: 22px;
}

/*
 * MiMo's resting title when it runs under the row's buttons: its last 24px
 * fade out instead of an ellipsis. Hovered, focused or open, it is left whole.
 */
.row.task:not(.on):not(:hover):not(:focus-within) .title-viewport[data-title-overflow="true"] {
  mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 24px), transparent 100%);
}

.row.task:not(.on):not(:hover):not(:focus-within) .title-viewport[data-title-overflow="true"]:dir(rtl) {
  mask-image: linear-gradient(to left, #000 0, #000 calc(100% - 24px), transparent 100%);
}

.empty {
  padding: 7px 9px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 19.2px;
}

/* Recent's heading actions, which MiMo keeps hidden until the heading is hovered. */
.sec-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast, 0.12s);
}

.recent-head:hover .sec-actions,
.recent-head:focus-within .sec-actions,
.recent-head.held .sec-actions {
  opacity: 1;
  pointer-events: auto;
}

/* MiMo's show-more row: 12px in the secondary colour, 9 by 7 of padding. */
.show-more {
  width: 100%;
  padding: 7px 9px;
  color: var(--text-weak);
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: start;
}

.show-more:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* Under a project's first five: 12px in the secondary colour, in line with the task names. */
.project-show-all {
  width: 100%;
  padding-block: 5px;
  padding-inline: 46px 9px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  /* MiMo's buttons keep the body's 22px line, which makes the row 32 tall. */
  line-height: calc(22px * var(--ui-font-scale, 1));
  text-align: start;
}

.project-show-all:hover {
  color: var(--text-strong);
}

/* MiMo's pages row under the projects: more on the left, collapse on the right. */
.projects-pages {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 5px 9px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(22px * var(--ui-font-scale, 1));
}

.projects-pages button {
  padding: 0;
  color: var(--text-weak);
  font-size: inherit;
  text-align: start;
}

.projects-pages button:hover {
  color: var(--text-strong);
}

.pages-more {
  flex: 1;
  min-width: 0;
}

.pages-collapse {
  flex: none;
  margin-inline-start: auto;
}

/* The priority filter's bell: sixth in the left-aligned controls row, lit while on. */
.ico.bell.on {
  color: var(--text-accent);
}

/* The priority section's menu button shows while its heading is hovered. */
.priority-head .more {
  opacity: 0;
}

.priority-head:hover .more,
.priority-head .more:focus-visible {
  opacity: 1;
}

/* The foot row sits 10 above the window's bottom edge. */
.foot {
  flex-shrink: 0;
  margin: 8px 8px 10px;
}

/*
 * MiMo's folded column: a 62px rail holding only the destinations and the
 * foot, icons centred, with the controls row floated just past its edge.
 */
.side.rail {
  position: relative;
  width: 62px;
}

.side.rail .top > *,
.side.rail .brand,
.side.rail .batch,
.side.rail .lists {
  display: none;
}

.side.rail .foot {
  margin-top: auto;
}

.side.rail .nav,
.side.rail .foot {
  align-items: center;
}

.side.rail .nav {
  margin-top: 36px;
}

.side.rail .row {
  justify-content: center;
  width: 46px;
  padding: 0;
  gap: 0;
}

.side.rail .row-label {
  display: none;
}

.side.rail .avatar {
  margin-inline-start: 0;
}

.rail-tools {
  position: absolute;
  top: 13px;
  inset-inline-start: 65px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.avatar {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 26px;
  height: 26px;
  margin-inline-start: -4px;
  color: var(--text-base);
  background: var(--surface-layer);
  border-radius: 50%;
}

/*
 * A row is now two controls in one line: the conversation, and the menu that
 * belongs to it. The menu keeps out of the way until the row is under the
 * pointer or holds the keyboard, which is how MiMo shows its own.
 */
.row-open {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 100%;
  padding: 0;
  color: inherit;
  text-align: start;
}

.pin {
  flex-shrink: 0;
  color: var(--text-weak);
}

.row-menu {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-inline-start: 4px;
  color: var(--text-weak);
  border-radius: 6px;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.row:hover .row-menu,
.row-menu:focus-visible,
.row.on .row-menu {
  opacity: 1;
}

.row-menu:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* Selection mode: a box before each row, and the bar that acts on them. */
.tick {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 15px;
  height: 15px;
  color: var(--surface-base);
  border: 1px solid var(--border-weak);
  border-radius: 4px;
}

.tick.on {
  background: var(--interactive);
  border-color: var(--interactive);
}

.batch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0 8px 6px;
  padding: 8px;
  background: var(--surface-menu);
  border: 0.5px solid var(--border-weak);
  border-radius: 10px;
}

.batch-count {
  flex: 1;
  min-width: 100%;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: 18px;
}

/* Six and five, not eight and six: at 256 the four labels came to 225 against
   224 of room, and "cancel" fell to a second line by one pixel. */
.batch-act {
  height: 26px;
  padding: 0 6px;
  color: var(--text-strong);
  border-radius: 7px;
  font-size: calc(13px * var(--ui-font-scale, 1));
  transition: background 0.12s, color 0.12s;
}

.batch-act:hover:not(:disabled) {
  background: var(--surface-hover);
}

.batch-act:disabled {
  color: var(--text-weak);
  cursor: default;
}

.batch-act.danger {
  color: var(--error);
}

/* The quick pin MiMo keeps beside the row's menu: no menu needed to use it. */
.row-pin {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-inline-start: 2px;
  color: var(--text-weak);
  border-radius: 6px;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.row:hover .row-pin,
.row-pin:focus-visible,
.row-pin.on {
  opacity: 1;
}

.row-pin.on {
  color: var(--text-base);
}

.row-pin:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}
/*
 * A row's live mark, as MiMo draws them: a 12px spinner with a 1.6px ring open
 * at the top, a 7px dot in the interactive colour, or a 17px grey pill with
 * 10px white text. The mark gives way when the row is hovered and its actions
 * come in.
 */
.row-status {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  margin-inline-start: auto;
  padding-inline-start: 8px;
  transition: opacity 0.12s;
}

.row:hover .row-status {
  opacity: 0;
}

.status-spin {
  width: 12px;
  height: 12px;
  border: 1.6px solid var(--text-weak);
  border-top-color: transparent;
  border-radius: 50%;
  animation: row-status-spin 0.8s linear infinite;
}

@keyframes row-status-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-spin {
    animation-duration: 2.4s;
  }
}

.status-dot {
  width: 7px;
  height: 7px;
  background: var(--text-interactive);
  border-radius: 50%;
}

.status-pill {
  height: 17px;
  padding: 0 7px;
  color: #fff;
  background: #6b7280;
  border-radius: 999px;
  font-size: calc(10px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: 17px;
  white-space: nowrap;
}
/*
 * A conversation row's pin and menu, laid over its end as MiMo lays its row
 * actions: out of the flow, so the title and the live mark have the whole row
 * until the pointer arrives, and on the row's own background when they show.
 */
.row.task,
.row.project {
  position: relative;
}

.row-actions {
  position: absolute;
  inset-block: 0;
  inset-inline-end: 0;
  display: flex;
  align-items: center;
  gap: 1px;
  border-start-end-radius: inherit;
  border-end-end-radius: inherit;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s cubic-bezier(0.4, 0, 0.2, 1);
}

/*
 * MiMo's scrim under the buttons: the row's tint on the column's own ground,
 * solid under them and fading in over the 32px before them, so a long name
 * runs out under it rather than stopping at an edge. The tint is translucent,
 * hence the ground beneath it.
 */
.row-actions::before {
  content: "";
  position: absolute;
  inset-block: 0;
  inset-inline: -32px 0;
  border-start-end-radius: inherit;
  border-end-end-radius: inherit;
  background:
    linear-gradient(to right, transparent 0, var(--surface-hover) 32px),
    linear-gradient(to right, transparent 0, var(--surface-base) 32px);
  pointer-events: none;
}

.row-actions:dir(rtl)::before {
  background:
    linear-gradient(to left, transparent 0, var(--surface-hover) 32px),
    linear-gradient(to left, transparent 0, var(--surface-base) 32px);
}

/* On the open row the scrim wears that row's selected tint instead. */
.row.on .row-actions::before {
  background:
    linear-gradient(to right, transparent 0, var(--surface-selected) 32px),
    linear-gradient(to right, transparent 0, var(--surface-base) 32px);
}

.row.on .row-actions:dir(rtl)::before {
  background:
    linear-gradient(to left, transparent 0, var(--surface-selected) 32px),
    linear-gradient(to left, transparent 0, var(--surface-base) 32px);
}

/* A project waiting on an answer keeps its pill in view, so no scrim goes over it. */
.row.project:has(.status-pill) .row-actions::before {
  content: none;
}

.row.task:hover .row-actions,
.row.project:hover .row-actions,
.row-actions:focus-within {
  opacity: 1;
  pointer-events: auto;
}

/* MiMo's 24px buttons, a pixel apart, above the scrim. */
.row-actions .row-pin,
.row-actions .row-menu,
.row-actions .ico.inline {
  position: relative;
  width: 24px;
  height: 24px;
  margin: 0;
  border-radius: 6px;
  opacity: 1;
}

/*
 * The waiting pill does not give way as the spinner and the dot do: on a task
 * it steps 54px aside for the buttons, on a project the marks make room for them.
 */
.row-status:has(.status-pill) {
  transition: opacity 0.12s, transform var(--motion-fast, 0.12s), padding var(--motion-fast, 0.12s);
}

.row.task:hover .row-status:has(.status-pill) {
  opacity: 1;
  transform: translateX(-54px);
}

.row.task:hover .row-status:has(.status-pill):dir(rtl) {
  transform: translateX(54px);
}

.row.project:hover .row-status:has(.status-pill),
.row.project:focus-within .row-status:has(.status-pill) {
  opacity: 1;
  padding-inline-end: 52px;
}
</style>
