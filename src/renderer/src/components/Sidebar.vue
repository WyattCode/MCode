<script setup lang="ts">
import OperationBadges from "./OperationBadges.vue"
import type { SessionInfo } from "@shared/protocol"
import { computed, onBeforeUnmount, onMounted, onUpdated, ref, watch } from "vue"
import RowTitle from "./RowTitle.vue"
import ChatLinkMark from "./ChatLinkMark.vue"
import { convoCard } from "../lib/convo-card"
import { projectOf } from "../lib/session-project"
import { subagentsAtWork } from "../lib/subagent-chip"
import { sidePreview } from "../lib/side-preview"
import { useApp } from "../stores/app"
import { useQuestions } from "../stores/questions"
import { dateIn, language, sessionTitle, t, tn } from "../lib/i18n"
import { notify, notifyFailure } from "../lib/toast"
import { RAIL_WIDTH, SIDE_WIDTH_MIN } from "../lib/right-tools"
import { shownChord } from "../lib/keys"
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
  /** Folded away altogether, as MiMo 26.920 folds it: its toggle stays, and resting there previews the column. */
  collapsed?: boolean
  /** The conversations ticked in selection mode; absent when not in it. */
  selecting?: string[]
  /** The projects ticked in project selection mode; absent when not in it. */
  selectingProjects?: string[]
  /** The project whose menu is open, so its row keeps its actions in view. */
  menuDirectory?: string
  /** The conversation whose row menu is open, so its "more" tip and card stay shut as MiMo's do. */
  menuSession?: string
  /** Whether MiMo's priority filter is on: attention first, then the week by day. */
  priority?: boolean
  /** Whether back and forward have anywhere to go; MiMo dims them when not. */
  canBack?: boolean
  canForward?: boolean
  /** How wide the open column is past its rail, as dragged; the app clamps and keeps it. */
  width: number
  maxWidth: number
}>()

const emit = defineEmits<{
  artifacts: []
  "toggle-priority": []
  "archive-all": []
  "show-archived": []
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
  /* subagents: the conversation, with its 子智能体 tab open beside it. */
  openSubagents: [sessionID: string]
  rename: [sessionID: string]
  createIn: [directory: string]
  settings: []
  /* The width asked for while dragging the edge; `done` once the button is let go. */
  resize: [width: number, done: boolean]
}>()

const app = useApp()
const questions = useQuestions()

/* The brand badge carries the running version's major.minor. It used to be a
 * hand-tuned "2.0" that drifted away from what releases actually said; now it
 * cannot. Empty before bootstrap lands, so the badge is dropped rather than
 * shown blank. */
const brandBadge = computed(() => app.version.split(".").slice(0, 2).join("."))

/* MiMo pages Recent fifty at a time. */
const RECENT_PAGE = 50
const recentShown = ref(RECENT_PAGE)

const name = (directory: string) =>
  app.config?.projectNames?.[directory] || directory.split(/[\\/]/).filter(Boolean).pop() || directory

/* Which project a row outside the tree says it belongs to; a conversation filed under none says nothing. */
const groupNote = (session: SessionInfo) => {
  const group = projectOf(session)
  return group ? name(group) : ""
}

/*
 * A row's name: the conversation's own, with the engine's placeholder worded as
 * MiMo words it (未命名对话) rather than shown raw, and 新建任务 for a title that
 * is empty altogether.
 */
const title = (text?: string) => (text && text.trim() ? sessionTitle(text) : t("side.newTask"))

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

/*
 * The stored project list, in the store's order. A project with no
 * conversation is listed all the same, as MiMo lists one: its row, and nothing
 * under it when it is opened.
 */
