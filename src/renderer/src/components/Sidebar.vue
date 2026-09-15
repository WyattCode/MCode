<script setup lang="ts">
import type { SessionInfo } from "@shared/protocol"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import RowTitle from "./RowTitle.vue"
import { convoCard } from "../lib/convo-card"
import { useApp } from "../stores/app"
import { language, t } from "../lib/i18n"
import type { MenuItem } from "../lib/menu"
import ContextMenu from "./ContextMenu.vue"
import UpdatePill from "./UpdatePill.vue"

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
  /** The projects ticked in project selection mode; absent when not in it. */
  selectingProjects?: string[]
  /** The project whose menu is open, so its row keeps its actions in view. */
  menuDirectory?: string
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
  /* `nested` is a row listed under its project, whose menu MiMo draws without "show in folder". */
  menu: [sessionID: string, x: number, y: number, nested: boolean]
  projectMenu: [directory: string, x: number, y: number]
  select: [sessionID: string]
  /* "all" carries the conversations the column is showing, which is what MiMo's select all takes. */
  batch: [action: "archive" | "delete" | "cancel" | "all" | "none", ids?: string[]]
  projectSelect: [directory: string]
  projectBatch: [action: "archive" | "remove" | "exit" | "all" | "none", directories?: string[]]
  newBlank: []
  newTask: []
  /* Folders dropped onto Projects; empty when what was dropped held none. */
  dropFolders: [directories: string[]]
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
function openMenu(sessionID: string, event: MouseEvent, nested = false) {
  const from = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  const x = event.clientX || (from ? Math.round(from.left) : 0)
  const y = event.clientY || (from ? Math.round(from.bottom + 4) : 0)
  emit("menu", sessionID, x, y, nested)
}

/*
 * Project selection mode, MiMo's project batch management: unpinned projects
 * tick instead of opening, and pinned ones cannot be chosen.
 */
const pickingProjects = computed(() => Array.isArray(props.selectingProjects))
const projectTicked = (directory: string) => Boolean(props.selectingProjects?.includes(directory))

function pressProject(directory: string) {
  if (pickingProjects.value && !pinnedProject(directory)) emit("projectSelect", directory)
  else toggleProject(directory)
}

function projectContext(directory: string, event: MouseEvent) {
  if (pickingProjects.value) return
  openProjectMenu(directory, event)
}

/* The project row's menu, from a right-click or from its own button. */
function openProjectMenu(directory: string, event: MouseEvent) {
  const from = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  const x = event.clientX || (from ? Math.round(from.left) : 0)
  const y = event.clientY || (from ? Math.round(from.bottom + 4) : 0)
  emit("projectMenu", directory, x, y)
}

/* Pinned from that menu: a pinned project moves up into the 置顶 section. */
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
    .map((entry) => {
      const sessions = [...entry.sessions].sort((a, b) => b.updated - a.updated)
      // A pinned conversation is listed in 置顶 rather than under its project, as MiMo lists it.
      return { ...entry, sessions, children: sessions.filter((session) => !app.isPinned(session.id)) }
    })
    .sort((a, b) => b.updated - a.updated)
})

type ProjectRow = (typeof projects.value)[number]

/*
 * The branch each project's folder is on, as MiMo keeps one per project. The
 * backend reads it from HEAD, so it is cheap; it is asked again when the list
 * of projects changes, when the window comes back into focus and when a turn
 * ends, and at most every few seconds per folder.
 */
const branches = ref<Record<string, string>>({})
const branchAsked = new Map<string, number>()
const BRANCH_EVERY = 3000

async function readBranches(force = false) {
  if (!app.connected) return
  const now = Date.now()
  for (const project of projects.value) {
    const directory = project.directory
    if (!force && now - (branchAsked.get(directory) ?? 0) < BRANCH_EVERY) continue
    branchAsked.set(directory, now)
    const info = await app.workspaceInfo(directory).catch(() => undefined)
    const branch = info?.branch ?? ""
    if ((branches.value[directory] ?? "") !== branch) branches.value = { ...branches.value, [directory]: branch }
  }
}

watch(
  () => [app.connected, projects.value.map((project) => project.directory).join("\n")],
  () => void readBranches(),
  { immediate: true },
)
watch(
  () => app.running.size,
  (now, before) => {
    if (now < before) void readBranches(true)
  },
)
const branchesOnFocus = () => void readBranches()
onMounted(() => window.addEventListener("focus", branchesOnFocus))
onBeforeUnmount(() => window.removeEventListener("focus", branchesOnFocus))

