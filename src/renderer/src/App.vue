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
import Composer from "./components/Composer.vue"
import TodoDock from "./components/TodoDock.vue"
import InfoPanel from "./components/InfoPanel.vue"
import ArtifactsView from "./components/ArtifactsView.vue"
import PluginsView from "./components/PluginsView.vue"
import RevertDock from "./components/RevertDock.vue"
import FilePanel from "./components/FilePanel.vue"
import CommandPalette, { type PaletteMode } from "./components/CommandPalette.vue"
import PermissionDialog from "./components/PermissionDialog.vue"
import SettingsDialog from "./components/SettingsDialog.vue"
import ProjectDialog from "./components/ProjectDialog.vue"
import ServerPopover from "./components/ServerPopover.vue"
import ServersDialog from "./components/ServersDialog.vue"
import ReleaseNotesDialog from "./components/ReleaseNotesDialog.vue"
import RenameDialog from "./components/RenameDialog.vue"
import TerminalDrawer from "./components/TerminalDrawer.vue"
import Toasts from "./components/Toasts.vue"
import ConfirmDialog from "./components/ConfirmDialog.vue"
import ConnectDialog from "./components/ConnectDialog.vue"
import EditMenu from "./components/EditMenu.vue"
import ManageModelsDialog from "./components/ManageModelsDialog.vue"
import McpDialog from "./components/McpDialog.vue"
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
import { closeTab, openTab, readStrip, stripKey, writeStrip } from "./lib/session-tabs"
import { notify, notifyFailure } from "./lib/toast"
import { projectName } from "./lib/project"
import { renderMarkdown } from "./lib/markdown"
import { chordOf } from "./lib/keys"
import FindBar from "./components/FindBar.vue"
import { createFind, openFind, stepFind } from "./lib/find"
import { play } from "./lib/sound"
import { themeTokens } from "./lib/theme-engine"
import { DEFAULT_THEME, THEMES, themeByID } from "./lib/theme-palettes"

const app = useApp()

/** "home" is the launcher; "session" is a project workspace. */
const view = ref<"home" | "session" | "artifacts" | "plugins">("home")
/** The 2.0 side column; up unless it has been put away. */
const leftPanel = ref(true)
/*
 * Shut to begin with, as opencode's is: a session opens on the conversation
 * alone and the review is asked for. This used to start open, so every new
 * window gave half its width to a panel that, on a project with no changes,
 * said only that there were none.
 */
/* The project a task typed on the home screen will be created in. */
const homeDirectory = ref<string>()

const rightPanel = ref(false)

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

function toggleInfo() {
  infoOpen.value = !infoOpen.value
  try {
    localStorage.setItem(INFO_KEY, infoOpen.value ? "1" : "0")
  } catch {
    // Remembered for this run only.
  }
}

/* Only beside a conversation: the home screen and an empty session have nothing to list. */
const infoShowing = computed(() => infoOpen.value && !isHome.value && !empty.value)

/*
 * The file column inside the review panel. Its own thing, because opencode
 * gives it its own shortcut: Ctrl+Shift+R shows or hides the panel, Ctrl+\\
 * folds the column away inside it.
 */
/*
 * Collapsed. This is the tree inside the review panel, and opencode's own
 * `showFileTree` default is false - a diff opens using the panel's whole
 * width, and the list is unfolded when someone wants to navigate by file.
 */
const fileTreeOpen = ref(false)

/*
 * How wide the review panel is, once someone has dragged the edge. Held here
 * rather than in the panel so it survives the panel being closed and reopened.
 */
const reviewWidth = ref<number>()

/*
 * The right-hand panel's tab strip: which tabs it offers, and which is up.
 *
 * Two bits rather than one. `contextTab` is whether Context is in the strip at
 * all - opencode puts it there only once something has asked for it and takes
 * it out again when it is closed - and `panelTab` is which of the two is being
 * read. Held apart because opencode leaves the Context tab in the strip while
 * the review is being read, so going back to the figures is one click on a tab
 * that is still there rather than a fresh trip through the ring.
 *
 * Both live here rather than in the panel because the ring in the session
 * header is what usually opens the Context tab, and the header is a sibling of
 * the panel: neither of the two can see the other, and only this can see both.
 *
 * Neither is a plain ref any more. They read and write one entry of a
 * per-session map (lib/session-tabs.ts), which is how the reference holds the
 * same state - so a Context tab opened in one conversation is still open when
 * that conversation is returned to, and is not there in the next one. What used
 * to do that job, a watch emptying both on every session change, is gone: the
 * map already answers per session, and the watch would now be erasing the very
 * thing that is being remembered.
 */
/** The one tab this app has beside the permanent review. */
const CONTEXT_TAB = "context"

const tabsKey = computed(() => stripKey(app.current?.directory, app.current?.id))
const strip = computed(() => readStrip(tabsKey.value))

const contextTab = computed({
  get: () => strip.value.all.includes(CONTEXT_TAB),
  set: (open: boolean) =>
    writeStrip(tabsKey.value, open ? openTab(strip.value, CONTEXT_TAB) : closeTab(strip.value, CONTEXT_TAB)),
})

const panelTab = computed<"review" | "context">({
  get: () => (strip.value.active === CONTEXT_TAB ? "context" : "review"),
  set: (tab) => writeStrip(tabsKey.value, { all: strip.value.all, active: tab }),
})

/*
 * Turned off entirely, the panel is not something a shortcut should be able to
 * bring back - the setting is the answer, not a suggestion.
 */
const showFileTree = computed(() => app.config?.showFileTree !== false)
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

async function fetchUpdate(url: string, version: string, sha256: string) {
  try {
    await window.mcode.downloadUpdate(url, version, sha256)
    downloadedUpdate.value = version
  } catch (err) {
    notifyFailure(t("update.failed"), reasonOf(err))
  }
}

