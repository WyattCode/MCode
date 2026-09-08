<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { GitChange, GitStatus } from "@shared/protocol"
import type { MenuItem } from "../lib/menu"
import ContextMenu from "./ContextMenu.vue"
import { FILE_MANAGER_ID, fileManagerLabel, openApps, type OpenApp } from "@shared/open-app"
import ContextRing from "./ContextRing.vue"
import ContextView from "./ContextView.vue"
import { useApp } from "../stores/app"
import ReviewPatch from "./ReviewPatch.vue"
import { badgeStyle, fileBadge } from "../lib/filetype"
import { readContext } from "./session-context"
import { t } from "../lib/i18n"

/**
 * The file column is opened and closed from two places - the button in this
 * panel's own bar, and Ctrl+\\ from anywhere - so the state belongs to whoever
 * can hear both.
 *
 * `panelTab` and `contextTab` sit with the parent for the same reason. The ring
 * in the session header is what usually asks for the Context tab, and the
 * header is a sibling of this panel rather than a child of it, so neither can
 * see the other's state - only something above both of them can.
 *
 * `canReview` is whether the review side is on offer at all. This panel can be
 * up purely because the Context tab was asked for, and in that state a Review
 * tab would be offering back the thing the reader had just put away.
 */
const props = defineProps<{
  treeOpen?: boolean
  width?: number
  contextTab?: boolean
  panelTab?: "review" | "context"
  canReview?: boolean
}>()

const emit = defineEmits<{
  notes: [notes: { file: string; line: number; text: string }[]]
  export: []
  "update:treeOpen": [open: boolean]
  "update:width": [width: number]
  "update:contextTab": [open: boolean]
  "update:panelTab": [tab: "review" | "context"]
}>()

const app = useApp()

type Tab = "review" | "changes" | "files"
/*
 * Review, not the file list. The title bar's button says "toggle review" and
 * the panel answers to review-panel; opening it onto a plain directory tree
 * made the control and the thing it opens disagree about what this is.
 */
const tab = ref<Tab>("review")

/**
 * Whether the strip is on its Context side.
 *
 * The parent works this out, because a tab that has been taken out of the strip
 * cannot be the one showing and only the parent knows which tabs exist. This
 * side just believes what it is handed.
 */
const onContext = computed(() => props.panelTab === "context")

/**
 * How full the model's context is, for the ring in front of the tab's label.
 *
 * Zero rather than nothing when the window the tokens were spent against is
 * unknown, which is what the reference does at this site: its indicator reads
 * `context()?.usage ?? 0` and draws an empty ring, where its session header
 * hides the control entirely until there is a figure. The two are not
 * inconsistent - the header's ring is the only way into this view, so a ring
 * with no denominator there would be a control that says nothing, while here
 * the tab is already open and the ring is describing it.
 *
 * The arithmetic is the same `readContext` the header and the Context view
 * read, so the three cannot come to different answers about one session.
 */
const contextPercent = computed(() => readContext(app.messages, app.providers)?.percent ?? 0)

/*
 * Picking a review tab moves the strip too, not only the sub-tab.
 *
 * One call rather than two halves on each button: the half that is easy to
 * forget is the second one, and forgetting it leaves someone pressing
 * "Changes" and watching a column of token counts refuse to go away.
 */
function pickReview(next: Tab) {
  tab.value = next
  if (onContext.value) emit("update:panelTab", "review")
}

/**
 * What the tab strip is labelled by, for the panel underneath it.
 *
 * Only one of the review bodies is ever mounted, so they can share an id and
 * point at whichever of the three tabs put them there.
 */
const reviewTabID = computed(() => `review-panel-tab-${tab.value}`)

const strip = ref<HTMLElement>()

/*
 * The tab being read has to be the tab you can see.
 *
 * Measured at this panel's 360px floor, which is where a 700-800px window puts
 * it: four tabs are wider than the bar (scrollWidth 354 against clientWidth 227
 * at 800px), so opening Context from the ring left the figures on screen while
 * the strip still showed Review, Changes and All files - the one tab that was
 * actually selected was scrolled off the end and nothing said so.
 *
 * The frame is the reference's, not decoration: `createFileTabListSync`
 * (main-8t-QUXax.js @5231411) schedules its scroll in a
 * `requestAnimationFrame` rather than acting the moment the list changes,
 * because the widths it has to measure are not settled until layout has run.
 * `nextTick` gets the new tab into the document; the frame gets its width.
 */
function revealActiveTab() {
  void nextTick(() => {
    requestAnimationFrame(() => {
      // The wrapper rather than the tab inside it where there is one, so the
      // close button is brought along instead of being left over the edge.
      strip.value
        ?.querySelector('.tab-wrap.on, [aria-selected="true"]')
        ?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" })
    })
  })
}

watch([() => props.panelTab, () => props.contextTab, tab], revealActiveTab)

/*
 * WHY THE WATCH ALONE WAS NOT ENOUGH, which is the whole of the defect.
 *
 * This panel is mounted by `v-if="reviewPanelUp"` (App.vue:2467), and
 * `reviewPanelUp` becomes true *because* a tab was asked for: pressing the
 * header's ring on a closed panel sets `contextTab` and `panelTab` together
 * (App.vue's `toggleContext`), and only then does the panel exist. So the
 * component's first render already has its final props, the watch has no change
 * to observe, and it never fires - the one path that most needs the strip moved
 * is the one path the watch cannot see. A watch with `immediate` would do it,
 * but this says plainly that the first reveal belongs to mounting.
 */
onMounted(revealActiveTab)

/**
 * A vertical wheel over the strip scrolls it sideways.
 *
 * The reference binds exactly this to the same element - `onWheel` in
 * `createFileTabListSync`: it takes over only when the gesture is more vertical
 * than horizontal, so a trackpad's sideways swipe is left to the browser, and
 * moves 50px a notch. Without it a mouse with one wheel has no way at all to
 * reach a tab that is off the end, since the strip has no scrollbar of its own.
 */
function onStripWheel(event: WheelEvent) {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
  if (!strip.value) return
  strip.value.scrollLeft += event.deltaY > 0 ? 50 : -50
  event.preventDefault()
}

/**
 * Review is git-backed, because "undo this" has to mean something durable -
 * the tool metadata only says which files were touched, not what they held
 * before. Everything here is read from the repository the project sits in.
 */
/*
 * Four ways of asking "what changed", which is four different questions.
 *
 * "Git" is the whole working tree and is the one that is true the moment a
 * session opens, so it is where the panel starts - the narrower two describe
 * work this session has done, and say nothing at all before it has done any.
 * "Branch" reaches past the working tree to everything committed since this
 * branch left its trunk.
 */
type Scope = "turn" | "session" | "git" | "branch"
const SCOPES = ["turn", "session", "git", "branch"] as const
const scopeLabel: Record<Scope, string> = {
  turn: "review.lastTurn",
  session: "review.sessionChanges",
  git: "review.gitChanges",
  branch: "review.branchChanges",
}
const scope = ref<Scope>("git")
const scopeOpen = ref(false)
const git = ref<GitStatus>()
const patches = ref<Record<string, string>>({})

/**
 * Files whose large-diff guard the reader has pressed through.
 *
 * It lives here rather than in ReviewPatch because ReviewPatch does not last
 * long enough to hold it: the diff is mounted with `v-if="patches[selected]"`,
 * so moving to a file whose patch has not been fetched yet unmounts it, and the
 * decision went with it - press "Render anyway", look at the next file, come
 * back, and the panel asks again. Per file rather than a flag, because pressing
 * through one enormous diff says nothing about the next one.
 *
 * It does not go any higher than this. The reference keeps the same record in
 * its SessionReview store (main-8t-QUXax.js @5161752), which outlives each
 * diff and dies when the review is torn down - so a module-level set, which
 * would remember for as long as the window is open, would not be the same
 * thing. This panel is unmounted with the review (App.vue's `v-if`), so the
 * list has exactly the reference's lifetime.
 */
const forced = ref<string[]>([])

function forceRender(file: string) {
  if (!forced.value.includes(file)) forced.value = [...forced.value, file]
}
const busy = ref(false)
const confirmRevert = ref<string>()

/** The right-click menu: where it sits, and which file it belongs to. */
const menu = ref<{ x: number; y: number; path: string; name: string; directory: boolean }>()

/**
 * The absolute path, rebuilt from the project root the panel already knows and
 * the relative path the server sent. The separator is taken from the root
 * rather than assumed, so a copied Windows path is not half forward slashes.
 */
