<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { AGENT_NAMES, DEFAULT_PERMISSIONS, PERMISSION_KINDS } from "@shared/protocol"
import type { Worktree } from "@shared/protocol"
import { useApp } from "./stores/app"
import Sidebar from "./components/Sidebar.vue"
import HomeHero from "./components/HomeHero.vue"
import SessionHero from "./components/SessionHero.vue"
import SessionHeader from "./components/SessionHeader.vue"
import ContextMenu from "./components/ContextMenu.vue"
import AppMenu from "./components/AppMenu.vue"
import MessageStream from "./components/MessageStream.vue"
import SessionSpine from "./components/SessionSpine.vue"
import Composer from "./components/Composer.vue"
import InfoPanel from "./components/InfoPanel.vue"
import { DEFAULT_APP_ICON } from "@shared/app-icons"
import ArtifactsView from "./components/ArtifactsView.vue"
import PluginsView from "./components/PluginsView.vue"
import RightPanel from "./components/RightPanel.vue"
import CommandPalette, { type PaletteMode } from "./components/CommandPalette.vue"
import QuestionDock from "./components/QuestionDock.vue"
import { useQuestions } from "./stores/questions"
import SettingsDialog from "./components/SettingsDialog.vue"
import ProjectDialog from "./components/ProjectDialog.vue"
import ServerPopover from "./components/ServerPopover.vue"
import ImagePreview from "./components/ImagePreview.vue"
import LiveEditPill from "./components/LiveEditPill.vue"
import { fileRequest, reviewRequest } from "./lib/review-request"
import { foldedMatches } from "./lib/find-folded"
import { imagePreview, videoPreview } from "./lib/image-preview"
import VideoPreview from "./components/VideoPreview.vue"
import ServersDialog from "./components/ServersDialog.vue"
import ReleaseNotesDialog from "./components/ReleaseNotesDialog.vue"
import RenameDialog from "./components/RenameDialog.vue"
import { markUpdateReady } from "./components/UpdatePill.vue"
import TerminalDrawer from "./components/TerminalDrawer.vue"
import Toasts from "./components/Toasts.vue"
import ConfirmDialog from "./components/ConfirmDialog.vue"
import NewProjectDialog from "./components/NewProjectDialog.vue"
import type { MenuItem } from "./lib/menu"
import ConnectDialog from "./components/ConnectDialog.vue"
import SearchOverlay from "./components/SearchOverlay.vue"
import ErrorBoundary from "./components/ErrorBoundary.vue"
import Onboarding from "./components/Onboarding.vue"
import {
  LANGUAGES,
  RTL_LANGUAGES,
  type Language,
  publishMenuLabels,
  language,
  sessionTitle,
  t,
  detectLanguage,
} from "./lib/i18n"
import changelog from "./lib/changelog.json"
import { loadReleaseHighlights, normalizeVersion, type Highlight } from "./lib/changelog"
import { toggleSteps } from "./lib/steps"
import { draftFromMessage, provideRestoreDraft } from "./lib/draft"
import { cycleVariant, findModel } from "./lib/model"
import { PANEL_MIN_WIDTH, useRightPanel } from "./stores/right-panel"
import { SIDE_COLUMN_WIDTH, arbitratePanel, boundChord, sideFits, toolHints } from "./lib/right-tools"
import { exportConversationById, exportConversationMarkdown, saveExport, transcriptOf } from "./lib/convo-export"
import { ZOOM_TOAST, dismiss, notify, notifyFailure, zoomNotice } from "./lib/toast"
import { sessionLink, type SessionLinkTarget } from "@shared/session-link"
import { hush, speak } from "./lib/voice"
import { folderName, projectName } from "./lib/project"
import { renderMarkdown } from "./lib/markdown"
import { chordOf } from "./lib/keys"
import FindBar from "./components/FindBar.vue"
import AnnotationComposer from "./components/AnnotationComposer.vue"
import AnnotationMarkers from "./components/AnnotationMarkers.vue"
import { HOME_SCOPE } from "./stores/annotations"
import { mainAnnotationScope } from "./lib/annotate"
import { createFind, openFind, stepFind } from "./lib/find"
import { chime, play } from "./lib/sound"
import { chimeOf, longTask } from "@shared/chime"
import { themeTokens } from "./lib/theme-engine"
import { DEFAULT_THEME, THEMES, themeByID } from "./lib/theme-palettes"

const app = useApp()
// The confirm dock's queue: permissions and questions for the session on screen.
const confirmDock = useQuestions()

/** "home" is the launcher; "session" is a project workspace. */
const view = ref<"home" | "session" | "artifacts" | "plugins">("home")
/** The 2.0 side column; up unless it has been put away. */
const leftPanel = ref(true)
/* The project a task typed on the home screen will be created in. */
const homeDirectory = ref<string>()
/* The folder the home screen has picked, which its bottom panel's terminal opens in. */
const homeShellDirectory = ref<string>()


/*
 * The info card beside a conversation (2.0, after Xiaomi MiMo's): the plan,
 * what the session produced and what it read. Open unless the reader put it
 * away, and remembered per machine - it is a way of reading, not a property
 * of any one session. Storage can be missing or refuse (a locked-down
 * profile), in which case the card simply starts open every time.
 */
const INFO_KEY = "mcode.infoPanel"
const infoOpen = ref(readInfoOpen())

function readInfoOpen(): boolean {
  try {
    return localStorage.getItem(INFO_KEY) !== "0"
  } catch {
    return true
  }
}

function setInfoOpen(next: boolean) {
  infoOpen.value = next
  try {
    localStorage.setItem(INFO_KEY, next ? "1" : "0")
  } catch {
    // Remembered for this run only.
  }
}

/*
 * MiMo's two ways of showing the card. Beside the conversation while the main
 * column is at least 790 wide - 480 of chat and the 310 the card takes - and
 * floating over it below that. Floating is its own flag, never remembered,
 * shut whenever the column crosses the line either way, and shut again by a
 * click anywhere outside the card.
 */
const INFO_INLINE_MIN = 790
const INFO_PANEL_WIDTH = 310
const mainWidth = ref(0)
const viewportWide = ref(false)
const infoFloating = computed(() => mainWidth.value > 0 && mainWidth.value < INFO_INLINE_MIN)
const infoOverlayOpen = ref(false)
watch(infoFloating, () => (infoOverlayOpen.value = false))

function toggleInfo() {
  if (infoFloating.value) infoOverlayOpen.value = !infoOverlayOpen.value
  else setInfoOpen(!infoOpen.value)
}

function closeInfo() {
  if (infoFloating.value) infoOverlayOpen.value = false
  else setInfoOpen(false)
}

/*
 * Only beside a conversation: the home screen and an empty session have nothing
 * to list. Not while the right panel is expanded over the conversation either,
 * as MiMo draws nothing of the card then.
 */
const infoShowing = computed(
  () =>
    !isHome.value &&
    !empty.value &&
    !(rp.open && rp.fullscreen) &&
    (infoFloating.value ? infoOverlayOpen.value : infoOpen.value),
)
const infoInline = computed(() => infoShowing.value && !infoFloating.value)

/*
 * How much of the column the card holds clear: only what keeps MiMo's 768
 * reading column (1000 on a 2000px screen) out from under a 310 card, so a wide
 * window gives up nothing at all.
 */
const infoInset = computed(() => {
  if (!infoInline.value) return "0px"
  const column = viewportWide.value ? 1000 : 768
  const need = column + INFO_PANEL_WIDTH * 2 - mainWidth.value
  return `${Math.max(0, Math.min(INFO_PANEL_WIDTH, need))}px`
})

let mainObserver: ResizeObserver | undefined
onMounted(() => {
  const pane = mainPane.value
  if (!pane) return
  mainObserver = new ResizeObserver(([entry]) => {
    if (!entry) return
    mainWidth.value = entry.contentRect.width
    viewportWide.value = window.innerWidth >= 2000
  })
  mainObserver.observe(pane)
})
onBeforeUnmount(() => mainObserver?.disconnect())

/*
 * A version that has been fetched and is waiting to be run.
 *
 * The download starts as soon as the check finds one, without asking - which
 * is what the reference does, and why the only thing it ever says out loud is
 * that a new version "is now available to install". Asking first would put a
 * question between the reader and an update they already asked for by running
 * the check.
 */
const downloadedUpdate = ref<string>()
/** A check in flight, so the update page can say 检查中… and not start another. */
const updateChecking = ref(false)

/* Fetched: MiMo's footer capsule and its bubble take it from here, and no modal interrupts. */
async function fetchUpdate(url: string, version: string, sha256: string, notes: string) {
  try {
    await window.mcode.downloadUpdate(url, version, sha256)
    downloadedUpdate.value = version
    markUpdateReady(version, notes)
    notify(t("update.readyToast"))
  } catch (err) {
    notifyFailure(t("update.failed"), reasonOf(err))
  }
}

const terminalOpen = ref(false)
/** How tall the docked terminal is, so the info card can end above it. */
const drawerHeight = ref(0)

/*
 * MiMo's drop overlay: while files are dragged over the window, the main column
 * says they will be added. Only files and links count, as in MiMo - dragged
 * text is not a file - and not while a dialog or overlay has the window.
 */
const fileDrag = ref(false)

function trackDrag(event: DragEvent) {
  const types = [...(event.dataTransfer?.types ?? [])].map((type) => type.toLowerCase())
  if (!types.includes("files") && !types.includes("text/uri-list")) return
  fileDrag.value = !document.querySelector(".scrim, .overlay")
}

function leaveDrag(event: DragEvent) {
  // Leaving one element for another inside the window is not leaving the window.
  if (!event.relatedTarget) fileDrag.value = false
}

function endDrag() {
  fileDrag.value = false
}

/*
 * What changed in the version now running, shown once.
 *
 * opencode's flow, step for step: remember the version last seen, and on the
 * first run where it differs, take the highlights between the two and show
 * them after a short delay. A reader with no remembered version - a fresh
 * install - is told nothing and simply has the current version recorded, so
 * the popup is about an upgrade rather than about arriving.
 *
 * The changelog ships with the build instead of being fetched, which is the
 * one place this departs from opencode. It fetches `opencode.ai/changelog.json`
 * because its releases are published; this app has no such feed, and a local
 * file also means the notes describe the build in hand and appear offline.
 */
const SEEN_VERSION_KEY = "mcode.highlights.v1"
const RELEASE_NOTES_DELAY = 500
const highlights = ref<Highlight[]>([])

function showReleaseNotes() {
  const version = app.version
  if (!version) return
  const previous = localStorage.getItem(SEEN_VERSION_KEY) ?? undefined
  if (!previous) {
    localStorage.setItem(SEEN_VERSION_KEY, version)
    return
  }
  if (normalizeVersion(previous) === normalizeVersion(version)) return
  // Recorded before the dialog, not after: a reader who closes it by quitting
  // should not be shown the same notes again on the next launch.
  localStorage.setItem(SEEN_VERSION_KEY, version)
  if (app.config?.releaseNotes === false) return
  const found = loadReleaseHighlights(changelog, version, previous)
  if (!found.length) return
  window.setTimeout(() => (highlights.value = found), RELEASE_NOTES_DELAY)
}

function dismissReleaseNotes(disable: boolean) {
  highlights.value = []
  if (disable) void app.patchConfig({ releaseNotes: false })
}

/*
 * Once, as soon as both the version and the settings are known - the same gate
 * opencode uses, whose effect waits on `platform.version` and `settings.ready`
 * before it will run. Neither is available at mount: the config arrives over
 * the socket, and reading it early would take the unset default and decide the
 * reader had opted out.
 */
const releaseNotesStarted = ref(false)
watch(
  () => [app.version, app.config] as const,
  ([version, config]) => {
    if (releaseNotesStarted.value || !version || !config) return
    releaseNotesStarted.value = true
    showReleaseNotes()
  },
  { immediate: true },
)

/*
 * Find-in-view over the conversation.
 *
 * opencode mounts its find on the file and diff viewers; this app has one here
 * because the conversation is the long scrolling thing a reader most often
 * wants to search. The module keeps a set of hosts and hands Ctrl+F to
 * whichever one the focus is in, so another viewer can mount one of its own.
 */
const mainPane = ref<HTMLElement>()
const find = createFind({ wrapper: () => mainPane.value, hidden: foldedMatches })
onMounted(() => find.mount())

/*
 * A notification that was clicked opens what it was about.
 *
 * The main process only ever raises one while the window is in the background,
 * so arriving here means the reader came back for this session in particular.
 */
onMounted(() => {
  const off = window.mcode.onNotificationClick((sessionID) => {
    if (sessionID && sessionID !== app.currentID) void app.open(sessionID)
  })
  onBeforeUnmount(off)
  const offLink = window.mcode.onOpenLink(receiveLink)
  onBeforeUnmount(offLink)
})
onBeforeUnmount(() => find.unmount())
const paletteOpen = ref(false)
/* MiMo's search over conversations, projects and artifacts: the side column's magnifier and Ctrl+K. */
const searchOpen = ref(false)
const searchOverlay = ref<InstanceType<typeof SearchOverlay>>()

/* Ctrl+K opens the search, or plays its exit when it is already up. */
function toggleSearch() {
  if (!searchOpen.value) searchOpen.value = true
  else if (searchOverlay.value) searchOverlay.value.close()
  else searchOpen.value = false
}
const settingsOpen = ref(false)
/** Non-default landing page for the settings dialog, when opened from a shortcut. */
const settingsSection = ref<"general" | "keys" | "server" | "models" | "mcp">()

/** The server control opens its own panel rather than general settings. */
const serverPanel = ref(false)
/*
 * Three things need a line of text from the user, and Electron has no
 * window.prompt to fall back on - it throws outright. Each is a flag rather
 * than a promise so the dialog stays declarative like every other overlay.
 */
/*
 * The header, so the rename command can start the title's own editor. Renaming
 * is inline now - there is no dialog left for a flag to open.
 */
/** The project a new workspace is being branched from, while it is being named. */
const namingWorkspace = ref<string>()
const choosingServer = ref(false)
/** Whether the saved-servers dialog is up. */
const managingServers = ref(false)

/*
 * The model menu's "configure custom models" lands on the models page, as MiMo's
 * does; the MCP command and Ctrl+; land on the MCP page, MiMo's only MCP screen.
 */
function openSettings(section?: unknown) {
  settingsSection.value = section === "models" || section === "mcp" ? section : undefined
  settingsOpen.value = true
}

/**
 * The title bar's server control carries a server icon and a status light, so
 * it has to land on the server page - sending it to general settings made the
 * icon a lie.
 */
function openServerInfo() {
  settingsSection.value = "server"
  settingsOpen.value = true
}
/** Directory whose presentation is being edited, if any. */
const editingProject = ref<string>()

/* MiMo's single rename dialog, for a conversation or for a project. */
const renamingSession = ref<{ id: string; title: string }>()
const renamingProject = ref<string>()

function beginRename(sessionID = app.currentID) {
  const session = app.sessions.find((entry) => entry.id === sessionID)
  if (session) renamingSession.value = { id: session.id, title: sessionTitle(session.title) }
}

/* The dialog closes first, then the rename runs, as MiMo orders it. */
async function submitSessionRename(title: string) {
  const target = renamingSession.value
  renamingSession.value = undefined
  if (target && title !== target.title) await app.rename(target.id, title)
}

async function submitProjectRename(name: string) {
  const directory = renamingProject.value
  renamingProject.value = undefined
  if (directory) await app.patchConfig({ projectNames: { ...(app.config?.projectNames ?? {}), [directory]: name } })
}
const composer = ref<InstanceType<typeof Composer>>()
const stream = ref<InstanceType<typeof MessageStream>>()

/*
 * Putting a rolled back message back into the box, for whoever asks.
 *
 * The transcript's Revert button and the dock's Restore button both do it, and
 * neither is anywhere near the composer: all three are siblings here, the
 * prompt is the composer's own state, and the store has no draft in it. This is
 * the one place that can see both ends, so it is where the wire is soldered.
 */
provideRestoreDraft((message) => {
  if (!message) {
    composer.value?.reset()
    return
  }
  composer.value?.set(draftFromMessage(message))
})
const paletteMode = ref<PaletteMode>("files")

/**
 * Starts a workspace: a second checkout of the project, on its own branch.
 *
 * A session is opened in it straight away, because a workspace with nothing
 * working in it is just a directory - the point is to take this conversation
 * somewhere it cannot collide with the one next door.
 */
function newWorkspace() {
  const directory = app.current?.directory ?? app.config?.directory
  if (!directory) return
  namingWorkspace.value = directory
}

async function createWorkspace(directory: string, name: string) {
  namingWorkspace.value = undefined
  if (!name.trim()) return
  try {
    const made = await app.client?.request({
      type: "workspace.create",
      directory,
      name: name.trim(),
    })
    if (!made) return
    startIn(made.directory)
    notify(t("workspace.created", { name: made.branch }))
  } catch (err) {
    notifyFailure(t("workspace.failed"), err instanceof Error ? err.message : String(err))
  }
}

/**
 * The workspace being deleted, and what deleting it would cost.
 *
 * `workspace.remove` has been on the wire and handled by the server since
 * workspaces were built, and nothing in the interface ever called it - a
 * workspace could be made and switched to but never removed, so the worktrees
 * piled up and the only way out was the command line.
 *
 * The state is the whole confirmation rather than a flag, because the warning
 * depends on what git says: `git worktree remove --force` discards uncommitted
 * work without asking, and the reference tells you before that happens
 * (`workspace.status.dirty`, "unmerged changes detected in this workspace").
 */
const deletingWorkspace = ref<{ target: string; from: string; dirty: boolean }>()

/** The other checkouts of the repository the open session sits in. */
async function worktreesHere(): Promise<{ list: Worktree[]; here: string } | undefined> {
  const here = app.current?.directory ?? app.config?.directory
  if (!here) return undefined
  const listed = await app.client?.request({ type: "workspace.list", directory: here })
  if (!listed?.worktrees.length) return undefined
  return { list: listed.worktrees, here }
}

/** Whether the session on screen is in a workspace that could be removed. */
const inRemovableWorkspace = ref(false)

async function refreshWorkspaceKind() {
  const found = await worktreesHere().catch(() => undefined)
  const here = found?.here
  inRemovableWorkspace.value = Boolean(
    here && found?.list.some((entry) => entry.directory === here && !entry.main),
  )
}

async function askDeleteWorkspace() {
  // A repository git cannot read is a reason to say so, not to leave a
  // rejected promise behind the `void` at the call site.
  const found = await worktreesHere().catch(() => undefined)
  if (!found) return
  const { list, here } = found
  const main = list.find((entry) => entry.main)
  if (!main || main.directory === here) {
    // The repository's own checkout is not a workspace and cannot be removed.
    notify(t("workspace.deleteMain"))
    return
  }

  /*
   * Asked from the main checkout, because a worktree cannot be removed from
   * inside itself - and asked before the dialog so the dialog can say what is
   * at stake rather than warning about it afterwards.
   */
  let dirty = false
  try {
    const status = await app.gitStatus(here)
    dirty = Boolean(status.changed.length)
  } catch {
    // A repository that cannot be read is treated as having something to lose.
    dirty = true
  }
  deletingWorkspace.value = { target: here, from: main.directory, dirty }
}

async function confirmDeleteWorkspace() {
  const asked = deletingWorkspace.value
  deletingWorkspace.value = undefined
  if (!asked) return
  try {
    await app.client?.request({ type: "workspace.remove", directory: asked.from, target: asked.target })
    // The directory the session was in is gone, so it cannot be left open on it.
    startIn(asked.from)
    notify(t("workspace.deleted"))
  } catch (err) {
    notifyFailure(t("workspace.deleteFailed"), err instanceof Error ? err.message : String(err))
  }
  void refreshWorkspaceKind()
}

/*
 * Re-asked whenever the session changes, because the answer is a property of
 * the directory that session sits in - and the command's enabled state is read
 * long before anyone opens the palette.
 */
watch(() => app.current?.directory ?? app.config?.directory, () => void refreshWorkspaceKind(), {
  immediate: true,
})

/** Opens a session in another checkout of the same repository. */
async function switchWorkspace() {
  const directory = app.current?.directory ?? app.config?.directory
  if (!directory) return
  const listed = await app.client?.request({ type: "workspace.list", directory })
  const others = (listed?.worktrees ?? []).filter((entry) => entry.directory !== directory)
  if (!others.length) {
    notify(t("workspace.none"))
    return
  }
  // One other checkout needs no picker; more than one goes through the palette
  // the same way projects do.
  if (others.length === 1) {
    startIn(others[0].directory)
    return
  }
  workspaceChoices.value = others.map((entry) => entry.directory)
  openPalette("projects")
}

/**
 * Writes out what the app has been complaining about.
 *
 * Kept in memory rather than on disk: the point of the log is a bug report,
 * and a ring buffer of the last few hundred lines is what makes one useful
 * without leaving a file growing in the background forever.
 */
const logLines: string[] = []

function recordLog(level: string, message: string) {
  logLines.push(`${new Date().toISOString()} ${level} ${message}`)
  if (logLines.length > 500) logLines.shift()
}

