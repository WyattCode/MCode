<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { AGENT_NAMES } from "@shared/protocol"
import { useApp } from "./stores/app"
import { pickDirectory, pickProjectFolder, saveText } from "./lib/native-pick"
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
// Pages, dialogs and previews that are not drawn at start: each its own chunk (see the note at TerminalDrawer).
const ArtifactsView = defineAsyncComponent(() => import("./components/ArtifactsView.vue"))
const PluginsView = defineAsyncComponent(() => import("./components/PluginsView.vue"))
import RightPanel from "./components/RightPanel.vue"
import QuestionDock from "./components/QuestionDock.vue"
import { useQuestions } from "./stores/questions"
import type SettingsDialogComponent from "./components/SettingsDialog.vue"
const SettingsDialog = defineAsyncComponent(() => import("./components/SettingsDialog.vue"))
import ProjectDialog from "./components/ProjectDialog.vue"
const ImagePreview = defineAsyncComponent(() => import("./components/ImagePreview.vue"))
import LiveEditPill from "./components/LiveEditPill.vue"
import { acceptsDrop, outsideWindow } from "./lib/attach"
import { fileRequest, reviewRequest } from "./lib/review-request"
import { foldedMatches } from "./lib/find-folded"
import { deliveryShown, setDeliveryView } from "./lib/delivered"
import { closeImagePreview, closeVideoPreview, imagePreview, videoPreview } from "./lib/image-preview"
const VideoPreview = defineAsyncComponent(() => import("./components/VideoPreview.vue"))
import RenameDialog from "./components/RenameDialog.vue"
import { markUpdateFailed, markUpdateReady, updateState } from "./components/UpdatePill.vue"
import { interruptedReason } from "@shared/update-reason"
import type TerminalDrawerComponent from "./components/TerminalDrawer.vue"
import Toasts from "./components/Toasts.vue"
import ConfirmDialog from "./components/ConfirmDialog.vue"
import NewProjectDialog from "./components/NewProjectDialog.vue"
import type { MenuItem } from "./lib/menu"
const ConnectDialog = defineAsyncComponent(() => import("./components/ConnectDialog.vue"))
import { connectableProviders, groupProviders, type Group } from "./lib/connect"
import SearchOverlay from "./components/SearchOverlay.vue"
import ErrorBoundary from "./components/ErrorBoundary.vue"
import {
  LANGUAGES,
  RTL_LANGUAGES,
  type Language,
  publishMenuLabels,
  language,
  sessionTitle,
  t,
  detectLanguage,
  languageReady,
  loadLanguage,
  rememberLanguage,
  refreshDateFormatters,
} from "./lib/i18n"
import { toggleSteps } from "./lib/steps"
import { draftFromMessage, provideRestoreDraft } from "./lib/draft"
import { cycleVariant, findModel } from "./lib/model"
import { PANEL_MIN_WIDTH, useRightPanel } from "./stores/right-panel"
import { arbitratePanel, boundChord, clampSideWidth, panelWidthShown, sideFits, toolHints } from "./lib/right-tools"
import { exportConversationById, exportConversationMarkdown, transcriptOf } from "./lib/convo-export"
import { ZOOM_TOAST, dismiss, notify, notifyFailure, zoomNotice } from "./lib/toast"
import { followZoom } from "./lib/zoom-resize"
import { openDocument } from "./lib/office-open"
import { sessionLink, type SessionLinkTarget } from "@shared/session-link"
import { folderName, projectName } from "./lib/project"
import { addDraftSkill, bindDraftSources, drafts, flushDrafts, homeFilled, loadDrafts, scheduleDraftSave } from "./lib/composer-drafts"
import { renderMarkdown } from "./lib/markdown"
import { chordOf, controlChord, controlHeld, keyOfCode, modHeld, recordingChord } from "./lib/keys"
import { normalizeChord } from "@shared/chord"
import { projectOf } from "./lib/session-project"
import FindBar from "./components/FindBar.vue"
import AnnotationComposer from "./components/AnnotationComposer.vue"
import AnnotationMarkers from "./components/AnnotationMarkers.vue"
import { HOME_SCOPE, useAnnotations } from "./stores/annotations"
import { mainAnnotationScope } from "./lib/annotate"
import { createFind, openFind } from "./lib/find"
import { chime, confirmChime } from "./lib/sound"
import { stepTarget } from "./lib/visible-chats"
import { fontScale } from "./lib/font-scale"
import { announce } from "./lib/announce"
import { dialogOpen, dismissMenus } from "./lib/escape-layer"
import { chimeOf, longTask } from "@shared/chime"

const app = useApp()
// The confirm dock's queue: permissions and questions for the session on screen.
const confirmDock = useQuestions()

/** "home" is the launcher; "session" is a project workspace. */
const view = ref<"home" | "session" | "artifacts" | "plugins">("home")
/*
 * The 2.0 side column; up unless it has been put away. MiMo saves the user's own
 * fold and starts from it; a fold made for a narrow window is not saved.
 */
const SIDE_COLLAPSED_KEY = "mcode.sidebarCollapsed"
const leftPanel = ref(
  (() => {
    try {
      return localStorage.getItem(SIDE_COLLAPSED_KEY) !== "true"
    } catch {
      return true
    }
  })(),
)
function setSide(open: boolean) {
  leftPanel.value = open
  try {
    localStorage.setItem(SIDE_COLLAPSED_KEY, String(!open))
  } catch {}
}
const toggleSide = () => setSide(!leftPanel.value)

/*
 * MiMo's saved composer input: read before any composer mounts, so every box
 * starts with its draft; the annotations waiting go back to their boxes; saved
 * as they change and once more as the page goes.
 */
const restoredDrafts = loadDrafts()
const annotationStore = useAnnotations()
for (const [scope, list] of Object.entries(restoredDrafts.annotations)) {
  if (!annotationStore.list(scope).length) annotationStore.put(scope, list)
}
bindDraftSources({
  annotations: () => annotationStore.byScope,
  current: () => (isHome.value ? "home" : app.currentID ? `main:${app.currentID}` : undefined),
})
watch(() => annotationStore.byScope, scheduleDraftSave)
window.addEventListener("pagehide", flushDrafts)
window.addEventListener("beforeunload", flushDrafts)
/*
 * N11-16: the machine is back on the network. The main process cannot see
 * this, and the backend, sitting in it, would otherwise wait out the rest of a
 * sixty-second backoff before finding out. An application-lifetime listener,
 * like the two above.
 */
window.addEventListener("online", () => window.mcode.networkBack())
let draftScreenRestored = false
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
 * How much of the column the card holds clear: all of it, whenever the card is
 * inline.
 *
 * MiMo holds clear only as much as keeps its reading column out from under the
 * card - `--info-inline-inset: clamp(0px, calc(--info-content-max + 2 *
 * --info-panel-width - 100cqw), --info-panel-width)`, which MCode copied
 * exactly. The card is drawn over the column's end rather than beside it, so on
 * a window with room the conversation gives up nothing and stays centred on the
 * whole column, half the card's width right of what can actually be seen. The
 * user read that on 2026-09-24 as "the code is off to the right", which is what
 * it is, and chose the conversation centred in what is left at every width.
 * A deliberate difference from MiMo; do not "fix" it back.
 */
const infoInset = computed(() => (infoInline.value ? `${INFO_PANEL_WIDTH}px` : "0px"))

let mainObserver: ResizeObserver | undefined
onMounted(() => {
  const pane = mainPane.value
  if (!pane) return
  mainObserver = new ResizeObserver(([entry]) => {
    if (!entry) return
    mainWidth.value = entry.contentRect.width
  })
  mainObserver.observe(pane)
})
onBeforeUnmount(() => mainObserver?.disconnect())

/*
 * A version the main process's updater has downloaded and is waiting to run.
 *
 * MiMo checks on its own, 5 s after launch and every 3 h, and downloads a newer
 * installer without asking; the capsule, its bubble and the settings row take a
 * ready update from here, and nothing interrupts.
 */
const downloadedUpdate = ref<string>()
/** A check in flight, so the update page can say 检查中… and not start another. */
const updateChecking = ref(false)
/** The one notice a check asked for by hand lives under, from 正在检查更新… to its answer. */
const UPDATE_CHECK_TOAST = "update-check"

type UpdateStatus = Awaited<ReturnType<typeof window.mcode.updateStatus>>

function takeUpdateState(state: UpdateStatus) {
  if (!state.ready) return
  downloadedUpdate.value = state.ready.version
  // A capsule already installing, or failed, for this same version keeps its phase.
  if (updateState.phase === "idle" || updateState.version !== state.ready.version) markUpdateReady(state.ready.version, state.ready.notes)
}

let offUpdateState: (() => void) | undefined
onMounted(() => {
  // The ready event may have gone out before this window was listening.
  void window.mcode
    .updateStatus()
    .then((state) => {
      takeUpdateState(state)
      /* MiMo's interrupted-update notice: the last install did not finish, said once, by its reason; the capsule offers 重试. */
      if (state.interrupted) {
        const { reason, hint } = interruptedReason(state.interrupted.error)
        markUpdateFailed(reason, hint, state.interrupted.targetVersion || undefined)
      }
    })
    .catch(() => {})
  offUpdateState = window.mcode.onUpdateState((state) => {
    takeUpdateState(state)
    /* A check asked for by hand says when it has moved on to downloading, as MiMo's toasts do. */
    if (updateChecking.value && state.phase === "downloading") notify(t("update.downloading"), { id: UPDATE_CHECK_TOAST, duration: 0, closable: false })
  })
})
onBeforeUnmount(() => offUpdateState?.())

const terminalOpen = ref(false)
/** How tall the docked terminal is, so the info card can end above it. */
const drawerHeight = ref(0)

/*
 * MiMo's drop overlay: while files are dragged over the main column, it says
 * they will be added. Only files and links count, as in MiMo - dragged text is
 * not a file - and not while a dialog or overlay has the window. Over the side
 * column or the side panel nothing lights, because nothing would be added.
 */
const fileDrag = ref(false)