const absolute = computed(() => {
  const root = app.current?.directory ?? ""
  if (!menu.value) return ""
  const sep = root.includes("\\") ? "\\" : "/"
  return root.replace(/[\\/]+$/, "") + sep + menu.value.path.split("/").join(sep)
})

function openMenu(event: MouseEvent, node: { path: string; name: string; directory: boolean }) {
  menu.value = { x: event.clientX, y: event.clientY, ...node }
}

function closeMenu() {
  menu.value = undefined
}

const menuItems = computed<MenuItem[]>(() => {
  if (!menu.value) return []
  return [
    // A directory has nothing to open with.
    ...(menu.value.directory ? [] : [{ key: "open", label: t("files.open") }]),
    { key: "reveal", label: t("files.reveal") },
    { key: "relative", label: t("files.copyRelative"), divided: true },
    { key: "absolute", label: t("files.copyPath") },
  ]
})

function pickMenu(key: string) {
  if (key === "open") void openFile()
  else if (key === "reveal") void revealFile()
  else void copyPath(key === "absolute" ? "absolute" : "relative")
}

async function revealFile() {
  const root = app.current?.directory
  if (root && menu.value) await window.mcode.revealFile(root, menu.value.path)
  closeMenu()
}

async function openFile() {
  const root = app.current?.directory
  if (root && menu.value) await window.mcode.openFile(root, menu.value.path)
  closeMenu()
}

/**
 * Which app the trailing button hands the project to.
 *
 * Remembered, as opencode remembers it: its menu is a RadioGroup whose value
 * persists, so the button keeps meaning whatever was last chosen rather than
 * asking again. The file manager is the starting value and the one with no
 * `openWith` - it is the plain "hand it to the desktop" path.
 */
const OPEN_WITH_KEY = "mcode.openWith"

function storedOpenWith(): string {
  try {
    const saved = localStorage.getItem(OPEN_WITH_KEY)
    if (saved && (saved === FILE_MANAGER_ID || apps.value.some((entry) => entry.id === saved))) return saved
  } catch {
    /* A window with storage switched off simply always starts at the default. */
  }
  return FILE_MANAGER_ID
}

const apps = computed<OpenApp[]>(() => openApps(app.platform))
/*
 * What the shell option is called here. It was "File Explorer" outright, which
 * is only true on Windows - the reference names it Finder on a Mac and File
 * Manager elsewhere, and that is the only part of the option the OS changes.
 */
const managerLabel = computed(() => t(fileManagerLabel(app.platform)))
const openWith = ref(FILE_MANAGER_ID)
onMounted(() => (openWith.value = storedOpenWith()))

const chosenApp = computed(() => apps.value.find((entry) => entry.id === openWith.value))
/** What the button says it will do, which is the whole point of remembering. */
const openLabel = computed(() =>
  chosenApp.value ? t(chosenApp.value.label) : managerLabel.value,
)

const appMenu = ref<{ x: number; y: number }>()

/** The panel's own "open in editor": the project, not a file inside it. */
async function openProject() {
  const root = app.current?.directory
  if (!root) return
  await window.mcode.openFile(root, "", chosenApp.value?.openWith)
}

const appMenuItems = computed<MenuItem[]>(() => [
  { key: "heading", label: t("session.header.openIn"), heading: true },
  {
    key: `app.${FILE_MANAGER_ID}`,
    label: managerLabel.value,
    checked: openWith.value === FILE_MANAGER_ID,
  },
  ...apps.value.map((entry) => ({
    key: `app.${entry.id}`,
    label: t(entry.label),
    checked: openWith.value === entry.id,
  })),
  { key: "copyPath", label: t("session.header.open.copyPath"), divided: true },
])

async function pickAppMenu(key: string) {
  appMenu.value = undefined
  if (key === "heading") return
  if (key === "copyPath") {
    const root = app.current?.directory
    if (root) await navigator.clipboard.writeText(root)
    return
  }
  const id = key.slice("app.".length)
  openWith.value = id
  try {
    localStorage.setItem(OPEN_WITH_KEY, id)
  } catch {
    /* Not remembering is a smaller failure than refusing to open. */
  }
  await openProject()
}

async function copyPath(which: "absolute" | "relative") {
  const text = which === "absolute" ? absolute.value : (menu.value?.path ?? "")
  if (text) await navigator.clipboard.writeText(text)
  closeMenu()
}

async function load() {
  const directory = app.current?.directory
  if (!directory || !app.client) return
  const result = await app.client.request({ type: "file.list", directory })
  paths.value = result.files.map((file) => file.path)
}

/** Only the branch scope asks git to look past the working tree. */
const gitScope = computed(() => (scope.value === "branch" ? ("branch" as const) : ("worktree" as const)))

async function refreshGit() {
  const directory = app.current?.directory
  if (!directory) return
  git.value = await app.gitStatus(directory, gitScope.value).catch(() => undefined)
}

watch(() => app.current?.directory, load, { immediate: true })

watch(() => [app.current?.directory, tab.value, scope.value] as const, () => {
  if (tab.value === "review") void refreshGit()
}, { immediate: true })

// A finished turn is the moment the review is worth re-reading.
watch(() => app.busy, (running) => {
  if (!running && tab.value === "review") void refreshGit()
})

/*
 * Undo moves files without running a turn, so nothing here would have noticed:
 * the review kept listing changes that had just been put back. The depth of the
 * undo history is the signal that the working tree moved underneath us.
 */
watch(
  () => [app.history.undo, app.history.redo] as const,
  () => {
    if (tab.value === "review") void refreshGit()
    void load()
  },
)

async function createRepo() {
  const directory = app.current?.directory
  if (!directory) return
  busy.value = true
  try {
    git.value = await app.gitInit(directory)
  } finally {
    busy.value = false
  }
}

/** The two narrow scopes filter git's answer down to what the model touched. */
const reviewed = computed<GitChange[]>(() => {
  const all = git.value?.entries ?? []
  if (scope.value === "git" || scope.value === "branch") return all
  const source = scope.value === "turn" ? lastTurnChanged.value : changed.value
  const touched = new Set(source.map((path) => path.replace(/\\/g, "/")))
  return all.filter((entry) => touched.has(entry.path) || touched.has(entry.path.replace(/\\/g, "/")))
})

/*
 * How much of the file to show around each change, and how to lay it out.
 *
 * "Show all lines" is not a second view of the same patch - it is the same
 * question asked of git with a wider window, so switching refetches. Which
 * one you are in is remembered, because it is a way of reading rather than a
 * property of any one file.
 */
type ExpandMode = "collapse" | "expand"
type DiffStyle = "unified" | "split"
const expandMode = ref<ExpandMode>("collapse")
const diffStyle = ref<DiffStyle>("unified")

const CONTEXT: Record<ExpandMode, number> = { collapse: 3, expand: 100_000 }

/** Fetches a file's patch and keeps it for as long as the panel is open. */
async function loadPatch(file: string) {
  const directory = app.current?.directory
  if (!directory) return
  const patch = await app
    .gitDiff(directory, file, CONTEXT[expandMode.value], gitScope.value)
    .catch(() => "")
  patches.value = { ...patches.value, [file]: patch }
}

/*
 * A change committed earlier on the branch cannot be thrown away with a
 * checkout, so the control that claims to do it does not appear there.
 */
const canRevert = computed(() => scope.value !== "branch")

/*
 * The comparison point moved, so every patch fetched against the old one is
 * answering a question no longer being asked.
 *
 * The forced list goes with them, and that part is MCode's own judgement rather
 * than the reference's - the reference has no scope switch, so it has nothing
 * to say here. "Draw this one anyway" was a decision about a diff that no
 * longer exists: the same file compared against the branch point instead of the
 * working tree can be many times larger, and carrying the decision across would
 * disarm the guard at exactly the moment it is worth having.
 */
watch(gitScope, () => {
  patches.value = {}
  forced.value = []
  if (selected.value) void loadPatch(selected.value)
})

/*
 * Widening the window invalidates every patch already fetched, so they are
 * dropped rather than mixed: half the files at three lines of context and half
 * at all of them would be a diff that changes meaning as you page through it.
 */
watch(expandMode, () => {
  patches.value = {}
  // And with them the decision to draw one anyway - see the scope watch above.
  forced.value = []
  if (selected.value) void loadPatch(selected.value)
})