/** The toast's next step after a save: show the file where it landed. */
function revealAction(target: string) {
  return { label: t("files.reveal"), run: () => void window.mcode.revealSaved(target) }
}

async function exportLog() {
  const header = [
    `MCode log`,
    `exported ${new Date().toISOString()}`,
    `platform ${navigator.userAgent}`,
    `theme ${app.config?.themeID ?? "oc-2"} / ${app.config?.theme ?? "system"}`,
    `language ${language.value}`,
    "",
  ]
  const body = logLines.length ? logLines : [t("log.empty")]
  const saved = await window.mcode.saveText("mcode-log.txt", [...header, ...body].join("\n"))
  if (saved) notify(t("log.saved"), { action: revealAction(saved) })
}

/**
 * Points the window at another server, or back at the local one.
 *
 * The address is remembered, so the choice survives a restart - a server the
 * user has to re-enter every morning is not a server they will use.
 */
function chooseServer() {
  choosingServer.value = true
}

async function applyServer(answer: string) {
  choosingServer.value = false
  const url = answer.trim()
  if (url && !/^wss?:\/\//.test(url)) {
    notifyFailure(t("server.badURL"))
    return
  }
  /*
   * The socket moves first. Writing the config is a request over it, so doing
   * that first meant a server that had stopped answering could not be left -
   * the write to change the address had to reach the address being changed.
   * Local storage is what the next boot reads, and is written here too.
   */
  if (url) localStorage.setItem("mcode.serverURL", url)
  else localStorage.removeItem("mcode.serverURL")
  app.client?.useServer(url)
  void app.patchConfig({ serverURL: url })
  notify(url ? t("server.switched", { url }) : t("server.local"))
}

/**
 * Asks the configured feed whether there is a newer release.
 *
 * There is no update service behind this app, so the feed is whatever the user
 * points it at - a JSON document with a `version`. With none configured the
 * command says so rather than pretending to have checked.
 */
async function checkForUpdates() {
  if (updateChecking.value) return
  const feed = app.config?.updateFeed?.trim()
  if (!feed) {
    notifyFailure(t("update.noFeed"))
    return
  }
  updateChecking.value = true
  /* MiMo's sticky 正在检查更新…, up for as long as the check runs. */
  const checking = notify(t("update.checking"), { id: "update-check", duration: 0 })
  try {
    /*
     * Asked of the main process rather than fetched here. This window is served
     * under a content policy that lets it open a socket to the local backend and
     * reach nothing else, so its own fetch of the feed never left the process -
     * the check reported "Failed to fetch" whatever the feed said.
     */
    const { version, url, sha256, notes } = await window.mcode.checkUpdates(feed)
    if (!version) throw new Error("the feed named no version")
    if (version === app.version) {
      notify(t("update.current"))
      return
    }
    /* A feed that names a version but no installer can only say where to get it. */
    if (!url) {
      notify(t("update.found", { version }))
      return
    }
    notify(t("update.downloading"))
    void fetchUpdate(url, version, sha256, notes)
  } catch (err) {
    /*
     * Electron wraps anything thrown in a handler as "Error invoking remote
     * method 'mcode:check-updates': ...", which tells the reader about our IPC
     * rather than about their feed. Only the reason is worth showing.
     */
    notifyFailure(t("update.checkFailed"), reasonOf(err))
  } finally {
    dismiss(checking)
    updateChecking.value = false
  }
}

/** Chord to command id, for whatever the user has re-bound. */
const rebound = computed(() => {
  const out = new Map<string, string>()
  for (const [id, chord] of Object.entries(app.config?.keybinds ?? {})) {
    if (chord) out.set(chord, id)
  }
  return out
})
/**
 * Built-in chords whose command has been moved somewhere else.
 *
 * Rebinding wrote the new chord and left the old one working: the shortcuts page
 * said Ctrl+J while Ctrl+T went on creating a session, because the built-in
 * table below is consulted by key and knows nothing about what the user has
 * changed. A chord that has been vacated has to stop doing its old job, or the
 * page is describing an app that no longer exists.
 *
 * Not vacated if some other command has since taken it - then it belongs to
 * that command and is handled a few lines above, by the rebinding itself.
 */
const retiredChords = computed(() => {
  const binds = app.config?.keybinds ?? {}
  const claimed = new Set(Object.values(binds).filter(Boolean))
  const out = new Set<string>()
  for (const command of bindableCommands.value) {
    const custom = binds[command.id]
    // Absent means untouched; an empty string means its built-in chord was deleted on the shortcuts page.
    if (custom === undefined || !command.hint || custom === command.hint) continue
    if (claimed.has(command.hint)) continue
    out.add(command.hint)
  }
  return out
})

const drawer = ref<InstanceType<typeof TerminalDrawer>>()
const rightPanel = ref<InstanceType<typeof RightPanel>>()
/* Set while the project picker is standing in for a workspace picker. */
const workspaceChoices = ref<string[]>([])

/**
 * Runs what was typed in the composer's shell mode.
 *
 * It goes to the drawer's own terminal rather than to a shell of its own, so a
 * command typed in the box and one typed in the terminal share a directory and
 * a history. The drawer opens if it was closed, because a command whose output
 * lands somewhere invisible has not really run.
 */
async function runShellCommand(command: string) {
  terminalOpen.value = true
  await nextTick()
  // The pane opens its shell asynchronously, so the first command after the
  // drawer appears has to wait for the handshake rather than vanish.
  for (let tries = 0; tries < 20; tries += 1) {
    if (drawer.value?.run(command) !== false) return
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * Opens the palette on one kind of thing.
 *
 * The reference offers separate pickers for files, sessions and projects; they
 * are the same list with a different filter, so they are the same surface here
 * rather than three dialogs that would drift apart.
 */
/*
 * The project picker answers two questions: which project a new task starts
 * in, and which project a conversation moves to. Which one is being asked is
 * held in `movingSession` while the picker is up.
 */
async function pickedProject(directory: string) {
  const moving = movingSession.value
  const many = movingMany.value
  movingSession.value = undefined
  movingMany.value = undefined
  if (many?.length) {
    for (const sessionID of many) await app.move(sessionID, directory)
    selecting.value = undefined
    return
  }
  if (moving) {
    await app.move(moving, directory)
    return
  }
  startIn(directory)
}

/* Set while the picker is being used to move everything that is ticked. */
const movingMany = ref<string[]>()

/** A conversation ticked or unticked in the side column's selection mode. */
function toggleSelected(sessionID: string) {
  const current = selecting.value ?? []
  selecting.value = current.includes(sessionID)
    ? current.filter((entry) => entry !== sessionID)
    : [...current, sessionID]
}

/**
 * What the selection bar asks for.
 *
 * Each of these is the single-conversation action run over the set, so the
 * rules that already hold - leaving an archived session, the confirmation
 * before a delete - hold here too.
 */
async function runBatch(action: "archive" | "move" | "delete" | "cancel" | "all" | "none", ids: string[] = []) {
  const chosen = selecting.value ?? []
  if (action === "cancel") {
    selecting.value = undefined
    return
  }
  // MiMo's select all: every conversation the column lists; its other half ticks none.
  if (action === "all" || action === "none") {
    selecting.value = action === "all" ? [...ids] : []
    return
  }
  if (!chosen.length) return
  if (action === "archive") {
    for (const sessionID of chosen) await app.archive(sessionID, true)
    selecting.value = undefined
    return
  }
  if (action === "move") {
    movingMany.value = [...chosen]
    openPalette("projects")
    return
  }
  deletingMany.value = [...chosen]
}

async function confirmDeleteMany() {
  const targets = deletingMany.value ?? []
  deletingMany.value = undefined
  for (const sessionID of targets) await app.remove(sessionID)
  selecting.value = undefined
}

function openPalette(mode: PaletteMode) {
  paletteMode.value = mode
  paletteOpen.value = true
}

/**
 * Puts whatever is selected on screen into the composer.
 *
 * Quoted, so it arrives as something being shown rather than as something
 * being asked - the model reads the two very differently.
 */
function addSelection() {
  const text = window.getSelection()?.toString().trim()
  if (!text) return
  const quoted = text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")
  composer.value?.insert(`\n${quoted}\n`)
  composer.value?.focus()
}
/** Which rail badge has its panel open, and where to anchor it. */

const theme = computed(() => app.config?.theme ?? "system")
const themeID = computed(() => app.config?.themeID ?? DEFAULT_THEME)

// The palette is defined against :root, so the override has to land on <html>.
// Setting it on a wrapper element silently does nothing - "system" would still
// work through the media query, but an explicit Dark/Light choice would not.
watch(
  theme,
  (next) => {
    if (next === "system") document.documentElement.removeAttribute("data-theme")
    else document.documentElement.setAttribute("data-theme", next)
  },
  { immediate: true },
)

/*
 * Which scheme is actually showing. "System" is the default, so the palette
 * below cannot be chosen from the setting alone - it has to follow the OS, and
 * follow it while the window is open rather than only at startup.
 */
const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)")
const systemDark = ref(schemeQuery.matches)
const onSchemeChange = (event: MediaQueryListEvent) => (systemDark.value = event.matches)
const darkScheme = computed(() =>
  theme.value === "system" ? systemDark.value : theme.value === "dark",
)

/**
 * Paints the chosen palette onto the document.
 *
 * The stylesheet already carries a full set of colours - they are OC-2, run
 * through this same generator - so this writes over them rather than filling a
 * blank. Setting the properties inline is what lets one theme override all
 * three of the stylesheet's blocks at once, media query included.
 */
watch(
  [themeID, darkScheme],
  ([id, dark]) => {
    const tokens = themeTokens(themeByID(id), dark)
    for (const [name, value] of Object.entries(tokens)) {
      document.documentElement.style.setProperty(name, value)
    }
    // The caption buttons are the OS's, drawn over a transparent fill. It knows
    // the system theme but not this app's, so it has to be told which one won.
    window.mcode.titlebarMode(dark ? "dark" : "light")
  },
  { immediate: true },
)

/*
 * The icon the window wears. Main cannot read the config document, so it is
 * told - at startup as well as on a change, because a window created before
 * the config arrived is wearing the packaged default.
 */
watch(
  () => app.config?.appIcon ?? DEFAULT_APP_ICON,
  (id) => window.mcode.appIcon(id),
  { immediate: true },
)

/* And whether there is an icon in the corner at all. */
watch(
  () => app.config?.tray ?? true,
  (enabled) => window.mcode.tray(enabled),
  { immediate: true },
)

/*
 * The tray's 配置切换: the models the picker offers, the one in use checked.
 * Main draws the menu; a model chosen there comes back here to be applied.
 */
watch(
  () => {
    const chosen = app.config?.enabledModels ?? []
    const current = app.config?.model
    return app.providers
      .filter((provider) => provider.configured)
      .flatMap((provider) =>
        provider.models
          .filter((model) => !chosen.length || chosen.includes(`${provider.id}/${model.id}`))
          .map((model) => ({
            key: `${provider.id}/${model.id}`,
            label: `${provider.name} · ${model.name || model.id}`,
            checked: current?.provider === provider.id && current.model === model.id,
          })),
      )
      .slice(0, 40)
  },
  (profiles) => window.mcode.trayProfiles(profiles),
  { immediate: true },
)
onBeforeUnmount(
  window.mcode.onTrayProfile((key) => {
    const cut = key.indexOf("/")
    if (cut > 0) void app.patchConfig({ model: { provider: key.slice(0, cut), model: key.slice(cut + 1) } })
  }),
)

/*
 * Choices that are answered by the stylesheet rather than by a component: the
 * cursor over what can be pressed, whether anything animates, how a diff marks
 * its changed lines, and how text is smoothed.
 *
 * They land on <html> because each one reaches across the whole window - a
 * wrapper element would leave out every dialog, menu and tooltip, which are
 * exactly the places a transition is most noticeable.
 */
watch(
  () =>
    [
      app.config?.pointerCursor ?? true,
      app.config?.reduceMotion ?? "system",
      app.config?.diffMarks ?? "color",
      app.config?.fontSmoothing ?? true,
    ] as const,
  ([cursor, motion, marks, smoothing]) => {
    const root = document.documentElement
    root.setAttribute("data-cursor", cursor ? "pointer" : "default")
    root.setAttribute("data-motion", motion)
    root.setAttribute("data-diff-marks", marks)
    root.setAttribute("data-smoothing", smoothing ? "on" : "off")
  },
  { immediate: true },
)

/*
 * A chosen typeface goes in front of the built-in stack rather than replacing
 * it: a name that turns out not to be installed then falls through to what was
 * there before instead of dropping the app to Times New Roman. The name is
 * quoted so a face with a space in it - "JetBrains Mono" - survives.
 */
/* MiMo's terminal stack, the same as tokens.css's --font-terminal, for a chosen face to stand in front of. */
const TERMINAL_FONT_STACK =
  '"SF Mono", ui-monospace, Menlo, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Noto Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "Symbols Nerd Font", "MesloLGS NF", "Hack Nerd Font", "JetBrainsMono Nerd Font", monospace'
watch(
  () => [app.config?.uiFont, app.config?.codeFont, app.config?.terminalFont] as const,
  ([ui, code, terminal]) => {
    const style = document.documentElement.style
    const put = (variable: string, chosen: string | undefined, fallback: string) => {
      const name = (chosen ?? "").trim()
      if (!name) style.removeProperty(variable)
      else style.setProperty(variable, `"${name.replace(/"/g, "")}", ${fallback}`)
    }
    put("--font-sans", ui, "var(--font-sans-stack)")
    put("--font-mono", code, "var(--font-mono-stack)")
    // MiMo's terminal stack, as tokens.css has it: a chosen face goes in front of it.
    put("--font-terminal", terminal, TERMINAL_FONT_STACK)
  },
  { immediate: true },
)

/*
 * The two sizes on the appearance page, carried the way MiMo carries them: a
 * scale on the root that every size in the interface is multiplied by - text
 * by the UI scale, code in the transcript and the diffs by the code one. At
 * the defaults both are 1 and nothing moves.
 */
watch(
  () => [app.config?.uiFontSize, app.config?.codeFontSize] as const,
  ([ui, code]) => {
    const style = document.documentElement.style
    style.setProperty("--ui-font-scale", String((ui || 14) / 14))
    style.setProperty("--code-font-scale", String((code || 12) / 12))
  },
  { immediate: true },
)

// The i18n table reads a module-level ref, so mirror config into it whenever
// the setting changes - every t() call re-renders off that ref.
watch(
  () => app.config?.language,
  (next) => {
    /*
     * Absent means nobody has chosen, so the machine's own preference decides.
     * An unknown code falls back to English rather than leaving the window
     * half-translated in whatever was showing before.
     */
    if (!next) language.value = detectLanguage()
    else if (LANGUAGES.some((entry) => entry.id === next)) language.value = next as Language
    else language.value = "en"
    // Arabic reads the other way, and the layout has to turn with it.
    document.documentElement.dir = RTL_LANGUAGES.includes(language.value) ? "rtl" : "ltr"
    // The menu bar is built in the main process, which cannot read that ref.
    publishMenuLabels()
  },
  { immediate: true },
)
/**
 * First run takes over the whole workspace until a provider is connected or
 * the step is skipped - an empty launcher would give no hint that the app
 * needs a key before it can do anything.
 */
const onboarding = computed(() => app.connected && app.config !== undefined && !app.config.onboarded)
const isArtifacts = computed(() => view.value === "artifacts")
const isPlugins = computed(() => view.value === "plugins")
const isHome = computed(
  () => !isArtifacts.value && !isPlugins.value && (view.value === "home" || !app.current),
)
/** Empty transcript shows the hero instead of a blank scroller. */
const empty = computed(() => app.messages.length === 0)

/*
 * The terminal docks along the foot of the main column. Not during onboarding
 * or on the artifacts and plugins pages; on the home screen, as MiMo allows,
 * once there is a project folder for it to open in, since no conversation has
 * one yet.
 */
const terminalUp = computed(
  () =>
    terminalOpen.value &&
    !onboarding.value &&
    !isArtifacts.value &&
    !isPlugins.value &&
    (!isHome.value || Boolean(homeShellDirectory.value)),
)

/*
 * MiMo's right panel (stores/right-panel.ts, RightPanel.vue): one panel of tabs
 * beside the conversation. Its tabs belong to the conversation on show - the
 * home screen's to nothing - and it is put away on the artifacts and plugins
 * pages, as MiMo's is on its own pages.
 */
const rp = useRightPanel()
watch(
  () => (isHome.value || onboarding.value ? undefined : app.currentID),
  (scope) => rp.setScope(scope),
  { immediate: true },
)
/* MiMo puts both the panel and the terminal away on its own pages. */
watch([isArtifacts, isPlugins], ([artifacts, plugins]) => {
  if (artifacts || plugins) {
    rp.setOpen(false)
    terminalOpen.value = false
  }
})

/* A conversation that is gone takes its tabs' shells and pages with it. */
watch(
  () => app.sessions.map((session) => session.id),
  (now, before) => {
    for (const id of before ?? []) if (!now.includes(id)) rp.forget(id)
  },
)

/* The panel on screen beside the main column, whose title row then ends at the column. */
const panelBeside = computed(() => rp.open && !onboarding.value)

/* What the panel's tools work in: the conversation's project, or the one picked on the home screen. */
const panelDirectory = computed(() => (isHome.value ? homeShellDirectory.value : app.current?.directory))

/* The title bar's button and Ctrl+Alt+B: the panel, with its launcher while it holds no tabs. */
function toggleSidePanel() {
  if (!onboarding.value) rp.toggleOpen()
}

/* MiMo's tool shortcuts ask for a conversation: on the home screen they do nothing. */
const inConversation = computed(() => !isHome.value && !onboarding.value && Boolean(app.currentID))

/*
 * The box goes into MiMo's floating chat while the panel is expanded over the
 * conversation - the same composer, moved, so a draft and its attachments come
 * along. `#float-dock` lives in the right panel and is always in the page, so
 * the Teleport always finds it.
 */
const floatingComposer = computed(() => inConversation.value && rp.open && rp.fullscreen)

/* The panel tools' shortcuts and the side panel toggle's, as bound now rather than as shipped. */
const panelHints = computed(() => toolHints(bindableCommands.value, app.config?.keybinds ?? {}))
const sidePanelHint = computed(() => boundChord("view.right", "Ctrl+Alt+B", app.config?.keybinds ?? {}))

/*
 * MiMo's narrow window: with the side column and the panel both open beside a
 * conversation left under 480, the panel shuts if the column was just opened;
 * otherwise the column folds, and comes back by itself once there is room.
 */
const windowWidth = ref(window.innerWidth)
const onWindowResize = () => (windowWidth.value = window.innerWidth)
onMounted(() => window.addEventListener("resize", onWindowResize))
onBeforeUnmount(() => window.removeEventListener("resize", onWindowResize))

/* P6-3: a project picked, brought in or made on the home screen opens the side column, as MiMo's does. */
const revealSide = () => (leftPanel.value = true)
onMounted(() => window.addEventListener("mcode:reveal-side", revealSide))
onBeforeUnmount(() => window.removeEventListener("mcode:reveal-side", revealSide))
let sideAutoFolded = false
watch(
  [windowWidth, leftPanel, () => rp.open, () => rp.width, () => rp.fullscreen],
  ([viewport, sideOpen], [, sideBefore]) => {
    if (onboarding.value) return
    if (sideOpen) sideAutoFolded = false
    const room = { viewport, sideWidth: SIDE_COLUMN_WIDTH, sideOpen, panelOpen: rp.open, panelWidth: Math.max(PANEL_MIN_WIDTH, rp.width), fullscreen: rp.fullscreen }
    const outcome = arbitratePanel(room, sideOpen && !sideBefore)
    if (outcome === "close-panel") rp.setOpen(false)
    else if (outcome === "collapse-side") {
      leftPanel.value = false
      sideAutoFolded = true
    } else if (!sideOpen && sideAutoFolded && sideFits({ ...room, sideOpen: true })) leftPanel.value = true
  },
)

/* Ctrl+Shift+G: another review tab. */
function openReviewTab() {
  if (inConversation.value) rp.openTool("review")
}

/* Ctrl+P: the files tab, the one there is. */
function openFilesTab() {
  if (inConversation.value) rp.openTool("files")
}

/* Ctrl+Alt+S: another side chat. */
function openSideChatTab() {
  if (inConversation.value) rp.openTool("chat")
}

/* The composer's plus menu: MiMo opens its terminal as a tab of the panel. */
function openTerminalTab() {
  if (inConversation.value) rp.openTool("terminal")
  else terminalOpen.value = true
}

/* Ctrl+T: another browser tab. */
function openBrowserTab() {
  if (inConversation.value && browserAllowed.value) rp.openTool("browser")
}

/*
 * Ctrl+Shift+B, MiMo's browser toggle: put the panel away while a browser tab is
 * the one on show; otherwise bring the browser tab there is forward, or open one.
 */
function toggleBrowserTab() {
  if (!browserAllowed.value) return
  if (rp.open && rp.activeTab?.type === "browser") {
    rp.setOpen(false)
    return
  }
  const existing = rp.tabs.find((tab) => tab.type === "browser")
  if (existing) {
    rp.activate(existing.id)
    rp.setOpen(true)
  } else openBrowserTab()
}

/* A browser tab on show, for the keys that reach into it. */
const browserShowing = computed(() => rp.open && rp.activeTab?.type === "browser")

/* Ctrl+L goes to the browser's address bar while a browser tab is showing, else to the box. */
function focusBrowserAddress() {
  const pane = browserShowing.value ? rightPanel.value?.activeBrowser() : undefined
  if (pane) pane.focusAddress()
  else composer.value?.focus()
}

/* C25: Ctrl+R reloads the browser tab on show, else the panel's first browser tab, as MiMo's lj() picks. */
const hasBrowserTab = computed(() => rp.tabs.some((tab) => tab.type === "browser"))
function reloadBrowser(force = false) {
  void rightPanel.value?.reloadTarget()?.reload(force)
}

/* Ctrl+period is MiMo's annotate while a browser tab shows a page; on a blank tab or elsewhere it steps the agent. */
function annotateOrCycleAgent() {
  const pane = browserShowing.value ? rightPanel.value?.activeBrowser() : undefined
  if (!pane?.toggleAnnotate()) void cycleAgent(1)
}

/*
 * The pill over the composer toggles its own diff tab (the latest turn, source
 * "live-edit"); the window only tells it whether that tab is the one on show.
 */
const LIVE_EDIT = "live-edit"
const liveEditShowing = computed(
  () => rp.open && rp.activeTab?.type === "diff" && rp.activeTab.source === LIVE_EDIT,
)

/* The "edited N files" card at the end of a turn: 审阅 brings the review tab there is forward, or opens one. */
watch(reviewRequest, () => {
  if (!inConversation.value) return
  const review = rp.tabs.find((tab) => tab.type === "review")
  if (review) {
    rp.activate(review.id)
    rp.setOpen(true)
  } else rp.openTool("review")
})
watch(fileRequest, (asked) => {
  const root = app.current?.directory
  if (asked && root) void window.mcode.openFile(root, asked.path)
})

function copyWorkingDirectory() {
  const directory = app.current?.directory
  if (!directory) return
  window.mcode.setClipboardText(directory)
  // MiMo's notice is the title alone; the path is already on the clipboard.
  notify(t("menu.copiedDirectory"))
}

/*
 * A new session starts on the review, not on the last session's figures - and
 * a session that had the Context tab open finds it open again.
 *
 * There used to be a watch here emptying both on every session change, because
 * there was nowhere to hang per-session panel state. There is now: `strip`
 * above is keyed by directory and session, so a session that never opened the
 * tab reads as empty without anything having to reset it, and one that did
 * keeps it. Resetting here would erase exactly what the map exists to hold.
 */

/*
 * Folders dropped onto the side column's Projects, as MiMo takes them: each
 * becomes a project - brought back if it had been closed, given a first task
 * if it has none, since a project here is a folder with a conversation - and
 * the last one is opened. A drop that held no folder says so.
 */
async function addDroppedProjects(directories: string[]) {
  if (!directories.length) {
    notifyFailure(t("side.dropNotDir"))
    return
  }
  const closed = app.config?.closedProjects ?? []
  const kept = closed.filter((entry) => !directories.includes(entry))
  if (kept.length !== closed.length) await app.patchConfig({ closedProjects: kept })
  for (const directory of directories) {
    if (!app.sessions.some((session) => session.directory === directory && !session.archived && !session.scratch)) {
      await app.create(directory)
    }
  }
  await openProject(directories[directories.length - 1]!)
}

async function openProject(directory: string) {
  // Opening a directory that was closed brings it - and its sessions - back.
  const closed = app.config?.closedProjects ?? []
  if (closed.includes(directory)) {
    await app.patchConfig({ closedProjects: closed.filter((entry) => entry !== directory) })
  }
  /*
   * Archived sessions are excluded on purpose. `find` matched them, so a
   * project whose sessions had all been archived opened one and was bounced
   * straight back out by the rule that the workspace never sits inside an
   * archived session - clicking the project looked like it did nothing at all.
   * Sorted, because "resume where I left off" means the newest, not whichever
   * happens to come first in the array.
   */
  const existing = app.sessions
    .filter((session) => session.directory === directory && !session.archived)
    .sort((a, b) => b.updated - a.updated)[0]
  if (existing) await app.open(existing.id)
  else await app.create(directory)
  view.value = "session"
  await focusComposer()
}

/**
 * Always starts a fresh session, unlike openProject, which resumes the existing
 * one. Both are reachable from the project panel, and a button labelled "new
 * session" reusing an old one reads as the button doing nothing.
 */
/*
 * Starting a task no longer creates anything: it puts the home screen up with
 * that project chosen, and the session is created by the send. A session made
 * on the way to the screen is a row in the side column that nobody asked for -
 * and MiMo has none of them.
 */
function startIn(directory?: string) {
  homeDirectory.value = directory
  goHome()
  void focusComposer()
}

async function newSessionIn(directory: string) {
  const closed = app.config?.closedProjects ?? []
  if (closed.includes(directory)) {
    await app.patchConfig({ closedProjects: closed.filter((entry) => entry !== directory) })
  }
  startIn(directory)
}

/*
 * DL15, MiMo's open-folder: the home screen with the folder picked and no
 * conversation made. Several may be chosen; each is brought back if it was
 * closed, and the last one is the pick.
 */
async function browse() {
  const directories = await window.mcode.pickDirectory(t("cmd.openProject"), true)
  if (!directories.length) return
  const closed = app.config?.closedProjects ?? []
  const kept = closed.filter((entry) => !directories.includes(entry))
  if (kept.length !== closed.length) await app.patchConfig({ closedProjects: kept })
  startIn(directories[directories.length - 1])
}

/**
 * A tab from the strip. Sets the view as well as the session, because the tab
 * that is already current opens nothing and would otherwise leave the click
 * with no effect at all while the launcher is up.
 */
async function selectTab(id: string) {
  if (app.currentID !== id) await app.open(id)
  view.value = "session"
  push({ view: "session", sessionID: id })
}

/** Starts a task from the 2.0 home screen, in the project picked there. */
function newSession() {
  startIn(app.current?.directory)
}

/**
 * Every permission bucket at once, on and off.
 *
 * Worth knowing while reading this: MCode's list is global, where the
 * reference scopes the same flag per session or per directory. Turning it on
 * here grants far more than the reference's equivalent does, which is why both
 * edges toast rather than only the one that reduces access.
 *
 * The question this button answers is "will anything stop and ask me", which is
 * why a bucket counts as satisfied when it is anything other than Ask. Reading
 * it as "is everything set to Allow" instead would leave the button stuck
 * showing off forever the moment a single bucket was refused, since the button
 * is not permitted to lift a refusal and so could never reach that state.
 */
function autoAcceptAll(): boolean {
  const current = app.config?.permissions
  return PERMISSION_KINDS.every((kind) => (current?.[kind] ?? DEFAULT_PERMISSIONS[kind]) !== "ask")
}

async function toggleAutoAccept() {
  const on = autoAcceptAll()
  const next = { ...DEFAULT_PERMISSIONS, ...app.config?.permissions }
  /*
   * A bucket the user set to Deny is left alone by both edges of this button.
   * Turning interruptions off is a statement about being asked, not about being
   * refused, and a switch that quietly undid a refusal would be the more
   * dangerous of the two readings.
   */
  for (const kind of PERMISSION_KINDS) {
    if (next[kind] === "deny") continue
    next[kind] = on ? DEFAULT_PERMISSIONS[kind] : "allow"
  }
  await app.patchConfig({ permissions: next, accessLevel: on ? "ask" : "full" })
  // MiMo's notice is its title alone.
  notify(t(on ? "toast.autoOffTitle" : "toast.autoOnTitle"))
}

async function focusComposer() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  composer.value?.focus()
}