function trackDrag(event: DragEvent) {
  if (!acceptsDrop(event.dataTransfer?.types)) return
  /*
   * The box takes the drag for itself. MiMo stops the event there, so the
   * column behind never learns of it and shows only the box's own ring; a
   * listener on the window cannot be stopped, so the box is recognised by its
   * element instead.
   */
  const target = event.target instanceof Element ? event.target : undefined
  const overBox = Boolean(target?.closest(".composer-wrap, .box"))
  const overMain = Boolean(target?.closest(".main"))
  // The copy a closing dialog leaves behind carries the scrim's classes for
  // 200ms; it is a picture of a layer, not one, and must not hold the drop
  // ring back, as escape-layer and the click guard already know.
  const covered = [...document.querySelectorAll(".scrim, .overlay")].some((node) => !node.closest("[data-modal-exit]"))
  fileDrag.value = overMain && !overBox && !covered
}

function leaveDrag(event: DragEvent) {
  // Leaving one element for another inside the window is not leaving the window.
  if (outsideWindow(event)) fileDrag.value = false
}

function endDrag() {
  fileDrag.value = false
}

/*
 * MiMo has no window of what changed after an update - its update pill says so
 * before the update. The key an earlier build kept the last version it had
 * shown notes for under is taken away so it cannot linger.
 */
try {
  localStorage.removeItem("mcode.highlights.v1")
} catch {}

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
 * The bar is mounted on the pane, and every view lives in that pane: opening
 * another conversation, or leaving for the artifacts or plugins page, puts
 * different text under a bar that is still counting the old one's matches and
 * still holding ranges that have left the document. The scan is run again so
 * the count, the highlights and 上一个/下一个 describe what is on screen.
 */
watch([() => app.currentID, view, () => app.messages.length], () => {
  if (!find.open.value) return
  void nextTick(() => find.refresh({ reset: true }))
})

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
const settingsSection = ref<"general" | "keys" | "models" | "mcp" | "archive">()
/*
 * The header, so the rename command, its chord and the header menu's 重命名 can
 * start the title's own in-place editor, as MiMo's requestRename does.
 */
const sessionHeader = ref<InstanceType<typeof SessionHeader>>()
function renameInHeader() {
  sessionHeader.value?.beginEdit()
}

/*
 * The model menu's "configure custom models" lands on the models page, as MiMo's
 * does; the MCP command and Ctrl+; land on the MCP page, MiMo's only MCP screen.
 */
function openSettings(section?: unknown) {
  settingsSection.value = section === "models" || section === "mcp" || section === "archive" ? section : undefined
  settingsOpen.value = true
}

/** Directory whose presentation is being edited, if any. */
const editingProject = ref<string>()

/* MiMo's rename dialog, for a side-column row or for a project; the open conversation's header edits in place. */
const renamingSession = ref<{ id: string; title: string }>()
const renamingProject = ref<string>()

function beginRename(sessionID: string) {
  const session = app.sessions.find((entry) => entry.id === sessionID)
  if (session) renamingSession.value = { id: session.id, title: sessionTitle(session.title) }
}

/* The dialog closes first, then the rename runs, as MiMo orders it. */
async function submitSessionRename(title: string) {
  const target = renamingSession.value
  renamingSession.value = undefined
  if (!target || title === target.title) return
  try {
    await app.rename(target.id, title)
  } catch (err) {
    notifyFailure(t("common.requestFailed"), err instanceof Error ? err.message : String(err))
  }
}

/* MiMo's project rename: another project already under that name is refused, and the new name is said. */
async function submitProjectRename(name: string) {
  const directory = renamingProject.value
  renamingProject.value = undefined
  if (!directory) return
  const names = app.config?.projectNames ?? {}
  if (app.projects.some((other) => other !== directory && projectName(other, names) === name)) {
    notifyFailure(t("toast.projectNameTaken", { name }))
    return
  }
  await app.patchConfig({ projectNames: { ...names, [directory]: name } })
  notify(t("toast.projectRenamedTo", { name }), { level: "success" })
}

/* MiMo's revealInFinder: the file manager's name once it is shown, or why it could not be. */
async function revealFolder(directory: string) {
  const result = await window.mcode.revealFile(directory, "")
  if (result.ok) notify(revealLabel())
  else notifyFailure(t("rp.files.revealFailed", { error: result.error || t("rp.files.pathNotExist") }))
}
const composer = ref<InstanceType<typeof Composer>>()
const homeHero = ref<InstanceType<typeof HomeHero>>()
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
    `theme ${app.config?.theme ?? "system"}`,
    `language ${language.value}`,
    "",
  ]
  const body = logLines.length ? logLines : [t("log.empty")]
  const saved = await saveText("mcode-log.txt", [...header, ...body].join("\n"))
  if (saved) notify(t("log.saved"), { action: revealAction(saved) })
}

/**
 * MiMo's updateCheckNow, from the settings row, the menu or the palette.
 *
 * There is no update service behind this app, so the feed is whatever the user
 * points it at - an update folder with electron-builder's latest.yml. The main
 * process reads it and downloads and verifies a newer installer (the window's
 * content policy reaches nothing but the local backend); this only says how it
 * went. With no feed configured the command says so rather than pretending to
 * have checked.
 */
async function checkForUpdates() {
  if (updateChecking.value) return
  updateChecking.value = true
  /*
   * MiMo's sticky 正在检查更新…, up for as long as the check (and a download)
   * runs, with no ✕; the result then takes its place under the same id, so the
   * one notice turns into the answer rather than a second one appearing.
   */
  const checking = notify(t("update.checking"), { id: UPDATE_CHECK_TOAST, duration: 0, closable: false })
  try {
    const result = await window.mcode.updateCheckNow()
    takeUpdateState(result)
    if (result.outcome === "current") notify(t("update.current"), { id: checking })
    else if (result.outcome === "ready") notify(t("update.readyToast"), { id: checking, level: "success" })
    else if (result.outcome === "no-feed") notifyFailure(t("update.noFeed"), { id: checking })
    else if (result.outcome === "failed") {
      notifyFailure(t(result.during === "download" ? "update.failed" : "update.checkFailed"), { id: checking, body: result.error ?? "" })
    } else dismiss(checking)
  } catch (err) {
    // Electron prefixes the IPC plumbing; only the reason is worth showing.
    notifyFailure(t("update.checkFailed"), { id: checking, body: reasonOf(err) })
  } finally {
    updateChecking.value = false
  }
}

/**
 * Chord to command id, for whatever the user has re-bound.
 *
 * Read in the physical-key spelling `chordOf` produces, so a binding written
 * the old printed way (Ctrl+Shift+{) that reached the config some other way
 * than the load-time migration still fires.
 */
const rebound = computed(() => {
  const out = new Map<string, string>()
  for (const [id, chord] of Object.entries(app.config?.keybinds ?? {})) {
    // Only a chord written as text is one; the backend drops anything else as it reads the file.
    if (chord && typeof chord === "string") out.set(normalizeChord(chord), id)
  }
  return out
})
/* The application menu names the chords as bound (MiMo's menu does), and none while one is being recorded. */
watch(
  [() => app.config?.keybinds, recordingChord],
  ([binds, recording]) => window.mcode.menuKeys?.({ binds: { ...(binds ?? {}) }, recording }),
  { immediate: true, deep: true },
)

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

/*
 * The terminal is fetched the first time one is opened rather than built into
 * the shell. MiMo keeps its terminal out of the entry chunk the same way -
 * ./vendor/xterm.js, addon-fit.js and pty-term.js are injected into the
 * document only when a terminal is first attached - while this bundle carried
 * xterm, its two addons and its stylesheet in the always-loaded chunk because
 * the drawer was imported like any other panel. Measured: the entry chunk was
 * 6 197 212 B against MiMo's 2 271 966 B, and was the only built file holding
 * xterm at all. The drawer is only ever rendered behind `terminalUp`, so the
 * fetch happens on the press that opens it.
 */
const TerminalDrawer = defineAsyncComponent(() => import("./components/TerminalDrawer.vue"))

const drawer = ref<InstanceType<typeof TerminalDrawerComponent>>()
const rightPanel = ref<InstanceType<typeof RightPanel>>()

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
async function runBatch(action: "archive" | "delete" | "cancel" | "all" | "none", ids: string[] = []) {
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
    await archiveSessions([...chosen])
    selecting.value = undefined
    return
  }
  deletingMany.value = [...chosen]
}

async function confirmDeleteMany() {
  const targets = deletingMany.value ?? []
  deletingMany.value = undefined
  for (const sessionID of targets) await app.remove(sessionID)
  selecting.value = undefined
  // MiMo's removeMany: one notice for the batch.
  if (targets.length) notify(t("toast.convosDeleted", { n: targets.length }), { level: "success" })
}

/*
 * MiMo's archive notice (store:threads): one per action, with 撤销 for the
 * conversations still archived and 已归档 to the Settings page. With nothing
 * to archive it says that instead.
 */
async function archiveSessions(ids: string[]) {
  if (!ids.length) {
    notify(t("toast.noConvosToArchive"))
    return
  }
  for (const sessionID of ids) await app.archive(sessionID, true)
  notify(ids.length === 1 ? t("toast.convoArchived") : t("toast.archivedNConvos", { count: ids.length }), {
    level: "success",
    links: [
      { label: t("toast.archiveUndo"), run: () => void undoArchive(ids) },
      { label: t("toast.viewArchived"), run: () => openSettings("archive") },
    ],
  })
}

/* Only what is still archived comes back; if none is, MiMo says the undo failed. */
async function undoArchive(ids: readonly string[]) {
  const still = ids.filter((id) => app.sessions.some((session) => session.id === id && session.archived))
  if (!still.length) {
    notifyFailure(t("toast.archiveUndoFailed"))
    return
  }
  for (const sessionID of still) await app.archive(sessionID, false)
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
 * Which scheme is actually showing. "System" is the default, so it cannot be
 * read from the setting alone - it has to follow the OS, and follow it while
 * the window is open rather than only at startup.
 */
const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)")
const systemDark = ref(schemeQuery.matches)
const onSchemeChange = (event: MediaQueryListEvent) => (systemDark.value = event.matches)
const darkScheme = computed(() =>
  theme.value === "system" ? systemDark.value : theme.value === "dark",
)

/*
 * The colours are the stylesheet's, as MiMo's are: tokens.css carries MCode's
 * one palette for both schemes, and `data-theme` above picks between them.
 * The caption buttons are the OS's, drawn over a transparent fill. It knows the
 * system theme but not this app's, so it has to be told which one won.
 */
watch(darkScheme, (dark) => window.mcode.titlebarMode(dark ? "dark" : "light"), { immediate: true })

/*
 * MiMo's native theme: main sets the OS-drawn surfaces (context menus, the
 * tray menu, message boxes, the pre-paint background) to the chosen scheme and
 * keeps it for the next launch's first paint.
 */