async function revertFile(file: string) {
  const directory = app.current?.directory
  if (!directory) return
  busy.value = true
  try {
    git.value = await app.gitRevert(directory, file)
    const next = { ...patches.value }
    delete next[file]
    patches.value = next
    confirmRevert.value = undefined
  } finally {
    busy.value = false
  }
}
const expanded = ref(new Set<string>())
const paths = ref<string[]>([])

/** Files the most recent reply touched, which is what "last turn" means. */
const lastTurnChanged = computed(() => {
  const out = new Set<string>()
  for (let index = app.messages.length - 1; index >= 0; index -= 1) {
    const message = app.messages[index]
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.name !== "edit" && part.name !== "write") continue
      const path = part.metadata?.path
      if (typeof path === "string") out.add(path)
    }
    break
  }
  return [...out].sort()
})

/** Files touched by tools this session, so "changes" reflects real work. */
const changed = computed(() => {
  const out = new Set<string>()
  for (const message of app.messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if (part.name !== "edit" && part.name !== "write") continue
      const path = part.metadata?.path
      if (typeof path === "string") out.add(path)
    }
  }
  return [...out].sort()
})

interface Node {
  name: string
  path: string
  directory: boolean
  children: Node[]
}

/** Builds a tree from the flat path list the backend returns. */
function toTree(list: string[]): Node[] {
  const root: Node = { name: "", path: "", directory: true, children: [] }
  for (const path of list) {
    const parts = path.split("/")
    let node = root
    parts.forEach((part, index) => {
      const isLeaf = index === parts.length - 1
      const full = parts.slice(0, index + 1).join("/")
      let next = node.children.find((child) => child.name === part)
      if (!next) {
        next = { name: part, path: full, directory: !isLeaf, children: [] }
        node.children.push(next)
      }
      node = next
    })
  }
  const sort = (nodes: Node[]) => {
    nodes.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    nodes.forEach((child) => sort(child.children))
  }
  sort(root.children)
  return root.children
}

const tree = computed(() => toTree(paths.value))