/** Reachable from the model menu, so an empty list has somewhere to go. */
const connectOpen = ref(false)

/** The session waiting on an answer before it is removed for good. */
const deletingSession = ref<string>()

/** Where the application menu was opened from, if it is open. */
const appMenu = ref<{ x: number; y: number }>()

/** Where the session's own menu was opened from, if it is open. */
const sessionMenu = ref<{ x: number; y: number; sessionID?: string; header?: boolean; nested?: boolean }>()

/* Which conversation the open menu is about: the row's, else the open one. */
const menuSession = computed(() =>
  app.sessions.find((entry) => entry.id === (sessionMenu.value?.sessionID ?? app.currentID)),
)

/* Set while the project picker is being used to move a conversation. */
const movingSession = ref<string>()

/* The project row's menu, and which project folder it is about. */
const projectMenu = ref<{ x: number; y: number; directory: string }>()

/*
 * Selection mode in the side column: the conversations ticked, or absent when
 * the column is being read rather than managed. The set is held here because
 * what it is for - archiving, moving, deleting - is held here too.
 */
const selecting = ref<string[]>()
const deletingMany = ref<string[]>()

/* Project selection mode, MiMo's project batch management: the projects ticked, or absent. */
const selectingProjects = ref<string[]>()
/* Projects waiting on the removal question: one from its menu, or the ticked set. */
const removingProjects = ref<{ directories: string[]; batch: boolean }>()
/* The new-project dialog, and the conversation to move into what it makes, if any. */
const namingProject = ref<{ sessionID?: string }>()

/* The title the delete question names, or MiMo's "untitled" for one never given a title. */
const deletingTitle = computed(() => {
  const session = app.sessions.find((entry) => entry.id === deletingSession.value)
  const title = session && session.title !== "New session" ? session.title.trim() : ""
  return title || t("confirm.untitledChat")
})

/**
 * The session menu's contents: what each entry does comes from the palette's
 * own command list, so a command's behaviour and availability are defined once.
 *
 * Its WORDS do not. A palette row has to stand on its own - "Rename session",
 * "Delete session" - where a menu hanging off one session's own header says
 * only "Rename" and "Delete", and opencode keeps a separate short form for
 * exactly that: `common.rename`, `common.export`, `common.archive`,
 * `common.delete`. This used to show the palette's sentences, so every row
 * repeated "this session" at a reader who had just opened that session's menu.
 *
 * The trailing ellipsis is the menu's, not the string's - the reference's own
 * values carry none - and marks the entries that open something rather than
 * acting at once.
 */
/*
 * MiMo's conversation menu, row for row: the wording names the conversation
 * rather than "this session", there are no trailing dots, and every row
 * carries a glyph. The four groups are its own.
 */
const FOLDER_ICON = "M2 4.4c0-.6.5-1 1-1h2.6l1.2 1.5h6.2c.5 0 1 .4 1 1v6.2c0 .6-.5 1-1 1H3c-.5 0-1-.4-1-1z"
const COPY_ICON = "M5.6 5.6h7.2v7.2H5.6zM3.2 10.4V3.2h7.2"

/*
 * MiMo's order since this round: rename, pin, read or unread, continue; move
 * (a submenu), archive, batch; show in the file manager (not on a row under
 * its project), copy the directory, export; delete.
 */
const SESSION_MENU: MenuRow[] = [
  { id: "session.rename", label: "common.rename", icon: "M11.2 2.6 13.4 4.8 5.6 12.6 2.8 13.2 3.4 10.4z" },
  { id: "row.pin", label: "menu.pin", icon: "M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" },
  {
    id: "row.unread",
    label: "menu.markUnread",
    icon: "M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8zM8 9.6a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z",
  },
  {
    id: "row.continue",
    label: "menu.continueNew",
    icon: "M4.6 4.8v6.6M4.6 4.8a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8zM4.6 7.6h4.2a2 2 0 0 1 2 2v1.4M10.8 11a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z",
  },
  {
    id: "row.move",
    label: "menu.moveToProject",
    icon: "M2 4.4c0-.6.5-1 1-1h2.6l1.2 1.5h6.2c.5 0 1 .4 1 1v6.2c0 .6-.5 1-1 1H3c-.5 0-1-.4-1-1zM8 7.4v4M6.4 9l1.6-1.6L9.6 9",
    divided: true,
  },
  {
    id: "session.archive",
    label: "menu.archive",
    icon: "M2.2 3h11.6v2.6H2.2zM3.2 5.6h9.6V13H3.2zM6.4 8.2h3.2",
  },
  { id: "row.batch", label: "menu.batch", icon: "M2.4 4.4h1.6M6.6 4.4h7M2.4 8h1.6M6.6 8h7M2.4 11.6h1.6M6.6 11.6h7" },
  { id: "row.reveal", label: "menu.revealIn", icon: FOLDER_ICON, divided: true },
  { id: "row.copyDirectory", label: "menu.copyDirectory", icon: COPY_ICON },
  { id: "session.export", label: "menu.export", icon: "M8 2.6v7.2M5.2 7.2 8 10l2.8-2.8M2.8 12.2h10.4" },
  {
    id: "session.delete",
    label: "menu.delete",
    icon: "M3 4.4h10M6.4 4.4V2.8h3.2v1.6M4.4 4.4l.7 8.4h5.8l.7-8.4M6.8 6.8v3.8M9.2 6.8v3.8",
    divided: true,
    danger: true,
  },
]

/* A row of either conversation menu. */
type MenuRow = {
  id: string
  label: string
  icon: string
  hint?: string
  divided?: boolean
  danger?: boolean
  children?: MenuRow[]
}

/*
 * The conversation header's own menu, which MiMo keeps shorter than a row's:
 * pin, rename and archive with their shortcuts beside them, then the side chat,
 * 复制 › (the working directory, the session ID, the session link, or the whole
 * conversation as Markdown) and branch, then delete. Branch carries it all into
 * a new conversation.
 */
const HEADER_MENU: MenuRow[] = [
  { id: "row.pin", label: "menu.pin", icon: "M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4", hint: "Ctrl+Alt+P" },
  { id: "session.rename", label: "menu.renameConversation", icon: "M11.2 2.6 13.4 4.8 5.6 12.6 2.8 13.2 3.4 10.4z", hint: "Ctrl+Alt+R" },
  { id: "session.archive", label: "menu.archive", icon: "M2.2 3h11.6v2.6H2.2zM3.2 5.6h9.6V13H3.2zM6.4 8.2h3.2", hint: "Ctrl+Alt+A" },
  { id: "session.side", label: "menu.openSideChat", icon: "M2.4 3h11.2v10H2.4zM9.6 3v10", hint: "Ctrl+Alt+S", divided: true },
  {
    id: "row.copy",
    label: "menu.copy",
    icon: COPY_ICON,
    children: [
      { id: "row.copyDirectory", label: "menu.copyDirectory", icon: FOLDER_ICON },
      { id: "row.copyID", label: "menu.copySessionID", icon: "M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4zM8 5v3.2l2.2 1.4" },
      {
        id: "row.copyLink",
        label: "menu.copySessionLink",
        icon: "M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.9-.9",
      },
      { id: "row.copyMarkdown", label: "menu.copyMarkdown", icon: "M2.2 4h11.6v8H2.2zM4.4 10V6l1.6 1.8L7.6 6v4M10.8 6v4M9.4 8.6l1.4 1.4 1.4-1.4" },
    ],
  },
  { id: "row.continue", label: "menu.branch", icon: "M4.6 4.8v6.6M4.6 4.8a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8zM4.6 7.6h4.2a2 2 0 0 1 2 2v1.4M10.8 11a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z" },
  { id: "session.delete", label: "menu.delete", icon: "M3 4.4h10M6.4 4.4V2.8h3.2v1.6M4.4 4.4l.7 8.4h5.8l.7-8.4M6.8 6.8v3.8M9.2 6.8v3.8", divided: true, danger: true },
]

/*
 * The shortcut a row shows is the one that will work: the reader's own
 * binding when they have moved it, else the default. Pinning is a row action
 * here and a command on the shortcuts page, so it is looked up by that name.
 */
const hintFor = (entry: MenuRow) =>
  entry.hint &&
  ((binds, id) => (id in binds ? binds[id] : entry.hint))(
    app.config?.keybinds ?? {},
    entry.id === "row.pin" ? "session.pin" : entry.id,
  )

/*
 * The rows that are this menu's own rather than commands: they name a
 * conversation, where a command acts on whichever one is open. A command
 * cannot take an argument here - the palette and the keyboard reach the same
 * table - so these live beside it and the menu dispatches both.
 */
/* Whether a row is showing its unread mark: a turn that finished, or failed, while away. */
const showsUnread = (sessionID: string) => app.unseen.has(sessionID) || app.failed(sessionID)

/* MiMo names the platform's file manager in the row: File Explorer, Finder, or a file manager. */
const revealLabel = () =>
  t("menu.revealIn", {
    manager: t(
      app.platform === "win32" ? "menu.fileManagerWin" : app.platform === "darwin" ? "menu.fileManagerMac" : "menu.fileManagerOther",
    ),
  })

const ROW_ACTIONS: Record<string, (sessionID: string, header: boolean) => void | Promise<void>> = {
  "row.pin": (sessionID) => app.togglePinned(sessionID),
  /* MiMo's toggle: a row showing its unread mark is marked read, any other unread. */
  "row.unread": (sessionID) => {
    if (showsUnread(sessionID)) app.markRead(sessionID)
    else app.markUnread(sessionID)
  },
  "row.continue": async (sessionID) => {
    if (app.currentID !== sessionID) await app.open(sessionID)
    const last = app.messages[app.messages.length - 1]
    if (last) await app.forkFrom(last.id)
    else notifyFailure(t("stream.branchNeedsMessage"))
  },
  "row.batch": (sessionID) => {
    selectingProjects.value = undefined
    selecting.value = [sessionID]
  },
  /* Out of its project, into a folder of its own; the side column follows the session update. */
  "row.moveOut": async (sessionID) => {
    try {
      await app.client?.request({ type: "session.moveOut", sessionID })
    } catch (failure) {
      notifyFailure(t("menu.moveOut"), reasonOf(failure))
    }
  },
  "row.newProjectMove": (sessionID) => {
    namingProject.value = { sessionID }
  },
  "row.copyMarkdown": async (sessionID) => {
    if (app.currentID !== sessionID) await app.open(sessionID)
    window.mcode.setClipboardText(transcriptMarkdown())
    notify(t("menu.copiedMarkdown"))
  },
  /* Round 3 AR15 (artifacts agent): MiMo's 导出对话记录 saves the named conversation as Markdown without opening it. */
  "session.export": (sessionID) => exportConversationById(sessionID),
  /* MiMo's copy notices are the title alone; what was copied is already on the clipboard. */
  "row.copyDirectory": (sessionID, header) => {
    const target = app.sessions.find((entry) => entry.id === sessionID)
    if (!target?.directory) {
      notifyFailure(t(header ? "menu.noCwdLinked" : "menu.noWorkDir"))
      return
    }
    window.mcode.setClipboardText(target.directory)
    notify(t("menu.copiedDirectory"))
  },
  "row.copyID": (sessionID) => {
    window.mcode.setClipboardText(sessionID)
    notify(t("menu.copiedSessionID"))
  },
  "row.copyLink": (sessionID) => {
    const target = app.sessions.find((entry) => entry.id === sessionID)
    if (!target) return
    window.mcode.setClipboardText(sessionLink(sessionID, target.directory))
    notify(t("menu.copiedLink"))
  },
  "row.reveal": async (sessionID) => {
    const target = app.sessions.find((entry) => entry.id === sessionID)
    if (!target?.directory) {
      notifyFailure(t("menu.noWorkDir"))
      return
    }
    await window.mcode.revealFile(target.directory, "")
    notify(revealLabel())
  },
}

/*
 * What 移动至项目 › lists: the side column's projects, newest first, the one the
 * conversation is in lit, 移出项目 above them while it is in one, and 新建项目…
 * kept below whatever the search leaves.
 */
function moveMenu(target?: (typeof app.sessions)[number]): Pick<MenuItem, "children" | "search" | "footer" | "childWidth"> {
  const closed = new Set(app.config?.closedProjects ?? [])
  const recent = new Map<string, number>()
  for (const session of app.sessions) {
    if (session.archived || session.scratch || closed.has(session.directory)) continue
    recent.set(session.directory, Math.max(recent.get(session.directory) ?? 0, session.updated))
  }
  const current = target && !target.scratch ? target.directory : undefined
  const rows: MenuItem[] = [...recent.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([directory]) => ({
      key: `move:${directory}`,
      label: projectName(directory, app.config?.projectNames),
      active: directory === current,
    }))
  return {
    childWidth: 200,
    search: { placeholder: t("menu.moveSearch"), empty: t("menu.moveNoMatch") },
    children: current ? [{ key: "row.moveOut", label: t("menu.moveOut"), sticky: true }, ...rows] : rows,
    footer: [{ key: "row.newProjectMove", label: t("menu.newProjectMove"), icon: `${FOLDER_ICON}M8 7.2v3.6M6.2 9h3.6` }],
  }
}

/*
 * Built from the UNFILTERED list, because `commands` drops anything disabled
 * and this menu is meant to keep its shape: MenuItem's own rule is that a
 * disabled row is greyed rather than hidden. With the filtered list, a fresh
 * session's menu lost Export entirely and came up two rows shorter than the
 * same menu a moment later.
 */