const projects = computed(() => {
  const byDirectory = new Map(app.projects.map((directory) => [directory, [] as typeof app.sessions]))
  for (const session of app.sessions) {
    if (session.archived) continue
    /*
     * Filed by its grouping label where 移动至项目 gave it one, else by the
     * folder it works in. A task with no project has neither; Recent has it.
     */
    const group = projectOf(session)
    if (group) byDirectory.get(group)?.push(session)
  }
  return app.projects.map((directory) => {
    const sessions = [...(byDirectory.get(directory) ?? [])].sort((a, b) => b.updated - a.updated)
    // A pinned conversation is listed in 置顶 rather than under its project, as MiMo lists it.
    return { directory, sessions, children: sessions.filter((session) => !app.isPinned(session.id)) }
  })
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
let branchSeq = 0

async function readBranches(force = false) {
  if (!app.connected) return
  const mine = ++branchSeq
  const now = Date.now()
  for (const project of projects.value) {
    if (mine !== branchSeq) return
    const directory = project.directory
    if (!force && now - (branchAsked.get(directory) ?? 0) < BRANCH_EVERY) continue
    branchAsked.set(directory, now)
    const info = await app.workspaceInfo(directory).catch(() => undefined)
    /* A newer readBranches started while this one was waiting; drop the slower pass. */
    if (mine !== branchSeq) {
      // The answer is thrown away, so the folder has not really been asked: let the newer pass ask it.
      branchAsked.delete(directory)
      return
    }
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
/* A switch or a new branch made in this window is shown straight away, as MiMo re-detects it. */
watch(
  () => app.branchNonce,
  () => void readBranches(true),
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
/* 置顶 rows reorder among themselves, as MiMo's pinned list does. */
const PINNED_DRAG = "application/x-mcode-pinned"
type CarryKind = "project" | "task" | "pinned"
const carried = ref<{ kind: CarryKind; key: string; group?: string }>()
const dropBefore = ref<string>()

function startCarry(event: DragEvent, kind: CarryKind, key: string, group?: string) {
  if (picking.value) {
    event.preventDefault()
    return
  }
  event.stopPropagation()
  event.dataTransfer?.setData(kind === "project" ? PROJECT_DRAG : kind === "pinned" ? PINNED_DRAG : TASK_DRAG, key)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
  carried.value = { kind, key, group }
}

function carryOver(event: DragEvent, kind: CarryKind, key: string, group?: string) {
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

async function setDown(event: DragEvent, kind: CarryKind, key: string, group?: string) {
  const held = carried.value
  endCarry()
  if (!held || held.kind !== kind || held.group !== group || held.key === key) return
  event.preventDefault()
  event.stopPropagation()
  /*
   * 置顶 is kept in the order it is pinned in, and MiMo lets that order be
   * dragged. Without it a sixth pin can only be reached by unpinning and
   * pinning again, since the section shows five rows before 展开更多.
   */
  if (kind === "pinned") {
    const list = pinnedConvos.value.map((session) => session.id)
    const next = movedBefore(list, held.key, key)
    if (next !== list) {
      // Anything pinned that this list does not name - a pinned project - keeps its place at the end.
      const rest = (app.config?.pinnedTabs ?? []).filter((id) => !next.includes(id))
      try {
        await app.patchConfig({ pinnedTabs: [...next, ...rest] })
      } catch {
        // patchConfig already toasts prefSaveFailed.
      }
    }
    return
  }
  if (kind === "project") {
    const list = normalProjects.value.map((project) => project.directory)
    const next = movedBefore(list, held.key, key)
    if (next !== list) {
      try {
        await app.patchConfig({ projectOrder: next })
      } catch {
        // patchConfig already toasts prefSaveFailed.
      }
    }
    return
  }
  const project = projects.value.find((entry) => entry.directory === group)
  if (!project || !group) return
  const list = inManualOrder(project.children, (session) => session.id, app.config?.taskOrder?.[group]).map((session) => session.id)
  const next = movedBefore(list, held.key, key)
  if (next !== list) {
    try {
      await app.patchConfig({ taskOrder: { ...(app.config?.taskOrder ?? {}), [group]: next } })
    } catch {
      // patchConfig already toasts prefSaveFailed.
    }
  }
}

const carrying = (kind: CarryKind, key: string) => carried.value?.kind === kind && carried.value.key === key
const landing = (kind: CarryKind, key: string) => carried.value?.kind === kind && dropBefore.value === key

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
  folderRing.value = { top: top - base.top - root.clientTop + root.scrollTop, height: bottom - top }
}

/*
 * MiMo 26.920's edge lines: a hairline above and below the list, each shown
 * only while rows lie hidden past it - clear at the top until the list is
 * scrolled, clear at the bottom once it is scrolled to the end or has nothing
 * to scroll.
 */
const atTop = ref(true)
const atEnd = ref(true)

function measureEdges() {
  const root = listsEl.value
  if (!root) return
  atTop.value = root.scrollTop <= 0
  atEnd.value = root.scrollTop + root.clientHeight >= root.scrollHeight - 1
}

let edgeWatch: ResizeObserver | undefined
onMounted(() => {
  measureEdges()
  if (!listsEl.value) return
  edgeWatch = new ResizeObserver(measureEdges)
  edgeWatch.observe(listsEl.value)
})
onUpdated(measureEdges)
onBeforeUnmount(() => edgeWatch?.disconnect())

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
  try {
    emit("dropFolders", await window.mcode.directoriesOf([...new Set(paths)]))
  } catch (err) {
    // Do not emit [] — that trips side.dropNotDir ("not a folder") for an IPC failure.
    notifyFailure(t("common.requestFailed"), err instanceof Error ? err.message : String(err))
  }
}

/* MiMo saves each section's fold - 置顶, Projects, Recent - and starts every one open. */
function storedOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "false"
  } catch {
    return true
  }
}

function keepOpen(key: string, open: boolean) {
  try {
    localStorage.setItem(key, String(open))
  } catch {}
}

const pinnedOpen = ref(storedOpen(PINNED_OPEN_KEY))

function togglePinnedOpen() {
  pinnedOpen.value = !pinnedOpen.value
  keepOpen(PINNED_OPEN_KEY, pinnedOpen.value)
}

const pinnedMore = ref(false)

interface ColumnBlock {
  key: string
  kind: "pinned-head" | "pinned-more" | "projects-head" | "projects-empty" | "projects-pages" | "session" | "project"
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
    // MiMo's 暂无项目 when nothing is left below 置顶.
    ...(projectsOpen.value && !normalProjects.value.length ? [{ key: "projects-empty", kind: "projects-empty" } as ColumnBlock] : []),
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
/*
 * How Recent is ordered, chosen from its heading's menu. MiMo starts every
 * launch at 最近 and never saves the choice; the key earlier builds wrote is
 * taken away so it cannot linger. Held in the store, because the numbered
 * shortcuts count along the same order.
 */
try {
  localStorage.removeItem("mcode.recentSort")
} catch {}
const recentSort = computed({ get: () => app.recentSort, set: (mode) => (app.recentSort = mode) })

/* MiMo's setSort: only a real change is said. */
function setRecentSort(mode: "recent" | "name") {
  if (mode === recentSort.value) return
  recentSort.value = mode
  notify(t(mode === "name" ? "toast.sortByName" : "toast.sortByRecent"))
}

const recentAll = computed(() => {
  const listed = new Set(projects.value.map((project) => project.directory))
  const rows = app.sessions.filter(
    (session) => !session.archived && !listed.has(projectOf(session) ?? "") && !app.isPinned(session.id),
  )
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
  return dateIn(at, { weekday: "long" })
}

/* subagents: the subagents still working for each conversation whose own turn has ended, for MiMo 26.920's chip. */
const workingFor = computed(() => subagentsAtWork(app.subagentSessions, app.running, app.rootOf))

/* The names of the subagents still working for a conversation, for its card's 运行中的子智能体 line; MiMo leaves an unnamed one out. */
function runningNames(sessionID: string): string[] {
  return (workingFor.value.get(sessionID) ?? []).map((session) => session.title?.trim() ?? "").filter(Boolean)
}

/* Their names, as a list is written in the reader's language. */
function subagentNames(sessions: SessionInfo[]): string {
  const names = sessions.map((session) => session.title?.trim() || t("subagentActivity.fallbackName"))
  try {
    return new Intl.ListFormat(language.value, { type: "conjunction" }).format(names)
  } catch {
    return names.join(", ")
  }
}

/* A conversation at work, or one whose subagents still are. */
const working = (sessionID: string) => app.running.has(sessionID) || workingFor.value.has(sessionID)

/* What a conversation is waiting on, most urgent first. */
type Attention = "waiting" | "unread" | "active"
const RANK: Record<Attention, number> = { waiting: 0, unread: 1, active: 2 }

function attentionOf(sessionID: string): Attention | undefined {
  if (questions.needsConfirm(sessionID)) return "waiting"
  if (app.unseen.has(sessionID) || app.failed(sessionID)) return "unread"
  if (working(sessionID)) return "active"
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
  if (questions.needsConfirm(sessionID) && app.currentID !== sessionID) return "waiting"
  if (working(sessionID)) return "running"
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
    rows.push({ session, note: groupNote(session) })
  }
  return rows
})

/* The priority view, top to bottom: attention, pinned when asked for, the week. */
const priorityList = computed<TimelineEntry[]>(() => [
  entry({ section: "priority", group: "priority" }),
  ...attention.value.map((session) => entry({ session, note: groupNote(session), group: "priority" })),
  ...(showPinned.value
    ? [
        entry({ section: "pinned", group: "pinned" }),
        ...pinnedSessions.value.map((session) => entry({ session, note: groupNote(session), group: "pinned" })),
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
 * The bottom row's menu, where MiMo keeps its account menu: settings, with its
 * shortcut. MCode has no account, so MiMo's account card, profile, usage and
 * sign-out rows have nothing to stand for; MiMo 26.920 has no quit row here
 * either (the menu bar and the tray quit).
 */
const footMenu = ref<{ x: number; y: number; end: boolean; width: number }>()

/** MiMo's account menu is 248 wide; MCode's column is narrower, so the menu is never wider than the row's own strip. */
const FOOT_MENU_WIDTH = 248

/** A gear on the 16 grid: the toothed outline and the hub. Settings used to be eight spokes round a dot, which read as a sun. */
const GEAR_ICON =
  "M8.15 1.33h-0.29a1.33 1.33 0 0 0 -1.33 1.33v0.12a1.33 1.33 0 0 1 -0.67 1.15l-0.29 0.17a1.33 1.33 0 0 1 -1.33 0l-0.1 -0.05a1.33 1.33 0 0 0 -1.82 0.49l-0.15 0.25a1.33 1.33 0 0 0 0.49 1.82l0.1 0.07a1.33 1.33 0 0 1 0.67 1.15v0.34a1.33 1.33 0 0 1 -0.67 1.16l-0.1 0.06a1.33 1.33 0 0 0 -0.49 1.82l0.15 0.25a1.33 1.33 0 0 0 1.82 0.49l0.1 -0.05a1.33 1.33 0 0 1 1.33 0l0.29 0.17a1.33 1.33 0 0 1 0.67 1.15V13.33a1.33 1.33 0 0 0 1.33 1.33h0.29a1.33 1.33 0 0 0 1.33 -1.33v-0.12a1.33 1.33 0 0 1 0.67 -1.15l0.29 -0.17a1.33 1.33 0 0 1 1.33 0l0.1 0.05a1.33 1.33 0 0 0 1.82 -0.49l0.15 -0.26a1.33 1.33 0 0 0 -0.49 -1.82l-0.1 -0.05a1.33 1.33 0 0 1 -0.67 -1.16v-0.33a1.33 1.33 0 0 1 0.67 -1.16l0.1 -0.06a1.33 1.33 0 0 0 0.49 -1.82l-0.15 -0.25a1.33 1.33 0 0 0 -1.82 -0.49l-0.1 0.05a1.33 1.33 0 0 1 -1.33 0l-0.29 -0.17a1.33 1.33 0 0 1 -0.67 -1.15V2.67a1.33 1.33 0 0 0 -1.33 -1.33zM8 6a2 2 0 1 1 0 4a2 2 0 1 1 0-4"

const footMenuItems = computed<MenuItem[]>(() => [
  {
    key: "settings",
    label: t("rail.settings"),
    hint: "Ctrl+,",
    icon: GEAR_ICON,
  },
])

/**
 * Opens above the row, since the row sits at the bottom of the window: y is the
 * menu's bottom edge. It lines up with the row's start, as MiMo's does - the
 * right edge when the interface runs right to left - and spans at most the
 * strip the row sits in (the column less its 8px margins), so it never reaches
 * over the column's edge, however narrow the column is dragged.
 */
function openFootMenu(event: MouseEvent) {
  const row = event.currentTarget as HTMLElement
  const from = row.getBoundingClientRect()
  const end = getComputedStyle(row).direction === "rtl"
  const strip = (row.closest(".foot") ?? row).getBoundingClientRect()
  footMenu.value = { x: Math.round(end ? from.right : from.left), y: Math.round(from.top - 4), end, width: Math.floor(Math.min(FOOT_MENU_WIDTH, strip.width)) }
}

function pickFootMenu(key: string) {
  footMenu.value = undefined
  if (key === "settings") emit("settings")
}

const PROJECTS_OPEN_KEY = "mcode.projectsOpen"
const RECENT_OPEN_KEY = "mcode.recentOpen"
const projectsOpen = ref(storedOpen(PROJECTS_OPEN_KEY))
const recentOpen = ref(storedOpen(RECENT_OPEN_KEY))
function toggleProjectsOpen() {
  projectsOpen.value = !projectsOpen.value
  keepOpen(PROJECTS_OPEN_KEY, projectsOpen.value)
}
function toggleRecentOpen() {
  recentOpen.value = !recentOpen.value
  keepOpen(RECENT_OPEN_KEY, recentOpen.value)
}
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

/* MiMo's side resizer: a 7px strip over the column's end edge, dragged to set the width. */
const dragging = ref(false)
function beginResize(event: MouseEvent) {
  const startX = event.clientX
  const start = props.width
  const sign = getComputedStyle(event.currentTarget as HTMLElement).direction === "rtl" ? -1 : 1
  let last = start
  dragging.value = true
  document.body.classList.add("resizing")
  const move = (moved: MouseEvent) => {
    last = start + sign * (moved.clientX - startX)
    emit("resize", last, false)
  }
  const done = () => {
    dragging.value = false
    document.body.classList.remove("resizing")
    window.removeEventListener("mousemove", move)
    window.removeEventListener("mouseup", done)
    emit("resize", last, true)
  }
  window.addEventListener("mousemove", move)
  window.addEventListener("mouseup", done)
}

function onResizeKey(event: KeyboardEvent) {
  const sign = getComputedStyle(event.currentTarget as HTMLElement).direction === "rtl" ? -1 : 1
  const step = event.shiftKey ? 40 : 12
  let width: number
  switch (event.key) {
    case "ArrowLeft": width = props.width - step * sign; break
    case "ArrowRight": width = props.width + step * sign; break
    case "Home": width = SIDE_WIDTH_MIN; break
    case "End": width = props.maxWidth; break
    default: return
  }
  event.preventDefault()
  emit("resize", width, true)
}

/*
 * MiMo 26.920's folded column: taken off the screen altogether rather than
 * left as a 62px rail, and shown whole on demand. Resting on the toggle for
 * 150ms floats a preview of the column over the window, 8 in from its corner;
 * the pointer can move into it, and 200ms after it has left both the preview
 * goes. Escape, a press anywhere else, the toggle itself, or a move to another
 * screen or conversation put it away at once. The controls row beside the
 * toggle only holds an open preview - resting on 新建任务 opens none.
 */
const preview = ref(false)
const shellEl = ref<HTMLElement>()
const toggleEl = ref<HTMLElement>()
const previewer = sidePreview(() => Boolean(props.collapsed), preview)
const schedulePreview = previewer.schedule
const holdPreview = previewer.hold
const closePreview = previewer.close

function toggleColumn() {
  closePreview()
  emit("toggle")
}

/* An Escape a menu opened from the preview took closes that menu alone. */
function onPreviewKey(event: KeyboardEvent) {
  if (event.key === "Escape" && !event.defaultPrevented) closePreview()
}

/*
 * What the preview opens over the window belongs to it while it is open - a
 * menu with the scrim under it, a conversation's information card - as the
 * portals of MiMo's menus belong to its column: the pointer on them holds the
 * preview, and a press on them is not a press elsewhere.
 */
const PREVIEW_LAYERS = '.scrim, [role="menu"], .app-tip.interactive'
const toolsEl = ref<HTMLElement>()

function inPreview(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(shellEl.value?.contains(target) || toolsEl.value?.contains(target) || target.closest(PREVIEW_LAYERS))
}

/* Held while the pointer is on the preview, the controls beside the toggle or a layer of the preview's; let go 200ms after it leaves them. */
let pointerInPreview = true
function onPreviewOver(event: PointerEvent) {
  const inside = inPreview(event.target)
  if (inside || pointerInPreview) holdPreview(inside)
  pointerInPreview = inside
}

/* Out of the window altogether: no element is entered, so nothing else would say so. */
function onPreviewOut(event: PointerEvent) {
  if (event.relatedTarget || !pointerInPreview) return
  pointerInPreview = false
  holdPreview(false)
}

function onPreviewPress(event: PointerEvent) {
  const target = event.target as Node | null
  if (inPreview(target) || (target && toggleEl.value?.contains(target))) return
  closePreview()
}

watch(preview, (open) => {
  if (open) {
    pointerInPreview = true
    document.addEventListener("keydown", onPreviewKey)
    document.addEventListener("pointerdown", onPreviewPress, true)
    document.addEventListener("pointerover", onPreviewOver, true)
    document.addEventListener("pointerout", onPreviewOut, true)
  } else {
    document.removeEventListener("keydown", onPreviewKey)
    document.removeEventListener("pointerdown", onPreviewPress, true)
    document.removeEventListener("pointerover", onPreviewOver, true)
    document.removeEventListener("pointerout", onPreviewOut, true)
  }
})
watch(
  () => props.collapsed,
  (folded) => {
    if (!folded) closePreview()
  },
)
watch(() => [props.page, app.currentID], closePreview)
onBeforeUnmount(() => {
  closePreview()
  document.removeEventListener("keydown", onPreviewKey)
  document.removeEventListener("pointerdown", onPreviewPress, true)
  document.removeEventListener("pointerover", onPreviewOver, true)
  document.removeEventListener("pointerout", onPreviewOut, true)
})
</script>

<template>
  <aside class="side" :class="{ folded: collapsed, dragging }" :style="{ width: collapsed ? '0px' : `${RAIL_WIDTH + width}px` }" :aria-label="t('a11y.sidebar')">
    <div
      v-if="!collapsed"
      class="resizer"
      role="separator"
      aria-orientation="vertical"
      :aria-valuenow="width"
      :aria-valuemin="SIDE_WIDTH_MIN"
      :aria-valuemax="maxWidth"
      :aria-label="t('a11y.sidebarResize')"
      tabindex="0"
      data-side-resizer
      @mousedown.prevent="beginResize"
      @keydown="onResizeKey"
    />
    <!--
      Folded, MiMo 26.920 keeps two controls in the title bar, past where its
      rail used to end: the toggle - which previews the column under the
      pointer, so it carries no tip of its own - and 新建任务. Back and forward
      go with the column.
    -->
    <div v-if="collapsed" ref="toolsEl" class="rail-tools" data-collapsed-tools>
      <button
        type="button"
        ref="toggleEl"
        class="ico"
        data-toggle-side
        :aria-label="t('side.toggle')"
        :aria-expanded="preview"
        @pointerenter="schedulePreview(true)"
        @pointerleave="schedulePreview(false)"
        @click="toggleColumn"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="2.5" width="19" height="19" rx="4" />
          <path d="M9 2.5v19" />
        </svg>
      </button>
      <!-- The same speech bubble with a plus as the column's 新建任务, on MiMo's lighter 1.75 line. -->
      <button type="button" class="ico" data-collapsed-new-task :aria-label="t('side.newTask')" v-tip="{ label: t('side.newTask'), hint: 'Ctrl+N' }" @click="closePreview(), emit('newTask')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.3 15.4A9 9 0 1 0 16.5 19.8L21 21z" />
          <path d="M12 9.5v5M9.5 12h5" />
        </svg>
      </button>
    </div>
    <!--
      The column itself, at its own width whatever the container shows of it:
      the whole of it while open, none of it while folded, and all of it again
      as a floating card while previewed.
    -->
    <div
      ref="shellEl"
      class="side-shell"
      :class="{ preview: collapsed && preview }"
      :style="{ width: `${RAIL_WIDTH + width}px` }"
      data-side-shell
      :data-side-preview="collapsed && preview ? '' : undefined"
      :inert="collapsed && !preview ? true : undefined"
      :aria-hidden="collapsed && !preview ? 'true' : undefined"
    >
    <div class="top" :class="{ mac: app.platform === 'darwin' }">
      <button type="button" class="ico side-toggle" :aria-label="t('side.toggle')" v-tip="{ label: t('side.toggle'), hint: 'Ctrl+B' }" @click="toggleColumn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="2.5" width="19" height="19" rx="4" />
          <path d="M9 2.5v19" />
        </svg>
      </button>
      <button type="button" class="ico side-way" :disabled="!canBack" :aria-label="t('side.back')" v-tip="{ label: t('side.back'), hint: 'Ctrl+[' }" @click="emit('back')">
        <svg class="way" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19.5 12h-15M11 5.5 4.5 12l6.5 6.5" />
        </svg>
      </button>
      <button type="button" class="ico side-way" :disabled="!canForward" :aria-label="t('title.forward')" v-tip="{ label: t('title.forward'), hint: 'Ctrl+]' }" @click="emit('forward')">
        <svg class="way" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4.5 12h15M13 5.5l6.5 6.5-6.5 6.5" />
        </svg>
      </button>
    </div>

    <div class="brand">
      <span class="brand-name">MCode</span>
      <span v-if="brandBadge" class="badge">{{ brandBadge }}</span>
      <!--
        MiMo 26.920's search and bell: out of the title-bar row and into this
        one, their end 16 short of the column's (its left at the column's width
        less 72).
      -->
      <span class="brand-actions" data-brand-actions>
        <button type="button" class="ico" data-search :aria-label="t('side.search')" v-tip="{ label: t('side.search'), hint: 'Ctrl+K' }" @click="closePreview(), emit('search')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.9" />
            <path d="m15.6 15.6 4.8 4.8" />
          </svg>
        </button>
        <!-- MiMo's priority filter: the column led by what wants attention, then the rest of the week by day. -->
        <button
          type="button"
          class="ico bell"
          :class="{ on: priority }"
          :aria-pressed="Boolean(priority)"
          :aria-label="t(priority ? 'side.priorityOff' : 'side.priorityOn')"
          v-tip="t(priority ? 'side.priorityTipOff' : 'side.priorityTipOn', { shortcut: shownChord('Ctrl+Alt+U') })"
          @click="emit('toggle-priority')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6.2 16.6V11a5.8 5.8 0 0 1 11.6 0v5.6l1.8 1.9H4.4z" />
            <path d="M10 21.2a2.1 2.1 0 0 0 4 0" />
          </svg>
        </button>
      </span>
    </div>

    <nav class="nav" :aria-label="t('key.groupNavigation')">
      <!-- MiMo's 新建任务: a round speech bubble, its tail at the lower end, a plus inside - 24 grid, 2 line, 18px. -->
      <button type="button" class="row" data-new-task @click="emit('newTask')">
        <svg class="row-ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20.3 15.4A9 9 0 1 0 16.5 19.8L21 21z" />
          <path d="M12 9.5v5M9.5 12h5" />
        </svg>
        <span class="row-label">{{ t("side.newTask") }}</span>
      </button>
      <!-- MiMo's plugins row sits between these two; the user asked for it hidden. -->
      <button
        type="button"
        class="row"
        :class="{ on: page === 'artifacts' }"
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

    <div
      ref="listsEl"
      class="lists"
      :class="{ 'at-top': atTop, 'at-end': atEnd }"
      data-sidebar-content
      @scroll="measureEdges"
      @dragover="folderOver"
      @dragleave="folderLeave"
      @drop="folderDrop"
    >
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
          <button type="button" class="section-head" :aria-expanded="pinnedOpen" @click="togglePinnedOpen">
            <span>{{ t("side.priorityPinned") }}</span>
            <svg class="chev" :class="{ shut: !pinnedOpen }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
            </svg>
          </button>
        </div>
        <button type="button" v-else-if="block.kind === 'pinned-more'" class="pinned-more" data-pin-show-more @click="pinnedMore = true">
          {{ t("side.expandPinned") }}
        </button>
        <div
          v-else-if="block.session"
          class="row task recent pinned-convo"
          :class="{
            on: app.currentID === block.session.id,
            carried: carrying('pinned', block.session.id),
            'lands-before': landing('pinned', block.session.id),
          }"
          :data-pinned-drag="block.session.id"
          :draggable="!anyPicking"
          @dragstart="startCarry($event, 'pinned', block.session.id)"
          @dragover="carryOver($event, 'pinned', block.session.id)"
          @drop="setDown($event, 'pinned', block.session.id)"
          @dragend="endCarry"
          @contextmenu.prevent="openMenu(block.session.id, $event)"
        >
          <button type="button" class="row-open" @click="press(block.session.id)">
            <span v-if="picking" class="tick" :class="{ on: ticked(block.session.id) }" aria-hidden="true">
              <svg v-if="ticked(block.session.id)" width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <!-- MiMo's pinned conversation leads with a conversation mark in a 46px cell. -->
            <span class="convo-cell" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4.5 5h15a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4.5A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5z" />
              </svg>
            </span>
            <ChatLinkMark v-if="app.chatLinksOf(block.session.id).length" :links="app.chatLinksOf(block.session.id)" />
            <RowTitle
              class="row-label task-label"
              v-tip="{ card: convoCard(block.session, app.config?.projectNames, app.chatLinksOf(block.session.id), (id: string) => emit('open', id), app.groupContext, app.automationTasks, runningNames(block.session.id)), placement: 'right', disabled: picking || menuSession === block.session.id }"
              :text="title(block.session.title)"
              :cover="picking ? 0 : TITLE_COVER"
              @rename="!picking && emit('rename', block.session.id)"
            />
            <span v-if="statusOf(block.session.id)" class="row-status" :data-status="statusOf(block.session.id)">
              <span v-if="statusOf(block.session.id) === 'running'" class="status-spin" aria-hidden="true" />
              <span v-else-if="statusOf(block.session.id) === 'unread'" class="status-dot" aria-hidden="true" />
              <span v-else class="status-pill" :aria-label="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
            </span>
          </button>
          <OperationBadges :session-id="block.session.id" :working="working(block.session.id)" />
          <!-- subagents: MiMo 26.920's chip - how many subagents still work for this conversation, named under the pointer. -->
          <button
            v-if="workingFor.get(block.session.id)"
            type="button"
            class="subagent-chip"
            :data-conv-subagent-chip="block.session.id"
            :aria-label="tn('side.subagentChip', workingFor.get(block.session.id)!.length)"
            v-tip="{ label: subagentNames(workingFor.get(block.session.id)!), placement: 'top' }"
            @click.stop="emit('openSubagents', block.session.id)"
          >
            {{ tn("side.subagentChip", workingFor.get(block.session.id)!.length) }}
          </button>
          <span class="row-actions">
            <button
              type="button"
              class="row-menu"
              :aria-label="t('session.options')"
              v-tip="{ label: t('side.priorityMore'), disabled: menuSession === block.session.id }"
              @click.stop="openMenu(block.session.id, $event)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="3" cy="8" r="1.1" fill="currentColor" />
                <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                <circle cx="13" cy="8" r="1.1" fill="currentColor" />
              </svg>
            </button>
            <button type="button" class="row-pin on" :aria-label="t('menu.unpin')" v-tip="t('side.unpinTip')" @click.stop="app.togglePinned(block.session.id)">
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
        <button type="button" class="section-head" :aria-expanded="projectsOpen" @click="toggleProjectsOpen">
          <span>{{ t("side.projects") }}</span>
          <svg class="chev" :class="{ shut: !projectsOpen }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
          </svg>
        </button>
        <!-- MiMo's "+", out of sight until the heading is hovered, opening its two-row menu. -->
        <span class="sec-actions">
          <button
            type="button"
            class="ico add project-new"
            data-new-project-button
            :aria-label="t('side.newProject')"
            aria-haspopup="menu"
            :aria-expanded="Boolean(newProjectMenu)"
            v-tip="{ label: t('side.newProject'), disabled: Boolean(newProjectMenu) }"
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
              <svg v-if="projectTicked(project.directory)" width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <button
              type="button"
              class="project-toggle"
              :aria-expanded="isExpanded(project.directory)"
              :aria-label="project.directory"
              v-tip="{ label: project.directory, disabled: pickingProjects || menuDirectory === project.directory }"
              @click="pressProject(project.directory)"
            >
              <!--
                Open while its tasks are listed under it, as MiMo draws an
                expanded project: MiMo's 16px folders, 24 grid on a 2 line.
              -->
              <svg
                v-if="isExpanded(project.directory)"
                class="row-ico"
                data-folder="open"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M18.5 10v-.8a1.8 1.8 0 0 0-1.8-1.8h-6.1L8.4 5H4.2a1.8 1.8 0 0 0-1.8 1.8v12.4A1.8 1.8 0 0 0 4.2 21" />
                <path d="M4.2 21h12.4a1.8 1.8 0 0 0 1.7-1.2l2.9-7.4a1.6 1.6 0 0 0-1.5-2.4H8.6a1.8 1.8 0 0 0-1.7 1.2z" />
              </svg>
              <svg
                v-else
                class="row-ico"
                data-folder="closed"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M2.4 7a2 2 0 0 1 2-2H9l2.4 3h8.2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4.4a2 2 0 0 1-2-2z" />
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
                  <span v-else class="status-pill" :aria-label="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
                </span>
              </span>
              <span
                v-else-if="!isExpanded(project.directory) && projectStatus(project.children)"
                class="row-status"
                :data-status="projectStatus(project.children)"
              >
                <span v-if="projectStatus(project.children) === 'running'" class="status-spin" aria-hidden="true" />
                <span v-else-if="projectStatus(project.children) === 'unread'" class="status-dot" aria-hidden="true" />
                <span v-else class="status-pill" :aria-label="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
              </span>
            </button>
            <!--
              MiMo's pair on a project row: its menu, then a new task in it. Laid
              over the row's end on hover, as a task row's are, so the project's
              name has the whole row until then. Not there while choosing projects.
            -->
            <span v-if="!pickingProjects" class="row-actions">
              <button
                type="button"
                class="row-menu"
                :aria-label="t('side.projectOptions')"
                v-tip="{ label: t('side.priorityMore'), disabled: menuDirectory === project.directory }"
                @click.stop="openProjectMenu(project.directory, $event)"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="3" cy="8" r="1.1" fill="currentColor" />
                  <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                  <circle cx="13" cy="8" r="1.1" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
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
              <button type="button" class="row-open" @click="press(session.id)">
                <span v-if="picking" class="tick" :class="{ on: ticked(session.id) }" aria-hidden="true">
                  <svg v-if="ticked(session.id)" width="12" height="12" viewBox="0 0 24 24" fill="none">
                    <path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
                <svg v-if="app.isPinned(session.id)" class="pin" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                </svg>
                <ChatLinkMark v-if="app.chatLinksOf(session.id).length" :links="app.chatLinksOf(session.id)" />
                <RowTitle
                  class="row-label task-label"
                  v-tip="{ card: convoCard(session, app.config?.projectNames, app.chatLinksOf(session.id), (id: string) => emit('open', id), app.groupContext, app.automationTasks, runningNames(session.id)), placement: 'right', disabled: picking || menuSession === session.id }"
                  :text="title(session.title)"
                  :cover="picking ? 0 : TITLE_COVER"
                  @rename="!picking && emit('rename', session.id)"
                />
                <span v-if="statusOf(session.id)" class="row-status" :data-status="statusOf(session.id)">
                  <span v-if="statusOf(session.id) === 'running'" class="status-spin" aria-hidden="true" />
                  <span v-else-if="statusOf(session.id) === 'unread'" class="status-dot" aria-hidden="true" />
                  <span v-else class="status-pill" :aria-label="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
                </span>
              </button>
              <!-- subagents: MiMo 26.920's chip - how many subagents still work for this conversation, named under the pointer. -->
              <OperationBadges :session-id="session.id" :working="working(session.id)" />
              <button
                v-if="workingFor.get(session.id)"
                type="button"
                class="subagent-chip"
                :data-conv-subagent-chip="session.id"
                :aria-label="tn('side.subagentChip', workingFor.get(session.id)!.length)"
                v-tip="{ label: subagentNames(workingFor.get(session.id)!), placement: 'top' }"
                @click.stop="emit('openSubagents', session.id)"
              >
                {{ tn("side.subagentChip", workingFor.get(session.id)!.length) }}
              </button>
              <span class="row-actions">
                <button
                  type="button"
                  class="row-menu"
                  :aria-label="t('session.options')"
                  v-tip="{ label: t('side.priorityMore'), disabled: menuSession === session.id }"
                  @click.stop="openMenu(session.id, $event, true)"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <circle cx="3" cy="8" r="1.1" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                    <circle cx="13" cy="8" r="1.1" fill="currentColor" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="row-pin"
                  :class="{ on: app.isPinned(session.id) }"
                  :aria-label="t(app.isPinned(session.id) ? 'menu.unpin' : 'menu.pin')"
                  v-tip="t(app.isPinned(session.id) ? 'side.unpinTip' : 'side.pinTip')"
                  @click.stop="app.togglePinned(session.id)"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                  </svg>
                </button>
              </span>
            </div>
            <button
              type="button"
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
        <div v-else-if="block.kind === 'projects-empty'" class="empty" data-projects-empty data-project-zone>{{ t("side.noProjects") }}</div>
        <div v-else-if="block.kind === 'projects-pages'" class="projects-pages" data-projects-pagination data-project-zone>
          <button type="button" v-if="projectsLeft > 0" class="pages-more" data-projects-show-more :aria-expanded="projectsPaged" @click="moreProjects">
            {{ projectsPaged ? t("side.moreProjectsLeft", { count: projectsLeft }) : t("side.moreProjects") }}
          </button>
          <button type="button" v-if="projectsPaged" class="pages-collapse" data-projects-collapse @click="projectsShown = PROJECT_PAGE">
            {{ t("side.collapseProjects") }}
          </button>
        </div>
      </template>

      <div v-if="!priority" class="section recent-head" :class="{ held: Boolean(recentMenu) }">
        <button type="button" class="section-head" :aria-expanded="recentOpen" @click="toggleRecentOpen">
          <span>{{ t("side.recent") }}</span>
          <svg class="chev" :class="{ shut: !recentOpen }" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" />
          </svg>
        </button>
        <!-- MiMo's two heading actions, out of sight until the heading is hovered. -->
        <span class="sec-actions">
          <button
            type="button"
            class="ico add recent-more"
            :aria-label="t('side.priorityMore')"
            v-tip="{ label: t('side.priorityMore'), disabled: Boolean(recentMenu) }"
            @click.stop="openRecentMenu"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="3" cy="8" r="1.1" fill="currentColor" />
              <circle cx="8" cy="8" r="1.1" fill="currentColor" />
              <circle cx="13" cy="8" r="1.1" fill="currentColor" />
            </svg>
          </button>
          <!-- MiMo's heading new task names no shortcut, unlike the folded rail's. -->
          <button
            type="button"
            class="ico add recent-new"
            :aria-label="t('side.newTask')"
            v-tip="t('side.newTask')"
            @click.stop="emit('newTask')"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 5V15M5 10H15" stroke="currentColor" stroke-linecap="square" />
            </svg>
          </button>
        </span>
      </div>
      <template v-if="priority || recentOpen">
        <!--
          Only once the list has been read. `app.ready` exists for exactly this
          - its own comment says so - and nothing read it, so every cold start
          drew "no tasks" over an empty list for as long as the first
          `session.list` took, then replaced it with the conversations (R25-C3).
          Nothing is drawn in its place: a spinner for a few hundred
          milliseconds is its own flicker.
        -->
        <div v-if="!listed.length && app.ready" class="empty">{{ t("side.noTasks") }}</div>
        <template v-for="(entry, index) in listed" :key="`${entry.group}-${entry.session?.id ?? entry.section ?? entry.head ?? index}`">
        <div v-if="entry.section" class="section priority-head">
          <span class="section-head">{{ t(entry.section === "priority" ? "side.priority" : "side.priorityPinned") }}</span>
          <button
            type="button"
            v-if="entry.section === 'priority'"
            class="ico add more"
            :aria-label="t('side.priorityMore')"
            v-tip="{ label: t('side.priorityMore'), disabled: Boolean(priorityMenu) }"
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
          <button type="button" class="row-open" @click="press(entry.session.id)">
            <span v-if="picking" class="tick" :class="{ on: ticked(entry.session.id) }" aria-hidden="true">
              <svg v-if="ticked(entry.session.id)" width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <svg v-if="app.isPinned(entry.session.id)" class="pin" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
            <ChatLinkMark v-if="app.chatLinksOf(entry.session.id).length" :links="app.chatLinksOf(entry.session.id)" />
            <span class="stack">
              <RowTitle
                class="row-label task-label"
                v-tip="{ card: convoCard(entry.session, app.config?.projectNames, app.chatLinksOf(entry.session.id), (id: string) => emit('open', id), app.groupContext, app.automationTasks, runningNames(entry.session.id)), placement: 'right', disabled: picking || menuSession === entry.session.id }"
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
              <span v-else class="status-pill" :aria-label="t('side.awaitingConfirm')">{{ t("side.awaitingPill") }}</span>
            </span>
          </button>
          <!-- subagents: MiMo 26.920's chip - how many subagents still work for this conversation, named under the pointer. -->
          <OperationBadges :session-id="entry.session.id" :working="working(entry.session.id)" />
          <button
            v-if="workingFor.get(entry.session.id)"
            type="button"
            class="subagent-chip"
            :data-conv-subagent-chip="entry.session.id"
            :aria-label="tn('side.subagentChip', workingFor.get(entry.session.id)!.length)"
            v-tip="{ label: subagentNames(workingFor.get(entry.session.id)!), placement: 'top' }"
            @click.stop="emit('openSubagents', entry.session.id)"
          >
            {{ tn("side.subagentChip", workingFor.get(entry.session.id)!.length) }}
          </button>
          <span class="row-actions">
            <button
              type="button"
              class="row-menu"
              :aria-label="t('session.options')"
              v-tip="{ label: t('side.priorityMore'), disabled: menuSession === entry.session.id }"
              @click.stop="openMenu(entry.session.id, $event)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="3" cy="8" r="1.1" fill="currentColor" />
                <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                <circle cx="13" cy="8" r="1.1" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              class="row-pin"
              :class="{ on: app.isPinned(entry.session.id) }"
              :aria-label="t(app.isPinned(entry.session.id) ? 'menu.unpin' : 'menu.pin')"
              v-tip="t(app.isPinned(entry.session.id) ? 'side.unpinTip' : 'side.pinTip')"
              @click.stop="app.togglePinned(entry.session.id)"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
            </button>
          </span>
        </div>
        </template>
        <button type="button" v-if="!priority && recentLeft > 0" class="show-more" @click="recentShown += RECENT_PAGE">
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
          type="button"
          class="sb-text"
          data-select-all
          @click="allTicked ? emit('batch', 'none') : emit('batch', 'all', selectableIDs)"
        >
          {{ allTicked ? t("batch.selectNone") : t("batch.selectAll") }}
        </button>
        <span class="sb-count">{{ t("batch.selected", { n: String(selecting?.length ?? 0) }) }}</span>
        <button type="button" class="sb-text" data-select-exit @click="emit('batch', 'cancel')">{{ t("batch.cancel") }}</button>
      </div>
      <div class="sb-row sb-actions">
        <button type="button" class="sb-btn" data-batch="archive" :disabled="!selecting?.length" @click="emit('batch', 'archive')">
          {{ t("batch.archiveShort") }}
        </button>
        <button type="button" class="sb-btn danger" data-batch="delete" :disabled="!selecting?.length" @click="emit('batch', 'delete')">
          {{ t("batch.deleteShort") }}
        </button>
      </div>
    </div>

    <!-- The same card for projects: archive their conversations, or take them off the list. -->
    <div v-if="pickingProjects" class="select-bar" data-select-bar="projects">
      <div class="sb-row">
        <button
          type="button"
          class="sb-text"
          data-select-all
          @click="allProjectsTicked ? emit('projectBatch', 'none') : emit('projectBatch', 'all', selectableProjects)"
        >
          {{ allProjectsTicked ? t("batch.projectsSelectNone") : t("batch.projectsSelectAll") }}
        </button>
        <span class="sb-count">{{ t("batch.selected", { n: String(selectingProjects?.length ?? 0) }) }}</span>
        <button type="button" class="sb-text" data-select-exit @click="emit('projectBatch', 'exit')">{{ t("batch.projectsExit") }}</button>
      </div>
      <div class="sb-row sb-actions">
        <button type="button" class="sb-btn" data-batch="archive" :disabled="!selectingProjects?.length" @click="emit('projectBatch', 'archive')">
          {{ t("batch.projectsArchive") }}
        </button>
        <button type="button" class="sb-btn" data-batch="remove" :disabled="!selectingProjects?.length" @click="emit('projectBatch', 'remove')">
          {{ t("batch.projectsRemove") }}
        </button>
      </div>
    </div>

    <button type="button" class="archive-entry" @click="emit('show-archived')">
      {{ t("set.group.archived") }}
    </button>

    <div class="foot">
      <!--
        MiMo 26.920's account row: a 46px cell holding a 28px round avatar, then
        the name. MCode signs nobody in, so the row names this machine and opens
        the menu of what it can honour. A dedicated gear opens Settings in one
        click (UI trust review: settings were buried behind This device).
      -->
      <button
        type="button"
        class="account"
        data-account-menu
        :aria-expanded="Boolean(footMenu)"
        aria-haspopup="menu"
        v-tip="app.version ? { label: t('side.thisDeviceVersion', { version: app.version }), placement: 'top' } : undefined"
        @click="openFootMenu"
      >
        <span class="account-cell">
          <span class="avatar" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4.5" width="18" height="12" rx="2" />
              <path d="M8.5 20h7M12 16.5V20" />
            </svg>
          </span>
        </span>
        <span class="account-label">{{ t("side.thisDevice") }}</span>
      </button>
      <button
        type="button"
        class="settings-gear"
        data-settings-open
        :aria-label="t('side.settingsGearTip')"
        v-tip="{ label: t('side.settingsGearTip'), hint: 'Ctrl+,' }"
        @click="emit('settings')"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path :d="GEAR_ICON" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <!-- MiMo's update capsule, beside the row. -->
      <UpdatePill />
    </div>
    </div>
    <ContextMenu
      v-if="footMenu"
      :x="footMenu.x"
      :y="footMenu.y"
      :items="footMenuItems"
      above
      :end="footMenu.end"
      :min-width="footMenu.width"
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
/*
 * Numbers from Xiaomi MiMo's side column, measured in CSS pixels.
 *
 * The aside is only what the column takes of the window - MiMo's reveal width,
 * eased over its 200ms when it folds or opens, none at all while folded - and
 * the column inside it keeps its own width throughout.
 */
.side {
  position: relative;
  flex-shrink: 0;
  width: 256px;
  height: 100%;
  background: var(--surface-base);
  color: var(--text-strong);
  font-size: calc(14px * var(--ui-font-scale, 1));
  user-select: none;
  transition: width 0.2s cubic-bezier(0.7, 0.1, 0.5, 0.9);
}

.side.folded {
  overflow: hidden;
}

.side.dragging {
  transition: none;
}

.side-shell {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  height: 100%;
  background: var(--surface-base);
  visibility: visible;
}

/* Folded, the column is hidden once the container has closed over it. */
.side.folded .side-shell:not(.preview) {
  visibility: hidden;
  transition: visibility 0s 0.2s;
}

/*
 * MiMo 26.920's preview: the whole column as a card 8 in from the window's
 * corner and 16 short of its height, 16 round on a hairline under the menus'
 * shadow, above the conversation (190) and below the toggle that opened it.
 */
.side-shell.preview {
  position: fixed;
  inset-block-start: 8px;
  inset-inline-start: 8px;
  z-index: 190;
  height: calc(100% - 16px);
  overflow: hidden;
  border: 1px solid var(--border-weak);
  border-radius: 16px;
  box-shadow: var(--shadow-menu);
}

/*
 * MiMo's --sidebar-brand-top is 43 inside the preview card, whose top and
 * hairline stand 9 below the window's: the brand row stays at 52 on screen.
 */
.side-shell.preview .top {
  height: 43px;
}

/* In the preview the title bar's own toggle stands where this row's did, and back and forward stay folded away. */
.side-shell.preview .side-toggle,
.side-shell.preview .side-way {
  display: none;
}

.side-shell.preview * {
  -webkit-app-region: no-drag;
}

/* MiMo's .resizer.r-side: 7 wide, 3 of it past the column's end, drawing nothing. */
.resizer {
  position: absolute;
  inset-block: 0;
  inset-inline-end: -3px;
  z-index: 30;
  width: 7px;
  cursor: col-resize;
  -webkit-app-region: no-drag;
}

/* The window-control row: the toggle, back and forward, 24x24 at 32px pitch.
   It drags the window; the buttons opt out. 52 tall - MiMo 26.920's
   --sidebar-brand-top - so the brand row starts 52 down.
   MiMo starts the row at x=65; MCode keeps it to the left on purpose, the 17px
   glyphs lining up with the brand and the destination icons at x=22. Only on
   macOS does it start further in, clear of the traffic lights - see .top.mac. */
.top {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  gap: 8px;
  height: 52px;
  padding-block: 13px 0;
  padding-inline: 18px 8px;
  -webkit-app-region: drag;
}

.top.mac {
  /*
   * Clear of the traffic lights, which the window places at x=20 and which
   * measure 60px, so they end at 80. macOS's own toolbars leave about a light's
   * width and a half after them; 98 starts the row there instead of the old 65,
   * which put the first button's box under the green light.
   */
  padding-inline-start: 98px;
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

/* MiMo's hover colour for these is its --color-txt, #151c13cc light and #f4f4f5 dark (below). */
.ico:hover {
  color: var(--text-body);
  background: var(--surface-hover);
}

.ico:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}

/*
 * The title-bar row in MiMo's --color-topbar-icon: the strongest text at 60%
 * on a light ground (#151c1399), and #f4f4f5 rather than white on a dark one.
 * Its glyphs are drawn on a 24 grid with a 2-unit round stroke shown at 14px,
 * the bell at 16 - about a 1.2px line, where the old 17px icons on a 20 grid
 * came out near 0.85.
 */
.top .ico,
.brand-actions .ico,
.rail-tools .ico {
  color: #151c1399;
}

/* The bell alone rests in MiMo's --color-mut, which is a step back from the others on dark. */
.brand-actions .ico.bell {
  color: var(--text-base);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .top .ico,
  :root:not([data-theme="light"]) .brand-actions .ico,
  :root:not([data-theme="light"]) .rail-tools .ico {
    color: #f4f4f5;
  }

  :root:not([data-theme="light"]) .brand-actions .ico.bell {
    color: var(--text-base);
  }
}

:root[data-theme="dark"] .top .ico,
:root[data-theme="dark"] .brand-actions .ico,
:root[data-theme="dark"] .rail-tools .ico {
  color: #f4f4f5;
}

:root[data-theme="dark"] .brand-actions .ico.bell {
  color: var(--text-base);
}

/*
 * MiMo on Windows: these glyphs 12px in its own --color-topbar-icon for that
 * platform, #2b2b2b light and #ececec dark (below) - the bell included, since
 * --topbar-priority-color and --topbar-hover-color both point at it there. A
 * spent arrow and the lit bell keep their own.
 */
.app[data-platform="win32"] .top .ico:not(:disabled),
.app[data-platform="win32"] .brand-actions .ico:not(.on),
.app[data-platform="win32"] .rail-tools .ico:not(:disabled),
.app[data-platform="win32"] .top .ico:not(:disabled):hover,
.app[data-platform="win32"] .brand-actions .ico:not(.on):hover,
.app[data-platform="win32"] .rail-tools .ico:not(:disabled):hover {
  color: #2b2b2b;
}

:root[data-theme="dark"] .app[data-platform="win32"] .top .ico:not(:disabled),
:root[data-theme="dark"] .app[data-platform="win32"] .brand-actions .ico:not(.on),
:root[data-theme="dark"] .app[data-platform="win32"] .rail-tools .ico:not(:disabled),
:root[data-theme="dark"] .app[data-platform="win32"] .top .ico:not(:disabled):hover,
:root[data-theme="dark"] .app[data-platform="win32"] .brand-actions .ico:not(.on):hover,
:root[data-theme="dark"] .app[data-platform="win32"] .rail-tools .ico:not(:disabled):hover {
  color: #ececec;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .app[data-platform="win32"] .top .ico:not(:disabled),
  :root:not([data-theme="light"]) .app[data-platform="win32"] .brand-actions .ico:not(.on),
  :root:not([data-theme="light"]) .app[data-platform="win32"] .rail-tools .ico:not(:disabled),
  :root:not([data-theme="light"]) .app[data-platform="win32"] .top .ico:not(:disabled):hover,
  :root:not([data-theme="light"]) .app[data-platform="win32"] .brand-actions .ico:not(.on):hover,
  :root:not([data-theme="light"]) .app[data-platform="win32"] .rail-tools .ico:not(:disabled):hover {
    color: #ececec;
  }
}

.app[data-platform="win32"] .top .ico svg,
.app[data-platform="win32"] .brand-actions .ico svg,
.app[data-platform="win32"] .rail-tools .ico svg {
  width: 12px;
  height: 12px;
}

/* MiMo draws the folded 新建任务 an eighth larger than the row's other glyphs. */
.app[data-platform="win32"] .rail-tools [data-collapsed-new-task] svg {
  width: calc(12px * 8 / 7);
  height: calc(12px * 8 / 7);
}

/* Right to left, back points the way the line came from - rightward - and forward the other way. */
.way:dir(rtl) {
  transform: scaleX(-1);
}

/* Nowhere to go back or forward to: MiMo leaves the arrow at a third, and it does nothing. */
.ico:disabled,
.ico:disabled:hover {
  color: var(--text-base);
  background: transparent;
  cursor: default;
  opacity: 0.35;
}

/* The name row: 28 tall, 14 in from the 8px inset, straight under the 52px controls row. */
.brand {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  height: 28px;
  margin: 0 8px;
  padding-inline-start: 14px;
}

/* MiMo's [data-brand-actions]: 24 tall, 8 apart, ending 8 in from the row's end - 16 from the column's. */
.brand-actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  height: 24px;
  margin-inline: auto 8px;
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
  height: calc(16px * var(--ui-font-scale, 1));
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

/*
 * Windows high contrast paints every row as Canvas, which hid the open one:
 * there it keeps a system-highlight outline. Nothing changes outside that mode.
 */
@media (forced-colors: active) {
  .row.on {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }
}

.row-ico {
  flex-shrink: 0;
}

.row-label {
  overflow: hidden;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(20px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-label.plain {
  font-weight: 400;
  line-height: calc(22px * var(--ui-font-scale, 1));
}

/*
 * MiMo's list box: 18 below the destinations, from the column's 8px inset to 2
 * short of its end, 6 of that kept clear at the end so the rows stay 16 in from
 * both edges; 8 of room at the bottom. Its hairlines are line-soft, and each is
 * clear while nothing is hidden past it.
 */
.lists {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  margin-block-start: 18px;
  margin-inline: 8px 2px;
  padding-block-end: 8px;
  padding-inline-end: 6px;
  overflow-y: auto;
  border-block: 1px solid transparent;
  transition: border-color var(--motion-fast, 0.12s);
}

/*
 * Every row keeps its height and the list scrolls: the compact rows set a
 * min-height of 0, and as flex items they had been squeezed to fit instead,
 * so a long list never scrolled and the lines below never showed.
 */
.lists > * {
  flex-shrink: 0;
}

.lists:not(.at-top) {
  border-block-start-color: #0000000d;
}

.lists:not(.at-end) {
  border-block-end-color: #0000000d;
}

:root[data-theme="dark"] .lists:not(.at-top) {
  border-block-start-color: #ffffff12;
}

:root[data-theme="dark"] .lists:not(.at-end) {
  border-block-end-color: #ffffff12;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .lists:not(.at-top) {
    border-block-start-color: #ffffff12;
  }

  :root:not([data-theme="light"]) .lists:not(.at-end) {
    border-block-end-color: #ffffff12;
  }
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

/* The first heading keeps its place under the destinations: the list's own 18 and hairline stand in for the rest. */
.lists > .section:first-child,
.lists > .folder-ring + .section {
  margin-top: 17px;
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
  line-height: calc(16px * var(--ui-font-scale, 1));
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

/*
 * A row's own button takes the keyboard, but the ring goes round the whole row,
 * as it does round 新建任务 (user, 2026-09-29): a task's button starts 46 in and
 * a project's stops before its inline buttons, so a ring on the button sat off
 * the row's highlight - and was square, the button having no corners of its own.
 */
.row:has(> .row-open:focus-visible),
.row:has(> .project-toggle:focus-visible) {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}

.row > .row-open:focus-visible,
.row > .project-toggle:focus-visible {
  outline: none;
}

.row.project {
  gap: 0;
  padding-inline: 0 9px;
}

.row.project > .project-toggle {
  gap: 0;
}

/* The 16px folder centred in MiMo's 46px cell, so the name starts at 46. */
.row.project > .project-toggle > .row-ico {
  margin-inline: 15px;
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
  line-height: calc(22px * var(--ui-font-scale, 1));
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
  /* Its keyboard ring rounds like every other ring in the column (user, 2026-09-29: no square rings); nothing else shows it. */
  border-radius: 4px;
}

/* MiMo's section toggle keyboard ring: 1px in its muted text colour, 2px out. */
button.section-head:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--text-strong) 60%, transparent);
  outline-offset: 2px;
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

/* MiMo's --color-side-item: #4a4a4a on light, #ccc on dark (below). */
.task-label {
  color: #4a4a4a;
  font-weight: 400;
  line-height: calc(22px * var(--ui-font-scale, 1));
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
  line-height: calc(19.2px * var(--ui-font-scale, 1));
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

/* MiMo's show-more row: 12px in its muted colour, 9 by 7 of padding, and no fill under the pointer. */
.show-more {
  width: 100%;
  padding: 7px 9px;
  color: var(--text-base);
  border-radius: 6px;
  font-size: calc(12px * var(--ui-font-scale, 1));
  text-align: start;
}

.show-more:hover {
  color: var(--text-body);
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

/* 展开更多 under the first five pinned rows: 12px in the muted colour, 9 in, 5 above and below. */
.pinned-more {
  width: 100%;
  padding: 5px 9px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  line-height: calc(22px * var(--ui-font-scale, 1));
  text-align: start;
}

.pinned-more:hover {
  color: var(--text-body);
}

/* Under a project's first five: 12px in the muted colour, in line with the task names. */
.project-show-all {
  width: 100%;
  padding-block: 5px;
  padding-inline: 46px 9px;
  color: var(--text-base);
  font-size: calc(12px * var(--ui-font-scale, 1));
  /* MiMo's buttons keep the body's 22px line, which makes the row 32 tall. */
  line-height: calc(22px * var(--ui-font-scale, 1));
  text-align: start;
}

.project-show-all:hover {
  color: var(--text-body);
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
  color: var(--text-base);
  font-size: inherit;
  text-align: start;
}

.projects-pages button:hover {
  color: var(--text-body);
}

.pages-more {
  flex: 1;
  min-width: 0;
}

.pages-collapse {
  flex: none;
  margin-inline-start: auto;
}

/*
 * The priority filter's bell, 6 round where search is 7, lit while on. MiMo's
 * lit colour overrides the row's in every theme, so this outranks the dark rows above.
 */
.ico.bell {
  border-radius: 6px;
}

/* MiMo's --color-priority-on is #3295fb on both schemes, not the accent that turns over with them. */
.ico.bell.on,
:root .brand-actions .ico.bell.on {
  color: #3295fb;
}

/* The priority section's menu button shows while its heading is hovered. */
.priority-head .more {
  opacity: 0;
}

.priority-head:hover .more,
.priority-head .more:focus-visible {
  opacity: 1;
}

.archive-entry {
  flex-shrink: 0;
  align-self: flex-start;
  margin: 0 8px;
  padding: 6px 8px;
  border-radius: 6px;
  color: var(--text-weak);
}

.archive-entry:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.archive-entry:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

/*
 * MiMo's side-bottom: 4 above, then its row 6 lower, beside the update capsule
 * 8 away, all 10 above the window's bottom edge.
 */
.foot {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  margin: 10px 8px;
}

/* The row: 38 tall (more under a larger interface font), 8 round, 14px regular in the strongest text. */
.account {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  min-height: 38px;
  color: var(--text-strong);
  border-radius: 8px;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 400;
  text-align: start;
  transition: background var(--motion-fast, 0.12s);
}

.account:hover {
  background: var(--surface-hover);
}

.account:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
}

.account-cell {
  display: grid;
  flex: none;
  place-items: center;
  width: 46px;
  height: 38px;
}

.account-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  line-height: calc(20px * var(--ui-font-scale, 1));
  text-overflow: ellipsis;
  white-space: nowrap;
}

.settings-gear {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  color: var(--text-base);
  border-radius: 8px;
  transition: background var(--motion-fast, 0.12s), color var(--motion-fast, 0.12s);
}

.settings-gear:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/*
 * MiMo 26.920's folded controls on Windows: the toggle at 62 + 13 = 75, where
 * its rail used to end, and 新建任务 8 past it, over the conversation's top
 * strip - and over the preview (201 to its 190) once that is open.
 */
.rail-tools {
  position: fixed;
  top: 13px;
  inset-inline-start: 98px;
  z-index: 201;
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}

/*
 * Folded, the controls keep the side column's own start, as the unfolded row
 * does (`.top`, 18): the user's 2026-09-21 choice extends the left-aligned top
 * row to the folded state. Only macOS moves them in, clear of the traffic
 * lights, to the same 98 as the unfolded row - 75 left them under the green
 * light, whose group now ends at 80.
 */
.app:not([data-platform="darwin"]) .rail-tools {
  inset-inline-start: 18px;
}

/* MiMo's avatar: 28 round on its input-border line, the glyph 15px. */
.avatar {
  display: grid;
  box-sizing: border-box;
  place-items: center;
  width: 28px;
  height: 28px;
  overflow: hidden;
  border: 1px solid #151c130f;
  border-radius: 50%;
}

:root[data-theme="dark"] .avatar {
  border-color: #2e2e2e;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .avatar {
    border-color: #2e2e2e;
  }
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
  color: var(--text-base);
}

.row-menu {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-inline-start: 4px;
  color: var(--text-base);
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
  color: var(--text-body);
  background: var(--surface-hover);
}

/*
 * Selection mode: a box before each row, and the bar that acts on them. MiMo's
 * is 18 on a 5px corner, outlined in its --color-dim while empty and filled
 * with its --color-send, tick in --color-send-fg, once it is ticked.
 */
.tick {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 18px;
  height: 18px;
  color: transparent;
  background: transparent;
  border: 1px solid var(--text-weak);
  border-radius: 5px;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.tick.on {
  color: #ffffff;
  background: #151c13;
  border-color: #151c13;
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

.sb-text:focus-visible,
.sb-btn:focus-visible,
.show-more:focus-visible,
.pages-more:focus-visible,
.pages-collapse:focus-visible,
.pinned-more:focus-visible,
.project-show-all:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: 2px;
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
  color: var(--text-body);
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
  color: var(--text-base);
  border-radius: 6px;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.row:hover .row-pin,
.row-pin:focus-visible,
.row-pin.on {
  opacity: 1;
}

/* A pinned row's pin keeps MiMo's --color-priority-on, one blue in both schemes. */
.row-pin.on {
  color: #3295fb;
}

.row-pin:hover {
  color: var(--text-body);
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

/*
 * subagents: MiMo 26.920's chip - a 10px pill on the hover colour, 6 after the
 * spinner (the row's 14 less 8), stepping 54px aside for the row's pin and
 * menu when the row is under the pointer, and over their scrim.
 */
.subagent-chip {
  position: relative;
  z-index: 1;
  flex: none;
  align-self: center;
  margin-inline-start: -8px;
  padding: 1px 6px;
  color: var(--text-weak);
  background: var(--surface-hover);
  border-radius: 999px;
  font-size: calc(10px * var(--ui-font-scale, 1));
  line-height: calc(14px * var(--ui-font-scale, 1));
  white-space: nowrap;
  transition: transform var(--motion-fast, 0.12s);
}

.subagent-chip:hover {
  color: var(--text-strong);
}

.row:hover .subagent-chip,
.row:focus-within .subagent-chip {
  transform: translateX(-54px);
}

.row:hover .subagent-chip:dir(rtl),
.row:focus-within .subagent-chip:dir(rtl) {
  transform: translateX(54px);
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

/* MiMo's --color-blue, which --interactive already is: #2f6fed light, #5a9cff dark. */
.status-dot {
  width: 7px;
  height: 7px;
  background: var(--interactive);
  border-radius: 50%;
}

.status-pill {
  height: calc(17px * var(--ui-font-scale, 1));
  padding: 0 7px;
  color: #fff;
  background: #6b7280;
  border-radius: 999px;
  font-size: calc(10px * var(--ui-font-scale, 1));
  font-weight: 500;
  line-height: calc(17px * var(--ui-font-scale, 1));
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
  inset-inline: 0 6px;
  z-index: 2;
  border-radius: 8px;
  /* MiMo's accent, orange in both themes. */
  outline: 2px dashed #ff6a2b;
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

/*
 * MiMo's --color-txt, --color-side-item, --color-send and --color-send-fg on
 * the dark scheme. Written out because no token holds that pair, so the
 * pair is written out.
 */
:root[data-theme="dark"] .ico:hover,
:root[data-theme="dark"] .row-menu:hover,
:root[data-theme="dark"] .row-pin:hover,
:root[data-theme="dark"] .show-more:hover,
:root[data-theme="dark"] .pinned-more:hover,
:root[data-theme="dark"] .project-show-all:hover,
:root[data-theme="dark"] .projects-pages button:hover,
:root[data-theme="dark"] .sb-btn:not(.danger) {
  color: #f4f4f5;
}

:root[data-theme="dark"] .task-label {
  color: #cccccc;
}

:root[data-theme="dark"] .tick.on {
  color: #0d0d0d;
  background: #ececec;
  border-color: #ececec;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ico:hover,
  :root:not([data-theme="light"]) .row-menu:hover,
  :root:not([data-theme="light"]) .row-pin:hover,
  :root:not([data-theme="light"]) .show-more:hover,
  :root:not([data-theme="light"]) .pinned-more:hover,
  :root:not([data-theme="light"]) .project-show-all:hover,
  :root:not([data-theme="light"]) .projects-pages button:hover,
  :root:not([data-theme="light"]) .sb-btn:not(.danger) {
    color: #f4f4f5;
  }

  :root:not([data-theme="light"]) .task-label {
    color: #cccccc;
  }

  :root:not([data-theme="light"]) .tick.on {
    color: #0d0d0d;
    background: #ececec;
    border-color: #ececec;
  }
}
</style>