/* The fewest parent folders that tell same-named projects apart, as the home picker words them. */
const pathSegments = (directory: string) => directory.split(/[\\/]/).filter(Boolean)

function parentHints(group: string[]): Map<string, string> {
  const parents = group.map((directory) => pathSegments(directory).slice(0, -1))
  const deepest = Math.max(0, ...parents.map((parts) => parts.length))
  for (let depth = 1; depth <= deepest; depth++) {
    const tails = parents.map((parts) => parts.slice(-depth).join("/"))
    if (new Set(tails).size === tails.length) return new Map(group.map((directory, index) => [directory, tails[index]!]))
  }
  return new Map()
}

/*
 * MiMo's project labels. Projects are grouped by name: a name only one project
 * has, or one whose projects are all on different branches, stays bare; any
 * other group is told apart by parent folders. A label still shared after that
 * shows each project's branch beside it - so ordinary projects show none.
 */
const projectLabels = computed(() => {
  const groups = new Map<string, string[]>()
  for (const project of projects.value) {
    const base = name(project.directory)
    groups.set(base, [...(groups.get(base) ?? []), project.directory])
  }
  const labels = new Map<string, string>()
  for (const [base, group] of groups) {
    const onBranches = group.map((directory) => branches.value[directory] ?? "")
    const apart = group.length === 1 || (onBranches.every(Boolean) && new Set(onBranches).size === onBranches.length)
    const hints = apart ? new Map<string, string>() : parentHints(group)
    for (const directory of group) {
      const hint = hints.get(directory)
      labels.set(directory, hint ? `${base} (${hint})` : base)
    }
  }
  const shared = new Map<string, number>()
  for (const label of labels.values()) shared.set(label, (shared.get(label) ?? 0) + 1)
  const out = new Map<string, { label: string; branch?: string }>()
  for (const [directory, label] of labels) {
    const branch = branches.value[directory]
    out.set(directory, { label, branch: (shared.get(label) ?? 0) > 1 && branch ? branch : undefined })
  }
  return out
})

const projectLabel = (directory: string) => projectLabels.value.get(directory)?.label ?? name(directory)
const projectBranch = (directory: string) => projectLabels.value.get(directory)?.branch

/*
 * MiMo's 置顶 section, above Projects: pinned conversations in the order they
 * were pinned, then pinned projects with the latest pin first. Five rows until
 * 展开更多, which opens the rest - conversations before projects - and opens by
 * itself when the open conversation is among them. Neither kind is listed again
 * further down.
 */
const PINNED_PAGE = 5
const PINNED_OPEN_KEY = "mcode.pinnedOpen"

const pinnedConvos = computed(() =>
  (app.config?.pinnedTabs ?? [])
    .map((id) => app.sessions.find((session) => session.id === id))
    .filter((session): session is SessionInfo => Boolean(session && !session.archived)),
)

const pinnedProjectRows = computed(() =>
  (app.config?.pinnedProjects ?? [])
    .map((directory) => projects.value.find((project) => project.directory === directory))
    .filter((project): project is ProjectRow => Boolean(project)),
)

/*
 * A dragged order, as MiMo keeps one: the items it names take the slots those
 * same items already hold, in the order it gives, and anything it does not
 * name - a project opened since - stays where recency put it.
 */
function inManualOrder<T>(items: T[], keyOf: (item: T) => string, manual?: string[]): T[] {
  if (!manual?.length) return items
  const byKey = new Map(items.map((item) => [keyOf(item), item]))
  const placed = new Set<string>()
  const ordered: T[] = []
  for (const key of manual) {
    const item = byKey.get(key)
    if (!item || placed.has(key)) continue
    placed.add(key)
    ordered.push(item)
  }
  if (!ordered.length) return items
  let next = 0
  return items.map((item) => (placed.has(keyOf(item)) ? ordered[next++]! : item))
}

/* The dragged item set down just before the one it was dropped on. */
function movedBefore(list: string[], moved: string, target: string): string[] {
  if (moved === target || !list.includes(moved) || !list.includes(target)) return list
  const rest = list.filter((key) => key !== moved)
  rest.splice(rest.indexOf(target), 0, moved)
  return rest
}

const normalProjects = computed(() =>
  inManualOrder(
    projects.value.filter((project) => !pinnedProject(project.directory)),
    (project) => project.directory,
    app.config?.projectOrder,
  ),
)

/*
 * Dragging a project or a task to a new place, as MiMo's side column allows:
 * the row being carried fades, and a short line over the row under the pointer
 * says it will land before it. Tasks move only among their own project's.
 */