function menuRow(entry: MenuRow): MenuItem | undefined {
  const target = menuSession.value
  const base = {
    key: entry.id,
    divided: Boolean(entry.divided),
    icon: entry.icon,
    danger: Boolean(entry.danger),
    hint: hintFor(entry) || undefined,
  }
  if (entry.children) {
    const children = entry.children.map(menuRow).filter((item): item is MenuItem => Boolean(item))
    return { ...base, label: t(entry.label), enabled: Boolean(target), children }
  }
  if (entry.id === "row.move") return { ...base, label: t(entry.label), enabled: Boolean(target), ...moveMenu(target) }
  if (ROW_ACTIONS[entry.id]) {
    const label =
      entry.id === "row.pin"
        ? t(target && app.isPinned(target.id) ? "menu.unpin" : "menu.pin")
        : entry.id === "row.unread"
          ? t(target && showsUnread(target.id) ? "menu.markRead" : "menu.markUnread")
          : entry.id === "row.reveal"
            ? revealLabel()
            : t(entry.label)
    return { ...base, label, enabled: Boolean(target) }
  }
  const command = bindableCommands.value.find((item) => item.id === entry.id)
  if (!command) return undefined
  const short = t(entry.label)
  return {
    ...base,
    // A key with no string of its own falls back to the command's sentence
    // rather than showing the key, which is what `t` returns when it misses.
    label: short === entry.label ? command.title : short,
    enabled: command.enabled && Boolean(target),
  }
}

const sessionMenuItems = computed(() => {
  const header = Boolean(sessionMenu.value?.header)
  let rows = header ? HEADER_MENU : SESSION_MENU
  // A row listed under its project has no "show in" row, so copying the directory takes its rule.
  if (!header && sessionMenu.value?.nested) {
    rows = rows
      .filter((entry) => entry.id !== "row.reveal")
      .map((entry) => (entry.id === "row.copyDirectory" ? { ...entry, divided: true } : entry))
  }
  return rows.map(menuRow).filter((item): item is MenuItem => Boolean(item))
})

/*
 * MiMo's project menu, row for row: rename, pin, archive its conversations,
 * batch management, show in the file explorer, copy the working directory,
 * change the folder location, remove. Removing only takes the project out of
 * the side column - its conversations and its folder stay, and opening the
 * folder again brings it back, the same as closing a project always has.
 */
const PROJECT_MENU: { id: string; label: string; icon: string; divided?: boolean; danger?: boolean }[] = [
  { id: "rename", label: "menu.renameProject", icon: "M11.2 2.6 13.4 4.8 5.6 12.6 2.8 13.2 3.4 10.4z" },
  /* MCode's own: the icon and colour a project wears, which MiMo's name-only rename has no room for. */
  { id: "appearance", label: "menu.projectAppearance", icon: "M8 2.4a5.6 5.6 0 1 0 0 11.2c.8 0 1.2-.5 1.2-1 0-.6-.4-.8-.4-1.3 0-.6.5-1 1.1-1h1.3a2.4 2.4 0 0 0 2.4-2.4C13.6 4.6 11.1 2.4 8 2.4zM5.2 7.4h.01M6.6 4.9h.01M9.6 4.9h.01" },
  { id: "pin", label: "menu.pinProject", icon: "M9.6 2.2 13.8 6.4l-1.5.4-2.3 2.3.4 2.6-1.2 1.2-5.5-5.5 1.2-1.2 2.6.4 2.3-2.3zM5.6 10.4 2.6 13.4" },
  { id: "archive", label: "menu.archiveProject", icon: "M2.2 3h11.6v2.6H2.2zM3.2 5.6h9.6V13H3.2zM6.4 8.2h3.2", divided: true },
  { id: "batch", label: "menu.batch", icon: "M2.4 4.4h1.6M6.6 4.4h7M2.4 8h1.6M6.6 8h7M2.4 11.6h1.6M6.6 11.6h7" },
  { id: "reveal", label: "files.reveal", icon: "M2 4.4c0-.6.5-1 1-1h2.6l1.2 1.5h6.2c.5 0 1 .4 1 1v6.2c0 .6-.5 1-1 1H3c-.5 0-1-.4-1-1z", divided: true },
  { id: "copyDirectory", label: "menu.copyDirectory", icon: "M5.6 5.6h7.2v7.2H5.6zM3.2 10.4V3.2h7.2" },
  { id: "relocate", label: "menu.relocateProject", icon: "M2 4.4c0-.6.5-1 1-1h2.6l1.2 1.5h6.2c.5 0 1 .4 1 1v6.2c0 .6-.5 1-1 1H3c-.5 0-1-.4-1-1zM8 7.4v4M6.4 9l1.6-1.6L9.6 9" },
  { id: "remove", label: "menu.removeProject", icon: "M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2", divided: true, danger: true },
]

/* A project's conversations that are still in the side column. */
const projectSessions = (directory: string) =>
  app.sessions.filter((session) => session.directory === directory && !session.archived)

/* Settings keyed by a project's folder follow it when the folder changes. */
function rekey<T>(map: Record<string, T> | undefined, from: string, to: string): Record<string, T> {
  const next = { ...(map ?? {}) }
  if (from in next) {
    next[to] = next[from]
    delete next[from]
  }
  return next
}

const PROJECT_ACTIONS: Record<string, (directory: string) => void | Promise<void>> = {
  rename: (directory) => {
    renamingProject.value = directory
  },
  appearance: (directory) => {
    editingProject.value = directory
  },
  /* MiMo's pinToFront: the latest pin heads 置顶, and a toast says what happened. */
  pin: async (directory) => {
    const pinned = app.config?.pinnedProjects ?? []
    const was = pinned.includes(directory)
    await app.patchConfig({
      pinnedProjects: was ? pinned.filter((entry) => entry !== directory) : [directory, ...pinned],
    })
    notify(t(was ? "side.projectUnpinnedToast" : "side.projectPinnedToast"))
  },
  archive: async (directory) => {
    for (const session of projectSessions(directory)) await app.archive(session.id, true)
  },
  /* MiMo's project batch management chooses projects, starting with this one. */
  batch: (directory) => {
    selecting.value = undefined
    selectingProjects.value = [directory]
  },
  reveal: (directory) => {
    void window.mcode.revealFile(directory, "")
  },
  copyDirectory: (directory) => {
    window.mcode.setClipboardText(directory)
    notify(t("menu.copiedDirectory"))
  },
  /*
   * The folder was moved or renamed on disk: every conversation that worked in
   * the old path works in the new one, archived ones included, and the name,
   * icon, colour and pin the project had come along with it.
   */
  relocate: async (directory) => {
    const [next] = await window.mcode.pickDirectory(t("menu.relocateProject"), false)
    if (!next || next === directory) return
    for (const session of app.sessions.filter((entry) => entry.directory === directory)) await app.move(session.id, next)
    const config = app.config
    if (!config) return
    const swap = (list: string[] | undefined) => (list ?? []).map((entry) => (entry === directory ? next : entry))
    await app.patchConfig({
      projectNames: rekey(config.projectNames, directory, next),
      projectIcons: rekey(config.projectIcons, directory, next),
      projectColors: rekey(config.projectColors, directory, next),
      pinnedProjects: swap(config.pinnedProjects),
      closedProjects: swap(config.closedProjects),
    })
  },
  /* Asked first, as MiMo asks: the project leaves the list, its conversations stay. */
  remove: (directory) => {
    removingProjects.value = { directories: [directory], batch: false }
  },
}

/* Takes projects off the side column; opening the folder again brings each back. */
async function closeProjects(directories: string[]) {
  const closed = app.config?.closedProjects ?? []
  const next = [...closed, ...directories.filter((directory) => !closed.includes(directory))]
  if (next.length !== closed.length) await app.patchConfig({ closedProjects: next })
}

const projectMenuItems = computed<MenuItem[]>(() => {
  const directory = projectMenu.value?.directory
  const pinned = directory ? (app.config?.pinnedProjects ?? []).includes(directory) : false
  const live = directory ? projectSessions(directory).length : 0
  return PROJECT_MENU.filter((entry) => !(entry.id === "batch" && pinned)).map((entry) => ({
    key: entry.id,
    label: entry.id === "reveal" ? revealLabel() : t(entry.id === "pin" && pinned ? "side.unpinProject" : entry.label),
    // Archiving needs a conversation to act on. Batch management chooses projects, and a pinned one has no such row.
    enabled: Boolean(directory) && (entry.id !== "archive" || live > 0),
    divided: Boolean(entry.divided),
    icon: entry.icon,
    danger: Boolean(entry.danger),
  }))
})

async function runProjectMenu(key: string) {
  const directory = projectMenu.value?.directory
  projectMenu.value = undefined
  if (directory) await PROJECT_ACTIONS[key]?.(directory)
}

/**
 * Runs an application-menu item.
 *
 * The in-app menu offers what the platform menu does, so the ones that are
 * already commands go through the same table, and the rest are the bridge
 * calls the native menu would have made itself.
 */
function runAppMenu(key: string) {
  appMenu.value = undefined
  if (menuCommands[key]) {
    runMenuCommand(key)
    return
  }
  if (
    key === "undo" ||
    key === "redo" ||
    key === "cut" ||
    key === "copy" ||
    key === "paste" ||
    key === "delete" ||
    key === "selectAll"
  ) {
    window.mcode.edit(key)
    return
  }
  if (key === "reload" || key === "devtools" || key === "fullscreen") {
    window.mcode.view(key)
    return
  }
  if (key === "new-window") {
    window.mcode.newWindow()
    return
  }
  if (key === "zoom-in" || key === "zoom-out" || key === "zoom-reset") {
    window.mcode.zoom(key === "zoom-in" ? "in" : key === "zoom-out" ? "out" : "reset")
    return
  }
  /* 退出 quits for real; only closing a window may hide it to the tray. */
  if (key === "quit") {
    window.mcode.quitApp()
    return
  }
  if (key === "minimize" || key === "maximize" || key === "close") {
    window.mcode.window(key)
  }
}

/*
 * A row's menu acts on the conversation it names. The entries that have to
 * show it - renaming edits the header, exporting writes what is on screen -
 * open it first and then run the command that already exists, so there is one
 * implementation of each rather than two that can drift.
 */
async function runSessionMenu(key: string) {
  const target = menuSession.value?.id
  const header = Boolean(sessionMenu.value?.header)
  sessionMenu.value = undefined
  if (!target) return
  // A project chosen in the move submenu.
  if (key.startsWith("move:")) {
    const directory = key.slice("move:".length)
    if (app.sessions.find((entry) => entry.id === target)?.directory !== directory) await app.move(target, directory)
    return
  }
  const own = ROW_ACTIONS[key]
  if (own) {
    await own(target, header)
    return
  }
  if (app.currentID !== target) {
    view.value = "session"
    await app.open(target)
  }
  await commands.value.find((entry) => entry.id === key)?.run()
}

/* A double-click on a row's title renames it in the same dialog its menu's rename opens. */
function renameFromSide(sessionID: string) {
  beginRename(sessionID)
}

async function confirmDeleteSession() {
  const target = deletingSession.value
  deletingSession.value = undefined
  if (target) await app.remove(target)
}

/* A project ticked or unticked in project selection mode. */
function toggleProjectSelected(directory: string) {
  const current = selectingProjects.value ?? []
  selectingProjects.value = current.includes(directory)
    ? current.filter((entry) => entry !== directory)
    : [...current, directory]
}

/* What MiMo's project selection bar asks for. */
async function runProjectBatch(action: "archive" | "remove" | "exit" | "all" | "none", directories: string[] = []) {
  if (action === "exit") {
    selectingProjects.value = undefined
    return
  }
  if (action === "all" || action === "none") {
    selectingProjects.value = action === "all" ? [...directories] : []
    return
  }
  const chosen = selectingProjects.value ?? []
  if (!chosen.length) return
  if (action === "archive") {
    for (const directory of chosen) {
      for (const session of projectSessions(directory)) await app.archive(session.id, true)
    }
    selectingProjects.value = undefined
    return
  }
  removingProjects.value = { directories: [...chosen], batch: true }
}

async function confirmRemoveProjects() {
  const removing = removingProjects.value
  removingProjects.value = undefined
  if (!removing) return
  await closeProjects(removing.directories)
  if (removing.batch) selectingProjects.value = undefined
}

/*
 * The new-project dialog's answer, from the Projects "+" or from 新建项目… in the
 * move submenu. With a source folder, that folder under the name given;
 * without, a new empty folder. A conversation waiting on it moves in and opens;
 * otherwise the project is added and opened, as a dropped folder is.
 */
async function createNamedProject(title: string, source?: string) {
  const moving = namingProject.value?.sessionID
  namingProject.value = undefined
  let directory = source
  if (!directory) {
    try {
      directory = (await app.client?.request({ type: "project.createBlank", name: title }))?.directory
    } catch (failure) {
      notifyFailure(t("menu.createFailed", { error: reasonOf(failure) }))
      return
    }
  }
  if (!directory) return
  if (source && title !== folderName(source)) {
    await app.patchConfig({ projectNames: { ...(app.config?.projectNames ?? {}), [source]: title } })
  }
  if (moving) {
    const closed = app.config?.closedProjects ?? []
    if (closed.includes(directory)) await app.patchConfig({ closedProjects: closed.filter((entry) => entry !== directory) })
    await app.move(moving, directory)
    if (app.currentID !== moving) await app.open(moving)
    view.value = "session"
    return
  }
  // DL15: MiMo lands on the home screen with the new project picked, and makes no conversation for it.
  await newSessionIn(directory)
}

/**
 * The conversation on show as Markdown, in MiMo's shape (lib/convo-export.ts).
 * Round 3 AR16 (artifacts agent).
 */
function transcriptMarkdown(): string {
  return transcriptOf(app.current ? sessionTitle(app.current.title) : "", app.messages)
}

/**
 * A session as data rather than as prose.
 *
 * The reference exports {info, messages} indented by two, and names the file
 * after the session's title with everything outside [a-z0-9_-] collapsed to a
 * hyphen. Tool calls and reasoning are included here where the readable
 * transcript drops them: this is the format meant to be parsed, so leaving
 * parts out would defeat it.
 */
function exportFilename(): string {
  const session = app.current
  const raw = session ? sessionTitle(session.title) || session.id : "session"
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `${clean || session?.id || "session"}.json`
}

/**
 * Says that writing a file did not work, and leaves the app alone otherwise.
 *
 * `app.error` is the one message the boot screen reads, and setting it does
 * more than show a line of text: it hides the empty-session hero, takes the
 * blank class off the body, and puts a raw exception in the stream with nothing
 * to dismiss it. That is right for a backend that never started - there is no
 * app to go back to - and wrong for a save that failed, which leaves everything
 * else exactly where it was. So this goes in a toast, which times out and has a
 * close button.
 *
 * `what` names the thing that was being attempted, so the message is not just a
 * bare errno with no subject.
 */
function reportSaveFailure(what: string, failure: unknown): void {
  notifyFailure(what, reasonOf(failure))
}

/**
 * The part of a failure worth showing someone.
 *
 * Anything thrown inside a main-process handler comes back wrapped as "Error
 * invoking remote method 'mcode:save-text': ...", which tells the reader about
 * this app's plumbing rather than about the disk being full or the file being
 * open in something else.
 */
function reasonOf(failure: unknown): string {
  const raw = failure instanceof Error ? failure.message : String(failure)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "")
}

/* Round 3 AR17-AR18 (artifacts agent): MiMo's file name and single-line toasts, shared with the row menu's export. */
async function exportSessionData() {
  if (!app.current) return
  await saveExport(exportFilename(), JSON.stringify({ info: app.current, messages: app.messages }, null, 2))
}

async function exportSession() {
  if (!app.messages.length) return
  await exportConversationMarkdown(app.current ? sessionTitle(app.current.title) : "", app.messages)
}

/**
 * Puts a conversation somewhere it can be sent to someone.
 *
 * The reference publishes to a URL on its own service; there is no service
 * behind this app, so sharing here means a single self-contained page - no
 * assets, no network - that opens in any browser and can be attached to a
 * message. Unsharing is deleting that file, which is the user's to do.
 */