async function installUpdate() {
  try {
    await window.mcode.installUpdate()
  } catch (err) {
    // The app is still here, so it can still say why.
    notifyFailure(t("update.failed"), reasonOf(err))
    downloadedUpdate.value = undefined
  }
}

const terminalOpen = ref(false)

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
 * wants to search. FilePanel and ReviewPatch can each mount a second host in
 * two lines when someone owns those files - the module keeps a set of hosts and
 * hands Ctrl+F to whichever one the focus is in.
 */
const mainPane = ref<HTMLElement>()
const find = createFind({ wrapper: () => mainPane.value })
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
})
onBeforeUnmount(() => find.unmount())
const mcpOpen = ref(false)
const paletteOpen = ref(false)
const settingsOpen = ref(false)
/** Non-default landing page for the settings dialog, when opened from a shortcut. */
const settingsSection = ref<"general" | "keys" | "server" | "providers" | "models">()

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
const header = ref<InstanceType<typeof SessionHeader>>()
/** The project a new workspace is being branched from, while it is being named. */
const namingWorkspace = ref<string>()
const choosingServer = ref(false)
/** Whether the saved-servers dialog is up. */
const managingServers = ref(false)

function openSettings() {
  settingsSection.value = undefined
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
const paletteMode = ref<PaletteMode>("all")

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
  if (saved) notify(t("log.saved"), saved, revealAction(saved))
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
  const feed = app.config?.updateFeed?.trim()
  if (!feed) {
    notifyFailure(t("update.noFeed"))
    return
  }
  try {
    /*
     * Asked of the main process rather than fetched here. This window is served
     * under a content policy that lets it open a socket to the local backend and
     * reach nothing else, so its own fetch of the feed never left the process -
     * the check reported "Failed to fetch" whatever the feed said.
     */
    const { version, url, sha256 } = await window.mcode.checkUpdates(feed)
    if (!version) throw new Error("the feed named no version")
    if (version === app.version) {
      notify(t("update.current"))
      return
    }
    notify(t("update.available", { version }))
    /*
     * A feed that names a version but no installer is as far as this goes -
     * saying a newer one exists is still worth saying, and it is what this
     * command did for every feed until now.
     */
    if (!url) return
    void fetchUpdate(url, version, sha256)
  } catch (err) {
    /*
     * Electron wraps anything thrown in a handler as "Error invoking remote
     * method 'mcode:check-updates': ...", which tells the reader about our IPC
     * rather than about their feed. Only the reason is worth showing.
     */
    notifyFailure(t("update.failed"), reasonOf(err))
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
    if (!custom || !command.hint || custom === command.hint) continue
    if (claimed.has(command.hint)) continue
    out.add(command.hint)
  }
  return out
})