watch(theme, (value) => window.mcode.nativeTheme(value), { immediate: true })

/*
 * MiMo's exit-full-screen button. On Windows the caption buttons are the OS's
 * overlay, and full screen takes them away with nothing left to click; the
 * button stands in until the window leaves full screen.
 */
const fullScreen = ref(false)
let offFullscreen: (() => void) | undefined
onMounted(() => {
  void window.mcode
    .isFullscreen()
    .then((value) => (fullScreen.value = value))
    .catch(() => {})
  offFullscreen = window.mcode.onFullscreen((value) => (fullScreen.value = value))
})
onBeforeUnmount(() => offFullscreen?.())
const exitFullScreen = () => window.mcode.exitFullscreen()

/*
 * The icon the window wears. Main cannot read the config document, so it is
 * told - at startup as well as on a change, because a window created before
 * the config arrived is wearing the packaged default.
 */
watch(
  () => app.config?.appIcon ?? DEFAULT_APP_ICON,
  (id) => void window.mcode.appIcon(id),
  { immediate: true },
)

/* And whether there is an icon in the corner at all. */
watch(
  () => app.config?.tray ?? true,
  (enabled) => window.mcode.tray(enabled),
  { immediate: true },
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
 * The two sizes on the appearance page, carried the way MiMo carries them: a
 * scale on the root that every size in the interface is multiplied by - text
 * by the UI scale, code in the transcript and the diffs by the code one. At
 * the defaults both are 1 and nothing moves. Worked out as MiMo's does: a size
 * is clamped to its range before it becomes a scale, and anything that is not
 * a positive number is no scale at all.
 */
watch(
  () => [app.config?.uiFontSize, app.config?.codeFontSize] as const,
  ([ui, code]) => {
    const style = document.documentElement.style
    style.setProperty("--ui-font-scale", String(fontScale(ui, 14, 10, 24)))
    style.setProperty("--code-font-scale", String(fontScale(code, 12, 9, 24)))
  },
  { immediate: true },
)

// The i18n table reads a module-level ref, so mirror config into it whenever
// the setting changes - every t() call re-renders off that ref.
let languageAsked = 0
watch(
  () => app.config?.language,
  async (next) => {
    /*
     * Absent means nobody has chosen, so the machine's own preference decides.
     * An unknown code falls back to English rather than leaving the window
     * half-translated in whatever was showing before.
     */
    const chosen: Language = !next ? detectLanguage() : LANGUAGES.some((entry) => entry.id === next) ? (next as Language) : "en"
    /*
     * Most tables are a chunk of their own (lib/i18n.ts): the words showing
     * stay until the table asked for is in hand, so nothing is ever drawn
     * half in one language. A later change of mind wins over a slower fetch.
     */
    const asked = ++languageAsked
    if (!languageReady(chosen)) await loadLanguage(chosen)
    if (asked !== languageAsked) return
    language.value = chosen
    // Remembered only once the settings have spoken, never the guess made before they arrive.
    if (app.config) rememberLanguage(chosen)
    // Arabic reads the other way, and the layout has to turn with it.
    document.documentElement.dir = RTL_LANGUAGES.includes(language.value) ? "rtl" : "ltr"
    /*
     * The table's id is its BCP-47 tag. Screen readers pick their voice by it,
     * `:lang()` and the font fallback pick Japanese or Traditional glyphs for a
     * shared Han character by it, and echarts in a PPTX picks its own language
     * by it.
     */
    document.documentElement.lang = language.value
    // The menu bar is built in the main process, which cannot read that ref.
    publishMenuLabels()
  },
  { immediate: true },
)
const isArtifacts = computed(() => view.value === "artifacts")
const isPlugins = computed(() => view.value === "plugins")
const isHome = computed(
  () => !isArtifacts.value && !isPlugins.value && (view.value === "home" || !app.current),
)
/** Empty transcript shows the hero instead of a blank scroller; one still loading shows its loading line instead. */
const empty = computed(() => app.messages.length === 0 && app.loadingID !== app.currentID)

/*
 * The terminal docks along the foot of the main column. Not on the artifacts
 * and plugins pages; on the home screen, as MiMo allows, once there is a
 * project folder for it to open in, since no conversation has one yet.
 */
const terminalUp = computed(
  () =>
    terminalOpen.value &&
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
  () => (isHome.value ? undefined : app.currentID),
  (scope) => rp.setScope(scope),
  { immediate: true },
)
/*
 * MiMo's automatic opens (lib/delivered): a conversation is on show when it is
 * the one in the middle of its conversation view, or the side chat tab open in
 * the panel. An open held for one runs when it comes on show.
 */
setDeliveryView({
  shown: (sessionID) =>
    (!isHome.value && !isArtifacts.value && !isPlugins.value && app.currentID === sessionID) ||
    (rp.open && rp.activeTab?.type === "chat" && rp.activeTab.convoId === sessionID),
  directory: (sessionID) => (app.sessions.find((session) => session.id === sessionID) ?? app.sideSessionOf(sessionID))?.directory ?? app.current?.directory,
})
watch([() => (isHome.value || isArtifacts.value || isPlugins.value ? undefined : app.currentID)], ([shown]) => deliveryShown(shown))
watch([() => rp.open, () => rp.activeTab], ([open, tab]) => {
  if (open && tab?.type === "chat") deliveryShown(tab.convoId)
})
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
const panelBeside = computed(() => rp.open)

/* What the panel's tools work in: the conversation's project, or the one picked on the home screen. */
const panelDirectory = computed(() => (isHome.value ? homeShellDirectory.value : app.current?.directory))

/* The title bar's button and Ctrl+Alt+B: the panel, with its launcher while it holds no tabs. */
function toggleSidePanel() {
  rp.toggleOpen()
}

/* MiMo's tool shortcuts ask for a conversation: on the home screen they do nothing. */
const inConversation = computed(() => !isHome.value && Boolean(app.currentID))

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

/*
 * MiMo's side column width, dragged at its edge: kept as last let go, and shown
 * clamped to what the window leaves beside an open panel, so a narrower window
 * narrows it without forgetting the choice.
 */
const SIDE_WIDTH_KEY = "mcode.sideWidth"
const storedSideWidth = ref(
  (() => {
    try {
      return parseInt(localStorage.getItem(SIDE_WIDTH_KEY) ?? "", 10)
    } catch {
      return NaN
    }
  })(),
)
const sideWidth = computed(() =>
  clampSideWidth(storedSideWidth.value, windowWidth.value, rp.open ? Math.max(PANEL_MIN_WIDTH, rp.width) : 0),
)
function resizeSide(width: number, done: boolean) {
  storedSideWidth.value = clampSideWidth(width, windowWidth.value, rp.open ? Math.max(PANEL_MIN_WIDTH, rp.width) : 0)
  if (!done) return
  try {
    localStorage.setItem(SIDE_WIDTH_KEY, String(storedSideWidth.value))
  } catch {}
}

/* P6-3: a project picked, brought in or made on the home screen opens the side column, as MiMo's does. */
const revealSide = () => setSide(true)
onMounted(() => window.addEventListener("mcode:reveal-side", revealSide))
onBeforeUnmount(() => window.removeEventListener("mcode:reveal-side", revealSide))
let sideAutoFolded = false
watch(
  [windowWidth, leftPanel, () => rp.open, () => rp.width, () => rp.fullscreen],
  ([viewport, sideOpen], [, sideBefore]) => {
    if (sideOpen) sideAutoFolded = false
    // MiMo weighs the panel as drawn, narrowed toward 300 beside the column, not as dragged.
    const panelWidth = panelWidthShown(rp.width, viewport, sideWidth.value, PANEL_MIN_WIDTH)
    const room = { viewport, sideWidth: sideWidth.value, sideOpen, panelOpen: rp.open, panelWidth, fullscreen: rp.fullscreen }
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

/*
 * Ctrl+period is MiMo's annotate while a browser tab shows a page. A blank tab
 * has nothing to mark, so `toggleAnnotate` says no and the chord falls back to
 * stepping the agent, as it does everywhere else.
 */
function annotateBrowser() {
  const annotated = browserShowing.value ? rightPanel.value?.activeBrowser()?.toggleAnnotate() : false
  if (!annotated && app.currentID) void cycleAgent(1)
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
/**
 * A file named on the edited-files card, opened the way MiMo opens one.
 *
 * The recorded path is resolved first - against the project as well as as it
 * stands - and a path that is no longer there is said so rather than doing
 * nothing. What can be previewed opens in the panel (a document in the Office
 * tab, anything else in the files tab, rooted at its own folder when it lies
 * outside the project); a folder is shown in the system's file manager. Nothing
 * is handed to an external editor any more.
 */
watch(fileRequest, async (asked) => {
  if (!asked) return
  const root = app.current?.directory?.replace(/[\\/]+$/, "")
  const candidates = [asked.path, ...(root ? [`${root}/${asked.path}`] : [])]
  const found = await window.mcode.resolveExistingPath(candidates).catch(() => null)
  if (!found) {
    notifyFailure(t("harnessRow.pathNotExist"))
    return
  }
  if (found.directory) {
    const shown = await window.mcode.revealPath(found.path).catch(() => ({ ok: false, error: "" }))
    if (!shown.ok) notifyFailure(t("harnessRow.revealFailed", { error: shown.error ?? "" }))
    return
  }
  await openDocument({ path: found.path }, root)
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
 * goes onto the project list with no conversation made, and the home screen
 * comes up with the last one picked. A drop that held no folder says so.
 */
async function addDroppedProjects(directories: string[]) {
  if (!directories.length) {
    notifyFailure(t("side.dropNotDir"))
    return
  }
  await addAndBrowse(directories)
}

/* MiMo's add then browseProject: listed, the last one the latest pick, and home with it chosen. */
async function addAndBrowse(directories: string[]) {
  const last = directories[directories.length - 1]!
  for (const directory of directories) {
    await app.addProject(directory, { used: directory === last, switched: directory === last })
  }
  startIn(last)
}

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

/*
 * MiMo's 已经是新任务了: the home screen is already up in that project with
 * nothing typed, attached or chipped, so starting afresh would change nothing.
 */
function alreadyNewTask(directory: string | undefined): boolean {
  if (view.value !== "home" || homeDirectory.value !== directory || homeFilled.value) return false
  notify(t("toast.alreadyNewTask"))
  return true
}

/* The side column's 新建任务, MiMo's newChatGlobal. */
function newTaskFromSide() {
  if (alreadyNewTask(homeDirectory.value)) return
  goHome()
  void focusComposer()
}

async function newSessionIn(directory: string) {
  if (alreadyNewTask(directory)) return
  await app.addProject(directory, { used: true, silent: true })
  startIn(directory)
}

/*
 * DL15, MiMo's open-folder: each folder chosen goes onto the project list, so
 * the side column shows it at once, and the home screen comes up with the last
 * one picked. No conversation is made.
 */
async function browse() {
  const directories = await pickProjectFolder(t("dialog.pickProjectFolder"), true)
  if (!directories.length) return
  await addAndBrowse(directories)
}

/**
 * A numbered slot's conversation. Sets the view as well as the session, because
 * the one already current opens nothing and would otherwise leave the shortcut
 * with no effect at all while the launcher is up.
 */
async function selectTab(id: string) {
  if (app.currentID !== id) await app.open(id)
  view.value = "session"
  push({ view: "session", sessionID: id })
}

/** Starts a task from the 2.0 home screen, in the project picked there. */
function newSession() {
  if (!alreadyNewTask(app.current?.directory)) startIn(app.current?.directory)
}

const settingsDialog = ref<InstanceType<typeof SettingsDialogComponent>>()

/**
 * MiMo's new task clears the screen before it runs: every menu, the search,
 * the palette, Settings - asking first when an environment has unsaved edits -
 * and the previews. A dialog that asks something (a rename, a confirmation)
 * keeps the key, and then this answers false and does nothing.
 */
function newTaskOverLayers(): boolean {
  const asking = [...document.querySelectorAll('[aria-modal="true"]')].some(
    (node) => !node.closest("[data-new-task-clears]") && !node.closest("[data-modal-exit]"),
  )
  if (asking || editingProject.value || renamingSession.value || renamingProject.value) return false
  dismissMenus()
  searchOpen.value = false
  closeImagePreview()
  closeVideoPreview()
  if (settingsOpen.value && settingsDialog.value) {
    settingsDialog.value.leaveThen(() => {
      settingsOpen.value = false
      newSession()
    })
    return true
  }
  settingsOpen.value = false
  newSession()
  return true
}

/** Whether a chord is the one new task answers to: Ctrl+N, or wherever it has been re-bound. */
function isNewTaskChord(chord: string): boolean {
  if (!chord) return false
  const bound = rebound.value.get(chord)
  if (bound) return bound === "session.new"
  return chord === "Ctrl+N" && !retiredChords.value.has(chord)
}

/* What a click in the thread leaves alone because it takes the click or the keyboard itself: MiMo's list. */
const THREAD_CONTROLS =
  "button, a, input, textarea, select, label, [contenteditable], [role=button], [role=textbox], [role=link], [role=menuitem], [role=checkbox], [role=tab]"

/** MiMo: a click on the thread, not on a control and with nothing selected, puts the caret at the end of the box. */
function onThreadClick(event: MouseEvent) {
  if (window.getSelection()?.toString()) return
  if ((event.target as Element | null)?.closest?.(THREAD_CONTROLS)) return
  composer.value?.focus()
}

/*
 * The home screen draws a box of its own (HomeHero's), so a new task focuses
 * that one; the conversation's box is not on screen there, and focusing it
 * left the keyboard on the page body.
 */
async function focusComposer() {
  await nextTick()
  if (isHome.value) homeHero.value?.focus()
  else composer.value?.focus()
}

/** Reachable from the model menu, so an empty list has somewhere to go. */
const connectOpen = ref(false)
/** The vendor a request named (an expired sign-in's "sign in again"), or none to browse. */
const connectGroup = ref<Group>()
watch(
  () => app.connectRequest,
  (request) => {
    if (!request) return
    connectGroup.value = request.provider
      ? groupProviders(connectableProviders(app.providers)).find((group) => group.entries.some((entry) => entry.id === request.provider))
      : undefined
    connectOpen.value = true
  },
)

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
  /* MCode's own: MiMo reaches this state from its review service, which MCode does not have. */
  {
    id: "row.reviewRestricted",
    label: "menu.restrictConversation",
    icon: "M8 2.4 13.6 4v4.2c0 3.2-2.2 5.2-5.6 6.2-3.4-1-5.6-3-5.6-6.2V4zM6 7.8 7.4 9.2 10.2 6.4",
  },
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
  /* MCode's own: MiMo reaches this state from its review service, which MCode does not have. */
  {
    id: "row.reviewRestricted",
    label: "menu.restrictConversation",
    icon: "M8 2.4 13.6 4v4.2c0 3.2-2.2 5.2-5.6 6.2-3.4-1-5.6-3-5.6-6.2V4zM6 7.8 7.4 9.2 10.2 6.4",
  },
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
  { id: "row.continue", label: "menu.fork", icon: "M4.6 4.8v6.6M4.6 4.8a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8zM4.6 7.6h4.2a2 2 0 0 1 2 2v1.4M10.8 11a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z" },
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
    else notifyFailure(t("stream.forkNeedsMessage"))
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
    await revealFolder(target.directory)
  },
  /*
   * MCode's own way in to MiMo's `reviewRestricted`: MiMo's own review service
   * reports a filtered turn, and MCode has none, so the state would otherwise be
   * unreachable. Marks the conversation as one that cannot be continued, or
   * lifts that when it already is.
   */
  "row.reviewRestricted": async (sessionID) => {
    const target = app.sessions.find((entry) => entry.id === sessionID)
    if (!target) return
    try {
      await app.client?.request({ type: "session.reviewRestricted", sessionID, restricted: !target.reviewRestricted })
      notify(t(target.reviewRestricted ? "menu.allowContinue" : "menu.restrictConversation"))
    } catch (failure) {
      notifyFailure(t("menu.restrictConversation"), reasonOf(failure))
    }
  },
}

/*
 * What 移动至项目 › lists: the side column's projects, newest first, the one the
 * conversation is in lit, 移出项目 above them while it is in one, and 新建项目…
 * kept below whatever the search leaves.
 */
function moveMenu(target?: (typeof app.sessions)[number]): Pick<MenuItem, "children" | "search" | "footer" | "childWidth"> {
  const current = target ? projectOf(target) : undefined
  const rows: MenuItem[] = app.projects.map((directory) => ({
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
            : entry.id === "row.reviewRestricted"
              ? t(target?.reviewRestricted ? "menu.allowContinue" : "menu.restrictConversation")
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
    // A row's menu acts on its own conversation (runSessionMenu opens it first where it must), so whether one
    // is open now says nothing about it; only the header's menu, which names the open one, keeps the command's rule.
    enabled: Boolean(target) && (!sessionMenu.value?.header || command.enabled !== false),
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
    await archiveSessions(projectSessions(directory).map((session) => session.id))
  },
  /* MiMo's project batch management chooses projects, starting with this one. */
  batch: (directory) => {
    selecting.value = undefined
    selectingProjects.value = [directory]
  },
  reveal: (directory) => revealFolder(directory),
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
    const [next] = await pickDirectory(t("menu.relocateProject"), false)
    if (!next || next === directory) return
    // MiMo refuses a folder that is already another project's, rather than merging the two.
    if (app.projects.includes(next) || app.sessions.some((entry) => entry.directory === next && !entry.archived)) {
      notifyFailure(t("toast.projectPathTaken", { name: projectName(next, app.config?.projectNames) }))
      return
    }
    // Refuse before move: without config the name/icon/pin rewrite cannot run, and a silent
    // early return used to leave sessions already moved on the new path.
    const config = app.config
    if (!config) {
      notifyFailure(t("common.requestFailed"))
      return
    }
    for (const session of app.sessions.filter((entry) => entry.directory === directory)) await app.move(session.id, next)
    const swap = (list: string[] | undefined) => (list ?? []).map((entry) => (entry === directory ? next : entry))
    try {
      await app.patchConfig({
        projectNames: rekey(config.projectNames, directory, next),
        projectIcons: rekey(config.projectIcons, directory, next),
        projectColors: rekey(config.projectColors, directory, next),
        pinnedProjects: swap(config.pinnedProjects),
        projects: swap(config.projects),
        projectOrder: swap(config.projectOrder),
        closedProjects: swap(config.closedProjects),
      })
    } catch (err) {
      notifyFailure(t("common.requestFailed"), reasonOf(err))
      return
    }
    notify(t("toast.projectPathChanged", { name: projectName(next, app.config?.projectNames) }), { level: "success" })
  },
  /* Asked first, as MiMo asks: the project leaves the list, its conversations stay. */
  remove: (directory) => {
    removingProjects.value = { directories: [directory], batch: false }
  },
}

/* Takes projects off the project list; adding the folder again brings each back. */
async function closeProjects(directories: string[]) {
  await app.removeProjects(directories)
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
    const moving = app.sessions.find((entry) => entry.id === target)
    if (moving && projectOf(moving) !== directory) await app.move(target, directory)
    return
  }
  const own = ROW_ACTIONS[key]
  if (own) {
    await own(target, header)
    return
  }
  // Archiving and deleting need nothing on screen, so the row's conversation is not opened just to go away.
  if (key === "session.archive") {
    await archiveSessions([target])
    return
  }
  if (key === "session.delete") {
    deletingSession.value = target
    return
  }
  // A row's 重命名 is MiMo's dialog, over whatever is open; the header's edits the title in place.
  if (key === "session.rename" && !header) {
    beginRename(target)
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
  if (!target) return
  await app.remove(target)
  notify(t("toast.convoDeleted"), { level: "success" })
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
    // MiMo's batch project archive is silent per project and says the count once, with no links.
    notify(t("toast.projectsArchivedN", { count: chosen.length }), { level: "success" })
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
  if (!directory) {
    notifyFailure(t("menu.createFailed", { error: t("common.requestFailed") }))
    return
  }
  if (source && title !== folderName(source)) {
    await app.patchConfig({ projectNames: { ...(app.config?.projectNames ?? {}), [source]: title } })
  }
  if (moving) {
    await app.addProject(directory, { silent: true })
    await app.move(moving, directory)
    if (app.currentID !== moving) await app.open(moving)
    view.value = "session"
    return
  }
  // DL15: MiMo lands on the home screen with the new project picked, and makes no conversation for it.
  await addAndBrowse([directory])
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
/**
 * Says that writing a file did not work, and leaves the app alone otherwise.
 *
 * `app.error` is the one message the boot screen reads, and setting it
 * replaces the whole window with that screen. That is right for a backend that
 * never started - there is no app to go back to - and wrong for a save that
 * failed, which leaves everything else exactly where it was. So this goes in a
 * toast, which times out and has a close button, as send failures do.
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
    const saved = await saveText(`${name}.html`, page)
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
  // Pin the conversation that owned the command: send() otherwise re-reads
  // currentID, and a switch mid-flight would start the brief elsewhere.
  const id = app.currentID
  if (!id || app.busy) return
  await app.send(t("init.prompt"), [], id)
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
  await archiveSessions(app.sessions.filter((entry) => !entry.archived).map((entry) => entry.id))
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

/* subagents: MiMo 26.920's chip on a side column row - the conversation, then its 子智能体 tab. */
async function openSubagentsFromSide(sessionID: string) {
  await openFromSide(sessionID)
  rp.openSubagents()
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

/*
 * The skill card's 在对话中试用, as MiMo's: the skill goes as a chip into the
 * open conversation's box when there is one, otherwise into a new task's, and
 * a note says so.
 */
async function trySkill(name: string, title: string) {
  const current = app.current
  if (current && !current.archived && !current.parentID && !current.sideOf) {
    addDraftSkill(`main:${current.id}`, name)
    await openFromSide(current.id)
    push({ view: "session", sessionID: current.id })
  } else {
    addDraftSkill("home", name)
    goHome()
  }
  notify(t("skillDetail.tryInChatToast", { name: title }))
}

/* MiMo's 让 Agent 配置: a new task with the skill-writing skill as its only chip and a request already written. */
function configureSkill(name: string, title: string) {
  addDraftSkill("home", "skill-creator", { only: true, text: t("skillDetail.configureDraft", { name: title, id: name }) })
  goHome()
}

/**
 * Steps to the next conversation with something waiting, along the side
 * column's visible order.
 *
 * Wraps around and stops where it started, so pressing it with nothing unread
 * leaves the screen alone rather than walking the whole list.
 */
async function stepUnread(by: 1 | -1) {
  const chats = app.visibleChats
  if (!chats.length) return
  const at = app.currentID ? chats.indexOf(app.currentID) : -1
  for (let step = 1; step <= chats.length; step += 1) {
    const candidate = chats[(at + by * step + chats.length * step) % chats.length]
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

/* MiMo's previous / next conversation, along the side column's visible order. */
async function stepSession(by: 1 | -1) {
  const next = stepTarget(app.visibleChats, app.currentID, by)
  if (next) await selectTab(next)
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
    { id: "session.new", group: "key.groupGeneral", title: t("side.newTask"), hint: "Ctrl+N", run: newSession },
    {
      id: "view.model",
      group: "key.groupModels",
      title: t("cmd.switchModel"),
      hint: "Ctrl+Shift+M",
      // The picker hangs off the composer's model pill, and the composer is
      // only mounted inside a project - so on the home screen this command had
      // nothing to open, and both menus offered it anyway.
      enabled: inWorkspace,
      run: () => composer.value?.openModelMenu(),
    },
    {
      id: "session.abort",
      group: "key.groupConversation",
      title: t("cmd.abort"),
      enabled: app.busy,
      run: () => app.abort(),
    },
    {
      id: "session.rename",
      group: "key.groupConversation",
      title: t("cmd.rename"),
      hint: "Ctrl+Alt+R",
      enabled: hasSession,
      run: () => renameInHeader(),
    },
    {
      id: "session.undo",
      group: "key.groupConversation",
      title: t("cmd.undo"),
      enabled: hasSession && !app.busy && app.history.undo > 0,
      run: undoTurn,
    },
    {
      id: "session.redo",
      group: "key.groupConversation",
      title: t("cmd.redo"),
      enabled: hasSession && !app.busy && app.history.redo > 0,
      run: redoTurn,
    },
    {
      id: "session.share",
      group: "key.groupConversation",
      title: t("share.session"),
      enabled: hasSession && app.messages.length > 0,
      run: shareSession,
    },
    {
      id: "session.exportMarkdown",
      group: "key.groupConversation",
      title: t("cmd.exportMarkdown"),
      enabled: hasSession && app.messages.length > 0,
      run: exportSession,
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
      group: "key.groupConversation",
      title: t("cmd.compact"),
      // A model call, and pointless on a conversation that is one exchange long.
      enabled: hasSession && !app.busy && !app.compacting && app.messages.length > 1,
      run: compactSession,
    },
    {
      id: "session.archive",
      group: "key.groupConversation",
      title: t("cmd.archive"),
      hint: "Ctrl+Alt+A",
      enabled: hasSession,
      run: async () => {
        if (app.currentID) await archiveSessions([app.currentID])
      },
    },
    {
      id: "session.delete",
      group: "key.groupConversation",
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
      run: () => toggleSide(),
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
      group: "key.groupConversation",
      title: t("key.reviewTab"),
      hint: "Ctrl+Shift+G",
      enabled: inConversation.value,
      run: openReviewTab,
    },
    {
      id: "app.copyDirectory",
      group: "key.groupConversation",
      title: t("menu.copyDirectory"),
      hint: "Ctrl+Shift+C",
      enabled: hasSession,
      run: copyWorkingDirectory,
    },
    {
      id: "view.right",
      group: "key.groupConversation",
      title: t("key.sidePanel"),
      hint: "Ctrl+Alt+B",
      run: toggleSidePanel,
    },
    {
      id: "view.terminal",
      group: "key.groupTerminal",
      title: terminalOpen.value ? t("cmd.hideTerminal") : t("cmd.showTerminal"),
      // MiMo's `ctrl`: Control on a Mac too, where Command+` cycles windows.
      hint: controlChord("`", app.platform),
      enabled: inWorkspace,
      run: () => (terminalOpen.value = !terminalOpen.value),
    },
    // App
    {
      id: "composer.promptMode",
      group: "key.groupPrompt",
      title: t("cmd.promptMode"),
      enabled: hasSession,
      run: () => composer.value?.setMode("normal"),
    },
    {
      id: "composer.shellMode",
      group: "key.groupPrompt",
      title: t("cmd.shellMode"),
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
      id: "session.prevUnread",
      group: "key.groupConversation",
      title: t("conv.prevUnread"),
      run: () => void stepUnread(-1),
    },
    {
      id: "session.nextUnread",
      group: "key.groupConversation",
      title: t("conv.nextUnread"),
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
      group: "key.groupConversation",
      title: t("cmd.toggleSteps"),
      enabled: inWorkspace,
      run: toggleSteps,
    },
    {
      id: "session.prevMessage",
      group: "key.groupConversation",
      title: t("cmd.prevMessage"),
      run: () => stream.value?.stepMessage(-1),
    },
    {
      id: "session.nextMessage",
      group: "key.groupConversation",
      title: t("cmd.nextMessage"),
      run: () => stream.value?.stepMessage(1),
    },
    {
      id: "app.mcp",
      group: "key.groupModels",
      title: t("cmd.mcp"),
      run: () => openSettings("mcp"),
    },
    {
      id: "session.previous",
      group: "key.groupConversation",
      title: t("conv.prev"),
      hint: "Ctrl+Shift+[",
      run: () => void stepSession(-1),
    },
    {
      id: "session.next",
      group: "key.groupConversation",
      title: t("conv.next"),
      hint: "Ctrl+Shift+]",
      run: () => void stepSession(1),
    },
    {
      id: "agent.cycle",
      group: "key.groupModels",
      title: t("key.cycleAgent"),
      enabled: hasSession,
      run: () => void cycleAgent(1),
    },
    {
      id: "agent.cycle.reverse",
      group: "key.groupModels",
      title: t("key.cycleAgentBack"),
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
      // 追求目标, unbound: for the open conversation, or on the home screen for the next task.
      id: "composer.goal.toggle",
      group: "key.groupPrompt",
      title: t("key.label.toggle-goal"),
      run: () => void app.toggleGoalMode(isHome.value),
    },
    {
      id: "project.previous",
      group: "key.groupGeneral",
      title: t("key.prevProject"),
      run: () => void stepProject(-1),
    },
    {
      id: "project.next",
      group: "key.groupGeneral",
      title: t("key.nextProject"),
      run: () => void stepProject(1),
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
     * The numbered slots, counted along the side column as MiMo counts them:
     * pinned conversations first, then the rest in the order they are listed.
     */
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `tab.goto.${index + 1}`,
      group: "key.groupConversation",
      title: t("key.gotoTab", { n: index + 1 }),
      hint: `Ctrl+${index + 1}`,
      enabled: () => app.visibleChats.length > index,
      run: () => {
        const target = app.visibleChats[index]
        if (target) void selectTab(target)
      },
    })),
    {
      id: "session.side",
      group: "key.groupConversation",
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
      group: "key.groupConversation",
      title: t("key.togglePin"),
      hint: "Ctrl+Alt+P",
      enabled: hasSession,
      run: () => {
        if (app.currentID) app.togglePinned(app.currentID)
      },
    },
    {
      id: "session.copyID",
      group: "key.groupConversation",
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
      group: "key.groupConversation",
      title: t("key.copyLink"),
      hint: "Ctrl+Alt+L",
      enabled: hasSession,
      run: copySessionLink,
    },
    {
      id: "session.nextRecent",
      group: "key.groupConversation",
      title: t("key.nextRecent"),
      hint: controlChord("Tab", app.platform),
      run: async () => {
        await stepRecent(1)
        endRecentWalk()
      },
    },
    {
      id: "session.prevRecent",
      group: "key.groupConversation",
      title: t("key.prevRecent"),
      hint: controlChord("Shift+Tab", app.platform),
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
      title: t("key.label.search"),
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
    {
      // MiMo's branchConvo: the whole conversation at once, titled 「… (分支)」; the store toasts either way.
      id: "session.fork",
      group: "key.groupConversation",
      title: t("key.label.fork-chat"),
      enabled: hasSession,
      run: () => {
        const last = app.messages[app.messages.length - 1]
        if (!last) notifyFailure(t("stream.forkNeedsMessage"))
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
      group: "key.groupConversation",
      title: t("menu.copyMarkdown"),
      enabled: hasSession && app.messages.length > 0,
      run: () => {
        if (app.currentID) void ROW_ACTIONS["row.copyMarkdown"](app.currentID, false)
      },
    },
    {
      id: "panel.maximize",
      group: "key.groupConversation",
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
    Boolean(editingProject.value) ||
    Boolean(renamingSession.value) ||
    Boolean(renamingProject.value),
)

/*
 * The commands that act on the open conversation, which MiMo gives no target
 * while anything covers it.
 */
const CONVERSATION_COMMANDS = new Set([
  "session.pin",
  "session.rename",
  "session.archive",
  "session.delete",
  "session.side",
  "session.fork",
  "session.share",
  "session.copyID",
  "session.copyLink",
  "session.copyMarkdown",
  "session.exportMarkdown",
  "session.compact",
  "view.priority",
])

/**
 * Whether a layer covers the conversation: MiMo's target for a conversation
 * command is empty while a dialog, the search, the palette or a preview is up.
 * Read from the page as well as from the flags above, so the search, the
 * palette and every confirmation count without a list of them to keep.
 */
function conversationCovered(): boolean {
  return modalOpen.value || searchOpen.value || dialogOpen()
}

/* The box MiMo's annotations go to: the open conversation's, or the home screen's. */
const annotationScope = computed(() => (isHome.value || !app.currentID ? HOME_SCOPE : app.currentID))
watch(annotationScope, (scope) => (mainAnnotationScope.value = scope), { immediate: true })

/**
 * Stops the browser opening a file the user let go of by accident.
 *
 * Only a file: a drag carrying words is left to the browser, so dropping a
 * phrase from a page into the box - or moving a selection inside it - inserts
 * it the way it does anywhere else. Swallowing every drop made both do nothing.
 */
function swallowDrop(event: DragEvent) {
  if (acceptsDrop(event.dataTransfer?.types)) event.preventDefault()
}

function onKeydown(event: KeyboardEvent) {
  const platform = app.platform
  // MiMo's `mod`: Command on a Mac and Ctrl elsewhere, never the two folded together.
  const mod = modHeld(event, platform)
  // Read by where the key sits: with Option held a Mac types another character.
  const letter = (keyOfCode(event.code) ?? event.key).toLowerCase()
  if (event.isComposing || event.keyCode === 229) return

  /* New task runs over whatever is on screen, clearing it first, as MiMo's does; the rest stays put behind a modal. */
  if (isNewTaskChord(chordOf(event, platform)) && !commandDisabled("session.new") && newTaskOverLayers()) {
    event.preventDefault()
    return
  }

  /*
   * A shortcut the user has re-bound wins over the built-in table, and is
   * looked up by the chord rather than by the key - which is what lets a
   * rebinding move an action onto a combination the table knows nothing about.
   */
  if (!modalOpen.value) {
    const chord = chordOf(event, platform)
    const bound = rebound.value.get(chord)
    if (bound) {
      const command = commands.value.find((entry) => entry.id === bound)
      if (command && command.enabled !== false) {
        if (TYPING_OFF.has(command.id) && typingIn(event.target)) return
        if (CONVERSATION_COMMANDS.has(command.id) && conversationCovered()) return
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
   * Control rather than Command: on a Mac, Cmd+Tab belongs to the system.
   */
  if (controlHeld(event) && !event.altKey && event.key === "Tab") {
    if (modalOpen.value) return
    event.preventDefault()
    void stepRecent(event.shiftKey ? -1 : 1)
    return
  }

  /* The side panel, on MiMo's chord and on every screen, as its title-bar button is; its review tab is Ctrl+Shift+G. */
  if (mod && event.altKey && letter === "b") {
    if (modalOpen.value) return
    event.preventDefault()
    toggleSidePanel()
    return
  }

  /* Pinning the open conversation, and copying the id of it. */
  if (mod && event.altKey && letter === "p") {
    if (conversationCovered() || !app.currentID) return
    event.preventDefault()
    app.togglePinned(app.currentID)
    return
  }

  /* Renaming and archiving the open conversation, on MiMo's chords. */
  if (mod && event.altKey && letter === "r") {
    if (conversationCovered() || !app.currentID || isHome.value) return
    event.preventDefault()
    renameInHeader()
    return
  }

  if (mod && event.altKey && letter === "a") {
    if (conversationCovered() || !app.currentID) return
    event.preventDefault()
    void archiveSessions([app.currentID])
    return
  }

  /* A side chat tab, on MiMo's chord. */
  if (mod && event.altKey && letter === "s") {
    if (conversationCovered()) return
    event.preventDefault()
    openSideChatTab()
    return
  }

  /* The priority filter, on MiMo's own chord. */
  if (mod && event.altKey && letter === "u") {
    if (conversationCovered()) return
    event.preventDefault()
    priorityFilter.value = !priorityFilter.value
    return
  }

  if (mod && event.altKey && letter === "c") {
    if (conversationCovered() || !app.currentID) return
    event.preventDefault()
    window.mcode.setClipboardText(app.currentID)
    notify(t("menu.copiedID"))
    return
  }

  if (mod && event.altKey && letter === "l") {
    if (conversationCovered() || !app.current) return
    event.preventDefault()
    copySessionLink()
    return
  }

  /* MiMo's terminal toggle is its `ctrl` chord: Control+` on a Mac as well. */
  if (controlHeld(event) && !event.altKey && !event.shiftKey && event.code === "Backquote") {
    if (modalOpen.value) return
    event.preventDefault()
    if (!commandDisabled("view.terminal")) terminalOpen.value = !terminalOpen.value
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
   * Ctrl+N would quietly start a session under the settings window.
   */
  if (modalOpen.value) return

  /*
   * Shift combinations first: they are separate commands, not variants, and a
   * handler table keyed on the bare letter cannot tell Ctrl+T from Ctrl+Shift+T.
   */
  /*
   * Find first, and only if a host will have it.
   *
   * `openFind` answers false when the chord was typed into a text field or when
   * no host wants it, and then Ctrl+F does nothing, as MiMo's does.
   */
  if (!event.shiftKey && event.key === "f" && openFind(event)) {
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
      g: openReviewTab,
      // The box, on MiMo's chord; Ctrl+L is the browser's address bar.
      l: () => composer.value?.focus(),
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
   * Ctrl and a digit opens the conversation in that slot of the side column's
   * visible order, the way MiMo does. The project in that position is Ctrl+Alt
   * and the digit.
   */
  if (/^[1-9]$/.test(event.key)) {
    const target = app.visibleChats[Number(event.key) - 1]
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
    // MiMo's files tab.
    p: openFilesTab,
    b: () => toggleSide(),
    ",": openSettings,
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
    // MiMo's annotate, while a browser tab is showing.
    ".": annotateBrowser,
    "[": back,
    "]": forward,
  }
  const handler = handlers[event.key]
  if (!handler) return
  // MiMo's back and forward alone stay out of text fields: the bracket is left to what is being typed.
  if ((event.key === "[" || event.key === "]") && typingIn(event.target)) return
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
  "new-session": () => void newTaskOverLayers(),
  back: () => void back(),
  forward: () => void forward(),
  "prev-session": () => void stepSession(-1),
  "next-session": () => void stepSession(1),
  "prev-project": () => void stepProject(-1),
  "next-project": () => void stepProject(1),
  "open-project": () => void browse(),
  settings: openSettings,
  terminal: () => (terminalOpen.value = !terminalOpen.value),
  sidebar: () => toggleSide(),
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
  j: "view.bottom",
  "[": "app.back",
  "]": "app.forward",
}

/* MiMo's only two commands marked off in form fields (`formTags: false`). */
const TYPING_OFF = new Set(["app.back", "app.forward"])

/** A form field or editable text, where MiMo leaves those two chords to the typing. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
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

/*
 * MiMo's task notifications.
 *
 * A turn that ends normally - not stopped, not failed - in any conversation says
 * the task finished, and a permission or a question arriving for any
 * conversation says it needs a confirmation. The main process titles them
 * "project · conversation" and drops them while the window is in front. They are
 * silent only when this app made a sound of its own instead: a finish past a
 * minute with the chime on, or a confirmation whose two-tone cue was heard. A
 * long finish in the conversation on screen is held while it stays there, and
 * sent once it is left.
 *
 * MiMo has no switch for either notice, and neither does this.
 */
const chimeOn = () => chimeOf(app.config?.taskDoneSound) !== "off"

function noticeAbout(sessionID: string) {
  const session = app.sessions.find((entry) => entry.id === sessionID)
  return {
    sessionID,
    title: session ? sessionTitle(session.title) : undefined,
    project: session && projectOf(session) ? projectName(projectOf(session)!, app.config?.projectNames) : undefined,
  }
}

function watching(sessionID: string) {
  return app.currentID === sessionID && !isHome.value && !document.hidden
}

const heldNotices = new Set<string>()
/* automation: whether the completion chime played for a scheduled run, so its own notice does not sound a second time. */
const automationChimed = new Map<string, boolean>()

function flushNotices() {
  for (const sessionID of [...heldNotices]) {
    if (watching(sessionID)) continue
    heldNotices.delete(sessionID)
    window.mcode.taskNotice({ kind: "done", ...noticeAbout(sessionID), silent: true })
  }
}

/* Leaving the window sends what was held; coming back re-reads the machine's zone (a formatter keeps the one it was built with). */
document.addEventListener("visibilitychange", () => {
  flushNotices()
  if (!document.hidden) refreshDateFormatters()
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
    /*
     * Beyond MiMo, whose thread says nothing as a turn ends: a screen reader
     * hears it, with the conversation's name when it is not the one on screen.
     * A subagent's own turns are left to the notice below.
     */
    const done = t("notify.done")
    if (app.currentID === turn.sessionID) announce(done)
    else if (about.title !== undefined) announce(`${about.title} · ${done}`)
    /*
     * automation: a scheduled task's run is told about by its own policy,
     * below - but the chime above has already played for it, so whether it did
     * is carried across. Every other notice here passes `silent: chiming` for
     * the same reason; the run's notice passed `silent: false` and a long
     * scheduled run therefore both chimed and sounded the system notification.
     */
    if (app.automationRuns.has(turn.sessionID)) {
      automationChimed.set(turn.sessionID, chiming)
      return
    }
    if (chiming && watching(turn.sessionID)) {
      heldNotices.add(turn.sessionID)
      return
    }
    window.mcode.taskNotice({ kind: app.answeredAnother.has(turn.sessionID) ? "chat" : "done", ...about, silent: chiming })
  },
)

/*
 * A background subagent of the conversation on screen finishing, said to a
 * screen reader: the 子智能体 tab changes without a word otherwise.
 */
const SUBAGENT_OUTCOME = { success: "subagents.status.completed", failure: "subagents.status.error", cancelled: "subagents.status.rejected" } as const
const subagentRunning = new Map<string, boolean>()

watch(
  () => app.subagentSessions.map((session) => ({ session, running: session.subagent?.status === "running" })),
  (entries) => {
    // Subagents come and go with their parent; what is no longer in the list
    // has nothing left to announce, so its last state is dropped with it.
    const live = new Set(entries.map(({ session }) => session.id))
    for (const id of subagentRunning.keys()) if (!live.has(id)) subagentRunning.delete(id)
    for (const { session, running } of entries) {
      const was = subagentRunning.get(session.id)
      subagentRunning.set(session.id, running)
      const outcome = session.subagent?.outcome
      if (!was || running || !session.subagent?.background || !outcome) continue
      if (app.rootOf(session.id) !== app.currentID) continue
      announce(`${session.title || t("subagentActivity.fallbackName")} · ${t(SUBAGENT_OUTCOME[outcome])}`)
    }
  },
)

/*
 * automation: MiMo tells the user about a scheduled task's run when the task's
 * notification policy says to, failures included.
 *
 * `session.idle` always reaches this window before the run's own end does - the
 * backend settles the run on that very event - so whether the completion chime
 * played for this conversation is already known by the time the notice lands.
 * A run with no record of a chime never had one.
 */
watch(
  () => app.automationNotice,
  (notice) => {
    if (!notice) return
    const chimed = automationChimed.get(notice.sessionID) === true
    automationChimed.delete(notice.sessionID)
    window.mcode.taskNotice({ kind: notice.failed ? "failed" : "done", ...noticeAbout(notice.sessionID), silent: chimed })
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
    /*
     * The two-tone cue first, then the notice - and the notice is silent only
     * because the cue was heard. Not bounded by the long-task threshold, as
     * MiMo's is not: a question is waiting however quickly it arrived.
     */
    const cued = chimeOn() && confirmChime()
    window.mcode.taskNotice({ kind: "confirm", ...noticeAbout(entry.sessionID), silent: cued })
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
    // Logged; MiMo makes no sound and sends no notification for a failure.
    recordLog("ERROR", message)
  },
)

/**
 * The projects a digit can reach, ordered the way the home screen orders them:
 * whichever was worked on most recently is Ctrl+1.
 */
const openProjects = computed(() => app.projects)

/** Steps the session's agent, wrapping - there are only ever a handful. */
async function cycleAgent(by: 1 | -1) {
  // One target for the write and the announcement, so a switch mid-flight
  // cannot retarget the choice.
  const target = app.currentID
  const current = app.current?.agent ?? app.config?.agent ?? "build"
  const at = AGENT_NAMES.indexOf(current)
  const next = AGENT_NAMES[(at + by + AGENT_NAMES.length) % AGENT_NAMES.length]
  if (!next) return
  const before = app.modeOf(target)
  await app.setAgent(next, target)
  app.announceMode(before, target)
}

/**
 * And the reasoning effort: MiMo's one app-wide level, cycled through the
 * steps the model in use has and wrapping at the end.
 */
async function cycleEffort() {
  /*
   * The steps this model has, not all five: the pill beside it now offers only
   * those, and a keyboard that could still reach a sixth would be the pointer
   * and the keyboard disagreeing about what the control is. A model with no
   * steps at all draws no pill and this does nothing.
   */
  // The optional id is the conversation that owned the keypress, so a switch mid-await cannot retarget it.
  const target = app.currentID
  const variants = findModel(app.providers, app.shownModel(app.current?.model) ?? app.config?.model)?.variants ?? []
  const next = cycleVariant(variants, app.current?.effort ?? app.config?.effort)
  if (next) await app.setEffort(next, target)
}

/** MiMo's decrease and increase rows: one step along this model's efforts, stopping at either end. */
async function stepEffort(by: 1 | -1) {
  // The optional id is the conversation that owned the keypress, so a switch mid-await cannot retarget it.
  const target = app.currentID
  const variants = findModel(app.providers, app.shownModel(app.current?.model) ?? app.config?.model)?.variants ?? []
  if (!variants.length) return
  const current = app.current?.effort ?? app.config?.effort
  const at = current ? variants.indexOf(current) : -1
  const next = at === -1 ? variants[0] : variants[at + by]
  if (next && next !== current) await app.setEffort(next, target)
}

let offMenu: (() => void) | undefined
let offZoom: (() => void) | undefined
let offZoomResize: (() => void) | undefined
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
  // A drag the system took over never sends `dragend`; the next press is when the app knows it is over.
  window.addEventListener("pointerdown", endDrag, true)
  window.addEventListener("keydown", onKeydown)
  window.addEventListener("keyup", endRecentWalk)
  window.addEventListener("blur", forgetRecentWalk)
  // MiMo re-reads the working tree whenever its window comes back; the review tab reads on this.
  window.addEventListener("focus", app.bumpFsNonce)
  schemeQuery.addEventListener("change", onSchemeChange)
  offMenu = window.mcode.onMenu(runMenuCommand)
  // Every measurement in this window is re-taken on a resize and on nothing else; see the module.
  offZoomResize = followZoom()
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

  if (app.currentID) view.value = "session"

  // MiMo opens again on the conversation whose draft was on screen when the app closed.
  const draftScreen = restoredDrafts.current?.startsWith("main:") ? restoredDrafts.current.slice("main:".length) : undefined
  if (!draftScreenRestored && draftScreen && !app.currentID && drafts.has(`main:${draftScreen}`) && app.sessions.some((session) => session.id === draftScreen)) {
    draftScreenRestored = true
    await app.open(draftScreen).catch(() => undefined)
  }

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
  window.removeEventListener("pointerdown", endDrag, true)
  window.removeEventListener("drop", swallowDrop)
  window.removeEventListener("keydown", onKeydown)
  window.removeEventListener("keyup", endRecentWalk)
  window.removeEventListener("blur", forgetRecentWalk)
  window.removeEventListener("focus", app.bumpFsNonce)
  schemeQuery.removeEventListener("change", onSchemeChange)
  offMenu?.()
  offZoom?.()
  offZoomResize?.()
  offQuitHint?.()
})
</script>

<template>
  <div class="app" :data-platform="app.platform || undefined">
    <!-- MiMo's one title-bar button on the right, on every screen: the side panel. -->
    <button
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
        /* The side panel expanded over the main column. */
        'panel-full': rp.open && rp.fullscreen,
      }"
    >
      <!-- MiMo's per-region boundaries: a region that fails to render shows its own strip. -->
      <ErrorBoundary :reset-key="view">
      <Sidebar
        :collapsed="!leftPanel"
        :page="view"
        :priority="priorityFilter"
        :can-back="canGoBack"
        :can-forward="canGoForward"
        :width="sideWidth"
        @resize="resizeSide"
        @toggle-priority="priorityFilter = !priorityFilter"
        @archive-all="archiveAll"
        @newTask="newTaskFromSide"
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
        @toggle="toggleSide"
        @browse="browse"
        @dropFolders="addDroppedProjects"
        @open="openFromSide"
        @openSubagents="openSubagentsFromSide"
        @rename="renameFromSide"
        @createIn="newSessionIn"
        @settings="openSettings"
      />
      </ErrorBoundary>

      <main ref="mainPane" class="main" :class="{ 'info-open': infoInline, 'info-shown': infoShowing, beside: panelBeside }">
        <ErrorBoundary :reset-key="`${view}:${app.currentID ?? ''}`">
        <!--
          No bar across the top of the column while a turn runs. This used to
          draw a sweeping blue 2px line there; the user looked at it on
          2026-09-24 and had it taken out. A running turn already says so in
          the transcript, in the composer's stop button and in the side column.
        -->
        <!--
          Ahead of everything else: if the backend never opened there is no
          project, no session and no stream, so none of the usual places an
          error can appear exist yet.
        -->
        <!-- Boot failures only: a drop after boot keeps the view, and the reconnect notice escalates instead. -->
        <div v-if="app.error" class="boot">
          <p class="boot-msg">{{ app.error }}</p>
          <button class="boot-retry" @click="retry">{{ t("common.retry") }}</button>
        </div>

        <ArtifactsView v-else-if="isArtifacts" @open="openFromArtifacts" />

        <PluginsView v-else-if="isPlugins" @manage="openSettings('mcp')" @try-skill="trySkill" @configure-skill="configureSkill" />

        <HomeHero
          v-else-if="isHome"
          ref="homeHero"
          :directory="homeDirectory"
          @directory="(directory?: string) => (homeShellDirectory = directory)"
          @open-settings="openSettings"
          @connect="connectOpen = true"
          @shell="runShellCommand"
          @terminal="terminalOpen = true"
        />

        <template v-else>
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
            ref="sessionHeader"
            :info-open="infoShowing"
            :bottom-open="terminalUp"
            :side-collapsed="!leftPanel"
            :panel-beside="panelBeside"
            :has-content="!empty"
            :menu-open="Boolean(sessionMenu?.header)"
            @info="toggleInfo"
            @menu="(x, y) => (sessionMenu = { x, y, header: true })"
            @bottom="terminalOpen = !terminalOpen"
          />

          <SessionHero v-if="empty" />
          <MessageStream v-else ref="stream" @click="onThreadClick" />
          <SessionSpine v-if="!empty" :scroller="stream?.scroller" />
          <!-- MiMo's boundaries inside the page: the info panel, and the composer's dock zone, each apart from the transcript. -->
          <ErrorBoundary :reset-key="app.currentID ?? ''">
          <InfoPanel
            :visible="infoShowing"
            :floating="infoFloating"
            :bottom-inset="terminalUp ? drawerHeight : 0"
            @close="closeInfo"
          />
          </ErrorBoundary>

          <!--
            The dock, which is the same region in every state a session can be
            in. It used to be handed to the hero as a slot, and the hero stripped
            the padding and the fill off it, so the box someone types into was
            one shape on an empty session and another the moment they sent - and
            the composer was torn down and rebuilt on that first message.
          -->
          <!-- MiMo's confirm dock: the first undecided permission or question, in arrival order. -->
          <ErrorBoundary :reset-key="app.currentID ?? ''">
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
          <Teleport :to="floatingComposer ? '#float-dock' : empty ? '#hero-dock' : '#main-dock'">
            <Composer
              ref="composer"
              :resizable="!floatingComposer"
              @open-settings="openSettings"
              @connect="connectOpen = true"
              @shell="runShellCommand"
              @terminal="openTerminalTab"
            />
          </Teleport>
          </ErrorBoundary>
        </template>

        <!--
          MiMo's home screen keeps the bottom panel's button at the end of the
          main column's title row (a conversation has its own in the header):
          4px before the side panel toggle, or at the column's end once a panel
          stands beside it. After the home strip in the document, so its no-drag
          wins over that strip's drag. Unlit when pressed, as MiMo's is.
        -->
        <button
          v-if="isHome"
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
        <!--
          The drawer styles bp-enter/leave itself. Deliberately unkeyed: MiMo
          keeps one bottom panel whose tabs outlive the view, so stepping from
          the home screen into a conversation must not remount it. It used to
          be keyed by view and folder, which threw the tab list away - a dev
          server started at home vanished from the drawer the moment a
          conversation opened, still running with nothing attached to it. The
          drawer already answers a change of folder by itself: an untouched
          terminal is restarted in the new one and a used one gets MiMo's
          notice above it.
        -->
        <Transition name="bp">
          <TerminalDrawer
            v-if="terminalUp"
            ref="drawer"
            :sessionID="isHome ? undefined : app.currentID"
            :directory="isHome ? homeShellDirectory : undefined"
            @close="terminalOpen = false"
            @height="(px: number) => (drawerHeight = px)"
          />
        </Transition>

        <!-- MiMo's drop overlay over the main column; the drop itself is the composer's. -->
        <div v-if="fileDrag" class="drop-overlay" data-drop-overlay aria-hidden="true">
          <div class="drop-card">{{ t("composer.dropOverlay") }}</div>
        </div>
        </ErrorBoundary>
      </main>

      <!-- Floats over the pane, so opening it neither reflows nor shortens it. -->
      <FindBar :find="find" :anchor="() => mainPane" />

      <!-- MiMo's annotation box, for a selection in a reply or the files tab's code, or a whole file. -->
      <!-- The video preview is the one modal the box works over: its boxed regions are annotated with it. -->
      <AnnotationComposer :scope="annotationScope" :disabled="modalOpen && !videoPreview" />
      <AnnotationMarkers :mainScope="annotationScope" :disabled="modalOpen" />

      <!-- MiMo's right panel: tabs beside the conversation, or its launcher while it holds none. -->
      <ErrorBoundary :reset-key="app.currentID ?? ''">
      <RightPanel
        ref="rightPanel"
        :sessionID="isHome ? undefined : app.currentID"
        :directory="panelDirectory"
        :browserAllowed="browserAllowed"
        :sidebarWidth="leftPanel ? sideWidth : 0"
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

    <SearchOverlay
      v-if="searchOpen"
      ref="searchOverlay"
      @close="searchOpen = false"
      @open="openFromSearch"
      @project="startIn"
    />

    <!-- MiMo's settings boundary: a page that fails to draw shows its strip, not the fatal page. -->
    <ErrorBoundary v-if="settingsOpen" :reset-key="settingsSection">
    <SettingsDialog
      ref="settingsDialog"
      :section="settingsSection"
      :commands="bindableCommands"
      :update-checking="updateChecking"
      :update-ready="downloadedUpdate"
      @close="settingsOpen = false"
      @check-updates="checkForUpdates"
    />
    </ErrorBoundary>

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
  <ConnectDialog v-if="connectOpen" :group="connectGroup" @close="(connectOpen = false), (connectGroup = undefined)" />
  <ImagePreview />
  <VideoPreview />

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
  <div v-if="!leftPanel" class="rail-no-drag" :data-platform="app.platform || undefined" aria-hidden="true" />
  <!-- MiMo's exit-full-screen button: Windows only, where full screen hides the overlay caption buttons. -->
  <button
    v-if="app.platform === 'win32' && fullScreen"
    type="button"
    class="exit-fs"
    data-exit-fullscreen
    :title="t('side.exitFullscreen')"
    :aria-label="t('side.exitFullscreen')"
    @click="exitFullScreen"
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  </button>
  <div class="toggles-no-drag" aria-hidden="true" />
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

/* The window itself is the darker frame the workspace is set into. */
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--surface-base);
}

/*
 * One flush plane, not cards floating on a frame.
 *
 * MiMo's `<main>` is `flex min-w-0 flex-1 flex-col overflow-hidden bg-panel
 * shadow-[var(--shadow-panel)]` with no margin, no radius and no gutter, and
 * `--shadow-panel` is `none` in both schemes - so the workspace never lifts off
 * the window at all. What divides it from the side column is a single hairline:
 * main carries `border-left: 1px solid var(--color-line-soft)`, and the side
 * panel beyond it carries its own leading border. The only rounding left
 * anywhere is the side panel's own full-screen state.
 */
.body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}

/*
 * The conversation's plane, flush to the column beside it. The hairline is
 * MiMo's `--color-line-soft` - fainter than the lines inside the panel, because
 * it separates two surfaces rather than two rows.
 */
.body > .main {
  overflow: hidden;
  background: var(--surface-raised);
  border-inline-start: 1px solid var(--border-muted);
}

/* The docked terminal keeps the height it was dragged to; the transcript gives way. */
.main > .drawer {
  flex: none;
}

.main {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  /*
   * MiMo's main column has no floor of its own: the side column and the panel
   * are sized to leave it 480, and when the window is too narrow for that
   * beside the panel's 300, the conversation is what narrows, so nothing is
   * pushed past the window's edge.
   */
  min-width: 0;
}

/* The composer's ordinary dock; `contents` keeps it out of the layout. */
.main-dock {
  display: contents;
}

/*
 * The folded column's controls - the toggle and 新建任务 - float over the
 * start of the main column, and the main column's own top strip (the
 * home screen's, or the conversation header) is a window drag region. Electron
 * works drag regions out in document order, so that strip, coming later, took
 * the buttons back into the title bar and Windows swallowed every click on
 * them. This patch is the last thing in the document, so its no-drag wins; it
 * takes no pointer events, so the clicks still land on the buttons beneath.
 */
/*
 * MiMo's exit-full-screen button: 26 square and 7 round, 20 in from the start
 * edge and centred on the 44px controls row, over the side column's own row.
 * Its 16px glyph is the four inward corners.
 */
.exit-fs {
  position: fixed;
  top: 9px;
  inset-inline-start: 20px;
  z-index: 205;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-weak);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.exit-fs:hover {
  color: var(--text-strong);
  background: var(--surface-hover);
}

/* It lies outside .app, last in the document, so it carries the platform itself. */
.rail-no-drag:not([data-platform="darwin"]) {
  inset-inline-start: 18px;
}

.rail-no-drag {
  position: fixed;
  top: 13px;
  inset-inline-start: 98px;
  z-index: 1;
  width: 56px;
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

/*
 * The information panel is inset into this same column rather than being a
 * column of its own, so an overlay at `inset: 0` covered it too. It stops where
 * the conversation stops, as MiMo's does.
 */
.main.info-open .drop-overlay {
  inset-inline-end: v-bind(infoInset);
}

/* MiMo's card: its page ground (#fffefd, #181818 dark below) under the composer's shadow, not the dialog lift. */
.drop-card {
  padding: 10px 18px;
  color: #ff6a2b;
  background: #fffefd;
  border-radius: 12px;
  box-shadow:
    0 1px 2px #0000000d,
    0 6px 18px #0000001b;
  font-size: calc(14px * var(--ui-font-scale, 1));
  font-weight: 500;
}

:root[data-theme="dark"] .drop-card {
  background: #181818;
  box-shadow: 0 1px 3px #0006;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .drop-card {
    background: #181818;
    box-shadow: 0 1px 3px #0006;
  }
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

/*
 * MiMo moves the find bar clear of the card: 20 plus its own width.
 *
 * Keyed on `info-open`, not `info-shown`. `info-shown` is true in both modes,
 * and a floating card takes no width at all - so on a narrow window the bar was
 * pushed 310 in from a pane only about 460 wide and ran out over the side
 * column (R25-D3). The width comes from the same binding every other consumer
 * uses, so it cannot drift from INFO_PANEL_WIDTH on its own.
 */
.main.info-open ~ [data-find-bar] {
  margin-inline-end: v-bind(infoInset);
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

/*
 * MiMo on Windows: every title-bar glyph 12px in its Windows title-bar colour,
 * #2b2b2b on light and #ececec on dark, kept on hover and while pressed.
 */
.app[data-platform="win32"] .side-panel-toggle,
.app[data-platform="win32"] .home-bottom:not(:disabled) {
  color: #2b2b2b;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .app[data-platform="win32"] .side-panel-toggle,
  :root:not([data-theme="light"]) .app[data-platform="win32"] .home-bottom:not(:disabled) {
    color: #ececec;
  }
}

:root[data-theme="dark"] .app[data-platform="win32"] .side-panel-toggle,
:root[data-theme="dark"] .app[data-platform="win32"] .home-bottom:not(:disabled) {
  color: #ececec;
}

.app[data-platform="win32"] .side-panel-toggle svg,
.app[data-platform="win32"] .home-bottom svg {
  width: 12px;
  height: 12px;
}

/*
 * MiMo warms its light theme on Windows and Linux, and only there:
 * `html:not([data-theme=dark]) #app.plat-win32, ... #app.plat-linux` sets a
 * warm-grey side column (#f8f7f5) against the white main plane, with warm
 * lines (#f0ebe5) instead of neutral ones. macOS keeps the neutral set, and
 * dark is untouched in every platform.
 *
 * MiMo's block also resets the hover and selected washes, but R21-F1 measured
 * those two off its root and they are the same #f1f0ec / #eeedec there, so
 * repeating them here only restated the default on two platforms.
 *
 * Written as the positive light condition rather than `:not(dark)`, and hung on
 * `.app` rather than `:root`: the palette is written inline onto <html> at boot,
 * so only a rule matching a descendant of it can win.
 */
:root[data-theme="light"] .app[data-platform="win32"],
:root[data-theme="light"] .app[data-platform="linux"] {
  --surface-base: #f8f7f5;
  --border-weak: #f0ebe5;
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) .app[data-platform="win32"],
  :root:not([data-theme="dark"]) .app[data-platform="linux"] {
    --surface-base: #f8f7f5;
    --border-weak: #f0ebe5;
  }
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