async function shareSession() {
  if (!app.messages.length) return
  const title = app.current ? sessionTitle(app.current.title) : "session"
  const name = title.replace(/[\/:*?"<>|]/g, "-").slice(0, 60)
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

  const style = [
    "body{margin:0;background:#080808;color:#fafafa;",
    "font:440 14px/1.6 ui-sans-serif,system-ui,'Segoe UI',sans-serif}",
    "main{max-width:760px;margin:0 auto;padding:40px 20px}",
    "h1{font-size:17px;font-weight:600;margin:0 0 24px}",
    ".turn{margin:0 0 24px}",
    ".who{font-size:11px;font-weight:530;letter-spacing:.05px;color:gray;margin:0 0 6px}",
    ".said{overflow-wrap:anywhere}",
    ".said p{margin:0 0 12px}.said p:last-child{margin:0}",
    ".said pre{background:#161616;border-radius:6px;padding:10px 12px;overflow-x:auto}",
    ".said code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px}",
    ".said ul,.said ol{margin:0 0 12px;padding-left:22px}",
    ".said h1,.said h2,.said h3{font-size:14px;font-weight:600;margin:16px 0 8px}",
    ".user .said{background:#242424;border-radius:6px;padding:10px 12px}",
    ".note{margin:32px 0 0;padding-top:16px;border-top:1px solid #242424;",
    "font-size:12px;color:gray}",
  ].join("")

  /*
   * Whether anything was left on the floor. Counted rather than assumed: a
   * conversation of plain text has nothing missing, and a note claiming
   * otherwise would be its own small lie.
   */
  const dropped = app.messages.some((message) =>
    message.role === "user"
      ? Boolean(message.attachments?.length)
      : message.parts.some((part) => part.type !== "text"),
  )

  const turns = app.messages
    .map((message) => {
      // A user turn carries its text directly; an assistant turn carries parts.
      const said =
        message.role === "user"
          ? message.text
          : message.parts
              .map((part) => (part.type === "text" ? part.text : ""))
              .filter(Boolean)
              .join("\n\n")
      if (!said.trim()) return ""
      const who = message.role === "user" ? t("share.you") : t("share.assistant")
      // renderMarkdown escapes its source before formatting, so this is the
      // same guarantee `escape` gave, with the formatting kept.
      return `<div class="turn ${message.role}"><p class="who">${escape(who)}</p>` +
        `<div class="said">${renderMarkdown(said)}</div></div>`
    })
    .filter(Boolean)
    .join("\n")

  const page = [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<title>${escape(title)}</title>`,
    `<style>${style}</style></head><body><main>`,
    `<h1>${escape(title)}</h1>`,
    turns,
    dropped ? `<p class="note">${escape(t("share.omitted"))}</p>` : "",
    "</main></body></html>",
  ].join("\n")

  try {
    const saved = await window.mcode.saveText(`${name}.html`, page)
    // The page is meant to be looked at, so this one opens rather than reveals.
    if (saved) {
      notify(t("share.saved"), {
        action: { label: t("share.view"), run: () => void window.mcode.openSaved(saved) },
      })
    }
  } catch (failure) {
    reportSaveFailure(t("toast.shareFailed"), failure)
  }
}

/**
 * Asks the model to write the project's instruction file.
 *
 * Nothing here reads the project - that is the model's job, with the tools it
 * already has. This only supplies the brief.
 */
async function initProject() {
  if (!app.currentID || app.busy) return
  await app.send(t("init.prompt"))
}

/**
 * Puts back the files the last turn changed.
 *
 * The conversation is left in place: it still happened, and a transcript that
 * quietly loses turns is worse than one that records an undone change.
 */
async function undoTurn() {
  const id = app.currentID
  if (!id) return
  try {
    const files = await app.undo(id)
    notify(t("toast.undone", { n: files }))
  } catch (failure) {
    notifyFailure(t("toast.undoFailed"), reasonOf(failure))
  }
}

async function redoTurn() {
  const id = app.currentID
  if (!id) return
  try {
    const files = await app.redo(id)
    notify(t("toast.redone", { n: files }))
  } catch (failure) {
    notifyFailure(t("toast.redoFailed"), reasonOf(failure))
  }
}

async function compactSession() {
  const id = app.currentID
  if (!id) return
  try {
    await app.compact(id)
    notify(t("toast.compacted"))
  } catch (failure) {
    notifyFailure(t("toast.compactFailed"), reasonOf(failure))
  }
}

/* The artifacts page is a place, so it is worth being able to come back to. */
function goArtifacts() {
  view.value = "artifacts"
  push({ view: "artifacts" })
}

/* The in-app browser, unless it has been switched off in settings - which also closes its tabs. */
const browserAllowed = computed(() => app.config?.browserEnabled !== false)
watch(browserAllowed, (allowed) => {
  if (!allowed) rp.close(rp.tabs.filter((tab) => tab.type === "browser").map((tab) => tab.id))
})

/*
 * MiMo's priority filter: the side column led by what wants attention, then
 * the rest of the week by day. Remembered, as MiMo remembers it, because it is
 * a way of working through the day rather than a glance at the list.
 */
const PRIORITY_KEY = "mcode.priorityFilter"
const priorityFilter = ref(
  (() => {
    try {
      return localStorage.getItem(PRIORITY_KEY) === "true"
    } catch {
      return false
    }
  })(),
)
watch(priorityFilter, (on) => {
  try {
    localStorage.setItem(PRIORITY_KEY, String(on))
  } catch {}
})

/* The priority section's archive-all, which MiMo applies to every conversation. */
async function archiveAll() {
  for (const session of app.sessions.filter((entry) => !entry.archived)) await app.archive(session.id, true)
}

/* So is the plugins page, which MiMo opens in the workspace rather than over it. */
function goPlugins() {
  view.value = "plugins"
  push({ view: "plugins" })
}

/* A conversation picked in the side column always shows it, even the current one sitting behind the artifacts page. */
async function openFromSide(sessionID: string) {
  view.value = "session"
  if (app.currentID !== sessionID) await app.open(sessionID)
}

/** A file's session, opened from the artifacts page. */
async function openFromArtifacts(sessionID: string) {
  view.value = "session"
  await app.open(sessionID)
}

/* A8: a conversation found by what was said in it opens at that message, as MiMo's requestReveal does. */
async function openFromSearch(sessionID: string, messageID?: string) {
  await openFromArtifacts(sessionID)
  if (messageID) app.revealMessage(messageID)
}

function goHome() {
  view.value = "home"
  push({ view: "home" })
}

/**
 * Steps through the open tabs.
 *
 * Wraps at both ends: with three conversations open, going back from the first
 * should reach the last rather than stop, which is what makes the pair of
 * shortcuts usable without looking at the row.
 */
/**
 * Steps to the next session with something waiting.
 *
 * Wraps around and stops where it started, so pressing it with nothing unread
 * leaves the screen alone rather than walking the whole strip.
 */
async function stepUnread(by: 1 | -1) {
  const tabs = app.tabs
  if (!tabs.length) return
  const at = app.currentID ? tabs.indexOf(app.currentID) : -1
  for (let step = 1; step <= tabs.length; step += 1) {
    const candidate = tabs[(at + by * step + tabs.length * step) % tabs.length]
    if (candidate && app.unread(candidate)) {
      await app.open(candidate)
      return
    }
  }
}

/*
 * A link that opens this conversation from anywhere else, as MiMo copies one:
 * the session and the project it sits in, under this app's own scheme.
 */
function copySessionLink() {
  const session = app.current
  if (!session) return
  window.mcode.setClipboardText(sessionLink(session.id, session.directory))
  notify(t("menu.copiedLink"))
}

/* A link that arrives before the app has connected waits for it. */
let linksReady = false
let queuedLink: SessionLinkTarget | undefined

function receiveLink(link: SessionLinkTarget) {
  if (!linksReady) {
    queuedLink = link
    return
  }
  void openLink(link)
}

async function openLink(link: SessionLinkTarget) {
  try {
    if (link.sessionID !== app.currentID) await app.open(link.sessionID)
    view.value = "session"
  } catch {
    notifyFailure(t("menu.linkMissing"))
  }
}

/*
 * Ctrl+Tab walks the conversations in the order they were last viewed: a quick
 * press goes back to the previous one, and pressing Tab again with Ctrl still
 * held goes further back. The order is taken when the walk starts and kept
 * until the modifiers are let go, because every step opens a conversation and
 * would otherwise reshuffle the list being walked.
 */
let recentWalk: { order: string[]; at: number } | undefined

async function stepRecent(by: 1 | -1) {
  if (!recentWalk) {
    const live = new Set(app.sessions.filter((session) => !session.archived).map((session) => session.id))
    const order = app.recent.filter((id) => live.has(id))
    if (order.length < 2) return
    recentWalk = { order, at: app.currentID ? Math.max(0, order.indexOf(app.currentID)) : 0 }
  }
  const walk = recentWalk
  walk.at = (walk.at + by + walk.order.length) % walk.order.length
  const target = walk.order[walk.at]
  if (target !== app.currentID) await app.open(target)
  view.value = "session"
}

function endRecentWalk(event?: KeyboardEvent) {
  if (event && (event.ctrlKey || event.metaKey || event.altKey)) return
  recentWalk = undefined
}
const forgetRecentWalk = () => endRecentWalk()

async function stepSession(by: 1 | -1) {
  const tabs = app.tabs
  if (tabs.length < 2) return
  const at = app.currentID ? tabs.indexOf(app.currentID) : -1
  const next = tabs[(at + by + tabs.length) % tabs.length]
  if (next) await app.open(next)
}

/**
 * Steps through the projects, landing on whichever session each was last left
 * in - going to a project means going back to the work, not to a file list.
 */
async function stepProject(by: 1 | -1) {
  const closed = new Set(app.config?.closedProjects ?? [])
  const seen = new Map<string, number>()
  for (const session of app.sessions) {
    if (session.archived || closed.has(session.directory)) continue
    seen.set(session.directory, Math.max(seen.get(session.directory) ?? 0, session.updated))
  }
  const dirs = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([dir]) => dir)
  if (dirs.length < 2) return

  const here = app.current?.directory
  const at = here ? dirs.indexOf(here) : -1
  const target = dirs[(at + by + dirs.length) % dirs.length]
  const newest = app.sessions
    .filter((session) => session.directory === target && !session.archived)
    .sort((a, b) => b.updated - a.updated)[0]
  if (newest) await app.open(newest.id)
}

/**
 * Steps out of a project that was just closed.
 *
 * Only when it is the one on screen: closing some other project from the rail
 * should not throw away what the user is in the middle of.
 */
function leaveProject(directory: string) {
  if (app.current?.directory !== directory) return
  app.currentID = undefined
  goHome()
}

// ---------------------------------------------------------------------------
// Navigation history
// ---------------------------------------------------------------------------

interface Location {
  view: "home" | "session" | "artifacts" | "plugins"
  sessionID?: string
}

const history = ref<Location[]>([{ view: "home" }])
const cursor = ref(0)
/** Set while back/forward applies a location, so the watcher does not re-push it. */
let replaying = false

const canGoBack = computed(() => cursor.value > 0)
const canGoForward = computed(() => cursor.value < history.value.length - 1)

function push(location: Location) {
  const current = history.value[cursor.value]
  if (current?.view === location.view && current.sessionID === location.sessionID) return
  // Navigating after going back drops whatever was ahead, as a browser does.
  history.value = [...history.value.slice(0, cursor.value + 1), location]
  cursor.value = history.value.length - 1
}

async function apply(location: Location) {
  replaying = true
  try {
    if (location.view === "session" && location.sessionID) {
      // The session may have been deleted since it was visited.
      if (!app.sessions.some((session) => session.id === location.sessionID)) {
        view.value = "home"
        return
      }
      if (app.currentID !== location.sessionID) await app.open(location.sessionID)
      view.value = "session"
    } else if (location.view === "artifacts") {
      view.value = "artifacts"
    } else if (location.view === "plugins") {
      view.value = "plugins"
    } else {
      view.value = "home"
    }
  } finally {
    replaying = false
  }
}

async function back() {
  if (!canGoBack.value) return
  cursor.value--
  await apply(history.value[cursor.value])
}

async function forward() {
  if (!canGoForward.value) return
  cursor.value++
  await apply(history.value[cursor.value])
}

/**
 * Palette commands, grouped and ordered by what they act on: the session first
 * because that is what the window is about, then the project, then what is on
 * screen, then the app.
 *
 * A command is listed only when it can actually do something. Half of these
 * used to appear on the home screen, where there is no session to rename, no
 * turn to stop, and no panel to toggle - so choosing them did nothing at all.
 */
/**
 * Every command the app defines, whether or not it can run where you are.
 *
 * The palette narrows this to what is actionable; the shortcuts page must not,
 * because a chord belongs to a command rather than to a moment.
 */
/* One command, as the palette, the menus, the key table and the shortcuts page all read it. */
interface AppCommand {
  id: string
  group: string
  title: string
  hint?: string
  enabled?: boolean | (() => boolean)
  hidden?: boolean
  danger?: boolean
  run: () => unknown
}

const bindableCommands = computed((): AppCommand[] => {
  const hasSession = Boolean(app.currentID)
  const inWorkspace = !isHome.value

  const all: AppCommand[] = [
    // Session
    { id: "session.new", group: "key.groupGeneral", title: t("cmd.newSession"), hint: "Ctrl+N", run: newSession },
    {
      id: "view.model",
      group: "key.groupModels",
      title: t("cmd.switchModel"),
      // MiMo's chord for its model picker; Ctrl+' still opens the same menu.
      hint: "Ctrl+Shift+M",
      // The picker hangs off the composer's model pill, and the composer is
      // only mounted inside a project - so on the home screen this command had
      // nothing to open, and both menus offered it anyway.
      enabled: inWorkspace,
      run: () => composer.value?.openModelMenu(),
    },
    {
      id: "session.abort",
      group: "key.groupSession",
      title: t("cmd.abort"),
      enabled: app.busy,
      run: () => app.abort(),
    },
    {
      id: "session.rename",
      group: "key.groupSession",
      title: t("cmd.rename"),
      hint: "Ctrl+Alt+R",
      enabled: hasSession,
      run: () => beginRename(),
    },
    {
      id: "session.undo",
      group: "key.groupSession",
      title: t("cmd.undo"),
      enabled: hasSession && !app.busy && app.history.undo > 0,
      run: undoTurn,
    },
    {
      id: "session.redo",
      group: "key.groupSession",
      title: t("cmd.redo"),
      enabled: hasSession && !app.busy && app.history.redo > 0,
      run: redoTurn,
    },
    {
      id: "session.share",
      group: "key.groupSession",
      title: t("share.session"),
      enabled: hasSession && app.messages.length > 0,
      run: shareSession,
    },
    {
      id: "session.export",
      group: "key.groupSession",
      title: t("cmd.export"),
      enabled: hasSession && app.messages.length > 0,
      run: exportSessionData,
    },
    {
      id: "session.exportMarkdown",
      group: "key.groupSession",
      title: t("cmd.exportMarkdown"),
      enabled: hasSession && app.messages.length > 0,
      run: exportSession,
    },
    {
      id: "app.server",
      group: "key.groupGeneral",
      title: t("server.switch"),
      run: () => void chooseServer(),
    },
    {
      id: "app.update",
      group: "key.groupGeneral",
      title: t("update.check"),
      run: () => void checkForUpdates(),
    },
    {
      id: "app.exportLog",
      group: "key.groupGeneral",
      title: t("cmd.exportLog"),
      run: exportLog,
    },
    {
      id: "project.init",
      group: "key.groupGeneral",
      title: t("cmd.init"),
      enabled: hasSession && !app.busy,
      run: initProject,
    },
    {
      id: "session.compact",
      group: "key.groupSession",
      title: t("cmd.compact"),
      // A model call, and pointless on a conversation that is one exchange long.
      enabled: hasSession && !app.busy && !app.compacting && app.messages.length > 1,
      run: compactSession,
    },
    {
      // The title swaps with the state, so the row always names what pressing
      // it will do rather than what is currently true.
      id: "permissions.autoaccept",
      group: "key.groupSession",
      title: autoAcceptAll() ? t("cmd.autoAcceptOff") : t("cmd.autoAcceptOn"),
      hint: "Ctrl+Shift+A",
      run: () => void toggleAutoAccept(),
    },
    {
      id: "session.archive",
      group: "key.groupSession",
      title: t("cmd.archive"),
      hint: "Ctrl+Alt+A",
      enabled: hasSession,
      run: async () => {
        if (app.currentID) await app.archive(app.currentID, true)
      },
    },
    {
      id: "session.delete",
      group: "key.groupSession",
      title: t("cmd.delete"),
      danger: true,
      enabled: hasSession,
      run: () => {
        if (app.currentID) deletingSession.value = app.currentID
      },
    },

    // Project
    { id: "project.open", group: "key.groupGeneral", title: t("cmd.openProject"), hint: "Ctrl+O", run: browse },
    { id: "view.home", group: "key.groupGeneral", title: t("cmd.goHome"), enabled: inWorkspace, run: goHome },

    // View
    {
      id: "view.left",
      group: "key.groupGeneral",
      title: leftPanel.value ? t("cmd.hideSessions") : t("cmd.showSessions"),
      hint: "Ctrl+B",
      // On every screen, as MiMo's is: the home screen has a side column to fold too.
      run: () => (leftPanel.value = !leftPanel.value),
    },
    // MiMo's panel and browser chords.
    {
      id: "view.bottom",
      group: "key.groupGeneral",
      title: t("key.bottomPanel"),
      hint: "Ctrl+J",
      enabled: inWorkspace,
      run: () => (terminalOpen.value = !terminalOpen.value),
    },
    {
      id: "view.browser",
      group: "key.groupGeneral",
      title: t("key.browserPanel"),
      hint: "Ctrl+Shift+B",
      enabled: browserAllowed.value,
      run: toggleBrowserTab,
    },
    {
      id: "browser.tab",
      group: "key.groupGeneral",
      title: t("key.browserTab"),
      hint: "Ctrl+T",
      enabled: inConversation.value && browserAllowed.value,
      run: openBrowserTab,
    },
    { id: "browser.address", group: "key.groupGeneral", title: t("key.browserAddress"), hint: "Ctrl+L", run: focusBrowserAddress },
    {
      id: "browser.reload",
      group: "key.groupGeneral",
      title: t("key.browserReload"),
      hint: "Ctrl+R",
      enabled: hasBrowserTab.value,
      run: () => reloadBrowser(),
    },
    {
      id: "browser.forceReload",
      group: "key.groupGeneral",
      title: t("key.browserForceReload"),
      hint: "Ctrl+Shift+R",
      enabled: hasBrowserTab.value,
      run: () => reloadBrowser(true),
    },
    {
      id: "view.review",
      group: "key.groupSession",
      title: t("key.reviewTab"),
      hint: "Ctrl+Shift+G",
      enabled: inConversation.value,
      run: openReviewTab,
    },
    {
      id: "app.copyDirectory",
      group: "key.groupSession",
      title: t("menu.copyDirectory"),
      hint: "Ctrl+Shift+C",
      enabled: hasSession,
      run: copyWorkingDirectory,
    },
    {
      id: "view.server",
      group: "key.groupGeneral",
      title: t("cmd.server"),
      enabled: inWorkspace,
      run: () => (serverPanel.value = !serverPanel.value),
    },
    {
      id: "view.right",
      group: "key.groupSession",
      title: t("key.sidePanel"),
      hint: "Ctrl+Alt+B",
      run: toggleSidePanel,
    },
    {
      id: "view.terminal",
      group: "key.groupTerminal",
      title: terminalOpen.value ? t("cmd.hideTerminal") : t("cmd.showTerminal"),
      hint: "Ctrl+`",
      enabled: inWorkspace,
      run: () => (terminalOpen.value = !terminalOpen.value),
    },

    ...(["build", "plan"] as const).map((entry) => ({
      id: `agent.${entry}`,
      group: "key.groupModels",
      title: t("cmd.useAgent", { name: t(`agent.${entry}`) }),
      enabled: (app.config?.agent ?? "build") !== entry,
      run: async () => {
        await app.patchConfig({ agent: entry })
      },
    })),
    ...(["system", "dark", "light"] as const).map((entry) => ({
      id: `scheme.${entry}`,
      group: "key.groupGeneral",
      title: t("cmd.useScheme", { name: t(`set.theme${entry[0].toUpperCase()}${entry.slice(1)}`) }),
      enabled: (app.config?.theme ?? "system") !== entry,
      run: async () => {
        await app.patchConfig({ theme: entry })
      },
    })),
    ...LANGUAGES.map((entry) => ({
      id: `language.${entry.id}`,
      group: "key.groupGeneral",
      title: t("cmd.useLanguage", { name: entry.label }),
      run: () => void setLanguage(entry.id),
    })),
    {
      id: "language.cycle",
      group: "key.groupGeneral",
      title: t("cmd.cycleLanguage"),
      run: () => void cycleLanguage(),
    },
    ...THEMES.map((entry) => ({
      id: `theme.${entry.id}`,
      group: "key.groupGeneral",
      title: t("cmd.useTheme", { name: entry.name }),
      run: () => void setTheme(entry.id, entry.name),
    })),
    // App
    {
      /*
       * The reference's "Delete workspace". Only offered from inside one: the
       * repository's own checkout is not a workspace, and the entry would do
       * nothing there.
       */
      id: "workspace.remove",
      group: "key.groupGeneral",
      title: t("workspace.delete"),
      enabled: inWorkspace && inRemovableWorkspace.value,
      run: () => void askDeleteWorkspace(),
    },
    {
      id: "workspace.new",
      group: "key.groupGeneral",
      title: t("workspace.new"),
      hint: "Ctrl+Shift+W",
      enabled: hasSession,
      run: () => void newWorkspace(),
    },
    {
      id: "workspace.switch",
      group: "key.groupGeneral",
      title: t("workspace.switch"),
      enabled: hasSession,
      run: () => void switchWorkspace(),
    },
    {
      id: "composer.promptMode",
      group: "key.groupPrompt",
      title: t("cmd.promptMode"),
      hint: "Ctrl+Shift+E",
      enabled: hasSession,
      run: () => composer.value?.setMode("normal"),
    },
    {
      id: "composer.shellMode",
      group: "key.groupPrompt",
      title: t("cmd.shellMode"),
      hint: "Ctrl+Shift+X",
      enabled: hasSession,
      run: () => composer.value?.setMode("shell"),
    },
    // MiMo's 发送消息 row; Enter itself is answered by the composer.
    {
      id: "composer.send",
      group: "key.groupPrompt",
      title: t("cmd.sendMessage"),
      enabled: hasSession,
      run: () => void composer.value?.submit(),
    },
    {
      id: "app.openFile",
      group: "key.groupNavigation",
      title: t("cmd.openFile"),
      hint: "Ctrl+P",
      // MiMo's: the right panel's files tab, which needs a conversation to hold it.
      enabled: inConversation.value,
      run: openFilesTab,
    },
    {
      id: "app.attachFile",
      group: "key.groupNavigation",
      title: t("cmd.attachFile"),
      hint: "Ctrl+U",
      enabled: hasSession,
      run: () => composer.value?.pick(),
    },
    /*
     * The other half of attaching: naming a file in the sentence instead of
     * carrying it alongside. The reference offers both from the same menu on
     * the box, and this is where MCode keeps that menu's entries.
     */
    {
      id: "app.addContext",
      group: "key.groupNavigation",
      title: t("composer.context"),
      enabled: hasSession,
      run: () => composer.value?.openContext(),
    },
    {
      id: "app.addSelection",
      group: "key.groupGeneral",
      title: t("cmd.addSelection"),
      enabled: hasSession,
      run: () => addSelection(),
    },
    {
      id: "app.searchSessions",
      group: "key.groupGeneral",
      // No chord: MiMo's Ctrl+F is only the find bar's.
      title: t("cmd.searchSessions"),
      run: () => openPalette("sessions"),
    },
    {
      id: "app.searchProjects",
      group: "key.groupGeneral",
      title: t("cmd.searchProjects"),
      hint: "Ctrl+Shift+O",
      run: () => openPalette("projects"),
    },
    {
      id: "session.prevUnread",
      group: "key.groupSession",
      title: t("cmd.prevUnread"),
      hint: "Alt+Shift+↑",
      run: () => void stepUnread(-1),
    },
    {
      id: "session.nextUnread",
      group: "key.groupSession",
      title: t("cmd.nextUnread"),
      hint: "Alt+Shift+↓",
      run: () => void stepUnread(1),
    },
    {
      /*
       * The reference's `command.steps.toggle`. Its own description scopes it
       * to the current message; there is no focused message here - stepping
       * between them scrolls rather than selecting - so it moves the whole
       * transcript, which is the same thing when there is nothing to focus.
       */
      id: "view.steps",
      group: "key.groupSession",
      title: t("cmd.toggleSteps"),
      enabled: inWorkspace,
      run: toggleSteps,
    },
    {
      id: "session.prevMessage",
      group: "key.groupSession",
      title: t("cmd.prevMessage"),
      hint: "Ctrl+Alt+[",
      run: () => stream.value?.stepMessage(-1),
    },
    {
      id: "session.nextMessage",
      group: "key.groupSession",
      title: t("cmd.nextMessage"),
      hint: "Ctrl+Alt+]",
      run: () => stream.value?.stepMessage(1),
    },
    {
      id: "session.reopenTab",
      group: "key.groupGeneral",
      title: t("cmd.reopenTab"),
      hint: "Ctrl+Shift+T",
      run: () => void app.reopenTab(),
    },
    {
      id: "app.mcp",
      group: "key.groupModels",
      title: t("cmd.mcp"),
      hint: "Ctrl+;",
      run: () => openSettings("mcp"),
    },
    {
      id: "session.previous",
      group: "key.groupSession",
      title: t("key.prevSession"),
      // MiMo's chord; Alt+Up still steps as well.
      hint: "Ctrl+Shift+[",
      run: () => void stepSession(-1),
    },
    {
      id: "session.next",
      group: "key.groupSession",
      title: t("key.nextSession"),
      // MiMo's chord; Alt+Down still steps as well.
      hint: "Ctrl+Shift+]",
      run: () => void stepSession(1),
    },
    {
      id: "agent.cycle",
      group: "key.groupModels",
      title: t("key.cycleAgent"),
      hint: "Ctrl+.",
      enabled: hasSession,
      run: () => void cycleAgent(1),
    },
    {
      id: "agent.cycle.reverse",
      group: "key.groupModels",
      title: t("key.cycleAgentBack"),
      hint: "Ctrl+Shift+.",
      enabled: hasSession,
      run: () => void cycleAgent(-1),
    },
    {
      // Unbound, as MiMo leaves it.
      id: "model.variant.cycle",
      group: "key.groupModels",
      title: t("key.cycleEffort"),
      run: () => void cycleEffort(),
    },
    {
      id: "effort.decrease",
      group: "key.groupModels",
      title: t("key.decreaseEffort"),
      run: () => void stepEffort(-1),
    },
    {
      id: "effort.increase",
      group: "key.groupModels",
      title: t("key.increaseEffort"),
      run: () => void stepEffort(1),
    },
    {
      // MiMo's 切换语音模式, unbound: voice input between 智能编辑 and 快速输入.
      id: "voice.toggle",
      group: "key.groupPrompt",
      title: t("key.label.toggle-voice"),
      run: () => void app.toggleVoiceMode(),
    },
    {
      // MiMo's 切换编排模式, unbound: for the open conversation, or on the home screen for the next task.
      id: "composer.staged.toggle",
      group: "key.groupPrompt",
      title: t("key.label.toggle-plan"),
      run: () => void app.toggleComposeMode(isHome.value),
    },
    {
      id: "project.previous",
      group: "key.groupGeneral",
      title: t("key.prevProject"),
      hint: "Ctrl+Alt+↑",
      run: () => void stepProject(-1),
    },
    {
      id: "project.next",
      group: "key.groupGeneral",
      title: t("key.nextProject"),
      hint: "Ctrl+Alt+↓",
      run: () => void stepProject(1),
    },
    {
      id: "theme.cycle",
      group: "key.groupGeneral",
      // No chord: Ctrl+Shift+T is reopening a tab, and one chord holds one command.
      title: t("cmd.cycleTheme"),
      run: () => void cycleTheme(),
    },
    {
      id: "theme.scheme.cycle",
      group: "key.groupGeneral",
      title: t("cmd.cycleScheme"),
      hint: "Ctrl+Shift+S",
      run: () => void cycleScheme(),
    },
    {
      id: "input.focus",
      group: "key.groupGeneral",
      title: t("key.focusInput"),
      hint: "Ctrl+Shift+L",
      enabled: hasSession,
      run: () => composer.value?.focus(),
    },
    {
      // MiMo's 查找: the find bar in the conversation. Ctrl+F itself is answered in onKeydown.
      id: "app.find",
      group: "key.groupGeneral",
      title: t("key.label.find"),
      hint: "Ctrl+F",
      run: () => void openFind(),
    },
    {
      // MiMo's: the window closes, hiding to the tray when that is on. A tab closes from its own ✕.
      id: "window.close",
      group: "key.groupGeneral",
      title: t("key.closeWindow"),
      hint: "Ctrl+W",
      run: () => window.mcode.window("close"),
    },
    /*
     * The numbered slots. The strip is what they count along - not the sidebar
     * and not the recency order - because the number a reader is aiming at is
     * the position they can see.
     */
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `tab.goto.${index + 1}`,
      group: "key.groupSession",
      title: t("key.gotoTab", { n: index + 1 }),
      hint: `Ctrl+${index + 1}`,
      enabled: () => app.tabs.length > index,
      run: () => {
        const target = app.tabs[index]
        if (target) void app.open(target)
      },
    })),
    {
      id: "session.side",
      group: "key.groupSession",
      title: t("side.chat"),
      hint: "Ctrl+Alt+S",
      enabled: inConversation.value,
      run: openSideChatTab,
    },
    {
      id: "view.priority",
      group: "key.groupGeneral",
      title: priorityFilter.value ? t("side.priorityOff") : t("side.priorityOn"),
      hint: "Ctrl+Alt+U",
      run: () => (priorityFilter.value = !priorityFilter.value),
    },
    {
      id: "session.pin",
      group: "key.groupSession",
      title: t("key.togglePin"),
      hint: "Ctrl+Alt+P",
      enabled: hasSession,
      run: () => {
        if (app.currentID) app.togglePinned(app.currentID)
      },
    },
    {
      id: "session.copyID",
      group: "key.groupSession",
      title: t("key.copyID"),
      hint: "Ctrl+Alt+C",
      enabled: hasSession,
      run: () => {
        if (!app.currentID) return
        window.mcode.setClipboardText(app.currentID)
        notify(t("menu.copiedID"))
      },
    },
    {
      id: "session.copyLink",
      group: "key.groupSession",
      title: t("key.copyLink"),
      hint: "Ctrl+Alt+L",
      enabled: hasSession,
      run: copySessionLink,
    },
    {
      id: "session.nextRecent",
      group: "key.groupSession",
      title: t("key.nextRecent"),
      hint: "Ctrl+Tab",
      run: async () => {
        await stepRecent(1)
        endRecentWalk()
      },
    },
    {
      id: "session.prevRecent",
      group: "key.groupSession",
      title: t("key.prevRecent"),
      hint: "Ctrl+Shift+Tab",
      run: async () => {
        await stepRecent(-1)
        endRecentWalk()
      },
    },
    {
      id: "app.shortcuts",
      group: "key.groupGeneral",
      title: t("key.showShortcuts"),
      hint: "Ctrl+Shift+/",
      run: () => {
        settingsSection.value = "keys"
        settingsOpen.value = true
      },
    },
    { id: "app.back", group: "key.groupGeneral", title: t("key.back"), hint: "Ctrl+[", run: () => void back() },
    { id: "app.forward", group: "key.groupGeneral", title: t("key.forward"), hint: "Ctrl+]", run: () => void forward() },
    {
      // MiMo's 搜索: the search overlay.
      id: "app.search",
      group: "key.groupGeneral",
      title: t("key.palette"),
      hint: "Ctrl+K",
      run: () => {
        searchOpen.value = true
      },
    },
    {
      id: "terminal.close",
      group: "key.groupTerminal",
      title: t("key.closeTerminal"),
      enabled: terminalOpen.value,
      run: () => drawer.value?.closeActive(),
    },
    {
      id: "zoom.in",
      group: "key.groupDisplay",
      title: t("key.zoomIn"),
      hint: "Ctrl+=",
      run: () => window.mcode.zoom("in"),
    },
    {
      id: "zoom.out",
      group: "key.groupDisplay",
      title: t("key.zoomOut"),
      hint: "Ctrl+-",
      run: () => window.mcode.zoom("out"),
    },
    {
      id: "zoom.reset",
      group: "key.groupDisplay",
      title: t("key.zoomReset"),
      hint: "Ctrl+0",
      run: () => window.mcode.zoom("reset"),
    },
    /*
     * One per slot rather than one row covering the range: each carries its own
     * chord, so each has to be separately bindable. Hidden, because nine near
     * identical rows would crowd out everything else in the palette.
     */
    ...openProjects.value.slice(0, 9).map((directory, at) => ({
      id: `project.${at + 1}`,
      group: "key.groupGeneral",
      title: t("key.openProjectNumbered", { name: projectName(directory, app.config?.projectNames) }),
      hint: `Ctrl+Alt+${at + 1}`,
      hidden: true,
      run: () => startIn(directory),
    })),
    {
      // MiMo's branchConvo: the whole conversation at once, titled 「… (分支)」; the store toasts either way.
      id: "session.fork",
      group: "key.groupSession",
      title: t("key.label.fork-chat"),
      enabled: hasSession,
      run: () => {
        const last = app.messages[app.messages.length - 1]
        if (!last) notifyFailure(t("stream.branchNeedsMessage"))
        else void app.forkFrom(last.id, { titleSuffix: true })
      },
    },
    {
      id: "provider.connect",
      group: "key.groupGeneral",
      title: t("connect.title"),
      run: () => (connectOpen.value = true),
    },
    { id: "app.settings", group: "key.groupGeneral", title: t("cmd.settings"), hint: "Ctrl+,", run: openSettings },
    // MiMo's unbound rows: copy as Markdown, and the maximised side panel (only while the panel is open).
    {
      id: "session.copyMarkdown",
      group: "key.groupSession",
      title: t("menu.copyMarkdown"),
      enabled: hasSession && app.messages.length > 0,
      run: () => {
        if (app.currentID) void ROW_ACTIONS["row.copyMarkdown"](app.currentID, false)
      },
    },
    {
      id: "panel.maximize",
      group: "key.groupSession",
      title: t("key.toggleMaxSide"),
      enabled: rp.open,
      run: () => rp.toggleFullscreen(),
    },
  ]

  /* The shortcuts page draws lib/shortcut-page's fixed list out of these; every command keeps its chord. */
  return all
})