const drawer = ref<InstanceType<typeof TerminalDrawer>>()
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
async function runBatch(action: "archive" | "move" | "delete" | "cancel") {
  const chosen = selecting.value ?? []
  if (action === "cancel") {
    selecting.value = undefined
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

function openPalette(mode: PaletteMode = "all") {
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
 * A chosen typeface goes in front of the built-in stack rather than replacing
 * it: a name that turns out not to be installed then falls through to what was
 * there before instead of dropping the app to Times New Roman. The name is
 * quoted so a face with a space in it - "JetBrains Mono" - survives.
 */
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
    put("--font-terminal", terminal, "var(--font-mono-stack)")
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

/** Whether the review side of the right-hand panel is on offer at all. */
const canReview = computed(() => rightPanel.value && showFileTree.value)

/*
 * The panel is up when either of its tabs has been asked for.
 *
 * One expression, used both for mounting the panel and for the class that
 * drops the workspace panel out of a narrow row. Those were written out twice
 * and did not say quite the same thing, so the row could be told the panel was
 * there while nothing was mounted.
 */
const reviewPanelUp = computed(
  () => !isHome.value && !onboarding.value && (canReview.value || contextTab.value),
)

/*
 * The terminal shares the right column with the panel, so it is subject to the
 * same two conditions: the launcher has no column, and neither does onboarding.
 */
const terminalUp = computed(() => terminalOpen.value && !isHome.value && !onboarding.value)

/*
 * Which tab is actually up, as against the one last picked.
 *
 * Opencode resolves this the same way and in the same order: honour the active
 * tab while it is still in the strip, otherwise fall back to the review, and
 * only then to whatever is left. It matters because the review side can be
 * taken away underneath the reader - by the title bar's toggle, or by the file
 * tree setting - while `panelTab` still says "review".
 */
const shownTab = computed<"review" | "context">(() => {
  if (panelTab.value === "context" && contextTab.value) return "context"
  if (canReview.value) return "review"
  return "context"
})

/*
 * What the ring in the session header reports as pressed.
 *
 * The figures being up, not merely asked for: with the review showing over the
 * top of an open Context tab the ring is not what the reader is looking at, and
 * saying otherwise made the next press appear to do nothing.
 */
const contextShowing = computed(() => reviewPanelUp.value && shownTab.value === "context")

/*
 * The ring, and the palette entry behind it.
 *
 * Pressing it while the figures are up puts the tab away; the panel goes with
 * it only when nothing else was holding the panel open, which is what opencode
 * does - it remembers whether the ring is what opened the panel and closes it
 * again only in that case. Here `canReview` is that memory: if the panel was
 * already up for the review, dropping the tab leaves the review showing.
 */
function toggleContext() {
  if (contextShowing.value) {
    contextTab.value = false
    panelTab.value = "review"
    return
  }
  contextTab.value = true
  panelTab.value = "context"
}

/*
 * The title bar's button and Ctrl+Shift+R, which put the whole panel away.
 *
 * The Context tab goes with it. Opencode mounts its tab strip inside the review
 * panel, so closing the panel takes every tab with it - and without this the
 * button read as broken: with the figures up it would drop the review side and
 * leave the panel sitting there, having apparently done nothing.
 *
 * `rightPanel` alone is not the question any more, because the panel can be up
 * on the Context tab with `rightPanel` false. What is being toggled is whether
 * the panel is on screen at all.
 */
function toggleReviewPanel() {
  if (reviewPanelUp.value) {
    rightPanel.value = false
    contextTab.value = false
    panelTab.value = "review"
    return
  }
  rightPanel.value = true
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

async function browse() {
  // Several at once, the way the reference opens projects. The last one chosen
  // is the one landed on, so a batch still ends somewhere definite.
  const directories = await window.mcode.pickDirectory(t("cmd.openProject"), true)
  for (const directory of directories) await openProject(directory)
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
 * Another shell, opening the drawer first if it is not already up.
 *
 * The drawer owns the tabs, and it only exists while open, so the first call
 * has to wait a tick for it to mount before there is anything to ask.
 */
async function newTerminal() {
  const wasOpen = terminalOpen.value
  terminalOpen.value = true
  if (!wasOpen) await nextTick()
  // A freshly mounted drawer already starts one shell; a second call here
  // would leave two open for a single keystroke.
  if (wasOpen) drawer.value?.add()
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
  await app.patchConfig({ permissions: next })
  if (on) notify(t("toast.autoOffTitle"), t("toast.autoOffBody"))
  else notify(t("toast.autoOnTitle"), t("toast.autoOnBody"))
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
const sessionMenu = ref<{ x: number; y: number; sessionID?: string }>()

/* Which conversation the open menu is about: the row's, else the open one. */
const menuSession = computed(() =>
  app.sessions.find((entry) => entry.id === (sessionMenu.value?.sessionID ?? app.currentID)),
)

/* Set while the project picker is being used to move a conversation. */
const movingSession = ref<string>()

/*
 * Selection mode in the side column: the conversations ticked, or absent when
 * the column is being read rather than managed. The set is held here because
 * what it is for - archiving, moving, deleting - is held here too.
 */
const selecting = ref<string[]>()
const deletingMany = ref<string[]>()

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
const SESSION_MENU: { id: string; label: string; icon: string; divided?: boolean; danger?: boolean }[] = [
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
  {
    id: "row.copyDirectory",
    label: "menu.copyDirectory",
    icon: "M5.6 5.6h7.2v7.2H5.6zM3.2 10.4V3.2h7.2",
    divided: true,
  },
  { id: "session.export", label: "menu.export", icon: "M8 2.6v7.2M5.2 7.2 8 10l2.8-2.8M2.8 12.2h10.4" },
  {
    id: "session.delete",
    label: "menu.delete",
    icon: "M3 4.4h10M6.4 4.4V2.8h3.2v1.6M4.4 4.4l.7 8.4h5.8l.7-8.4M6.8 6.8v3.8M9.2 6.8v3.8",
    divided: true,
    danger: true,
  },
]

/*
 * The rows that are this menu's own rather than commands: they name a
 * conversation, where a command acts on whichever one is open. A command
 * cannot take an argument here - the palette and the keyboard reach the same
 * table - so these live beside it and the menu dispatches both.
 */
const ROW_ACTIONS: Record<string, (sessionID: string) => void | Promise<void>> = {
  "row.pin": (sessionID) => app.togglePinned(sessionID),
  "row.unread": (sessionID) => app.markUnread(sessionID),
  "row.continue": async (sessionID) => {
    if (app.currentID !== sessionID) await app.open(sessionID)
    const last = app.messages[app.messages.length - 1]
    if (last) await app.forkFrom(last.id)
  },
  "row.batch": (sessionID) => {
    selecting.value = [sessionID]
  },
  "row.move": (sessionID) => {
    movingSession.value = sessionID
    openPalette("projects")
  },
  "row.copyDirectory": (sessionID) => {
    const target = app.sessions.find((entry) => entry.id === sessionID)
    if (!target) return
    window.mcode.setClipboardText(target.directory)
    notify(t("menu.copiedDirectory"), target.directory)
  },
}

/*
 * Built from the UNFILTERED list, because `commands` drops anything disabled
 * and this menu is meant to keep its shape: MenuItem's own rule is that a
 * disabled row is greyed rather than hidden. With the filtered list, a fresh
 * session's menu lost Export entirely and came up two rows shorter than the
 * same menu a moment later.
 */
const sessionMenuItems = computed(() =>
  SESSION_MENU.map((entry) => {
    const target = menuSession.value
    if (ROW_ACTIONS[entry.id]) {
      const pinned = target ? app.isPinned(target.id) : false
      const label = entry.id === "row.pin" ? t(pinned ? "menu.unpin" : "menu.pin") : t(entry.label)
      return {
        key: entry.id,
        label,
        enabled: Boolean(target),
        divided: Boolean(entry.divided),
        icon: entry.icon,
        danger: Boolean(entry.danger),
      }
    }
    const command = bindableCommands.value.find((item) => item.id === entry.id)
    if (!command) return undefined
    const short = t(entry.label)
    return {
      key: entry.id,
      // A key with no string of its own falls back to the command's sentence
      // rather than showing the key, which is what `t` returns when it misses.
      label: short === entry.label ? command.title : short,
      enabled: command.enabled && Boolean(target),
      divided: Boolean(entry.divided),
      icon: entry.icon,
      danger: Boolean(entry.danger),
    }
  }).filter(
    (item): item is { key: string; label: string; enabled: boolean; divided: boolean; icon: string; danger: boolean } =>
      Boolean(item),
  ),
)

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
  if (key === "minimize" || key === "maximize" || key === "close" || key === "quit") {
    window.mcode.window(key === "quit" ? "close" : key)
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
  sessionMenu.value = undefined
  if (!target) return
  const own = ROW_ACTIONS[key]
  if (own) {
    await own(target)
    return
  }
  if (app.currentID !== target) {
    view.value = "session"
    await app.open(target)
  }
  await commands.value.find((entry) => entry.id === key)?.run()
}

async function confirmDeleteSession() {
  const target = deletingSession.value
  deletingSession.value = undefined
  if (target) await app.remove(target)
}
const manageModelsOpen = ref(false)

/**
 * The conversation as a Markdown file.
 *
 * Tool traffic is left out: the point of an export is what was asked and what
 * was answered, and the six shell invocations in between are noise on paper.
 */
function transcriptMarkdown(): string {
  const session = app.current
  const when = (at: number) => new Date(at).toLocaleString()
  const lines = [`# ${session ? sessionTitle(session.title) : t("session.new")}`, ""]
  if (session) {
    lines.push(`- ${session.directory}`, `- ${when(session.created)}`, "")
  }

  for (const message of app.messages) {
    if (message.role === "user") {
      lines.push(`## ${t("export.asked")}`, "", message.text, "")
      continue
    }
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n\n")
      .trim()
    if (!text) continue
    lines.push(`### ${t("export.answered")}`, "", text, "")
  }
  return lines.join("\n")
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

async function exportSessionData() {
  if (!app.current) return
  const data = { info: app.current, messages: app.messages }
  try {
    const saved = await window.mcode.saveText(exportFilename(), JSON.stringify(data, null, 2))
    if (saved) notify(t("toast.exported"), saved, revealAction(saved))
  } catch (failure) {
    reportSaveFailure(t("toast.exportFailed"), failure)
  }
}

async function exportSession() {
  if (!app.messages.length) return
  const name = (app.current ? sessionTitle(app.current.title) : "session")
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 60)
  try {
    const saved = await window.mcode.saveText(`${name}.md`, transcriptMarkdown())
    if (saved) notify(t("toast.exported"), saved, revealAction(saved))
  } catch (failure) {
    reportSaveFailure(t("toast.exportFailed"), failure)
  }
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
      notify(t("share.saved"), saved, {
        label: t("share.view"),
        run: () => void window.mcode.openSaved(saved),
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
    notify(t("toast.undone", { n: files }), t("toast.undoneBody"))
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
    notify(t("toast.compacted"), t("toast.compactedBody"))
  } catch (failure) {
    notifyFailure(t("toast.compactFailed"), reasonOf(failure))
  }
}

/**
 * Turns the review's notes into a message and hands it to the composer.
 *
 * Not sent outright: the notes are the reviewer's shorthand, and being able to
 * add a sentence before pressing enter is the difference between a list of
 * complaints and an instruction.
 */
function sendNotes(notes: { file: string; line: number; text: string }[]) {
  if (!notes.length) return
  const byFile = new Map<string, typeof notes>()
  for (const note of notes) byFile.set(note.file, [...(byFile.get(note.file) ?? []), note])

  const lines: string[] = []
  for (const [file, list] of byFile) {
    lines.push(`${file}`)
    for (const note of [...list].sort((a, b) => a.line - b.line)) {
      lines.push(`  L${note.line}: ${note.text}`)
    }
  }
  composer.value?.insert(lines.join("\n"))
  app.clearNotes()
  /* The notes are in the composer now, so the panel gets out of the way of
     reading them - the whole panel, since a Context tab left open in the strip
     would have held it on screen doing exactly what this is trying to undo. */
  rightPanel.value = false
  contextTab.value = false
  panelTab.value = "review"
}

/* The artifacts page is a place, so it is worth being able to come back to. */
function goArtifacts() {
  view.value = "artifacts"
  push({ view: "artifacts" })
}

/* So is the plugins page, which MiMo opens in the workspace rather than over it. */
function goPlugins() {
  view.value = "plugins"
  push({ view: "plugins" })
}

/** A file's session, opened from the artifacts page. */
async function openFromArtifacts(sessionID: string) {
  view.value = "session"
  await app.open(sessionID)
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
const bindableCommands = computed(() => {
  const hasSession = Boolean(app.currentID)
  const inWorkspace = !isHome.value

  const all = [
    // Session
    { id: "session.new", group: "key.groupGeneral", title: t("cmd.newSession"), hint: "Ctrl+T", run: newSession },
    {
      id: "view.model",
      group: "key.groupModels",
      title: t("cmd.switchModel"),
      hint: "Ctrl+'",
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
      enabled: hasSession,
      run: () => header.value?.begin(),
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
      /*
       * The Context view, without reaching for the ring.
       *
       * The ring is the way in that opencode gives, and it is only drawn once a
       * turn has reported what it spent - so on a session that has not answered
       * yet, and for anyone working without a pointer, this is the only door.
       */
      id: "session.context",
      group: "key.groupSession",
      title: t("context.usage.view"),
      enabled: hasSession && app.messages.length > 0,
      run: toggleContext,
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
      hint: "Ctrl+Shift+Backspace",
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
      enabled: hasSession,
      run: () => (leftPanel.value = !leftPanel.value),
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
      title: reviewPanelUp.value ? t("cmd.hideFiles") : t("cmd.showFiles"),
      hint: "Ctrl+Shift+R",
      enabled: inWorkspace,
      run: toggleReviewPanel,
    },
    {
      id: "view.terminal",
      group: "key.groupTerminal",
      title: terminalOpen.value ? t("cmd.hideTerminal") : t("cmd.showTerminal"),
      hint: "Ctrl+`",
      enabled: inWorkspace,
      run: () => (terminalOpen.value = !terminalOpen.value),
    },
    {
      id: "terminal.new",
      group: "key.groupTerminal",
      title: t("key.newTerminal"),
      hint: "Ctrl+Alt+T",
      enabled: inWorkspace,
      run: () => void newTerminal(),
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
    {
      id: "app.openFile",
      group: "key.groupNavigation",
      title: t("cmd.openFile"),
      hint: "Ctrl+P",
      /*
       * There is nothing to list without a project open. The palette's file
       * mode reads the current session's directory, so on the launcher this
       * offered a picker that came up empty and a choice that did nothing.
       */
      enabled: inWorkspace,
      run: () => openPalette("files"),
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
      hint: "Ctrl+Shift+L",
      enabled: hasSession,
      run: () => addSelection(),
    },
    {
      id: "app.searchSessions",
      group: "key.groupGeneral",
      title: t("cmd.searchSessions"),
      hint: "Ctrl+F",
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
      run: () => (mcpOpen.value = true),
    },
    {
      id: "session.previous",
      group: "key.groupSession",
      title: t("key.prevSession"),
      hint: "Alt+↑",
      run: () => void stepSession(-1),
    },
    {
      id: "session.next",
      group: "key.groupSession",
      title: t("key.nextSession"),
      hint: "Alt+↓",
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
      id: "model.variant.cycle",
      group: "key.groupModels",
      title: t("key.cycleEffort"),
      hint: "Ctrl+Shift+D",
      run: () => void cycleEffort(),
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
      id: "fileTree.toggle",
      group: "key.groupNavigation",
      title: t("key.toggleTree"),
      hint: "Ctrl+\\",
      enabled: inWorkspace,
      run: () => (fileTreeOpen.value = !fileTreeOpen.value),
    },
    {
      id: "theme.cycle",
      group: "key.groupGeneral",
      title: t("cmd.cycleTheme"),
      hint: "Ctrl+Shift+T",
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
      hint: "Ctrl+L",
      enabled: hasSession,
      run: () => composer.value?.focus(),
    },
    {
      id: "tab.close",
      group: "key.groupGeneral",
      title: t("key.closeTab"),
      hint: "Ctrl+W",
      enabled: hasSession,
      run: () => {
        if (app.currentID) app.closeTab(app.currentID)
      },
    },
    { id: "app.back", group: "key.groupGeneral", title: t("key.back"), hint: "Ctrl+[", run: () => void back() },
    { id: "app.forward", group: "key.groupGeneral", title: t("key.forward"), hint: "Ctrl+]", run: () => void forward() },
    {
      // Hidden the way the reference hides it: opening the palette from inside
      // the palette is not an offer worth making, but the chord is still worth
      // being able to change.
      id: "command.palette",
      group: "key.groupGeneral",
      title: t("key.palette"),
      hint: "Ctrl+K",
      hidden: true,
      run: () => openPalette("all"),
    },
    {
      id: "terminal.close",
      group: "key.groupTerminal",
      title: t("key.closeTerminal"),
      hint: "Ctrl+W",
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
      hint: `Ctrl+${at + 1}`,
      hidden: true,
      run: () => startIn(directory),
    })),
    {
      id: "session.fork",
      group: "key.groupSession",
      title: t("cmd.fork"),
      enabled: hasSession && app.messages.some((message) => message.role === "user"),
      run: () => openPalette("messages"),
    },
    {
      id: "provider.connect",
      group: "key.groupGeneral",
      title: t("connect.title"),
      run: () => (connectOpen.value = true),
    },
    { id: "app.settings", group: "key.groupGeneral", title: t("cmd.settings"), hint: "Ctrl+,", run: openSettings },
  ]

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
    settingsOpen.value ||
    mcpOpen.value ||
    choosingServer.value ||
    managingServers.value ||
    Boolean(namingWorkspace.value) ||
    Boolean(editingProject.value),
)

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
  notify(t("toast.languageTitle"), t("toast.languageBody", { name: entry?.label ?? id }))
}

async function cycleLanguage() {
  const current = language.value
  const index = LANGUAGES.findIndex((entry) => entry.id === current)
  await setLanguage(LANGUAGES[(index + 1) % LANGUAGES.length].id)
}

/** Steps to the next palette, naming it - there are thirty-seven to walk. */
async function setTheme(id: string, name: string) {
  await app.patchConfig({ themeID: id })
  notify(t("toast.themeTitle"), name)
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
   * A new terminal, from wherever. This used to live inside the drawer, which
   * is mounted only while the drawer is open, so the key did nothing in the one
   * state where someone is most likely to press it.
   */
  if (mod && event.altKey && event.key.toLowerCase() === "t") {
    if (modalOpen.value || isHome.value) return
    event.preventDefault()
    void newTerminal()
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
   * Backspace is not a letter, so it cannot ride in the table below - and it
   * is destructive enough that it should not be reachable by a near miss.
   */
  if (event.shiftKey && event.key === "Backspace") {
    if (modalOpen.value || !app.currentID) return
    event.preventDefault()
    void app.archive(app.currentID, true)
    return
  }

  /*
   * Find first, and only if a host will have it.
   *
   * `openFind` answers false when the chord was typed into a text field or when
   * no host wants it, and that is deliberately not the same as doing nothing:
   * Ctrl+F then falls through to the session palette below, which is where this
   * app has always had it. Ctrl+G steps, Ctrl+Shift+G steps back, and neither
   * does anything at all unless a bar is open.
   */
  if (!event.shiftKey && event.key === "f" && openFind(event)) {
    event.preventDefault()
    return
  }
  if (event.key === "g" && stepFind(event.shiftKey ? -1 : 1, event)) {
    event.preventDefault()
    return
  }

  if (event.shiftKey) {
    const shifted: Record<string, () => void> = {
      // The panel itself. Folding the column inside it is Ctrl+backslash.
      r: toggleReviewPanel,
      // Step the reasoning effort, which otherwise only lives in settings.
      d: () => void cycleEffort(),
      // Approve everything, or stop. Symmetric, and it always says so.
      a: () => void toggleAutoAccept(),
      // Searching the projects rather than the sessions inside one.
      o: () => openPalette("projects"),
      // A second checkout of the project, on its own branch.
      w: () => void newWorkspace(),
      // The two composer modes, on the reference's keys.
      x: () => composer.value?.setMode("shell"),
      e: () => composer.value?.setMode("normal"),
      // Whatever is selected on screen, handed to the composer.
      l: () => addSelection(),
      // Agents, backwards; forwards is Ctrl+period.
      ".": () => void cycleAgent(-1),
      // The reference lists this key twice, for reopening a tab and for
      // stepping the theme. Reopening wins while there is a tab to bring back,
      // which is what the key means everywhere else; with none, it steps.
      t: async () => {
        if (!(await app.reopenTab())) await cycleTheme()
      },
      // The scheme, then the palette. Stepping rather than opening a dialog is
      // what makes them worth a key: the answer is on screen immediately.
      s: () => void cycleScheme(),
    }
    const shiftedHandler = shifted[event.key.toLowerCase()]
    if (!shiftedHandler) return
    event.preventDefault()
    shiftedHandler()
    return
  }

  /*
   * Ctrl and a digit opens the project in that position, the way a browser
   * switches to the nth tab.
   */
  if (/^[1-9]$/.test(event.key)) {
    const directory = openProjects.value[Number(event.key) - 1]
    if (!directory) return
    event.preventDefault()
    startIn(directory)
    return
  }

  const handlers: Record<string, () => void> = {
    k: () => (paletteOpen.value ? (paletteOpen.value = false) : openPalette("all")),
    // The reference's file picker, session search and attach, on its keys.
    p: () => openPalette("files"),
    f: () => openPalette("sessions"),
    u: () => composer.value?.pick(),
    b: () => (leftPanel.value = !leftPanel.value),
    "`": () => (terminalOpen.value = !terminalOpen.value),
    m: () => composer.value?.openModelMenu(),
    ",": openSettings,
    ";": () => (mcpOpen.value = true),
    n: () => void newSession(),
    // The reference binds a new session to Ctrl+T, the way a browser binds a
    // new tab; Ctrl+N is kept because it is what this app has always used.
    t: () => void newSession(),
    o: () => void browse(),
    w: () => {
      if (app.currentID) app.closeTab(app.currentID)
    },
    /*
     * Ctrl+backslash folds the file column, not the panel. Hiding the panel is
     * Ctrl+Shift+R, below - the same split opencode makes, and the reason it
     * needs two keys is that the two are genuinely different questions.
     */
    "\\": () => (fileTreeOpen.value = !fileTreeOpen.value),
    // Focus the composer without reaching for the pointer.
    l: () => composer.value?.focus(),
    // The model picker, on the key opencode uses for it. There is one picker
    // and it hangs off the pill, so both keys open the same menu.
    "'": () => composer.value?.openModelMenu(),
    // Agents, forwards. Reverse is Ctrl+Shift+period.
    ".": () => void cycleAgent(1),
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
  files: () => (fileTreeOpen.value = !fileTreeOpen.value),
  "open-project": () => void browse(),
  settings: openSettings,
  palette: () => (paletteOpen.value = true),
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
  files: "fileTree.toggle",
  "open-project": "project.open",
  settings: "app.settings",
  palette: "command.palette",
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
  k: "command.palette",
  p: "app.openFile",
  b: "view.left",
  "`": "view.terminal",
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
 * Three occasions worth interrupting someone for, each its own setting.
 *
 * The main process drops the notification when the window is focused, so
 * nothing here has to reason about whether the user is already looking.
 */
function alertDesktop(kind: "agent" | "permission" | "error", body: string, sessionID?: string) {
  recordLog(kind === "error" ? "ERROR" : "INFO", body)
  const config = app.config
  /*
   * Sound and banner are decided separately: the reason to want one is not the
   * reason to want the other. Someone watching the window wants the tone and
   * not the banner; someone away from it wants the reverse.
   */
  if (kind === "agent" && config?.soundAgent) play("done")
  if (kind === "permission" && config?.soundPermission) play("permission")
  if (kind === "error" && config?.soundError) play("error")

  if (kind === "agent" && config?.notifyAgent === false) return
  if (kind === "permission" && config?.notifyPermission === false) return
  if (kind === "error" && config?.notifyError === false) return
  window.mcode.notify(t(`notify.${kind}`), body, sessionID)
}

// A turn that was running and now is not has finished, one way or another.
watch(
  () => app.busy,
  (running, was) => {
    if (running || !was) return
    alertDesktop("agent", app.current?.title ?? "", app.currentID)
  },
)

watch(
  () => app.permission,
  (request) => {
    if (request) alertDesktop("permission", request.title, request.sessionID ?? app.currentID)
  },
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
    if (message) alertDesktop("error", message, app.currentID)
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

let offMenu: (() => void) | undefined

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
  window.addEventListener("keydown", onKeydown)
  schemeQuery.addEventListener("change", onSchemeChange)
  window.addEventListener("wheel", onWheel, { passive: false })
  offMenu = window.mcode.onMenu(runMenuCommand)
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
  window.removeEventListener("drop", swallowDrop)
  window.removeEventListener("keydown", onKeydown)
  schemeQuery.removeEventListener("change", onSchemeChange)
  window.removeEventListener("wheel", onWheel)
  offMenu?.()
})
</script>

<template>
  <div class="app">

    <div
      class="body"
      :class="{
        blank: !isHome && !onboarding && empty && !app.error,
        /* Counts the panel whichever of its two tabs it is showing: it is the
           same column taking the same width either way. */
        'with-review': reviewPanelUp,
      }"
    >
      <Sidebar
        v-if="leftPanel && !onboarding"
        :page="view"
        @newTask="goHome"
        @artifacts="goArtifacts"
        @menu="(id, x, y) => (sessionMenu = { x, y, sessionID: id })"
        :selecting="selecting"
        @select="toggleSelected"
        @batch="runBatch"
        @plugins="goPlugins"
        @search="paletteOpen = true"
        @back="back"
        @forward="forward"
        @toggle="leftPanel = false"
        @browse="browse"
        @open="app.open($event)"
        @createIn="newSessionIn"
        @settings="openSettings"
      />

      <main ref="mainPane" class="main" :class="{ 'info-open': infoShowing }">
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

        <PluginsView v-else-if="isPlugins" @manage="mcpOpen = true" />

        <HomeHero
          v-else-if="isHome"
          :directory="homeDirectory"
          :commands="commands"
          @open-settings="openSettings"
          @connect="connectOpen = true"
          @manage-models="manageModelsOpen = true"
          @shell="runShellCommand"
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
            ref="header"
            :context-open="contextShowing"
            :info-open="infoShowing"
            @info="toggleInfo"
            @rename="(title) => app.currentID && void app.rename(app.currentID, title)"
            @menu="(x, y) => (sessionMenu = { x, y })"
            @context="toggleContext"
          />

          <SessionHero v-if="empty && !app.error" />
          <MessageStream v-else ref="stream" />
          <InfoPanel v-if="infoShowing" />

          <!--
            The dock, which is the same region in every state a session can be
            in. It used to be handed to the hero as a slot, and the hero stripped
            the padding and the fill off it, so the box someone types into was
            one shape on an empty session and another the moment they sent - and
            the composer was torn down and rebuilt on that first message.
          -->
          <PermissionDialog
            v-if="app.permission"
            :request="app.permission"
            :covered="modalOpen || paletteOpen"
          />
          <!--
            The plan, above the box it is being carried out from. Drawn only
            when a turn has recorded one, so an ordinary conversation is not
            given a strip of empty chrome.
          -->
          <TodoDock v-if="!infoShowing" />
          <!--
            What a rollback took out, and the way back. Drawn only while a
            rollback stands, because otherwise there is nothing on screen at all
            to say that the end of the conversation was set aside rather than
            lost - and no way to ask for it back.
          -->
          <RevertDock />
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
          <div id="main-dock" class="main-dock" />
          <Teleport :to="empty && !app.error ? '#hero-dock' : '#main-dock'">
            <Composer
              ref="composer"
              :commands="commands"
              @open-settings="openSettings"
              @connect="connectOpen = true"
              @manage-models="manageModelsOpen = true"
              @shell="runShellCommand"
            />
          </Teleport>
        </template>
      </main>

      <!-- Floats over the pane, so opening it neither reflows nor shortens it. -->
      <FindBar :find="find" :anchor="() => mainPane" />

      <!--
        One panel with two tabs, the way opencode has it, rather than two panels
        taking turns in the same column. The two used to swap places here, which
        meant opening the figures made the review vanish, closing them made it
        reappear, and nothing on screen said the two were the same panel or
        which of them was being read.
      -->
      <!--
        The right column: the panel and the terminal, stacked.

        Measured on the reference with both up - review at `616,44 831x575` and
        the terminal directly beneath it at `616,627 831x280`, the same left
        edge and the same width, 8 apart. They are not alternatives to each
        other; closing the review lets the terminal take the whole column
        (`616,44 831x863`), which is why the column exists rather than the two
        taking turns in the row.

        The column owns the width, so dragging the panel's edge and dragging it
        with only a terminal open move the same thing.
      -->
      <div v-if="reviewPanelUp || terminalUp" class="column" :style="reviewWidth ? { width: `${reviewWidth}px` } : undefined">
      <FilePanel
        v-if="reviewPanelUp"
        v-model:tree-open="fileTreeOpen"
        v-model:width="reviewWidth"
        v-model:context-tab="contextTab"
        :can-review="canReview"
        :panel-tab="shownTab"
        @update:panel-tab="panelTab = $event"
        @notes="sendNotes"
        @export="exportSessionData"
      />
      <TerminalDrawer v-if="terminalUp" ref="drawer" @close="terminalOpen = false" />
      </div>
    </div>

    <ReleaseNotesDialog
      v-if="highlights.length"
      :highlights="highlights"
      @close="dismissReleaseNotes(false)"
      @disable="dismissReleaseNotes(true)"
    />

    <McpDialog v-if="mcpOpen" @close="mcpOpen = false" />

    <CommandPalette
      v-if="paletteOpen"
      :commands="commands"
      :mode="paletteMode"
      :projects="workspaceChoices.length ? workspaceChoices : openProjects"
      @close="paletteOpen = false; workspaceChoices = []"
      @file="composer?.mention($event)"
      @project="pickedProject"
      @message="app.forkFrom($event)"
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
      @close="settingsOpen = false"
      @check-updates="checkForUpdates"
    />

    <ProjectDialog
      v-if="editingProject"
      :directory="editingProject"
      @close="editingProject = undefined"
    />

  </div>
  <ConnectDialog v-if="connectOpen" @close="connectOpen = false" />

  <!--
    Fetched and ready. The reference offers exactly this, in these words, once
    the download it started on its own has finished.
  -->
  <ConfirmDialog
    v-if="downloadedUpdate"
    :title="t('update.readyTitle')"
    :body="t('update.readyBody', { version: downloadedUpdate })"
    :confirm-label="t('update.installRestart')"
    @confirm="installUpdate"
    @close="downloadedUpdate = undefined"
  />

  <ConfirmDialog
    v-if="deletingWorkspace"
    :title="t('workspace.delete')"
    :body="deletingWorkspace.dirty ? t('workspace.deleteDirty') : t('workspace.deleteBody')"
    :confirm-label="t('common.delete')"
    @confirm="confirmDeleteWorkspace"
    @close="deletingWorkspace = undefined"
  />

  <!--
    Several conversations at once, so the button says "Delete" rather than
    "Delete this session" - the question above it is about a count.
  -->
  <ConfirmDialog
    v-if="deletingMany?.length"
    :title="t('confirm.deleteSessions')"
    :body="t('confirm.deleteSessionsBody', { n: String(deletingMany.length) })"
    :confirm-label="t('common.delete')"
    @confirm="confirmDeleteMany"
    @close="deletingMany = undefined"
  />

  <ConfirmDialog
    v-if="deletingSession"
    :title="t('confirm.deleteSession')"
    :body="t('confirm.deleteSessionBody')"
    :confirm-label="t('cmd.delete')"
    @confirm="confirmDeleteSession"
    @close="deletingSession = undefined"
  />

  <AppMenu
    v-if="appMenu"
    :disabled="disabledMenuItems"
    :x="appMenu.x"
    :y="appMenu.y"
    @run="runAppMenu"
    @close="appMenu = undefined"
  />

  <ContextMenu
    v-if="sessionMenu"
    :x="sessionMenu.x"
    :y="sessionMenu.y"
    :items="sessionMenuItems"
    @pick="runSessionMenu"
    @close="sessionMenu = undefined"
  />

  <!-- Listens at the document, so every text field gets the same menu. -->
  <EditMenu />

  <ManageModelsDialog
    v-if="manageModelsOpen"
    @close="manageModelsOpen = false"
    @connect="manageModelsOpen = false; connectOpen = true"
  />

  <Toasts />

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
  font-size: 13.5px;
  line-height: 1.65;
}

.boot-retry {
  padding: 7px 16px;
  color: var(--text-strong);
  background: var(--surface-raised);
  border: 1px solid var(--border-weak);
  border-radius: var(--radius-md);
  font-size: 13px;
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

/*
 * The right column. It carries the width; what is in it fills that width and
 * shares the height, 8 apart - the gutter the reference leaves between its
 * review and its terminal, and the same one this row leaves beside them.
 */
.column {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  /*
   * Until it is dragged. Measured off opencode at two window sizes: 800px at
   * 1279 and 839 at 1343, which is 62.5% of the window both times - of the
   * window, note, not of the inset row this sits in, which is why the unit is
   * vw. This lived on the panel before the terminal joined it in the column.
   */
  width: 62.5vw;
  /*
   * A floor, because the panel's own contents have one.
   *
   * This was 0, on the reasoning that a third minimum in the row could exceed
   * the window. It could - but squeezing below this does not shrink what is
   * inside: the file list is a fixed 240 and the diff needs room beside it, so
   * the column went on drawing its full width inside a narrower box and `.body`
   * clipped the overhang. Measured at 900x700 with the workspace panel also up,
   * 16 controls ended up outside the window with no way to scroll to them.
   *
   * 360 is the file list's 240 plus somewhere for the diff to start. opencode
   * gives the same list a 200 minimum and 480 maximum. The row not fitting is
   * handled where the row is, in App.vue, by dropping the workspace panel.
   *
   * The floor yields once even it will not fit, because a floor that cannot be
   * honoured is not a floor - min-width beats max-width in CSS, so an
   * unconditional 360 here does not hold the panel open, it pushes the column's
   * trailing edge off the window. Measured at the 721px minimum window: the
   * panel ended 87px past the right edge with the open-in-app button out
   * there with it, unreachable and unscrollable. opencode never meets this
   * because its review panel is `width: auto` with `flex-1` and has no floor
   * at all. Below this point the file list inside gives way instead.
   */
  min-width: min(360px, calc(100% - 450px));
  /* The conversation still needs somewhere to be. */
  max-width: calc(100% - 450px);
}

/* Each region is its own card. */
.body > .main,
.column > .panel,
.column > .drawer,
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
.column > .panel,
.column > .drawer,
.body > .panel-host {
  box-shadow: var(--shadow-md);
}

/*
 * The panel takes what the terminal leaves. With no terminal it is the whole
 * column; with one it is the column less the terminal's own height, which is
 * the reader's to drag and so is left fixed here.
 */
.column > .panel {
  flex: 1;
  width: auto;
  min-height: 0;
}

.column > .drawer {
  flex: none;
}

/*
 * With the review closed the terminal has the column to itself, which is what
 * the reference does: its terminal goes from `831x280` under the review to
 * `831x863` without it. `flex-basis` beats the dragged height here, so the
 * height the reader chose is kept for when the review comes back.
 */
.column > .drawer:only-child {
  flex: 1;
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

/*
 * Three columns need more room than a small window has.
 *
 * The workspace panel, the conversation and the review panel each have a width
 * below which they stop working - 280, 440 and 360 - and 1080 plus the body's
 * own margins is more than a 1000px window. Something has to give, and it is
 * the workspace panel: the review panel is the work being looked at, the
 * conversation is where the work is done, and the project list is navigation
 * that the title bar and the home screen both still offer.
 *
 * Only when the review panel is actually up. On its own the workspace panel is
 * fine at any width the window can be.
 */
@media (max-width: 1095px) {
  .body.with-review .panel.docked {
    display: none;
  }
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
 * With the info card up the conversation makes room for it the way MiMo's
 * does: 262 held clear at the inline end of the transcript and of the dock,
 * so the reading column and the composer centre in what is left and line up
 * with each other rather than with the window.
 */
.main.info-open :deep(.stream) {
  padding-inline-end: 262px;
}

.main.info-open :deep(.composer) {
  padding-inline-end: calc(24px + 262px);
}
</style>