const PROJECT_DRAG = "application/x-mcode-project"
const TASK_DRAG = "application/x-mcode-task"
const carried = ref<{ kind: "project" | "task"; key: string; group?: string }>()
const dropBefore = ref<string>()

function startCarry(event: DragEvent, kind: "project" | "task", key: string, group?: string) {
  if (picking.value) {
    event.preventDefault()
    return
  }
  event.stopPropagation()
  event.dataTransfer?.setData(kind === "project" ? PROJECT_DRAG : TASK_DRAG, key)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
  carried.value = { kind, key, group }
}

function carryOver(event: DragEvent, kind: "project" | "task", key: string, group?: string) {
  const held = carried.value
  if (!held || held.kind !== kind || held.group !== group) return
  event.stopPropagation()
  if (held.key === key) {
    dropBefore.value = undefined
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
  dropBefore.value = key
}

function endCarry() {
  carried.value = undefined
  dropBefore.value = undefined
}

async function setDown(event: DragEvent, kind: "project" | "task", key: string, group?: string) {
  const held = carried.value
  endCarry()
  if (!held || held.kind !== kind || held.group !== group || held.key === key) return
  event.preventDefault()
  event.stopPropagation()
  if (kind === "project") {
    const list = normalProjects.value.map((project) => project.directory)
    const next = movedBefore(list, held.key, key)
    if (next !== list) await app.patchConfig({ projectOrder: next })
    return
  }
  const project = projects.value.find((entry) => entry.directory === group)
  if (!project || !group) return
  const list = inManualOrder(project.children, (session) => session.id, app.config?.taskOrder?.[group]).map((session) => session.id)
  const next = movedBefore(list, held.key, key)
  if (next !== list) await app.patchConfig({ taskOrder: { ...(app.config?.taskOrder ?? {}), [group]: next } })
}

const carrying = (kind: "project" | "task", key: string) => carried.value?.kind === kind && carried.value.key === key
const landing = (kind: "project" | "task", key: string) => carried.value?.kind === kind && dropBefore.value === key

/*
 * Folders dropped onto the project list become projects, as MiMo takes them:
 * the list is ringed in a dashed accent line while a drag of files is over it.
 * The ring is drawn over the rows rather than around a wrapper, since the
 * column's rows are one flat list; it is measured from the first and last row
 * that belong to Projects when the drag arrives.
 */
const listsEl = ref<HTMLElement>()
const folderRing = ref<{ top: number; height: number }>()

function carriesFiles(event: DragEvent) {
  const types = [...(event.dataTransfer?.types ?? [])].map((type) => type.toLowerCase())
  return types.includes("files") || types.includes("text/uri-list")
}

function overProjects(event: DragEvent) {
  return Boolean((event.target as HTMLElement | null)?.closest?.("[data-project-zone]"))
}

function ringProjects() {
  const root = listsEl.value
  if (!root) return
  const parts = [...root.querySelectorAll<HTMLElement>("[data-project-zone]")]
  if (!parts.length) return
  const base = root.getBoundingClientRect()
  const top = parts[0]!.getBoundingClientRect().top
  const bottom = Math.max(...parts.map((part) => part.getBoundingClientRect().bottom))
  folderRing.value = { top: top - base.top + root.scrollTop, height: bottom - top }
}

function folderOver(event: DragEvent) {
  if (carried.value || !carriesFiles(event)) return
  if (!overProjects(event)) {
    folderRing.value = undefined
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
  if (!folderRing.value) ringProjects()
}

function folderLeave(event: DragEvent) {
  const next = event.relatedTarget as Node | null
  if (next && listsEl.value?.contains(next)) return
  folderRing.value = undefined
}

async function folderDrop(event: DragEvent) {
  const ringed = Boolean(folderRing.value)
  folderRing.value = undefined
  if (carried.value || !carriesFiles(event) || !(ringed || overProjects(event))) return
  event.preventDefault()
  const paths = [...(event.dataTransfer?.files ?? [])].map((file) => window.mcode.pathForFile(file)).filter(Boolean)
  for (const line of (event.dataTransfer?.getData("text/uri-list") ?? "").split(/\r?\n/)) {
    if (!line.startsWith("file:")) continue
    const local = decodeURIComponent(line.slice("file:".length).replace(/^\/\/\/?(?=[a-zA-Z]:)/, "").replace(/^\/\//, "/"))
    paths.push(/^\/[a-zA-Z]:/.test(local) ? local.slice(1) : local)
  }
  emit("dropFolders", await window.mcode.directoriesOf([...new Set(paths)]))
}

const pinnedOpen = ref(
  (() => {
    try {
      return localStorage.getItem(PINNED_OPEN_KEY) !== "false"
    } catch {
      return true
    }
  })(),
)

function togglePinnedOpen() {
  pinnedOpen.value = !pinnedOpen.value
  try {
    localStorage.setItem(PINNED_OPEN_KEY, String(pinnedOpen.value))
  } catch {}
}

const pinnedMore = ref(false)

interface ColumnBlock {
  key: string
  kind: "pinned-head" | "pinned-more" | "projects-head" | "projects-pages" | "session" | "project"
  session?: SessionInfo
  project?: ProjectRow
}

const pinnedBlocks = computed<ColumnBlock[]>(() => {
  const convos = pinnedConvos.value
  const rows = pinnedProjectRows.value
  if (!convos.length && !rows.length) return []
  const head: ColumnBlock = { key: "pinned-head", kind: "pinned-head" }
  if (!pinnedOpen.value) return [head]
  const firstConvos = convos.slice(0, PINNED_PAGE)
  const firstProjects = rows.slice(0, Math.max(0, PINNED_PAGE - firstConvos.length))
  const restConvos = convos.slice(firstConvos.length)
  const restProjects = rows.slice(firstProjects.length)
  const open = pinnedMore.value || restConvos.some((session) => session.id === app.currentID)
  const sessionBlock = (session: SessionInfo): ColumnBlock => ({ key: `pinned-session:${session.id}`, kind: "session", session })
  const projectBlock = (project: ProjectRow): ColumnBlock => ({ key: `pinned-project:${project.directory}`, kind: "project", project })
  return [
    head,
    ...firstConvos.map(sessionBlock),
    ...firstProjects.map(projectBlock),
    ...(!open && (restConvos.length || restProjects.length) ? [{ key: "pinned-more", kind: "pinned-more" } as ColumnBlock] : []),
    ...(open ? [...restConvos.map(sessionBlock), ...restProjects.map(projectBlock)] : []),
  ]
})

/* The top of the column, in order: 置顶, then Projects with its pages. */
const columnBlocks = computed<ColumnBlock[]>(() => {
  if (props.priority) return []
  return [
    ...pinnedBlocks.value,
    { key: "projects-head", kind: "projects-head" },
    ...(projectsOpen.value
      ? shownProjects.value.map((project): ColumnBlock => ({ key: `project:${project.directory}`, kind: "project", project }))
      : []),
    ...(projectsOpen.value && !picking.value && !pickingProjects.value && (projectsLeft.value > 0 || projectsPaged.value)
      ? [{ key: "projects-pages", kind: "projects-pages" } as ColumnBlock]
      : []),
  ]
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
  const rows = app.sessions.filter((session) => !session.archived && !listed.has(session.directory) && !app.isPinned(session.id))
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

/*
 * MiMo's: archive all, a rule, then 排序条件：最近 › - the order in force after
 * the label - opening the two orders with a tick at the end of the current one.
 */
const recentMenuItems = computed<MenuItem[]>(() => [
  { key: "archive", label: t("side.archiveAll"), icon: "M2.2 3h11.6v2.6H2.2zM3.2 5.6h9.6V13H3.2zM6.4 8.2h3.2" },
  {
    key: "sort",
    label: t("side.sortBy"),
    value: t(recentSort.value === "name" ? "side.sortName" : "side.sortRecent"),
    icon: "M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4zM8 5v3.2l2.2 1.4",
    divided: true,
    children: [
      { key: "sort-recent", label: t("side.sortRecent"), checked: recentSort.value === "recent", checkEnd: true, active: recentSort.value === "recent" },
      { key: "sort-name", label: t("side.sortName"), checked: recentSort.value === "name", checkEnd: true, active: recentSort.value === "name" },
    ],
  },
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
const tasksOf = (project: ProjectRow) => {
  const rows = inManualOrder(project.children, (session) => session.id, app.config?.taskOrder?.[project.directory])
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
const anyPicking = computed(() => picking.value || pickingProjects.value)
const shownProjects = computed(() => (anyPicking.value ? normalProjects.value : normalProjects.value.slice(0, projectsShown.value)))
const projectsLeft = computed(() => normalProjects.value.length - shownProjects.value.length)
const projectsPaged = computed(() => !anyPicking.value && projectsShown.value > PROJECT_PAGE && normalProjects.value.length > PROJECT_PAGE)
function moreProjects() {
  const shown = projectsShown.value
  projectsShown.value = Math.min(normalProjects.value.length, shown <= PROJECT_PAGE ? PROJECT_STEP : shown + PROJECT_STEP)
}
watch(anyPicking, (on) => {
  if (on) projectsShown.value = PROJECT_PAGE
})

/* What MiMo's select all takes: every conversation the column is showing. */
const selectableIDs = computed(() => {
  const ids = new Set<string>()
  for (const block of columnBlocks.value) {
    if (block.session) ids.add(block.session.id)
    if (block.project && isExpanded(block.project.directory)) {
      for (const session of tasksOf(block.project)) ids.add(session.id)
    }
  }
  if (props.priority || recentOpen.value) {
    for (const row of listed.value) if (row.session) ids.add(row.session.id)
  }
  return [...ids]
})
const allTicked = computed(() => selectableIDs.value.length > 0 && selectableIDs.value.every(ticked))

/* And for projects, every unpinned one, since selection lists them all. */
const selectableProjects = computed(() => normalProjects.value.map((project) => project.directory))
const allProjectsTicked = computed(
  () => selectableProjects.value.length > 0 && selectableProjects.value.every(projectTicked),
)

/* The Projects heading's "+": a blank project, or a folder already on disk. */
const FOLDER = "M2 4.4c0-.6.5-1 1-1h2.6l1.2 1.5h6.2c.5 0 1 .4 1 1v6.2c0 .6-.5 1-1 1H3c-.5 0-1-.4-1-1z"
const newProjectMenu = ref<{ x: number; y: number }>()
const newProjectItems = computed<MenuItem[]>(() => [
  { key: "blank", label: t("side.newBlankProject"), icon: `${FOLDER}M8 7.2v3.6M6.2 9h3.6` },
  { key: "existing", label: t("side.useExistingFolder"), icon: FOLDER },
])

/* Below the button, its end lined up with the button's, as MiMo opens it. */
function openNewProjectMenu(event: MouseEvent) {
  const from = (event.currentTarget as HTMLElement).getBoundingClientRect()
  newProjectMenu.value = { x: Math.round(from.right), y: Math.round(from.bottom + 4) }
}

function pickNewProject(key: string) {
  newProjectMenu.value = undefined
  if (key === "blank") emit("newBlank")
  else if (key === "existing") emit("browse")
}
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

    <div ref="listsEl" class="lists" @dragover="folderOver" @dragleave="folderLeave" @drop="folderDrop">
      <div
        v-if="folderRing"
        class="folder-ring"
        data-folder-ring
        :style="{ top: `${folderRing.top}px`, height: `${folderRing.height}px` }"
        aria-hidden="true"
      />
      <template v-for="block in columnBlocks" :key="block.key">
        <!-- MiMo's 置顶 section: pinned conversations, then pinned projects. -->
        <div v-if="block.kind === 'pinned-head'" class="section pinned-head" data-pinned-section>
          <button class="section-head" :aria-expanded="pinnedOpen" @click="togglePinnedOpen">
            <span>{{ t("side.priorityPinned") }}</span>
            <svg class="chev" :class="{ shut: !pinnedOpen }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
            </svg>
          </button>
        </div>
        <button v-else-if="block.kind === 'pinned-more'" class="pinned-more" data-pin-show-more @click="pinnedMore = true">
          {{ t("side.expandPinned") }}
        </button>
        <div
          v-else-if="block.session"
          class="row task recent pinned-convo"
          :class="{ on: app.currentID === block.session.id }"
          @contextmenu.prevent="openMenu(block.session.id, $event)"
        >
          <button class="row-open" @click="press(block.session.id)">
            <span v-if="picking" class="tick" :class="{ on: ticked(block.session.id) }" aria-hidden="true">
              <svg v-if="ticked(block.session.id)" width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M3.5 8.2 6.4 11.2 12.5 4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <!-- MiMo's pinned conversation leads with a conversation mark in a 46px cell. -->
            <span class="convo-cell" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4.5A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5z" />
              </svg>
            </span>
            <RowTitle
              class="row-label task-label"
              v-tip="picking ? '' : { card: convoCard(block.session, app.config?.projectNames), placement: 'right' }"
              :text="title(block.session.title)"
              :cover="picking ? 0 : TITLE_COVER"
              @rename="!picking && emit('rename', block.session.id)"
            />
            <span v-if="statusOf(block.session.id)" class="row-status" :data-status="statusOf(block.session.id)">
              <span v-if="statusOf(block.session.id) === 'running'" class="status-spin" aria-hidden="true" />
              <span v-else-if="statusOf(block.session.id) === 'unread'" class="status-dot" aria-hidden="true" />
              <span v-else class="status-pill" :title="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
            </span>
          </button>
          <span class="row-actions">
            <button class="row-menu" :aria-label="t('session.options')" @click.stop="openMenu(block.session.id, $event)">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="3" cy="8" r="1.1" fill="currentColor" />
                <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                <circle cx="13" cy="8" r="1.1" fill="currentColor" />
              </svg>
            </button>
            <button class="row-pin on" :aria-label="t('menu.unpin')" @click.stop="app.togglePinned(block.session.id)">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
            </button>
          </span>
        </div>
        <div
          v-else-if="block.kind === 'projects-head'"
          class="section projects-head"
          :class="{ held: Boolean(newProjectMenu) }"
          data-project-zone
        >
        <button class="section-head" :aria-expanded="projectsOpen" @click="projectsOpen = !projectsOpen">
          <span>{{ t("side.projects") }}</span>
          <svg class="chev" :class="{ shut: !projectsOpen }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
          </svg>
        </button>
        <!-- MiMo's "+", out of sight until the heading is hovered, opening its two-row menu. -->
        <span class="sec-actions">
          <button
            class="ico add project-new"
            data-new-project-button
            :aria-label="t('side.newProject')"
            aria-haspopup="menu"
            :aria-expanded="Boolean(newProjectMenu)"
            v-tip="{ label: t('side.newProject') }"
            @click.stop="openNewProjectMenu"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 5V15M5 10H15" stroke="currentColor" stroke-linecap="square" />
            </svg>
          </button>
        </span>
      </div>
        <template v-else-if="block.project">
          <template v-for="project in [block.project]" :key="project.directory">
          <div
            class="row project"
            :class="{
              on: app.current?.directory === project.directory && !isExpanded(project.directory),
              carried: carrying('project', project.directory),
              'lands-before': landing('project', project.directory),
              picked: pickingProjects && projectTicked(project.directory),
              'menu-open': menuDirectory === project.directory,
            }"
            data-project-zone
            :data-project-drag="project.directory"
            :draggable="!anyPicking"
            @dragstart="startCarry($event, 'project', project.directory)"
            @dragover="carryOver($event, 'project', project.directory)"
            @drop="setDown($event, 'project', project.directory)"
            @dragend="endCarry"
            @contextmenu.prevent="projectContext(project.directory, $event)"
          >
            <!-- MiMo's tick before the folder cell, only on projects that can be chosen. -->
            <span
              v-if="pickingProjects && !pinnedProject(project.directory)"
              class="tick project-tick"
              :class="{ on: projectTicked(project.directory) }"
              data-project-tick
              aria-hidden="true"
            >
              <svg v-if="projectTicked(project.directory)" width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M3.5 8.2 6.4 11.2 12.5 4.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <button
              class="project-toggle"
              v-tip="pickingProjects ? '' : { label: project.directory, placement: 'top' }"
              @click="pressProject(project.directory)"
            >
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
              <span class="row-label plain">{{ projectLabel(project.directory) }}</span>
              <!--
                MiMo's branch, only beside a name another project shares: the
                branch text and then the live mark, faded out under the pointer
                so the row's actions take the place.
              -->
              <span v-if="projectBranch(project.directory)" class="row-branch" data-project-branch>
                <span class="branch-text">{{ projectBranch(project.directory) }}</span>
                <span
                  v-if="!isExpanded(project.directory) && projectStatus(project.children)"
                  class="row-status"
                  :data-status="projectStatus(project.children)"
                >
                  <span v-if="projectStatus(project.children) === 'running'" class="status-spin" aria-hidden="true" />
                  <span v-else-if="projectStatus(project.children) === 'unread'" class="status-dot" aria-hidden="true" />
                  <span v-else class="status-pill" :title="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
                </span>
              </span>
              <span
                v-else-if="!isExpanded(project.directory) && projectStatus(project.children)"
                class="row-status"
                :data-status="projectStatus(project.children)"
              >
                <span v-if="projectStatus(project.children) === 'running'" class="status-spin" aria-hidden="true" />
                <span v-else-if="projectStatus(project.children) === 'unread'" class="status-dot" aria-hidden="true" />
                <span v-else class="status-pill" :title="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
              </span>
            </button>
            <!--
              MiMo's pair on a project row: its menu, then a new task in it. Laid
              over the row's end on hover, as a task row's are, so the project's
              name has the whole row until then. Not there while choosing projects.
            -->
            <span v-if="!pickingProjects" class="row-actions">
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
              <button
                class="ico inline"
                :aria-label="t('side.newTaskIn', { name: projectLabel(project.directory) })"
                v-tip="{ label: t('side.newTaskIn', { name: projectLabel(project.directory) }) }"
                @click="emit('createIn', project.directory)"
              >
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
              :class="{ on: app.currentID === session.id, carried: carrying('task', session.id), 'lands-before': landing('task', session.id) }"
              data-project-zone
              :data-task-drag="session.id"
              :draggable="!picking"
              @dragstart="startCarry($event, 'task', session.id, project.directory)"
              @dragover="carryOver($event, 'task', session.id, project.directory)"
              @drop="setDown($event, 'task', session.id, project.directory)"
              @dragend="endCarry"
              @contextmenu.prevent="openMenu(session.id, $event, true)"
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
                <button class="row-menu" :aria-label="t('session.options')" @click.stop="openMenu(session.id, $event, true)">
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
              v-if="project.children.length > PROJECT_TASKS && !allTasks.has(project.directory)"
              class="project-show-all"
              :data-project-show-all="project.directory"
              aria-expanded="false"
              @click.stop="showAllTasks(project.directory)"
            >
              {{ t("side.showAllTasks") }}
            </button>
          </template>
          </template>
        </template>
        <div v-else-if="block.kind === 'projects-pages'" class="projects-pages" data-projects-pagination data-project-zone>
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

    <!--
      MiMo's selection bar, between the lists and the foot: select all, the
      count and the way out on one line, and the two things worth doing to
      several conversations at once under it.
    -->
    <div v-if="picking && !pickingProjects" class="select-bar" data-select-bar="threads">
      <div class="sb-row">
        <button
          class="sb-text"
          data-select-all
          @click="allTicked ? emit('batch', 'none') : emit('batch', 'all', selectableIDs)"
        >
          {{ allTicked ? t("batch.selectNone") : t("batch.selectAll") }}
        </button>
        <span class="sb-count">{{ t("batch.selected", { n: String(selecting?.length ?? 0) }) }}</span>
        <button class="sb-text" data-select-exit @click="emit('batch', 'cancel')">{{ t("batch.cancel") }}</button>
      </div>
      <div class="sb-row sb-actions">
        <button class="sb-btn" data-batch="archive" :disabled="!selecting?.length" @click="emit('batch', 'archive')">
          {{ t("batch.archiveShort") }}
        </button>
        <button class="sb-btn danger" data-batch="delete" :disabled="!selecting?.length" @click="emit('batch', 'delete')">
          {{ t("batch.deleteShort") }}
        </button>
      </div>
    </div>

    <!-- The same card for projects: archive their conversations, or take them off the list. -->
    <div v-if="pickingProjects" class="select-bar" data-select-bar="projects">
      <div class="sb-row">
        <button
          class="sb-text"
          data-select-all
          @click="allProjectsTicked ? emit('projectBatch', 'none') : emit('projectBatch', 'all', selectableProjects)"
        >
          {{ allProjectsTicked ? t("batch.projectsSelectNone") : t("batch.projectsSelectAll") }}
        </button>
        <span class="sb-count">{{ t("batch.selected", { n: String(selectingProjects?.length ?? 0) }) }}</span>
        <button class="sb-text" data-select-exit @click="emit('projectBatch', 'exit')">{{ t("batch.projectsExit") }}</button>
      </div>
      <div class="sb-row sb-actions">
        <button class="sb-btn" data-batch="archive" :disabled="!selectingProjects?.length" @click="emit('projectBatch', 'archive')">
          {{ t("batch.projectsArchive") }}
        </button>
        <button class="sb-btn" data-batch="remove" :disabled="!selectingProjects?.length" @click="emit('projectBatch', 'remove')">
          {{ t("batch.projectsRemove") }}
        </button>
      </div>
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
      <!-- MiMo's update capsule, after the footer menu and only while the column is open. -->
      <UpdatePill v-if="!collapsed" />
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
      side
      :min-width="208"
      @pick="pickPriorityMenu"
      @close="priorityMenu = undefined"
    />
    <ContextMenu
      v-if="recentMenu"
      :x="recentMenu.x"
      :y="recentMenu.y"
      :items="recentMenuItems"
      side
      :min-width="208"
      @pick="pickRecentMenu"
      @close="recentMenu = undefined"
    />
    <ContextMenu
      v-if="newProjectMenu"
      :x="newProjectMenu.x"
      :y="newProjectMenu.y"
      :items="newProjectItems"
      side
      end
      :min-width="184"
      @pick="pickNewProject"
      @close="newProjectMenu = undefined"
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
.recent-head.held .sec-actions,
.projects-head:hover .sec-actions,
.projects-head:focus-within .sec-actions,
.projects-head.held .sec-actions {
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

/* A pinned conversation: MiMo's 46px mark cell in place of the 9px start, the title right after it. */
.row.task.pinned-convo {
  padding-inline-start: 0;
}

.row.task.pinned-convo > .row-open {
  gap: 0;
}

.convo-cell {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 46px;
  color: var(--text-weak);
}

/* 展开更多 under the first five pinned rows: 12px in the secondary colour, 9 in, 5 above and below. */
.pinned-more {
  width: 100%;
  padding: 5px 9px;
  color: var(--text-weak);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(22px * var(--ui-font-scale, 1));
  text-align: start;
}

.pinned-more:hover {
  color: var(--text-strong);
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
.side.rail .select-bar,
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

/* A project's tick sits before its folder cell, 9 in and 7 before the folder, as MiMo's does. */
.project-tick {
  align-self: center;
  margin-inline: 9px -7px;
}

.row.project.picked {
  background: var(--surface-selected);
}

/*
 * MiMo's selection bar: a card of two rows between the lists and the foot,
 * 10 round with 8 by 10 of padding and 12px text.
 */
.select-bar {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 8px;
  margin: 6px 8px 0;
  padding: 8px 10px;
  color: var(--text-base);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 10px;
  font-size: calc(12px * var(--ui-font-scale, 1));
}

.sb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.sb-actions {
  gap: 6px;
}

.sb-text {
  flex: none;
  padding: 0;
  color: var(--text-base);
  font-size: inherit;
}

.sb-text:hover {
  color: var(--text-strong);
}

.sb-count {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-weak);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Two equal buttons, 7 round on a 1px line, at 40% while there is nothing to act on. */
.sb-btn {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: 7px;
  font-size: inherit;
  transition: background 0.12s;
}

.sb-btn:hover:not(:disabled) {
  background: var(--surface-hover);
}

.sb-btn:disabled {
  cursor: default;
  opacity: 0.4;
}

/* MiMo's delete: the light red pair, darker under the pointer. */
.sb-btn.danger {
  color: #d93025;
  background: #fdecea;
  border-color: #fdecea;
}

.sb-btn.danger:hover:not(:disabled) {
  background: #fadbd8;
  border-color: #fadbd8;
}

:root[data-theme="dark"] .sb-btn.danger {
  color: #ff9b7f;
  background: #3a2320;
  border-color: #3a2320;
}

:root[data-theme="dark"] .sb-btn.danger:hover:not(:disabled) {
  background: #4a2c27;
  border-color: #4a2c27;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .sb-btn.danger {
    color: #ff9b7f;
    background: #3a2320;
    border-color: #3a2320;
  }

  :root:not([data-theme="light"]) .sb-btn.danger:hover:not(:disabled) {
    background: #4a2c27;
    border-color: #4a2c27;
  }
}

/*
 * MiMo's branch beside a shared project name: 10px in the dim colour, up to
 * half the row, then the live mark. The whole span gives way to the row's
 * actions under the pointer and while the row's menu is open.
 */
.row-branch {
  display: flex;
  flex-shrink: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 50%;
  margin-inline-start: auto;
  padding-inline-start: 8px;
  transition: opacity 0.12s;
}

.branch-text {
  overflow: hidden;
  color: var(--text-weak);
  font-size: calc(10px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-branch .row-status {
  margin-inline-start: 0;
  padding-inline-start: 0;
}

.row.project:hover .row-branch:not(:has(.status-pill)),
.row.project:focus-within .row-branch:not(:has(.status-pill)),
.row.project.menu-open .row-branch:not(:has(.status-pill)) {
  opacity: 0;
}

/* The open menu's row keeps its actions showing, as the pointer would. */
.row.project.menu-open .row-actions {
  opacity: 1;
  pointer-events: auto;
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

/* A row being dragged to a new place, and the line over the row it will land before. */
.row.carried {
  opacity: 0.5;
}

.row.lands-before {
  position: relative;
}

.row.lands-before::before {
  position: absolute;
  inset-inline: 6px;
  top: -1px;
  z-index: 1;
  height: 2px;
  content: "";
  background: var(--interactive);
  border-radius: 999px;
  pointer-events: none;
}

/* Folders being dropped onto Projects. */
.lists {
  position: relative;
}

.folder-ring {
  position: absolute;
  inset-inline: 0;
  z-index: 2;
  border-radius: 8px;
  outline: 2px dashed var(--interactive);
  outline-offset: -2px;
  pointer-events: none;
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