const commands = computed(() => bindableCommands.value.filter((command) => command.enabled !== false))

/** Anything that takes over the screen and should own the keyboard with it. */
/**
 * Whether something is up that owns the keyboard.
 *
 * The permission panel is deliberately absent: it is not modal - the composer
 * stays usable underneath it - so counting it here stopped every shortcut in
 * the app while an answer was pending. It binds Escape itself, on the capture
 * phase, which is the one key it does need.
 */
const modalOpen = computed(
  () =>
    Boolean(imagePreview.value) ||
    Boolean(videoPreview.value) ||
    settingsOpen.value ||
    choosingServer.value ||
    managingServers.value ||
    Boolean(namingWorkspace.value) ||
    Boolean(editingProject.value) ||
    Boolean(renamingSession.value) ||
    Boolean(renamingProject.value),
)

/* The box MiMo's annotations go to: the open conversation's, or the home screen's. */
const annotationScope = computed(() => (isHome.value || !app.currentID ? HOME_SCOPE : app.currentID))
watch(annotationScope, (scope) => (mainAnnotationScope.value = scope), { immediate: true })

/** Steps to the next colour scheme, in the order the settings list them. */
async function cycleScheme() {
  const order = ["system", "dark", "light"] as const
  const next = order[(order.indexOf(theme.value) + 1) % order.length]
  await app.patchConfig({ theme: next })
  notify(t("cmd.useScheme", { name: t(`set.theme${next[0].toUpperCase()}${next.slice(1)}`) }))
}

/**
 * Steps to the next language, naming it in the language being moved to.
 *
 * Naming it in its own language rather than the outgoing one is what makes the
 * step legible when you have cycled somewhere you cannot read.
 */
async function setLanguage(id: string) {
  const entry = LANGUAGES.find((candidate) => candidate.id === id)
  await app.patchConfig({ language: id })
  // Named in the language just chosen, which is what makes the step legible
  // when you have landed somewhere you cannot read.
  notify(t("toast.switchedTo", { name: entry?.label ?? id }))
}

async function cycleLanguage() {
  const current = language.value
  const index = LANGUAGES.findIndex((entry) => entry.id === current)
  await setLanguage(LANGUAGES[(index + 1) % LANGUAGES.length].id)
}

/** Steps to the next palette, naming it - there are thirty-seven to walk. */
async function setTheme(id: string, name: string) {
  await app.patchConfig({ themeID: id })
  notify(t("toast.switchedTo", { name }))
}

async function cycleTheme() {
  const index = THEMES.findIndex((entry) => entry.id === themeID.value)
  const next = THEMES[(index + 1) % THEMES.length]
  await setTheme(next.id, next.name)
}

/** Stops the browser opening a file the user let go of by accident. */
function swallowDrop(event: DragEvent) {
  event.preventDefault()
}

function onKeydown(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey
  if (event.isComposing || event.keyCode === 229) return

  /*
   * A shortcut the user has re-bound wins over the built-in table, and is
   * looked up by the chord rather than by the key - which is what lets a
   * rebinding move an action onto a combination the table knows nothing about.
   */
  if (!modalOpen.value) {
    const chord = chordOf(event)
    const bound = rebound.value.get(chord)
    if (bound) {
      const command = commands.value.find((entry) => entry.id === bound)
      if (command && command.enabled !== false) {
        event.preventDefault()
        void command.run()
        return
      }
    }
    // Nothing answers to it any more, and the built-in table below must not.
    if (retiredChords.value.has(chord)) {
      event.preventDefault()
      return
    }
  }

  /*
   * Ctrl+Tab and Ctrl+Shift+Tab, through the recently viewed conversations.
   * Ctrl rather than Cmd: on a Mac, Cmd+Tab belongs to the system.
   */
  if (event.ctrlKey && !event.altKey && event.key === "Tab") {
    if (modalOpen.value) return
    event.preventDefault()
    void stepRecent(event.shiftKey ? -1 : 1)
    return
  }

  /*
   * Alt+arrow walks the visit history. The bar used to carry a pair of arrow
   * buttons for this; the new one is a row of tabs, and the shortcut is what
   * keeps the history reachable now that they are gone.
   */
  if (event.altKey && !mod && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    if (modalOpen.value) return
    event.preventDefault()
    void (event.key === "ArrowLeft" ? back() : forward())
    return
  }

  /*
   * Alt+up and down step through the open conversations; adding Ctrl steps
   * through the projects instead. Same axis, one level out - which is why they
   * share a key and differ by a modifier.
   */
  if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    if (modalOpen.value) return
    event.preventDefault()
    const by = event.key === "ArrowUp" ? -1 : 1
    // Adding shift narrows the walk to the conversations asking for attention.
    if (event.shiftKey) void stepUnread(by)
    else void (mod ? stepProject(by) : stepSession(by))
    return
  }

  /*
   * Ctrl+Alt+bracket moves through the conversation itself, where the bare
   * bracket moves through the history of what was visited.
   */
  if (mod && event.altKey && (event.key === "[" || event.key === "]")) {
    if (modalOpen.value) return
    event.preventDefault()
    stream.value?.stepMessage(event.key === "[" ? -1 : 1)
    return
  }

  /*
   * Ctrl+Alt and a digit opens the slot the strip shows in that position.
   *
   * The reference puts this on Ctrl and a digit; here that already opens the
   * project in that position, and moving a shortcut a reader already uses is a
   * worse trade than putting the new one a modifier away.
   */
  if (mod && event.altKey && /^[1-9]$/.test(event.key)) {
    if (modalOpen.value) return
    const directory = openProjects.value[Number(event.key) - 1]
    if (!directory) return
    event.preventDefault()
    startIn(directory)
    return
  }

  /* The side panel, on MiMo's chord and on every screen, as its title-bar button is; its review tab is Ctrl+Shift+G. */
  if (mod && event.altKey && event.key.toLowerCase() === "b") {
    if (modalOpen.value) return
    event.preventDefault()
    toggleSidePanel()
    return
  }

  /* Pinning the open conversation, and copying the id of it. */
  if (mod && event.altKey && event.key.toLowerCase() === "p") {
    if (modalOpen.value || !app.currentID) return
    event.preventDefault()
    app.togglePinned(app.currentID)
    return
  }

  /* Renaming and archiving the open conversation, on MiMo's chords. */
  if (mod && event.altKey && event.key.toLowerCase() === "r") {
    if (modalOpen.value || !app.currentID || isHome.value) return
    event.preventDefault()
    beginRename()
    return
  }

  if (mod && event.altKey && event.key.toLowerCase() === "a") {
    if (modalOpen.value || !app.currentID) return
    event.preventDefault()
    void app.archive(app.currentID, true)
    return
  }

  /* A side chat tab, on MiMo's chord. */
  if (mod && event.altKey && event.key.toLowerCase() === "s") {
    if (modalOpen.value) return
    event.preventDefault()
    openSideChatTab()
    return
  }

  /* The priority filter, on MiMo's own chord. */
  if (mod && event.altKey && event.key.toLowerCase() === "u") {
    if (modalOpen.value) return
    event.preventDefault()
    priorityFilter.value = !priorityFilter.value
    return
  }

  if (mod && event.altKey && event.key.toLowerCase() === "c") {
    if (modalOpen.value || !app.currentID) return
    event.preventDefault()
    window.mcode.setClipboardText(app.currentID)
    notify(t("menu.copiedID"))
    return
  }

  if (mod && event.altKey && event.key.toLowerCase() === "l") {
    if (modalOpen.value || !app.current) return
    event.preventDefault()
    copySessionLink()
    return
  }

  if (!mod) return

  // Zoom keys carry several spellings depending on layout and shift state,
  // and the numpad reports its own codes.
  const zoomIn = event.key === "=" || event.key === "+" || event.code === "NumpadAdd"
  const zoomOut = event.key === "-" || event.key === "_" || event.code === "NumpadSubtract"
  const zoomReset = event.key === "0" || event.code === "Numpad0"
  if (zoomIn || zoomOut || zoomReset) {
    event.preventDefault()
    window.mcode.zoom(zoomIn ? "in" : zoomOut ? "out" : "reset")
    return
  }

  /*
   * A shortcut fired behind a dialog acts on a screen the user cannot see -
   * Ctrl+N would quietly start a session under the settings window. The palette
   * is the one exception: its own shortcut still closes it.
   */
  if (modalOpen.value) return
  if (paletteOpen.value && event.key !== "k") return

  /*
   * Shift combinations first: they are separate commands, not variants, and a
   * handler table keyed on the bare letter cannot tell Ctrl+T from Ctrl+Shift+T.
   */
  /*
   * Find first, and only if a host will have it.
   *
   * `openFind` answers false when the chord was typed into a text field or when
   * no host wants it, and then Ctrl+F does nothing, as MiMo's does. Ctrl+G
   * steps, Ctrl+Shift+G steps back, and neither does anything at all unless a
   * bar is open.
   */
  if (!event.shiftKey && event.key === "f" && openFind(event)) {
    event.preventDefault()
    return
  }
  if (event.key === "g" && stepFind(event.shiftKey ? -1 : 1, event)) {
    event.preventDefault()
    return
  }

  /*
   * MiMo's previous and next chat. Read by where the key sits rather than by
   * what it types: with Shift held a bracket prints a brace on some layouts
   * and something else entirely on others.
   */
  if (mod && event.shiftKey && !event.altKey && (event.code === "BracketLeft" || event.code === "BracketRight")) {
    if (modalOpen.value) return
    event.preventDefault()
    void stepSession(event.code === "BracketLeft" ? -1 : 1)
    return
  }

  if (event.shiftKey) {
    const shifted: Record<string, () => void> = {
      // MiMo's: a reload that skips the cache, while there is a page to reload.
      r: () => reloadBrowser(true),
      // MiMo's model picker and working directory.
      m: () => composer.value?.openModelMenu(),
      c: copyWorkingDirectory,
      // Stepping back through a search while one is open; otherwise the review tab.
      g: () => {
        if (!stepFind(-1, event)) openReviewTab()
      },
      // Approve everything, or stop. Symmetric, and it always says so.
      a: () => void toggleAutoAccept(),
      // Searching the projects rather than the sessions inside one.
      o: () => openPalette("projects"),
      // A second checkout of the project, on its own branch.
      w: () => void newWorkspace(),
      // The two composer modes, on the reference's keys.
      x: () => composer.value?.setMode("shell"),
      e: () => composer.value?.setMode("normal"),
      // The box, on MiMo's chord; Ctrl+L is the browser's address bar.
      l: () => composer.value?.focus(),
      // Agents, backwards; forwards is Ctrl+period.
      ".": () => void cycleAgent(-1),
      // Reopening a closed tab. The theme steps from its own command, which has no chord.
      t: () => void app.reopenTab(),
      // The scheme, then the palette. Stepping rather than opening a dialog is
      // what makes them worth a key: the answer is on screen immediately.
      s: () => void cycleScheme(),
      // MiMo's browser toggle.
      b: toggleBrowserTab,
      // And the list of all of these, which is a settings page here.
      "?": () => {
        settingsSection.value = "keys"
        settingsOpen.value = true
      },
      "/": () => {
        settingsSection.value = "keys"
        settingsOpen.value = true
      },
    }
    const shiftedHandler = shifted[event.key.toLowerCase()]
    if (!shiftedHandler) return
    event.preventDefault()
    shiftedHandler()
    return
  }

  /*
   * Ctrl and a digit opens the conversation in that slot of the strip, the way
   * MiMo and a browser both do. The project in that position is Ctrl+Alt and
   * the digit.
   */
  if (/^[1-9]$/.test(event.key)) {
    const target = app.tabs[Number(event.key) - 1]
    if (!target) return
    event.preventDefault()
    void selectTab(target)
    return
  }

  /*
   * The table below is Ctrl alone. With Alt held a chord is a different one -
   * Ctrl+Alt+T is not Ctrl+T (MiMo has no Ctrl+Alt+T) - and AltGr, which types
   * brackets on many layouts, arrives as Ctrl+Alt and is not a shortcut.
   */
  if (event.altKey) return

  const handlers: Record<string, () => void> = {
    k: toggleSearch,
    // MiMo's files tab, and the reference's attach on its key.
    p: openFilesTab,
    u: () => composer.value?.pick(),
    b: () => (leftPanel.value = !leftPanel.value),
    "`": () => (terminalOpen.value = !terminalOpen.value),
    m: () => composer.value?.openModelMenu(),
    ",": openSettings,
    ";": () => openSettings("mcp"),
    n: () => void newSession(),
    // MiMo's: Ctrl+T is a browser tab, and the bottom panel is Ctrl+J.
    t: () => void openBrowserTab(),
    j: () => (terminalOpen.value = !terminalOpen.value),
    r: () => reloadBrowser(),
    o: () => void browse(),
    // MiMo's: the window closes, hiding to the tray when that is on.
    w: () => window.mcode.window("close"),
    // The browser's address bar while it is open, else the box.
    l: focusBrowserAddress,
    // The model picker, on the key opencode uses for it. There is one picker
    // and it hangs off the pill, so both keys open the same menu.
    "'": () => composer.value?.openModelMenu(),
    // Annotate while a browser tab is showing, else agents forwards. Reverse is Ctrl+Shift+period.
    ".": annotateOrCycleAgent,
    // The reference walks the visit history on these as well as on Alt+arrow.
    "[": back,
    "]": forward,
  }
  const handler = handlers[event.key]
  if (!handler) return
  /*
   * Claimed before the availability test, not after: Ctrl+P belongs to the
   * browser's print dialog otherwise, so letting an unavailable chord fall
   * through would replace doing nothing with doing something surprising.
   */
  event.preventDefault()
  const id = KEY_COMMAND_IDS[event.key]
  if (id && commandDisabled(id)) return
  handler()
}