/** Rows are flattened so the template stays a single loop instead of recursing. */
const rows = computed(() => {
  const out: { node: Node; depth: number }[] = []
  const walk = (nodes: Node[], depth: number) => {
    for (const node of nodes) {
      out.push({ node, depth })
      if (node.directory && expanded.value.has(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(tree.value, 0)
  return out
})

function toggle(node: Node) {
  if (!node.directory) return
  const next = new Set(expanded.value)
  if (next.has(node.path)) next.delete(node.path)
  else next.add(node.path)
  expanded.value = next
}

/*
 * The file column, and how wide it is.
 *
 * Folding it away is what lets a diff use the panel's whole width; the width
 * itself is draggable because how much room a path needs depends entirely on
 * how deeply the project nests.
 */
/*
 * How the window divides between the conversation and this panel.
 *
 * opencode's own figures: the conversation never goes below 450, and this
 * panel never below 480 - 800 once a diff is laid out side by side, because
 * two columns of code in less than that is two columns of wrapping. The
 * conversation is what the drag actually sizes; this panel takes the rest.
 */
const SESSION_MIN = 450
const REVIEW_MIN = 480
const REVIEW_MIN_SPLIT = 800

const root = ref<HTMLElement>()

/*
 * The row the panel's column sits in. Widths are shares of the row, and the
 * panel is no longer its direct child - it stacks with the terminal inside a
 * column - so this asks for the row by name instead of walking up a fixed
 * number of levels, which would go wrong again the next time either nests.
 */
function row() {
  return root.value?.closest(".body") as HTMLElement | null
}
const splitting = ref(false)

/** The width the panel would take if nothing had been dragged. */
const DEFAULT_SHARE = 0.625

function clampWidth(want: number, available: number) {
  const floor = diffStyle.value === "split" ? REVIEW_MIN_SPLIT : REVIEW_MIN
  const ceiling = Math.max(floor, available - SESSION_MIN)
  return Math.round(Math.min(ceiling, Math.max(floor, want)))
}

function beginSplit(event: PointerEvent) {
  const element = root.value
  const parent = row()
  if (!element || !parent) return
  const startX = event.clientX
  const startWidth = element.getBoundingClientRect().width
  const available = parent.getBoundingClientRect().width
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  splitting.value = true

  /*
   * Dragging towards the conversation widens the panel. That is leftwards while
   * the interface runs left to right and rightwards when it does not, because
   * the panel changes sides with the language - so the delta is subtracted one
   * way and added the other. Unsigned, both handles dragged backwards in Arabic.
   */
  const sign = getComputedStyle(target).direction === "rtl" ? 1 : -1
  const move = (moved: PointerEvent) => {
    emit("update:width", clampWidth(startWidth + sign * (moved.clientX - startX), available))
  }
  const done = () => {
    splitting.value = false
    target.removeEventListener("pointermove", move)
    target.removeEventListener("pointerup", done)
    target.removeEventListener("pointercancel", done)
  }
  target.addEventListener("pointermove", move)
  target.addEventListener("pointerup", done)
  target.addEventListener("pointercancel", done)
}

/** Back to the share it starts at, which is what a double-click means here. */
function resetSplit() {
  const parent = row()
  if (!parent) return
  emit("update:width", clampWidth(parent.getBoundingClientRect().width * DEFAULT_SHARE, parent.getBoundingClientRect().width))
}

/*
 * Laying a diff out side by side needs more room than reading one. If the
 * panel is already narrower than that, widen it rather than letting the two
 * columns squeeze.
 */
watch(diffStyle, () => {
  const parent = row()
  if (!parent || props.width === undefined) return
  const available = parent.getBoundingClientRect().width
  const fixed = clampWidth(props.width, available)
  if (fixed !== props.width) emit("update:width", fixed)
})

const SIDE_MIN = 200
const SIDE_MAX = 480
const sideOpen = computed({
  get: () => props.treeOpen !== false,
  set: (value: boolean) => emit("update:treeOpen", value),
})
const sideWidth = ref(240)
const resizing = ref(false)

const SIDE_DEFAULT = 240

function resetWidth() {
  sideWidth.value = SIDE_DEFAULT
}

function beginResize(event: PointerEvent) {
  const startX = event.clientX
  const startWidth = sideWidth.value
  const target = event.currentTarget as HTMLElement
  target.setPointerCapture(event.pointerId)
  resizing.value = true

  // As above: the file list is on the other side of the panel in Arabic, so the
  // pointer has to travel the other way to widen it.
  const sign = getComputedStyle(target).direction === "rtl" ? -1 : 1
  const move = (moved: PointerEvent) => {
    const next = startWidth + sign * (moved.clientX - startX)
    sideWidth.value = Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(next)))
  }
  const done = () => {
    resizing.value = false
    target.removeEventListener("pointermove", move)
    target.removeEventListener("pointerup", done)
    target.removeEventListener("pointercancel", done)
  }
  target.addEventListener("pointermove", move)
  target.addEventListener("pointerup", done)
  target.addEventListener("pointercancel", done)
}

/** The file being previewed, and what the list is narrowed to. */
const selected = ref<string>()
const filter = ref("")

/** The files this tab lists, after the filter. */
const listed = computed<GitChange[]>(() => {
  const source: GitChange[] =
    tab.value === "review"
      ? reviewed.value
      : changed.value.map((path) => ({ path, kind: kindOf(path) }))
  const needle = filter.value.trim().toLowerCase()
  return needle ? source.filter((entry) => entry.path.toLowerCase().includes(needle)) : source
})

/** What git says about a path, for the list the tool metadata builds. */
function kindOf(path: string): GitChange["kind"] {
  return git.value?.entries.find((entry) => entry.path === path)?.kind ?? "modified"
}

const kindLabel: Record<GitChange["kind"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
}

/** Where the shown file sits in the list, which is what the toolbar counts. */
const at = computed(() => listed.value.findIndex((entry) => entry.path === selected.value))

/*
 * The changed files as a tree, which is how they are actually arranged.
 *
 * A flat column of paths repeats the same directory prefix down its whole
 * length and leaves the eye to find where one folder ends. Filtering replaces
 * it with a flat list, because a tree of search results is a tree of mostly
 * empty branches.
 */
interface ChangeNode {
  name: string
  path: string
  directory: boolean
  kind?: GitChange["kind"]
  children: ChangeNode[]
}

const changeTree = computed<ChangeNode[]>(() => {
  const root: ChangeNode = { name: "", path: "", directory: true, children: [] }
  for (const entry of listed.value) {
    const parts = entry.path.split("/")
    let node = root
    parts.forEach((part, index) => {
      const leaf = index === parts.length - 1
      const full = parts.slice(0, index + 1).join("/")
      let next = node.children.find((child) => child.name === part && child.directory !== leaf)
      if (!next) {
        next = { name: part, path: full, directory: !leaf, children: [] }
        node.children.push(next)
      }
      if (leaf) next.kind = entry.kind
      node = next
    })
  }
  const sort = (nodes: ChangeNode[]) => {
    nodes.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    nodes.forEach((child) => sort(child.children))
  }
  sort(root.children)
  return root.children
})

/** Directories the reader has folded away; everything else is open. */
const folded = ref(new Set<string>())

function fold(path: string) {
  const next = new Set(folded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  folded.value = next
}

const changeRows = computed(() => {
  const out: { node: ChangeNode; depth: number }[] = []
  const walk = (nodes: ChangeNode[], depth: number) => {
    for (const node of nodes) {
      out.push({ node, depth })
      if (node.directory && !folded.value.has(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(changeTree.value, 0)
  return out
})

/** Searching flattens it: a tree of matches is mostly empty branches. */
const searching = computed(() => filter.value.trim().length > 0)

/** Picking a file loads its patch and shows it beside the list. */
async function choose(file: string) {
  selected.value = file
  confirmRevert.value = undefined
  if (patches.value[file] === undefined) await loadPatch(file)
}

/**
 * Steps to the file before or after this one, wrapping round the ends.
 *
 * Wrapping rather than stopping, because the list is a ring you are working
 * your way around - reaching the last file and being unable to go on is a
 * dead end where "back to the top" is what was meant.
 */
function step(by: 1 | -1) {
  const files = listed.value
  if (!files.length) return
  const from = at.value < 0 ? 0 : at.value
  const next = files[(from + by + files.length) % files.length]
  if (next) void choose(next.path)
}

/** The file on show, split the way the header prints it: directory, then name. */
const shown = computed(() => {
  const path = selected.value ?? ""
  const cut = path.lastIndexOf("/")
  /*
   * No trailing separator on the directory. The header prints it right to
   * left so that a deep path keeps its tail, and a trailing slash under that
   * rule is drawn at the front - "src/" came out as "/src".
   */
  return { dir: cut < 0 ? "" : path.slice(0, cut), name: cut < 0 ? path : path.slice(cut + 1) }
})

/**
 * How many lines the patch adds and removes.
 *
 * Counted from the patch already on screen rather than asked of git a second
 * time - the numbers have to agree with the lines underneath them, and the
 * only way to guarantee that is to count the same text.
 */
const stat = computed(() => {
  const patch = selected.value ? (patches.value[selected.value] ?? "") : ""
  let add = 0
  let del = 0
  let started = false
  for (const line of patch.split("\n")) {
    if (!started && !line.startsWith("@@")) continue
    started = true
    if (line.startsWith("+")) add += 1
    else if (line.startsWith("-")) del += 1
  }
  return { add, del }
})

/*
 * A file that leaves the list stops being the one on show - otherwise
 * reverting a change left its diff on screen with nothing behind it.
 */
watch(listed, (files) => {
  if (selected.value && !files.some((entry) => entry.path === selected.value)) selected.value = undefined
})

// Switching tabs is switching subject; the old selection does not belong.
watch(tab, () => {
  selected.value = undefined
  filter.value = ""
})

/*
 * Whether the list is scrolled away from either end.
 *
 * The reference drives these off a scroll timeline; measuring is the same
 * answer without needing the feature, and it has to be measured on resize too
 * - a list that fits has no edge to fade, and the window can make it fit.
 */
const scroller = ref<HTMLElement>()
const fadeTop = ref(false)
const fadeBottom = ref(false)

function measure() {
  const element = scroller.value
  if (!element) {
    fadeTop.value = false
    fadeBottom.value = false
    return
  }
  fadeTop.value = element.scrollTop > 0
  fadeBottom.value = element.scrollTop + element.clientHeight < element.scrollHeight - 1
}

/*
 * Left and right step between files, which is how opencode binds them. The
 * listener is on the panel rather than the window so the arrows still belong
 * to whatever has focus everywhere else - a composer, a filter box, the diff.
 */
function onKey(event: KeyboardEvent) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return
  if (!selected.value) return
  event.preventDefault()
  step(event.key === "ArrowRight" ? 1 : -1)
}

let observer: ResizeObserver | undefined
watch(scroller, (element) => {
  observer?.disconnect()
  if (!element) return
  observer = new ResizeObserver(measure)
  observer.observe(element)
  measure()
})
watch([listed, rows, sideWidth], () => requestAnimationFrame(measure))
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <aside
    ref="root"
    class="panel"
    :class="{ splitting }"
    tabindex="-1"
    @keydown="onKey"
  >
    <!--
      The edge between the conversation and this panel, which is a thing you
      drag. Eight pixels to grab, three to see, and the three only appear once
      the pointer is on them.
    -->
    <div
      class="pane-grip"
      :class="{ on: splitting }"
      v-tip="{ label: t('files.resize'), placement: 'right' }"
      @pointerdown.prevent="beginSplit"
      @dblclick="resetSplit"
    />
    <!--
      The panel's own bar. The first control folds the file column away, which
      is what lets a diff use the whole width when the list is not being read.
    -->
    <header class="head">
      <button
        v-if="canReview"
        class="head-toggle"
        :aria-expanded="sideOpen"
        v-tip="{ label: t('files.toggleTree'), placement: 'bottom' }"
        @click="sideOpen = !sideOpen"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.5 1.5V12.2484H6.75M2.5 4.74838H6.75" stroke="currentColor" stroke-width="1" />
          <rect x="8.5" y="3.2168" width="6" height="3" stroke="currentColor" stroke-width="1" />
          <rect x="8.5" y="10.75" width="6" height="3" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>

      <!--
        The strip scrolls sideways rather than squeezing its tabs.

        Four labels, two icon buttons and the bar's padding come to more than
        this panel's 360px floor, so before this the last tab and the open-in-app
        button were simply pushed out of the panel with no way to reach them.
        The reference answers the same problem the same way: the tab list is the
        only part of the bar that can scroll, and the controls either side of it
        stay put.
      -->
      <div ref="strip" class="tabs" role="tablist" @wheel="onStripWheel">
        <button
          v-if="canReview"
          id="review-panel-tab-review"
          class="tab"
          role="tab"
          :aria-selected="!onContext && tab === 'review'"
          :class="{ on: !onContext && tab === 'review' }"
          @click="pickReview('review')"
        >
          {{ t("review.tab") }}
        </button>
        <button
          v-if="canReview"
          id="review-panel-tab-changes"
          class="tab"
          role="tab"
          :aria-selected="!onContext && tab === 'changes'"
          :class="{ on: !onContext && tab === 'changes' }"
          @click="pickReview('changes')"
        >
          {{ t("files.changes", { n: changed.length }) }}
        </button>
        <button
          v-if="canReview"
          id="review-panel-tab-files"
          class="tab"
          role="tab"
          :aria-selected="!onContext && tab === 'files'"
          :class="{ on: !onContext && tab === 'files' }"
          @click="pickReview('files')"
        >
          {{ t("files.all") }}
        </button>

        <!--
          Context joins the strip only once something has asked for it and
          leaves again when it is closed, which is what the reference does: an
          always-present tab would claim room in a bar that is already tight,
          for a view most sessions never open.

          It keeps its own close because the ring in the session header - the
          usual way out - is only drawn once a turn has reported what it spent.
          Reached from the palette on a session that has not answered yet, there
          would otherwise be nothing on screen to close it with.
        -->
        <div v-if="contextTab" class="tab-wrap" :class="{ on: onContext }">
          <button
            id="review-panel-tab-context"
            class="tab ringed"
            role="tab"
            :aria-selected="onContext"
            :class="{ on: onContext }"
            @click="emit('update:panelTab', 'context')"
          >
            <!--
              A ring in front of the word, which is what the reference puts
              here: `<div class="flex items-center gap-2">` holding a
              ProgressCircle at size 16 / strokeWidth 2 and then the localised
              label. Larger and heavier than the header's own ring on purpose -
              the reference draws 16/2 in the tab and 14/1.5 in the header - so
              that it still reads as a gauge at the size a tab label sets.

              Unlabelled, because the tab it sits inside is already the
              accessible name and a second one here would have the control
              announce itself twice. The reference gives its indicator no label
              of its own for the same reason.
            -->
            <ContextRing :percent="contextPercent" :size="16" :stroke="2" />
            <span>{{ t("session.tab.context") }}</span>
          </button>
          <button
            class="tab-close"
            :aria-label="t('common.closeTab')"
            v-tip="{ label: t('common.closeTab'), placement: 'bottom' }"
            @click.stop="emit('update:contextTab', false)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <!--
        A split button, as opencode has it: pressing the face does the
        remembered thing, and the 20px caret beside it chooses what that is.
        Before this the button always went to the file manager and the five
        editors it has strings for were unreachable.
      -->
      <div class="head-open-split">
        <button
          class="head-open"
          :aria-label="t('session.header.open.ariaLabel', { app: openLabel })"
          v-tip="{ label: t('session.header.open.action', { app: openLabel }), placement: 'bottom' }"
          @click="openProject"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 4.5C2 3.67157 2.67157 3 3.5 3H6L7.5 4.75H12.5C13.3284 4.75 14 5.42157 14 6.25V11.5C14 12.3284 13.3284 13 12.5 13H3.5C2.67157 13 2 12.3284 2 11.5V4.5Z"
              stroke="currentColor"
              stroke-width="1"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          class="head-open-more"
          :aria-label="t('session.header.open.menu')"
          @click="
            appMenu = {
              x: ($event.currentTarget as HTMLElement).getBoundingClientRect().right,
              y: ($event.currentTarget as HTMLElement).getBoundingClientRect().bottom + 4,
            }
          "
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325" stroke="currentColor" stroke-linecap="square" />
          </svg>
        </button>
      </div>
    </header>

    <!--
      The other side of the strip. It sits inside this panel rather than beside
      it because that is one panel with two tabs rather than two panels taking
      turns: the width the reader dragged, the handle they dragged it with and
      the column it sits in all stay put, and only the contents change.
    -->
    <ContextView
      v-if="onContext"
      id="review-panel-context-tabpanel"
      role="tabpanel"
      aria-labelledby="review-panel-tab-context"
      @close="emit('update:contextTab', false)"
      @export="emit('export')"
    />

    <div
      v-else-if="git && !git.installed"
      id="review-panel-tabpanel"
      role="tabpanel"
      :aria-labelledby="reviewTabID"
      class="empty"
    >
      {{ t("review.noGit") }}
    </div>

    <div
      v-else-if="tab === 'review' && git && !git.repo"
      id="review-panel-tabpanel"
      role="tabpanel"
      :aria-labelledby="reviewTabID"
      class="init"
    >
      <div class="init-title">{{ t("review.initTitle") }}</div>
      <div class="init-sub">{{ t("review.initSub") }}</div>
      <button class="init-go" :disabled="busy" @click="createRepo">{{ t("review.initAction") }}</button>
    </div>

    <!--
      The whole project has no diff to sit beside it, so that tab keeps the
      panel to itself rather than parking a permanent empty state next to a
      column of file names.
    -->
    <div
      v-else-if="tab === 'files'"
      id="review-panel-tabpanel"
      role="tabpanel"
      :aria-labelledby="reviewTabID"
      class="body"
    >
      <div class="side full">
        <div class="side-filter">
          <label class="search">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M14 14L10.3454 10.3454M6.88889 11.7778C9.58889 11.7778 11.7778 9.58889 11.7778 6.88889C11.7778 4.18889 9.58889 2 6.88889 2C4.18889 2 2 4.18889 2 6.88889C2 9.58889 4.18889 11.7778 6.88889 11.7778Z"
                stroke="currentColor"
                stroke-width="1"
              />
            </svg>
            <input v-model="filter" type="search" :placeholder="t('files.filter')" spellcheck="false" />
          </label>
        </div>
        <div class="side-tree" :class="{ 'fade-top': fadeTop, 'fade-bottom': fadeBottom }">
          <div ref="scroller" class="side-scroll" @scroll="measure">
            <div v-if="!rows.length" class="empty small">{{ t("files.empty") }}</div>
            <button
              v-for="row in rows"
              :key="row.node.path"
              class="row"
              :style="{ paddingInlineStart: `${6 + row.depth * 14}px` }"
              @click="toggle(row.node)"
              @contextmenu.prevent.stop="openMenu($event, row.node)"
            >
              <svg
                v-if="row.node.directory"
                class="chev"
                :class="{ open: expanded.has(row.node.path) }"
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
              </svg>
              <span v-else class="badge" :style="badgeStyle(fileBadge(row.node.name))">
                {{ fileBadge(row.node.name).label }}
              </span>
              <span class="name" :class="{ dir: row.node.directory }">{{ row.node.name }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div
      v-else
      id="review-panel-tabpanel"
      role="tabpanel"
      :aria-labelledby="reviewTabID"
      class="body"
    >
      <!-- What there is to look at. -->
      <div class="side-root" :style="{ width: sideOpen ? `${sideWidth}px` : '0px' }">
        <aside class="side" :class="{ still: resizing }" :aria-hidden="!sideOpen" :style="{ width: `${sideWidth}px` }">
          <div class="side-head">
            <button v-if="tab === 'review'" class="scope-btn" @click="scopeOpen = !scopeOpen">
              <span>{{ t(scopeLabel[scope]) }}</span>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>
            <span v-else class="side-title">{{ t("files.changes", { n: changed.length }) }}</span>
            <div v-if="scopeOpen" class="scope-menu">
              <button
                v-for="entry in SCOPES"
                :key="entry"
                class="scope-item"
                @click="((scope = entry), (scopeOpen = false))"
              >
                <span>{{ t(scopeLabel[entry]) }}</span>
                <svg v-if="entry === scope" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.53613 8.17857L6.39328 11.75L12.4647 4.25" stroke="currentColor" stroke-width="1" />
                </svg>
              </button>
            </div>
          </div>

          <div class="side-filter">
            <label class="search">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M14 14L10.3454 10.3454M6.88889 11.7778C9.58889 11.7778 11.7778 9.58889 11.7778 6.88889C11.7778 4.18889 9.58889 2 6.88889 2C4.18889 2 2 4.18889 2 6.88889C2 9.58889 4.18889 11.7778 6.88889 11.7778Z"
                  stroke="currentColor"
                  stroke-width="1"
                />
              </svg>
              <input v-model="filter" type="search" :placeholder="t('files.filter')" spellcheck="false" />
            </label>
          </div>

          <div class="side-tree" :class="{ 'fade-top': fadeTop, 'fade-bottom': fadeBottom }">
            <div ref="scroller" class="side-scroll" @scroll="measure">
              <div v-if="!listed.length" class="empty small">
                {{ tab === "review" ? t("review.clean") : t("files.noChanges") }}
              </div>

              <!-- Searching: a flat list of what matched. -->
              <template v-if="searching">
                <button
                  v-for="entry in listed"
                  :key="entry.path"
                  class="side-file"
                  :class="{ on: selected === entry.path }"
                  @click="choose(entry.path)"
                  @contextmenu.prevent.stop="
                    openMenu($event, { path: entry.path, name: entry.path, directory: false })
                  "
                >
                  <span class="badge" :style="badgeStyle(fileBadge(entry.path))">
                    {{ fileBadge(entry.path).label }}
                  </span>
                  <span class="side-name">{{ entry.path }}</span>
                  <span class="change" :data-kind="entry.kind" v-tip="{ label: t(`review.${entry.kind}`) }">
                    {{ kindLabel[entry.kind] }}
                  </span>
                </button>
              </template>

              <!-- Otherwise the shape the files are actually in. -->
              <template v-else>
                <button
                  v-for="row in changeRows"
                  :key="row.node.path"
                  class="side-file"
                  :class="{ on: !row.node.directory && selected === row.node.path }"
                  :style="{ paddingInlineStart: `${6 + row.depth * 14}px` }"
                  @click="row.node.directory ? fold(row.node.path) : choose(row.node.path)"
                  @contextmenu.prevent.stop="
                    openMenu($event, {
                      path: row.node.path,
                      name: row.node.name,
                      directory: row.node.directory,
                    })
                  "
                >
                  <svg
                    v-if="row.node.directory"
                    class="chev"
                    :class="{ open: !folded.has(row.node.path) }"
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor" stroke-width="1" />
                  </svg>
                  <span v-else class="badge" :style="badgeStyle(fileBadge(row.node.name))">
                    {{ fileBadge(row.node.name).label }}
                  </span>
                  <span class="side-name flat" :class="{ dir: row.node.directory }">{{ row.node.name }}</span>
                  <span
                    v-if="row.node.kind"
                    class="change"
                    :data-kind="row.node.kind"
                    v-tip="{ label: t(`review.${row.node.kind}`) }"
                  >
                    {{ kindLabel[row.node.kind] }}
                  </span>
                </button>
              </template>
            </div>
          </div>
        </aside>

        <!-- A path column has no natural width; this is where it gets one. -->
        <div
          v-if="sideOpen"
          class="side-resize"
          :class="{ on: resizing }"
          v-tip="{ label: t('files.resize'), placement: 'right' }"
          @pointerdown.prevent="beginResize"
          @dblclick="resetWidth"
        />
      </div>

      <!-- And what is being looked at. -->
      <div class="preview">
        <template v-if="selected">
          <!--
            Where the file sits in the list, and how to leave it. Reading a
            review is a sequence, so stepping is a first-class control rather
            than a return trip to the column on the left.
          -->
          <div class="toolbar">
            <!--
              The file's own name only belongs here when the column that would
              otherwise be showing it is folded away.
            -->
            <div v-if="!sideOpen" class="toolbar-meta">
              <span class="toolbar-title">{{ shown.name }}</span>
              <span class="position">{{ at + 1 }} / {{ listed.length }}</span>
            </div>
            <button
              class="nav"
              :disabled="listed.length < 2"
              v-tip="{ label: t('review.prevFile'), hint: '←', placement: 'bottom' }"
              @click="step(-1)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M10 3.5L6 8L10 12.5" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>
            <button
              class="nav"
              :disabled="listed.length < 2"
              v-tip="{ label: t('review.nextFile'), hint: '→', placement: 'bottom' }"
              @click="step(1)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 3.5L10 8L6 12.5" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>

            <span class="grow" />

            <!-- How much of the file to show, and how to lay the change out. -->
            <div class="segments">
              <div class="segment" role="group" :aria-label="t('review.expandMode')">
                <button
                  class="segment-item"
                  :class="{ on: expandMode === 'expand' }"
                  v-tip="{ label: t('review.showAllLines'), placement: 'bottom' }"
                  @click="expandMode = 'expand'"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M5 6L8 3L11 6M5 10L8 13L11 10" stroke="currentColor" stroke-width="1" />
                  </svg>
                </button>
                <button
                  class="segment-item"
                  :class="{ on: expandMode === 'collapse' }"
                  v-tip="{ label: t('review.hideNonDiffLines'), placement: 'bottom' }"
                  @click="expandMode = 'collapse'"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M5 3L8 6L11 3M5 13L8 10L11 13" stroke="currentColor" stroke-width="1" />
                  </svg>
                </button>
              </div>

              <div class="segment" role="group" :aria-label="t('review.diffView')">
                <button
                  class="segment-item"
                  :class="{ on: diffStyle === 'unified' }"
                  v-tip="{ label: t('review.unifiedDiff'), placement: 'bottom' }"
                  @click="diffStyle = 'unified'"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="2.5" y="3.5" width="11" height="9" stroke="currentColor" stroke-width="1" />
                    <path d="M2.5 6.5H13.5M2.5 9.5H13.5" stroke="currentColor" stroke-width="1" />
                  </svg>
                </button>
                <button
                  class="segment-item"
                  :class="{ on: diffStyle === 'split' }"
                  v-tip="{ label: t('review.splitDiff'), placement: 'bottom' }"
                  @click="diffStyle = 'split'"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="2.5" y="3.5" width="11" height="9" stroke="currentColor" stroke-width="1" />
                    <path d="M8 3.5V12.5" stroke="currentColor" stroke-width="1" />
                  </svg>
                </button>
              </div>
            </div>

            <template v-if="confirmRevert === selected">
              <span class="warn">{{ t("review.reverting") }}</span>
              <button class="ghost" @click="confirmRevert = undefined">{{ t("common.cancel") }}</button>
              <button class="danger" :disabled="busy" @click="revertFile(selected)">{{ t("review.revert") }}</button>
            </template>
            <button
              v-else-if="canRevert"
              class="nav"
              v-tip="{ label: t('review.revert'), placement: 'bottom' }"
              @click="confirmRevert = selected"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3 5.5H9.75C11.5449 5.5 13 6.95507 13 8.75C13 10.5449 11.5449 12 9.75 12H4.5"
                  stroke="currentColor"
                  stroke-width="1"
                />
                <path d="M5.5 3L3 5.5L5.5 8" stroke="currentColor" stroke-width="1" />
              </svg>
            </button>
          </div>

          <!-- The file itself: what moved, what it is called, and by how much. -->
          <div class="file-head">
            <span class="status" :data-kind="kindOf(selected)">{{ kindLabel[kindOf(selected)] }}</span>
            <span class="file-name">{{ shown.name }}</span>
            <span class="file-path">{{ shown.dir }}</span>
            <span class="file-diff">
              <span class="add">+{{ stat.add }}</span>
              <span class="del">-{{ stat.del }}</span>
            </span>
          </div>

          <div class="diff-scroll">
            <ReviewPatch
              v-if="patches[selected]"
              :file="selected"
              :patch="patches[selected]"
              :layout="diffStyle"
              :forced="forced.includes(selected)"
              @render-anyway="forceRender(selected)"
            />
            <div v-else class="empty small">{{ t("review.clean") }}</div>
          </div>
        </template>

        <div v-else class="preview-empty">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1" />
            <path d="M8 5.5V10.5M5.5 8H10.5" stroke="currentColor" stroke-width="1" />
          </svg>
          <div class="preview-title">{{ listed.length ? t("review.pickFile") : t("review.noChangesTitle") }}</div>
          <div class="preview-sub">{{ listed.length ? t("review.pickFileSub") : t("review.noChangesSub") }}</div>
        </div>

        <!--
          Only once something has been written: an empty review needs no bar,
          and the count is the whole point of the sentence.
        -->
        <div v-if="app.sessionNotes.length" class="notes-bar">
          <button class="notes-send" @click="emit('notes', app.sessionNotes)">
            {{ t("review.sendNotes", { n: app.sessionNotes.length }) }}
          </button>
          <button class="notes-clear" @click="app.clearNotes()">{{ t("review.clearNotes") }}</button>
        </div>
      </div>
    </div>

    <ContextMenu
      v-if="appMenu"
      :x="appMenu.x"
      :y="appMenu.y"
      :items="appMenuItems"
      @pick="pickAppMenu"
      @close="appMenu = undefined"
    />

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :items="menuItems"
      @pick="pickMenu"
      @close="closeMenu"
    />
  </aside>
</template>

<style scoped>
/*
 * Wide, because what it holds is a diff.
 *
 * A three-hundred pixel column can list file names and nothing else - the
 * change itself had to be read through a keyhole. The panel takes the larger
 * share of the window and splits it: names down one side, the change on the
 * other, which is the proportion opencode settles on too.
 */
.panel {
  display: flex;
  flex-direction: column;
  position: relative;
  /*
   * So the list below can answer to the panel's real width rather than to the
   * window's. The two stop agreeing as soon as the panel hits either bound.
   */
  container-type: inline-size;
  /* The column sets the width; the panel takes all of it. */
  width: 100%;
  /*
   * No divider: the panel is its own card now, and the 8px gutter beside it is
   * what separates it from the conversation. The reference's own panel measures
   * `border-inline-start: 0px` for the same reason.
   */
}

/*
 * The panel takes focus so the arrow keys can reach it, but it is a container,
 * not a control - a ring around the whole thing read as a draggable divider
 * down its left edge. The ring belongs on whatever inside it is focused.
 */
.panel:focus,
.panel:focus-visible {
  outline: none;
}

/*
 * Sat over the border rather than beside it, so the panel keeps every pixel of
 * its own width. Three pixels of indicator inside eight of grab area, hidden
 * until the pointer arrives - the same proportions opencode uses.
 */
/*
 * Named for what it is rather than for what it does, because "split" is also
 * what the diff calls its side-by-side layout - and a child component's root
 * carries its parent's scope attribute, so a rule here reaches it.
 */
.pane-grip {
  position: absolute;
  inset-block: 0;
  inset-inline-start: -4px;
  z-index: 30;
  width: 8px;
  cursor: col-resize;
}

.pane-grip::after {
  position: absolute;
  inset-block: 0;
  /* Centred in the eight-pixel grab area. Written as an offset from the start
     edge rather than as a percentage and a transform, so it stays centred when
     the interface mirrors, like every other rule in this file. */
  inset-inline-start: 2.5px;
  width: 3px;
  background: var(--border-strong);
  opacity: 0;
  content: "";
  transition: opacity 0.15s ease-in-out;
}

.pane-grip:hover::after,
.pane-grip.on::after {
  opacity: 1;
}

.head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding-block: 0;
  padding-inline: 8px 12px;
  border-bottom: 1px solid var(--border-weaker);
}

/* First in the bar, and set apart: it acts on the bar's own layout. */
.head-toggle,
/*
 * The two halves read as one control: they share a border and only the seam
 * between them is drawn, which is what makes a split button look like a button
 * with a choice rather than two buttons that happen to touch.
 */
.head-open-split {
  display: flex;
  align-items: center;
  border-radius: var(--radius-md);
  overflow: hidden;
}

.head-open-split:hover {
  background: var(--surface-hover);
}

/* opencode's caret is a 20px column with no border of its own. */
.head-open-more {
  display: grid;
  place-items: center;
  width: 20px;
  align-self: stretch;
  color: var(--icon-base);
  border-inline-start: 1px solid var(--border-weaker);
}

.head-open-more:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.head-open {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 28px;
  color: var(--icon-base);
  border-radius: 6px;
  transition: background 0.12s, color 0.12s;
}

.head-toggle:hover,
.head-open:hover {
  background: var(--surface-hover);
}

.head-toggle[aria-expanded="true"] {
  background: var(--surface-layer);
}

/*
 * The one part of the bar that gives way when there is not enough room.
 *
 * The controls either side of it are fixed-size and must stay reachable, so the
 * tabs scroll under them rather than everything shrinking together. Without
 * `min-width: 0` a flex child refuses to go below the width of its contents and
 * the overflow is pushed out of the panel instead of scrolling inside it, which
 * is how four tabs put the open-in-app button off the edge of the window.
 */
.tabs {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  /* A scrollbar under a 28px tab is thicker than the gap below it and reads as
     a border. The wheel and the keyboard still reach the overflow. */
  scrollbar-width: none;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  height: 28px;
  padding: 0 12px;
  color: var(--text-weak);
  border-radius: var(--radius-md);
  font-size: 12.5px;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}

/* Tabs keep their own width when the strip runs out of room; the strip
   scrolls. */
.tab,
.tab-wrap {
  flex-shrink: 0;
}

.tab:hover {
  color: var(--text-strong);
}

.tab.on {
  color: var(--text-strong);
  background: var(--surface-layer);
}

/*
 * The one tab that is a picture and a word rather than a word.
 *
 * Applied to that tab alone rather than to `.tab`, because the other three hold
 * text and would gain a flex context they have no use for. The 8px is the
 * reference's `gap-2` between its ProgressCircle and the label beside it.
 */
.tab.ringed {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/*
 * A tab and its close, sharing one highlight.
 *
 * The close sits inside the tab's own background rather than after it, so the
 * pair reads as one control - and the tab's padding is trimmed on that side to
 * stop the two together being half as wide again as the tabs beside them.
 */
.tab-wrap {
  display: flex;
  align-items: center;
  padding-inline-end: 6px;
  border-radius: var(--radius-md);
  transition: background 0.12s;
}

.tab-wrap.on {
  background: var(--surface-layer);
}

.tab-wrap .tab {
  padding-inline-end: 6px;
  background: none;
}

/*
 * Out of the way until it is wanted.
 *
 * Shown on the tab that is open and while the pointer is on the pair, which is
 * what the reference does. Kept in the layout at all times rather than dropped
 * out of it, so the strip does not shift sideways under the pointer as it
 * appears.
 */
.tab-close {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--text-weak);
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.12s, background 0.12s, color 0.12s;
}

.tab-wrap.on .tab-close,
.tab-wrap:hover .tab-close,
.tab-close:focus-visible {
  opacity: 1;
}

.tab-close:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.grow {
  flex: 1;
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* Names down one side... */
.side-root {
  position: relative;
  display: flex;
  flex-shrink: 0;
  min-width: 0;
  /*
   * The dragged width is an upper bound, not a promise. In a panel too narrow
   * to honour it, a list that refuses to shrink does not stay readable - it
   * pushes the diff, and everything in the diff's header, out past the panel's
   * edge. 200 is what opencode leaves the diff at its narrowest.
   */
  max-width: calc(100% - 200px);
  overflow: hidden;
  transition: width 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

/*
 * Below this the list is not narrow, it is gone.
 *
 * Squeezed by the cap above, the names column reaches a width that shows
 * nothing - 56px at the smallest window this app will open - and the reader is
 * left with a sliver of truncated names next to a diff that has no room
 * either. One of the two has to go, and it is the names: the diff is what was
 * being read, and the fold control at the head of the panel brings the list
 * back the moment there is room for it. 420 is opencode's own 200 floor for
 * this list plus the 200 the diff needs beside it, plus the seam.
 */
@container (max-width: 420px) {
  .side-root {
    max-width: 0;
  }
}

.side {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  /* Follows the cap above rather than the width it was dragged to. */
  max-width: 100%;
  min-height: 0;
  /* The seam faces the diff, which is whatever side the names are not on. */
  border-inline-end: 1px solid var(--border-weaker);
}

/* Dragging is a direct manipulation; easing it makes the edge lag the pointer. */
.side-root:has(.side-resize.on) {
  transition: none;
}

.side.full {
  flex: 1;
  width: auto;
  border-inline-end: none;
}

.side-head {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-block: 12px;
  padding-inline: 8px 16px;
}

.side-title {
  padding-inline-start: 8px;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.side-filter {
  flex-shrink: 0;
  box-sizing: border-box;
  min-width: 0;
  padding: 0 8px 4px;
}

/*
 * A text-input-v2, which is 28 tall: the 35 measured off the reference was the
 * slot around it, three above the field and four below.
 */
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  margin-top: 3px;
  padding: 0 8px;
  color: var(--text-weak);
  background: linear-gradient(180deg, rgb(255 255 255 / 0.02) 0%, rgb(255 255 255 / 0) 100%),
    var(--surface-base);
  border: 0;
  border-radius: 6px;
  outline: 1px solid transparent;
  box-shadow: var(--shadow-input);
  transition: outline-color 85ms ease-out, box-shadow 85ms ease-out;
}

.search:focus-within {
  outline-color: var(--interactive);
  box-shadow: none;
}

.search svg {
  flex-shrink: 0;
}

.search input {
  flex: 1;
  min-width: 0;
  color: var(--text-strong);
  background: none;
  border: none;
  outline: none;
  font: inherit;
  font-size: 12.5px;
}

.search input::placeholder {
  color: var(--text-weak);
}

/*
 * A list that runs past its box says so at the edge it runs past. Both fades
 * are always painted and merely hidden, so appearing costs no layout.
 */
.side-tree {
  position: relative;
  flex: 1;
  min-height: 0;
}

.side-tree::before,
.side-tree::after {
  position: absolute;
  z-index: 10;
  height: 16px;
  visibility: hidden;
  content: "";
  pointer-events: none;
  inset-inline: 0;
}

.side-tree::before {
  top: 0;
  background: linear-gradient(to bottom, var(--surface-base), transparent);
}

.side-tree::after {
  bottom: 0;
  background: linear-gradient(to top, var(--surface-base), transparent);
}

.side-tree.fade-top::before,
.side-tree.fade-bottom::after {
  visibility: visible;
}

.side-scroll {
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: 100%;
  padding: 4px 8px 12px;
  overflow-y: auto;
}

/*
 * A fixed 28px row rather than one sized by its text, so a list of files reads
 * as an even column whatever the names in it are.
 */
.side-file,
.row {
  box-sizing: border-box;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding-inline-end: 8px;
  padding-inline-start: 6px;
  color: var(--text-base);
  border-radius: 6px;
  text-align: start;
  transition: background 0.12s, color 0.12s;
}

.side-file:hover,
.row:hover {
  background: var(--surface-hover);
}

/*
 * Selection is a fill, not a ring. A ring is what focus means, and drawing one
 * around whichever file happens to be on show made every click look as though
 * the keyboard had landed there.
 */
.side-file.on,
.side-file.on:hover {
  color: var(--text-strong);
  background: var(--surface-selected);
}

/* Drawn inside the row: it is as wide as the scroller, so a ring set outside
   it is clipped away at both edges. */
.side-file:focus-visible,
.row:focus-visible {
  outline: 2px solid var(--interactive);
  outline-offset: -2px;
}

.side-name {
  overflow: hidden;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* The end of a path is the part that identifies it, so that is the end kept. */
  direction: rtl;
  text-align: left;
}

/*
 * The turned-round direction above is a truncation device and not a reading
 * order, so asking for the start of the line would resolve against it and
 * leave every name stranded at the far side of its own row. The row is what
 * knows which way the reader goes, so both sides are named outright.
 */
[dir="rtl"] .side-name {
  text-align: right;
}

/* A name in the tree is already just a name; it truncates from the end. */
.side-name.flat {
  direction: ltr;
}

.side-name.dir {
  color: var(--text-strong);
}

/* The letter git already reported, in the colour that letter means. */
.change,
.status {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.04px;
  font-variant-numeric: tabular-nums lining-nums;
}

/*
 * The diff's own colours, not the generic semantic pair.
 *
 * The reference decorates a file in the tree with `var(--syntax-diff-add)` and
 * `var(--syntax-diff-delete)` - the same colours its diff paints lines with -
 * so the green on a file agrees with the green inside it. These were --success
 * and --error, which are a different green and a different red: measured at
 * #6bd586 against the diff's #a3da9f in the dark scheme, and #198b43 against
 * #20a923 in the light one.
 *
 * Modified keeps --info: the reference reaches for a third colour there
 * (`--syntax-diff-unknown`) that has no counterpart here, and inventing one
 * would be worse than using the colour this app already means "changed" by.
 */
.change[data-kind="added"],
.status[data-kind="added"] {
  color: var(--diff-add);
}

.change[data-kind="deleted"],
.status[data-kind="deleted"] {
  color: var(--diff-delete);
}

.change[data-kind="modified"],
.status[data-kind="modified"] {
  color: var(--info);
}

/* Zero-width, so the column keeps the width it was given; the grab area is the
   handle's own outline, widened past the edge it sits on. */
.side-resize {
  position: absolute;
  z-index: 20;
  inset-block: 0;
  inset-inline-end: -3px;
  width: 7px;
  cursor: col-resize;
}

.side-resize::after {
  position: absolute;
  inset-block: 0;
  inset-inline-start: 3px;
  width: 1px;
  background: var(--border-strong);
  opacity: 0;
  content: "";
  transition: opacity 0.12s;
}

.side-resize:hover::after,
.side-resize.on::after {
  opacity: 1;
}

/* ...and the change on the other. */
.preview {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.toolbar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 0;
  padding-block: 10px;
  padding-inline: 8px 12px;
  border-bottom: 1px solid var(--border-weaker);
}

/* Tabular, because it is a counter: the digits must not shift as it counts. */
.position {
  flex: none;
  margin-inline-end: 8px;
  color: var(--text-weak);
  font-size: 11px;
  font-weight: 440;
  line-height: 1;
  letter-spacing: 0.05px;
  font-variant-numeric: tabular-nums lining-nums;
  white-space: nowrap;
}

.nav {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 28px;
  color: var(--icon-base);
  border-radius: 6px;
  transition: background 0.12s, color 0.12s, opacity 0.12s;
}

.nav:hover:not(:disabled) {
  background: var(--surface-hover);
}

.nav:disabled {
  opacity: 0.35;
  cursor: default;
}

/* The file's identity, borrowed into the bar the column used to carry it in. */
.toolbar-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding-inline: 4px 8px;
}

.toolbar-title {
  overflow: hidden;
  min-width: 0;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.segments {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-inline-end: 12px;
}

/*
 * Two states of one setting, so they share a trough: the pair reads as a
 * single control with a position rather than as two buttons that happen to
 * disagree.
 */
.segment {
  display: flex;
  align-items: center;
  height: 28px;
  background: var(--surface-raised);
  border-radius: 6px;
  box-shadow: 0 0 0 0.5px var(--border-weak);
}

.segment-item {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 10px;
  color: var(--text-weak);
  border-radius: 6px;
  transition: background 0.12s, color 0.12s, box-shadow 0.12s;
}

.segment-item:hover {
  color: var(--text-strong);
}

.segment-item.on {
  z-index: 1;
  color: var(--text-strong);
  background: var(--surface-base);
  box-shadow: 0 0 0 0.5px var(--border-strong);
}

.warn {
  margin-inline-end: 8px;
  color: var(--text-weak);
  font-size: 12px;
}

.toolbar .ghost {
  height: 26px;
  padding: 0 10px;
  color: var(--text-base);
  border-radius: var(--radius-md);
  font-size: 12px;
}

.toolbar .ghost:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.toolbar .danger {
  height: 26px;
  margin-inline-start: 8px;
  padding: 0 10px;
  color: #fff;
  background: var(--error);
  border-radius: var(--radius-md);
  font-size: 12px;
}

.file-head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-weaker);
}

/* The name carries the weight; the directory it sits in is context, not label. */
.file-name {
  flex: none;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.04px;
  white-space: nowrap;
}

.file-path {
  overflow: hidden;
  flex: 0 1 auto;
  min-width: 0;
  margin-inline-start: -4px;
  color: var(--text-weak);
  font-size: 13px;
  font-weight: 440;
  line-height: 1;
  letter-spacing: -0.04px;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
}

.file-diff {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  margin-inline-start: auto;
  padding-inline-start: 12px;
  font-size: 11px;
  font-weight: 440;
  line-height: 1;
  letter-spacing: 0.05px;
  font-variant-numeric: tabular-nums lining-nums;
}

.file-diff .add {
  color: var(--success);
}

.file-diff .del {
  color: var(--error);
}

.diff-scroll {
  flex: 1;
  min-height: 0;
  padding: 8px 0 16px;
  overflow: auto;
}

/*
 * Pushed above centre rather than centred: an empty state that sits on the
 * exact middle line reads as though it is holding the panel open, and the
 * space below it is where the file list's content would be.
 */
.preview-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px 24px 160px;
  text-align: center;
}

.preview-empty svg {
  flex: none;
  color: var(--text-weaker);
}

.preview-title {
  flex: none;
  margin-top: -8px;
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.04px;
}

.preview-sub {
  flex: none;
  max-width: 282px;
  color: var(--text-weak);
  font-size: 13px;
  font-weight: 440;
  line-height: 20px;
  letter-spacing: -0.04px;
}

/* Sits under the diff, because it acts on every note in the session at once. */
.notes-bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-weaker);
}

.notes-send {
  flex: 1;
  height: 28px;
  padding: 0 10px;
  color: var(--button-primary-text);
  background: var(--button-primary);
  border-radius: 6px;
  font-size: 12.5px;
}

.notes-send:hover {
  filter: brightness(1.08);
}

.notes-clear {
  height: 28px;
  padding: 0 10px;
  color: var(--text-weak);
  border-radius: 6px;
  font-size: 12.5px;
}

.notes-clear:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.init {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px 24px 160px;
  text-align: center;
}

.init-title {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.init-sub {
  max-width: 360px;
  margin-top: -12px;
  color: var(--text-weak);
  font-size: 13px;
  line-height: 20px;
}

.init-go {
  height: 32px;
  padding: 0 16px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: 13px;
}

.init-go:hover:not(:disabled) {
  border-color: var(--border-strong);
}

.scope-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  color: var(--text-strong);
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 500;
  transition: background 0.12s;
}

.scope-btn:hover {
  background: var(--surface-hover);
}

.scope-menu {
  position: absolute;
  top: 40px;
  /* Hung under the button that opens it, which begins where the column does. */
  inset-inline-start: 8px;
  z-index: 20;
  min-width: 190px;
  padding: 4px;
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.scope-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  height: 30px;
  padding: 0 9px;
  color: var(--text-base);
  border-radius: var(--radius-md);
  font-size: 12.5px;
  white-space: nowrap;
}

.scope-item:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.empty {
  padding: 18px 14px;
  color: var(--text-weaker);
  font-size: 12.5px;
}

.empty.small {
  padding: 16px 10px;
  font-size: 12.5px;
}

/*
 * Down when the folder is open, pointing into it when it is not. The glyph is
 * drawn pointing down, so it is the folded state that turns - the other way
 * round left the open folders pointing sideways.
 */
.chev {
  flex-shrink: 0;
  color: var(--text-weaker);
  transform: rotate(-90deg);
  transition: transform 0.12s;
}

.chev.open {
  transform: rotate(0deg);
}

/* Sized to match the directory chevron so names stay on one baseline grid. */
.badge {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 15px;
  margin-inline-start: -3px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 8.5px;
  font-weight: 500;
  letter-spacing: -0.02em;
}

.name {
  overflow: hidden;
  color: var(--text-base);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name.dir {
  color: var(--text-strong);
}
</style>