const menuCommands: Record<string, () => void> = {
  "new-session": () => void newSession(),
  back: () => void back(),
  forward: () => void forward(),
  "prev-session": () => void stepSession(-1),
  "next-session": () => void stepSession(1),
  "prev-project": () => void stepProject(-1),
  "next-project": () => void stepProject(1),
  "open-project": () => void browse(),
  settings: openSettings,
  terminal: () => (terminalOpen.value = !terminalOpen.value),
  sidebar: () => (leftPanel.value = !leftPanel.value),
  abort: () => void app.abort(),
  model: () => composer.value?.openModelMenu(),
  "delete-session": () => {
    if (app.currentID) deletingSession.value = app.currentID
  },
  // The Help menu, which both menus carry.
  shortcuts: () => {
    settingsSection.value = "keys"
    settingsOpen.value = true
  },
  "check-updates": () => void checkForUpdates(),
}

/**
 * The registry command each menu item stands for, where there is one.
 *
 * Half of what the menus offer is only sometimes possible: there is no turn to
 * stop on the home screen, no session to delete, and no file column to fold
 * outside a project. The command registry already knows when each of those can
 * run - it is what greys the same rows out in the palette - so the menus ask it
 * rather than keeping a second copy of the answer that can drift from the
 * first.
 *
 * A menu item with no entry here is always available - the Help menu's
 * shortcuts page opens wherever you are, so there is nothing to ask about.
 */
const MENU_COMMAND_IDS: Record<string, string> = {
  "new-session": "session.new",
  back: "app.back",
  forward: "app.forward",
  "prev-session": "session.previous",
  "next-session": "session.next",
  "prev-project": "project.previous",
  "next-project": "project.next",
  "open-project": "project.open",
  settings: "app.settings",
  palette: "app.search",
  terminal: "view.terminal",
  sidebar: "view.left",
  abort: "session.abort",
  model: "view.model",
  "delete-session": "session.delete",
  "check-updates": "app.update",
}

/**
 * Runs a menu item, if it can run at all.
 *
 * Both menus arrive here - the one the platform draws and the one the app draws
 * itself - because a menu item that does nothing has to be inert rather than
 * quietly harmful. Choosing Stop with no turn running used to send an abort for
 * a session that does not exist.
 *
 * Read from `bindableCommands` rather than `commands`, because `commands` has
 * already dropped everything disabled: looking there could not tell "this
 * command cannot run here" apart from "there is no such command".
 */
function runMenuCommand(key: string): void {
  if (menuItemDisabled(key)) return
  menuCommands[key]?.()
}

/**
 * Whether a menu item can do anything where the user currently is.
 *
 * An item with no command behind it - Quit, the edit roles, the two Help rows -
 * is never disabled: it does not go through the registry at all.
 */
function menuItemDisabled(key: string): boolean {
  const id = MENU_COMMAND_IDS[key]
  return id ? commandDisabled(id) : false
}

/** Whether a command says it cannot run where the user currently is. */
function commandDisabled(id: string): boolean {
  return bindableCommands.value.find((entry) => entry.id === id)?.enabled === false
}

/*
 * The chords that are also commands.
 *
 * The table in onKeydown answers keys directly, which is readable but knows
 * nothing about whether what it runs can run: Ctrl+P opened a file picker with
 * nothing in it on the launcher, and Ctrl+B toggled a panel that was not there.
 * Where a key has a command behind it, that command decides. Keys with no
 * command - attach, the MCP dialog - are unaffected and keep answering.
 */
const KEY_COMMAND_IDS: Record<string, string> = {
  k: "app.search",
  p: "app.openFile",
  b: "view.left",
  "`": "view.terminal",
  j: "view.bottom",
  m: "view.model",
  "[": "app.back",
  "]": "app.forward",
}

/**
 * Which of the drawn menu's rows are unavailable, so it can grey them out.
 *
 * The dispatcher already refuses them. Without this they still looked ordinary,
 * so choosing one read as the menu being broken rather than the item being
 * unavailable where the user was standing.
 */
const disabledMenuItems = computed(() => {
  const out = new Set<string>()
  for (const key of Object.keys(MENU_COMMAND_IDS)) {
    if (menuItemDisabled(key)) out.add(key)
  }
  return out
})

/**
 * Ctrl+wheel is the other way people expect to zoom. preventDefault stops
 * Chromium applying its own page zoom on top of ours.
 */
function onWheel(event: WheelEvent) {
  if (!event.ctrlKey && !event.metaKey) return
  // Turned off, the gesture goes back to being an ordinary scroll.
  if (app.config?.pinchZoom === false) return
  event.preventDefault()
  if (event.deltaY === 0) return
  window.mcode.zoom(event.deltaY < 0 ? "in" : "out")
}

/*
 * MiMo's task notifications.
 *
 * A turn that ends normally - not stopped, not failed - in any conversation says
 * the task finished, and a permission or a question arriving for any
 * conversation says it needs a confirmation. The main process titles them
 * "project · conversation" and drops them while the window is in front. They are
 * silent only when a chime plays instead: a finish past a minute with the chime
 * on, or any confirmation with the chime on. A long finish in the conversation
 * on screen is held while it stays there, and sent once it is left.
 *
 * Sound, banner and spoken line stay separate settings: someone watching the
 * window wants the tone and not the banner; someone away from it the reverse.
 */
const chimeOn = () => chimeOf(app.config?.taskDoneSound) !== "off"

function noticeAbout(sessionID: string) {
  const session = app.sessions.find((entry) => entry.id === sessionID)
  return {
    sessionID,
    title: session ? sessionTitle(session.title) : undefined,
    project: session && !session.scratch ? projectName(session.directory, app.config?.projectNames) : undefined,
  }
}

function watching(sessionID: string) {
  return app.currentID === sessionID && !isHome.value && !document.hidden
}

const heldNotices = new Set<string>()

function flushNotices() {
  for (const sessionID of [...heldNotices]) {
    if (watching(sessionID)) continue
    heldNotices.delete(sessionID)
    window.mcode.taskNotice({ kind: "done", ...noticeAbout(sessionID), silent: true })
  }
}

/* Coming back to the window cuts off whatever was being read out; leaving it sends what was held. */
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) hush()
  flushNotices()
})
watch([() => app.currentID, isHome], flushNotices)

/*
 * A turn that ended on its own. The store times each turn from when it was seen
 * to start and reports only those that finished normally, in any conversation:
 * a stopped or failed turn is dropped from its clock rather than reported. So a
 * quick reply stays quiet, and one past a minute chimes wherever it ended.
 */
watch(
  () => app.finished,
  (turn) => {
    if (!turn) return
    const choice = chimeOf(app.config?.taskDoneSound)
    const chiming = choice !== "off" && longTask(turn.elapsed)
    if (choice !== "off" && longTask(turn.elapsed)) chime(choice)
    const about = noticeAbout(turn.sessionID)
    recordLog("INFO", about.title ?? turn.sessionID)
    // A short phrase read aloud is for someone who has looked away.
    if (app.config?.voiceFeedback && document.hidden) speak(t("voice.said.agent"), language.value)
    if (app.config?.notifyAgent === false) return
    if (chiming && watching(turn.sessionID)) {
      heldNotices.add(turn.sessionID)
      return
    }
    window.mcode.taskNotice({ kind: "done", ...about, silent: chiming })
  },
)

/* Every undecided permission and question, across conversations. */
const awaitingConfirm = computed(() => [
  ...[...app.pendingPermissions.values()].flat().map((request) => ({ id: request.id, sessionID: request.sessionID })),
  ...[...confirmDock.pending.values()].map((request) => ({ id: request.id, sessionID: request.sessionID })),
])

/* The ones already announced, so a queue changing does not announce them again. */
const announcedConfirms = new Set<string>()

watch(awaitingConfirm, (entries) => {
  const live = new Set(entries.map((entry) => entry.id))
  for (const id of [...announcedConfirms]) if (!live.has(id)) announcedConfirms.delete(id)
  for (const entry of entries) {
    if (announcedConfirms.has(entry.id)) continue
    announcedConfirms.add(entry.id)
    if (app.config?.soundPermission) play("permission")
    if (app.config?.notifyPermission === false) continue
    window.mcode.taskNotice({ kind: "confirm", ...noticeAbout(entry.sessionID), silent: chimeOn() })
  }
})

/* MiMo's launcher badge: conversations with an unseen finish or waiting on a confirmation. */
watch(
  () => new Set([...app.unseen, ...awaitingConfirm.value.map((entry) => entry.sessionID)]).size,
  (count) => window.mcode.badge(count),
  { immediate: true },
)

/*
 * A turn that ended badly. Watched on the last message's own error rather than
 * on a counter, so a failure that arrives without the busy flag ever flipping -
 * a refused request, a provider that answered with a 4xx - still says so.
 */
watch(
  () => {
    const last = app.messages[app.messages.length - 1]
    return last && last.role === "assistant" ? last.error : undefined
  },
  (message) => {
    if (!message) return
    // Logged, with its cue and spoken line if they are on; MiMo sends no notification for a failure.
    recordLog("ERROR", message)
    if (app.config?.soundError) play("error")
    if (app.config?.voiceFeedback && document.hidden) speak(t("voice.said.error"), language.value)
  },
)

/**
 * The projects a digit can reach, ordered the way the home screen orders them:
 * whichever was worked on most recently is Ctrl+1.
 */
const openProjects = computed(() => {
  const closed = new Set(app.config?.closedProjects ?? [])
  const seen = new Map<string, number>()
  for (const session of app.sessions) {
    if (closed.has(session.directory)) continue
    seen.set(session.directory, Math.max(seen.get(session.directory) ?? 0, session.updated))
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([directory]) => directory)
})

/** Steps the session's agent, wrapping - there are only ever a handful. */
async function cycleAgent(by: 1 | -1) {
  const current = app.current?.agent ?? app.config?.agent ?? "build"
  const at = AGENT_NAMES.indexOf(current)
  const next = AGENT_NAMES[(at + by + AGENT_NAMES.length) % AGENT_NAMES.length]
  if (next) await app.setAgent(next)
}

/**
 * And the reasoning effort - for this session, and with a way back to unset.
 *
 * Walking off the end returns to no setting at all rather than wrapping to the
 * first step. Unset is not a sixth level: it is the session deferring to the
 * app-wide default, and there is no other way back to that once a session has
 * been given a setting of its own.
 */
async function cycleEffort() {
  if (!app.currentID) return
  /*
   * The steps this model has, not all five: the pill beside it now offers only
   * those, and a keyboard that could still reach a sixth would be the pointer
   * and the keyboard disagreeing about what the control is. A model with no
   * steps at all draws no pill and this does nothing, which is the reference's
   * `if (variants.length === 0) return void 0` (main-8t-QUXax.js @2829562).
   */
  const variants = findModel(app.providers, app.current?.model)?.variants ?? []
  if (!variants.length) return
  await app.setEffort(cycleVariant(variants, app.current?.effort))
}

/** MiMo's decrease and increase rows: one step along this model's efforts, stopping at either end. */
async function stepEffort(by: 1 | -1) {
  if (!app.currentID) return
  const variants = findModel(app.providers, app.current?.model)?.variants ?? []
  if (!variants.length) return
  const current = app.current?.effort
  const at = current ? variants.indexOf(current) : -1
  const next = at === -1 ? (by > 0 ? variants[0] : undefined) : variants[Math.max(0, Math.min(variants.length - 1, at + by))]
  if (next && next !== current) await app.setEffort(next)
}

let offMenu: (() => void) | undefined
let offZoom: (() => void) | undefined
let offQuitHint: (() => void) | undefined

/* The platform for the zoom notice's key, before the backend has said it. */
const platformName = () => app.platform || (/Mac/.test(navigator.userAgent) ? "darwin" : "win32")

// A session arriving from anywhere - palette, sidebar, rail - means we are no
// longer home, and it is a place worth being able to come back to.
watch(
  () => app.currentID,
  (id) => {
    if (!id || replaying) return
    view.value = "session"
    push({ view: "session", sessionID: id })
  },
)

onMounted(async () => {
  /*
   * The composer takes what is dropped on it and calls preventDefault itself;
   * this is for everywhere else, where the browser would otherwise navigate to
   * the file and take the app off the screen.
   */
  window.addEventListener("dragover", swallowDrop)
  window.addEventListener("drop", swallowDrop)
  window.addEventListener("dragover", trackDrag)
  window.addEventListener("dragleave", leaveDrag)
  window.addEventListener("drop", endDrag)
  window.addEventListener("dragend", endDrag)
  window.addEventListener("keydown", onKeydown)
  window.addEventListener("keyup", endRecentWalk)
  window.addEventListener("blur", forgetRecentWalk)
  schemeQuery.addEventListener("change", onSchemeChange)
  window.addEventListener("wheel", onWheel, { passive: false })
  offMenu = window.mcode.onMenu(runMenuCommand)
  // MiMo's zoom notice after every step, and once at load when the window is not at 100%.
  offZoom = window.mcode.onZoomChanged((percent) =>
    notify(zoomNotice(percent, platformName()), { id: ZOOM_TOAST, duration: 5000 }),
  )
  void window.mcode
    .zoomPercent()
    .then((percent) => {
      if (Math.round(percent) !== 100) notify(zoomNotice(percent, platformName()), { id: ZOOM_TOAST, duration: 8000 })
    })
    .catch(() => undefined)
  // macOS: a first Cmd+Q only arms the quit, and says so.
  offQuitHint = window.mcode.onQuitHint(() => notify(t("quit.hint"), { id: "quit-shortcut", duration: 2000 }))
  await boot()
})

async function retry() {
  app.error = undefined
  await boot()
}

async function boot() {
  try {
    await app.start()
  } catch (failure) {
    // Boot failures used to reject out of onMounted, which silently abandoned
    // the rest of the setup below.
    app.error = failure instanceof Error ? failure.message : String(failure)
    return
  }

  // A key already present in the environment means setup is effectively done;
  // marking it so keeps the gate a single flag, which is what lets the Settings
  // reset bring the page back even with a provider still connected.
  if (app.config && !app.config.onboarded && app.providers.some((entry) => entry.configured)) {
    await app.patchConfig({ onboarded: true })
  }
  if (app.currentID) view.value = "session"

  linksReady = true
  const link = queuedLink ?? (await window.mcode.takeLink().catch(() => undefined))
  queuedLink = undefined
  if (link) await openLink(link)
}

/*
 * Said once, here, rather than by each of the three places that can connect a
 * provider. Watching the list also catches a sign-in that finishes after its
 * dialog has closed, which is the normal case for the browser flow.
 */
/**
 * Whether the provider list has arrived yet.
 *
 * Its first arrival is the state the app launched in, not news: without this
 * every start announced whatever was already connected as if it had just
 * happened.
 */
let providersLoaded = false

watch(
  () => app.providers.filter((entry) => entry.configured).map((entry) => entry.id),
  (now, before) => {
    if (!before || !providersLoaded) {
      providersLoaded = true
      return
    }
    const known = new Set(before)
    for (const id of now) {
      if (known.has(id)) continue
      const entry = app.providers.find((item) => item.id === id)
      if (!entry) continue
      /*
       * The count, not a promise. A provider can connect with an empty model
       * list - a key that is fine while discovery is not - and telling someone
       * its models are ready when there are none sends them looking for a
       * picker entry that does not exist.
       */
      const count = entry.models.length
      notify(
        t("toast.connected", { name: entry.name }),
        count
          ? t("toast.connectedBody", { name: entry.name, n: count })
          : t("toast.connectedEmpty"),
      )
    }
  },
)

onBeforeUnmount(() => {
  window.removeEventListener("dragover", swallowDrop)
  window.removeEventListener("dragover", trackDrag)
  window.removeEventListener("dragleave", leaveDrag)
  window.removeEventListener("drop", endDrag)
  window.removeEventListener("dragend", endDrag)
  window.removeEventListener("drop", swallowDrop)
  window.removeEventListener("keydown", onKeydown)
  window.removeEventListener("keyup", endRecentWalk)
  window.removeEventListener("blur", forgetRecentWalk)
  schemeQuery.removeEventListener("change", onSchemeChange)
  window.removeEventListener("wheel", onWheel)
  offMenu?.()
  offZoom?.()
  offQuitHint?.()
})
</script>

<template>
  <div class="app">
    <!-- MiMo's one title-bar button on the right, on every screen: the side panel. -->
    <button
      v-if="!onboarding"
      class="side-panel-toggle"
      :class="{ on: rp.open }"
      :aria-pressed="rp.open"
      :aria-label="t('key.sidePanel')"
      v-tip="{ label: t('key.sidePanel'), hint: sidePanelHint }"
      @click="toggleSidePanel"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2.5" y="2.5" width="19" height="19" rx="4" />
        <path d="M15 2.5v19" />
      </svg>
    </button>
    <div
      class="body"
      :class="{
        blank: !isHome && !onboarding && empty && !app.error,
        /* The side panel expanded over the main column. */
        'panel-full': rp.open && rp.fullscreen,
      }"
    >
      <!-- MiMo's per-region boundaries: a region that fails to render shows its own strip. -->
      <ErrorBoundary :reset-key="view">
      <Sidebar
        v-if="!onboarding"
        :collapsed="!leftPanel"
        :page="view"
        :priority="priorityFilter"
        :can-back="canGoBack"
        :can-forward="canGoForward"
        @toggle-priority="priorityFilter = !priorityFilter"
        @archive-all="archiveAll"
        @newTask="goHome"
        @artifacts="goArtifacts"
        @menu="(id, x, y, nested) => (sessionMenu = { x, y, sessionID: id, nested })"
        @projectMenu="(directory, x, y) => (projectMenu = { x, y, directory })"
        :selecting="selecting"
        :selecting-projects="selectingProjects"
        :menu-directory="projectMenu?.directory"
        :menu-session="sessionMenu && !sessionMenu.header ? sessionMenu.sessionID : undefined"
        @select="toggleSelected"
        @batch="runBatch"
        @projectSelect="toggleProjectSelected"
        @projectBatch="runProjectBatch"
        @newBlank="namingProject = {}"
        @search="searchOpen = true"
        @back="back"
        @forward="forward"
        @toggle="leftPanel = !leftPanel"
        @browse="browse"
        @dropFolders="addDroppedProjects"
        @open="openFromSide"
        @rename="renameFromSide"
        @createIn="newSessionIn"
        @settings="openSettings"
      />
      </ErrorBoundary>

      <main ref="mainPane" class="main" :class="{ 'info-open': infoInline, 'info-shown': infoShowing, beside: panelBeside }">
        <ErrorBoundary :reset-key="`${view}:${app.currentID ?? ''}`">
        <!-- A turn can run for minutes; the bar is the only thing that says so
             without the user watching the transcript for movement. -->
        <div v-if="app.busy && !onboarding" class="progress"><span /></div>

        <!--
          Ahead of everything else: if the backend never opened there is no
          project, no session and no stream, so none of the usual places an
          error can appear exist yet.
        -->
        <div v-if="!app.connected && (app.error || app.offline)" class="boot">
          <p class="boot-msg">{{ app.error || t("boot.unreachable", { url: app.client?.server ?? "" }) }}</p>
          <button class="boot-retry" @click="retry">{{ t("common.retry") }}</button>
          <button v-if="app.config?.serverURL" class="boot-retry" @click="applyServer('')">
            {{ t("boot.useLocal") }}
          </button>
        </div>

        <Onboarding v-else-if="onboarding" @done="app.patchConfig({ onboarded: true })" />

        <ArtifactsView v-else-if="isArtifacts" @open="openFromArtifacts" />

        <PluginsView v-else-if="isPlugins" @manage="openSettings('mcp')" />

        <HomeHero
          v-else-if="isHome"
          :directory="homeDirectory"
          @directory="(directory?: string) => (homeShellDirectory = directory)"
          @open-settings="openSettings"
          @connect="connectOpen = true"
          @shell="runShellCommand"
          @terminal="terminalOpen = true"
        />

        <template v-else-if="!onboarding">
          <!--
            The header is not part of the empty state.
            
            It used to be: the hero replaced the whole thing, so a session with
            nothing in it had no title, no context ring and no options menu -
            the three controls opencode shows from the moment a session opens.
            The hero now fills the room above the dock instead of standing in
            for the header, which is what it was always describing itself as.

            An error with nothing sent yet still has to be seen: the hero owns
            the empty state, but the banner lives in the stream, so a failure
            before the first message used to vanish silently.
          -->
          <SessionHeader
            :info-open="infoShowing"
            :bottom-open="terminalUp"
            :side-collapsed="!leftPanel"
            :panel-beside="panelBeside"
            :has-content="!empty"
            :menu-open="Boolean(sessionMenu?.header)"
            @info="toggleInfo"
            @rename="beginRename()"
            @menu="(x, y) => (sessionMenu = { x, y, header: true })"
            @bottom="terminalOpen = !terminalOpen"
          />

          <SessionHero v-if="empty && !app.error" />
          <MessageStream v-else ref="stream" />
          <SessionSpine v-if="!(empty && !app.error)" :scroller="stream?.scroller" />
          <InfoPanel
            :visible="infoShowing"
            :floating="infoFloating"
            :bottom-inset="terminalUp ? drawerHeight : 0"
            :escape-blocked="modalOpen || searchOpen || connectOpen || Boolean(sessionMenu) || Boolean(projectMenu) || Boolean(app.permission)"
            @close="closeInfo"
          />

          <!--
            The dock, which is the same region in every state a session can be
            in. It used to be handed to the hero as a slot, and the hero stripped
            the padding and the fill off it, so the box someone types into was
            one shape on an empty session and another the moment they sent - and
            the composer was torn down and rebuilt on that first message.
          -->
          <!-- MiMo's confirm dock: the first undecided permission or question, in arrival order. -->
          <QuestionDock />
          <!--
            While the session is empty the box belongs inside the hero, between
            the wordmark and the project row, which is where opencode puts it.

            Teleported rather than rendered in two places. `v-if`/`v-else`
            would be two vnodes and so two component instances: the box would
            be destroyed and rebuilt on the first message, losing a draft mid
            sentence and any attachment gathered with it. Teleport moves the
            same instance's DOM and leaves the instance alone.
          -->
          <!--
            The target is switched, not disabled. Vue resolves a Teleport's
            target once, at mount, and a later `disabled` flip only moves the
            content to that cached node. A session opened with messages in it
            mounted this with no hero on screen, so the cached target was null,
            and the first new session then moved the composer into nothing -
            the hero came up with no input box under it. Changing `to` is the
            one thing that makes Vue resolve again, and SessionHero is drawn
            above this in the same parent, so `#hero-dock` exists by the time
            the Teleport is patched. `#main-dock` is a `display: contents`
            placeholder at the composer's ordinary position, so the layout of
            `main` is what it was when the box rendered here in place.
          -->
          <!--
            MiMo's "N files changed" pill, hung over the composer's top edge.
            Zero tall, so it takes no room from the conversation; not drawn
            while the confirm dock is up, which it would sit on top of.
          -->
          <div v-if="!empty && !confirmDock.queue.length" class="live-edit-anchor">
            <LiveEditPill :expanded="liveEditShowing" />
          </div>
          <div id="main-dock" class="main-dock" />
          <Teleport :to="floatingComposer ? '#float-dock' : empty && !app.error ? '#hero-dock' : '#main-dock'">
            <Composer
              ref="composer"
              :resizable="!floatingComposer"
              @open-settings="openSettings"
              @connect="connectOpen = true"
              @shell="runShellCommand"
              @terminal="openTerminalTab"
            />
          </Teleport>
        </template>

        <!--
          MiMo's home screen keeps the bottom panel's button at the end of the
          main column's title row (a conversation has its own in the header):
          4px before the side panel toggle, or at the column's end once a panel
          stands beside it. After the home strip in the document, so its no-drag
          wins over that strip's drag. Unlit when pressed, as MiMo's is.
        -->
        <button
          v-if="isHome && !onboarding"
          class="home-bottom"
          :aria-pressed="terminalUp"
          :disabled="!homeShellDirectory"
          :aria-label="t('key.bottomPanel')"
          v-tip="{ label: t('key.bottomPanel'), hint: 'Ctrl+J' }"
          @click="terminalOpen = !terminalOpen"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2.5" y="2.5" width="19" height="19" rx="4" />
            <path d="M2.5 15h19" />
          </svg>
        </button>

        <!--
          The terminal, docked along the foot of the conversation the way MiMo
          has it: the full width of this column, under the composer, with its
          own edge to drag. Not in the right-hand column, which is the review's.
        -->
        <!-- The drawer styles bp-enter/leave itself; out-in so a new home folder closes one drawer before opening the next. -->
        <Transition name="bp" mode="out-in">
          <TerminalDrawer
            v-if="terminalUp"
            :key="isHome ? `home:${homeShellDirectory}` : 'session'"
            ref="drawer"
            :sessionID="isHome ? undefined : app.currentID"
            :directory="isHome ? homeShellDirectory : undefined"
            @close="terminalOpen = false"
            @height="(px: number) => (drawerHeight = px)"
          />
        </Transition>

        <!-- MiMo's drop overlay over the main column; the drop itself is the composer's. -->
        <div v-if="fileDrag && !onboarding" class="drop-overlay" data-drop-overlay aria-hidden="true">
          <div class="drop-card">{{ t("composer.dropOverlay") }}</div>
        </div>
        </ErrorBoundary>
      </main>

      <!-- Floats over the pane, so opening it neither reflows nor shortens it. -->
      <FindBar :find="find" :anchor="() => mainPane" />

      <!-- MiMo's annotation box, for a selection in a reply or the files tab's code, or a whole file. -->
      <!-- The video preview is the one modal the box works over: its boxed regions are annotated with it. -->
      <AnnotationComposer v-if="!onboarding" :scope="annotationScope" :disabled="modalOpen && !videoPreview" />
      <AnnotationMarkers v-if="!onboarding" :mainScope="annotationScope" :disabled="modalOpen" />

      <!-- MiMo's right panel: tabs beside the conversation, or its launcher while it holds none. -->
      <ErrorBoundary :reset-key="app.currentID ?? ''">
      <RightPanel
        v-if="!onboarding"
        ref="rightPanel"
        :sessionID="isHome ? undefined : app.currentID"
        :directory="panelDirectory"
        :browserAllowed="browserAllowed"
        :sidebarWidth="leftPanel ? SIDE_COLUMN_WIDTH : 0"
        :sideCollapsed="!leftPanel"
        :hints="panelHints"
        :modalOpen="modalOpen"
        :searchOpen="searchOpen"
        @open-settings="openSettings"
        @connect="connectOpen = true"
        @shell="runShellCommand"
        @terminal="openTerminalTab"
      />
      </ErrorBoundary>
    </div>

    <ReleaseNotesDialog
      v-if="highlights.length"
      :highlights="highlights"
      @close="dismissReleaseNotes(false)"
      @disable="dismissReleaseNotes(true)"
    />


    <CommandPalette
      v-if="paletteOpen"
      :mode="paletteMode"
      :projects="workspaceChoices.length ? workspaceChoices : openProjects"
      @close="paletteOpen = false; workspaceChoices = []"
      @file="composer?.mention($event)"
      @project="pickedProject"
    />

    <SearchOverlay
      v-if="searchOpen"
      ref="searchOverlay"
      @close="searchOpen = false"
      @open="openFromSearch"
      @project="startIn"
    />

    <ServerPopover
      v-if="serverPanel"
      @close="serverPanel = false"
      @manage="
        () => {
          serverPanel = false
          managingServers = true
        }
      "
    />

    <RenameDialog
      v-if="namingWorkspace"
      :value="''"
      :heading="t('workspace.namePrompt')"
      :confirm="t('workspace.new')"
      @close="namingWorkspace = undefined"
      @submit="(name) => createWorkspace(namingWorkspace!, name)"
    />

    <ServersDialog
      v-if="managingServers"
      @close="managingServers = false"
      @connect="applyServer"
    />

    <RenameDialog
      v-if="choosingServer"
      :value="app.config?.serverURL ?? ''"
      :heading="t('server.prompt')"
      placeholder="ws://host:port"
      @close="choosingServer = false"
      @submit="applyServer"
    />

    <SettingsDialog
      v-if="settingsOpen"
      :section="settingsSection"
      :commands="bindableCommands"
      :update-checking="updateChecking"
      :update-ready="downloadedUpdate"
      @close="settingsOpen = false"
      @check-updates="checkForUpdates"
    />

    <ProjectDialog
      v-if="editingProject"
      :directory="editingProject"
      @close="editingProject = undefined"
    />

    <RenameDialog
      v-if="renamingSession"
      :value="renamingSession.title"
      :heading="t('rename.convoTitle')"
      :subtitle="t('rename.subtitle')"
      @close="renamingSession = undefined"
      @submit="submitSessionRename"
    />

    <RenameDialog
      v-if="renamingProject"
      :value="projectName(renamingProject, app.config?.projectNames)"
      :heading="t('rename.projectTitle')"
      :subtitle="t('rename.subtitle')"
      @close="renamingProject = undefined"
      @submit="submitProjectRename"
    />

  </div>
  <ConnectDialog v-if="connectOpen" @close="connectOpen = false" />
  <ImagePreview />
  <VideoPreview />

  <ConfirmDialog
    v-if="deletingWorkspace"
    :title="t('workspace.delete')"
    :body="deletingWorkspace.dirty ? t('workspace.deleteDirty') : t('workspace.deleteBody')"
    :confirm-label="t('common.delete')"
    @confirm="confirmDeleteWorkspace"
    @close="deletingWorkspace = undefined"
  />

  <!-- MiMo's wording for several at once: the count in the title and in the question. -->
  <ConfirmDialog
    v-if="deletingMany?.length"
    :title="t('batch.deleteN', { count: deletingMany.length })"
    :body="t('batch.deleteManyBody', { count: deletingMany.length })"
    :confirm-label="t('common.delete')"
    @confirm="confirmDeleteMany"
    @close="deletingMany = undefined"
  />

  <!-- And for one, the conversation's own title in the question. -->
  <ConfirmDialog
    v-if="deletingSession"
    :title="t('confirm.deleteChatTitle')"
    :body="t('confirm.deleteChatBody', { title: deletingTitle })"
    :confirm-label="t('common.delete')"
    @confirm="confirmDeleteSession"
    @close="deletingSession = undefined"
  />

  <!-- Removing a project, or the ticked set, only takes it off the list. -->
  <ConfirmDialog
    v-if="removingProjects"
    :title="
      removingProjects.batch
        ? t('batch.projectsRemoveTitle', { count: removingProjects.directories.length })
        : t('side.removeProjectTitle')
    "
    :body="
      removingProjects.batch
        ? t('batch.projectsRemoveBody', { count: removingProjects.directories.length })
        : t('side.removeProjectBody', { name: projectName(removingProjects.directories[0] ?? '', app.config?.projectNames) })
    "
    :confirm-label="t('side.removeProjectOk')"
    @confirm="confirmRemoveProjects"
    @close="removingProjects = undefined"
  />

  <NewProjectDialog
    v-if="namingProject"
    :value="t('home.blankDefault')"
    @close="namingProject = undefined"
    @submit="createNamedProject"
  />

  <AppMenu
    v-if="appMenu"
    :disabled="disabledMenuItems"
    :x="appMenu.x"
    :y="appMenu.y"
    @run="runAppMenu"
    @close="appMenu = undefined"
  />

  <!-- MiMo's side column menus: the conversation row's at 164, the project's at 150. -->
  <ContextMenu
    v-if="sessionMenu"
    :x="sessionMenu.x"
    :y="sessionMenu.y"
    :items="sessionMenuItems"
    :side="!sessionMenu.header"
    :min-width="sessionMenu.header ? undefined : 164"
    @pick="runSessionMenu"
    @close="sessionMenu = undefined"
  />

  <ContextMenu
    v-if="projectMenu"
    :x="projectMenu.x"
    :y="projectMenu.y"
    :items="projectMenuItems"
    side
    :min-width="150"
    @pick="runProjectMenu"
    @close="projectMenu = undefined"
  />

  <Toasts />

  <!-- Last in the document on purpose: see .rail-no-drag. -->
  <div v-if="!leftPanel && !onboarding" class="rail-no-drag" aria-hidden="true" />
  <div v-if="!onboarding" class="toggles-no-drag" aria-hidden="true" />
</template>

<style scoped>
/* Shown in place of the whole workspace, so it centres on its own. */
.boot {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  height: 100%;
  padding: 40px;
  text-align: center;
}

.boot-msg {
  max-width: 460px;
  color: var(--text-weak);
  font-size: calc(13.5px * var(--ui-font-scale, 1));
  line-height: 1.65;
}

.boot-retry {
  padding: 7px 16px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: calc(13px * var(--ui-font-scale, 1));
}

.boot-retry:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.progress {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  z-index: 5;
  height: 2px;
  overflow: hidden;
  background: transparent;
}

.progress span {
  display: block;
  width: 40%;
  height: 100%;
  background: var(--interactive);
  border-radius: 1px;
  animation: sweep 1.5s ease-in-out infinite;
}

@keyframes sweep {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}

/* The window itself is the darker frame the workspace is set into. */
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface-base);
}

/*
 * The workspace is a single raised panel, inset from all three free edges and
 * from the title bar above it. Everything the session is made of - the side
 * panels included - lives on this one plane, which is what leaves the window
 * reading as a frame around the work rather than as more of the same colour.
 */
/*
 * Two cards with a gutter between them, not one card with a divider in it.
 *
 * Measured on the reference with its review panel open: its conversation is a
 * card at `8,44 600x861` and its panel another at `616,44 829x861` - both on a
 * 10px radius over rgb(22,22,22), both inset 8 from the window, and 8 apart.
 * This was a single card that the panel divided with a 1px line, so the two
 * regions read as halves of one sheet rather than as two surfaces.
 *
 * The row itself now paints nothing; the fill and the corners belong to the
 * regions inside it, which is what lets the gutter show through.
 */
.body {
  position: relative;
  display: flex;
  flex: 1;
  gap: 8px;
  min-height: 0;
  margin: 8px;
}

/* Each region is its own card. */
.body > .main,
.body > .panel-host {
  overflow: hidden;
  background: var(--surface-raised);
  border-radius: 10px;
}

/*
 * Only the panel is raised, and its shadow is elevation/raised - measured layer
 * for layer on the reference, whose conversation card computes `box-shadow:
 * none` while its review panel carries the full four. The asymmetry is the part
 * that could not have been guessed: the panel sits above the conversation
 * rather than the two lying in the same plane.
 */
.body > .panel-host {
  box-shadow: var(--shadow-md);
}

/* The docked terminal keeps the height it was dragged to; the transcript gives way. */
.main > .drawer {
  flex: none;
}

/*
 * A session with nothing in it is set down rather than lifted. The plane itself
 * is the same one a transcript sits on - the reference changes only the
 * elevation, and painting the panel the frame's own colour instead left the
 * composer's fill showing as a band across the foot of an empty session.
 */
.body.blank {
  box-shadow: none;
}

.main {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  /*
   * Falls back to the full width on a window too narrow to give it 440, which
   * is the case where something has to overflow and the conversation is not
   * the thing that should.
   */
  min-width: min(440px, 100%);
}

/* The composer's ordinary dock; `contents` keeps it out of the layout. */
.main-dock {
  display: contents;
}

/*
 * The folded column's controls row - toggle, back, forward, search - floats
 * over the start of the main column, and the main column's own top strip (the
 * home screen's, or the conversation header) is a window drag region. Electron
 * works drag regions out in document order, so that strip, coming later, took
 * the buttons back into the title bar and Windows swallowed every click on
 * them. This patch is the last thing in the document, so its no-drag wins; it
 * takes no pointer events, so the clicks still land on the buttons beneath.
 */
.rail-no-drag {
  position: fixed;
  top: 13px;
  inset-inline-start: 65px;
  z-index: 1;
  width: 120px;
  height: 24px;
  pointer-events: none;
  -webkit-app-region: no-drag;
}

/*
 * The same trap on the right: the side panel toggle sits fixed at the end of
 * the title bar, and the home strip, the conversation header or the side
 * panel's own head, later in the document, dragged over it. Covers the toggle,
 * 9px from the caption buttons.
 */
.toggles-no-drag {
  position: fixed;
  top: 13px;
  inset-inline-end: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 9px);
  z-index: 1;
  width: 24px;
  height: 24px;
  pointer-events: none;
  -webkit-app-region: no-drag;
}

/*
 * Laid over the composer's own box: its 4px top inset is added back so the
 * pill hangs 8px clear of the box, and the info card's width is kept off the
 * end the way the composer keeps it, so the two centre on the same column.
 */
.live-edit-anchor {
  position: relative;
  top: 4px;
  flex: none;
  height: 0;
}

.main.info-open .live-edit-anchor {
  margin-inline-end: v-bind(infoInset);
}

/*
 * MiMo's: the column tinted 8% of the accent inside a 2px dashed line at 55%,
 * and a card in the middle - 12 round, 10 by 18 of padding, 14px medium text
 * in the accent - that lets the drop through to what is underneath.
 */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 250;
  display: grid;
  place-items: center;
  /* MiMo's accent is orange in both schemes. */
  background: color-mix(in srgb, #ff6a2b 8%, transparent);
  border: 2px dashed color-mix(in srgb, #ff6a2b 55%, transparent);
  border-radius: inherit;
  pointer-events: none;
}

.drop-card {
  padding: 10px 18px;
  color: #ff6a2b;
  background: var(--surface-base);
  border-radius: 12px;
  box-shadow: var(--shadow-md);
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

/*
 * 2.0 shell. Xiaomi MiMo's window has no title strip and no inset panel: the
 * side column runs the full height on the deepest surface and the main plane
 * sits flush beside it, one hairline between them.
 */
.body {
  gap: 0;
  margin: 0;
  border-radius: 0;
  box-shadow: none;
}

/* The same selector the inset panel was drawn with, so this one wins. */
.body > .main {
  margin: 0;
  background: var(--surface-raised);
  border: 0;
  border-inline-start: 1px solid var(--border-weaker);
  border-radius: 0;
  box-shadow: none;
}

/*
 * With the info card beside it the conversation makes room the way MiMo's
 * does: only as much as keeps the 768 reading column clear of the 310 card,
 * held at the inline end of the transcript and of the dock, so the column and
 * the composer centre in what is left - and the jump-to-bottom button, centred
 * inside the transcript, moves with them. Floating, the card takes nothing.
 */
.main.info-open :deep(.stream) {
  padding-inline-end: v-bind(infoInset);
}

.main.info-open :deep(.composer),
.main.info-open :deep(.confirm-wrap) {
  padding-inline-end: calc(24px + v-bind(infoInset));
}

/* MiMo moves the find bar clear of the card whenever the card is up: 20 plus its 310. */
.main.info-shown ~ [data-find-bar] {
  margin-inline-end: 310px;
}

/* Left of the caption buttons where Windows draws them, level with the header's own row: MiMo's 24px in a 32px row 9 down. */
.side-panel-toggle {
  position: fixed;
  top: 13px;
  inset-inline-end: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 9px);
  z-index: 30;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  /* MiMo's title-bar icon colour: near the strongest text on dark, 60% of it on light. */
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  border-radius: 7px;
  -webkit-app-region: no-drag;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .side-panel-toggle,
  :root:not([data-theme="light"]) .home-bottom {
    color: var(--text-strong);
  }
}

:root[data-theme="dark"] .side-panel-toggle,
:root[data-theme="dark"] .home-bottom {
  color: var(--text-strong);
}

.side-panel-toggle:hover,
.home-bottom:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

.side-panel-toggle.on {
  color: var(--text-strong);
  background: var(--surface-selected);
}

/*
 * The home screen's bottom panel button, in the main column's title row: MiMo's
 * 4px before the side panel toggle, or 12 from the column's end with a panel beside it.
 */
.home-bottom {
  position: absolute;
  top: 13px;
  inset-inline-end: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 37px);
  z-index: 30;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: color-mix(in srgb, var(--text-strong) 60%, transparent);
  border-radius: 7px;
  -webkit-app-region: no-drag;
}

.main.beside .home-bottom {
  inset-inline-end: 12px;
}

/* "No project" leaves the terminal nowhere to open. */
.home-bottom:disabled {
  background: transparent;
  cursor: default;
  opacity: 0.35;
}

/*
 * MiMo's expanded side panel: the main column folds to nothing and the panel
 * takes its room.
 */
.body.panel-full > .main {
  flex: 0 0 0;
  width: 0;
  min-width: 0;
  overflow: hidden;
  border-inline-start-width: 0;
}
</style>
