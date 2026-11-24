import { registerMacOSControl } from "./macctl"
import fs from "node:fs/promises"
import { existsSync, readFileSync, renameSync } from "node:fs"
import { execFile, execFileSync, spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, clipboard, crashReporter, ipcMain, dialog, shell, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, screen, Tray, Menu, session, systemPreferences, type Rectangle } from "electron"
import { PowerHold } from "./power"
import { PRUNE_DELAY_MS, pruneCrashDumps, startLocalCrashDumps } from "./crash-dumps"
import { refreshEnvironment } from "./shell-env"
import { applyRuntimeEnv, bundledRuntimeEnv } from "./runtimes"
import { DailyLog, LOG_DIR } from "./log-file"
import { BOOT_DEFAULTS, BOOT_PREFS_FILE, inspectBootPrefsText, readBootPrefs, themePref, windowBackground, writeBootPrefs, type BootPrefs } from "./boot-prefs"
import { startBackend, type Backend } from "../server/index"
import { startRemoteGateway, type RemoteGateway } from "../server/remote/gateway"
import { loadOrCreateToken } from "../server/remote/token"
import { rendererOrigins } from "../server/socket-guard"
import { safeStorageBox } from "./safe-storage"
import { workingRoots } from "../server/file-access"
import { insideReal } from "../server/tool/fs-util"
import { setImageShrinker } from "../server/provider/attachment-parts"
import { shrinkImage } from "./image-shrink"
import { scratchRoot } from "../server/scratch"
import { wakeWaiters } from "../server/session/retry"
import { setMachineLocale } from "../server/session/locale"
import { cutLiveStreams } from "../server/provider/stall"
import { LINK_SCHEME, linkInArgs, parseSessionLink } from "@shared/session-link"
import { closeHidesToTray } from "@shared/protocol"
import { label, setLabels } from "./labels"
import { sweepWriterTemps, writeAtomicSync } from "./atomic-write"
import { LOGIN_ITEM_FILE, loginItemSupported, parseLoginItem, readLaunchAtLogin, startsHidden, writeLaunchAtLogin, type LoginItemStore } from "./login-item"
import { USER_VERIFY_FILE, UserVerifySession, checkUserVerifyAvailable, parseUserVerifyPref, renderUserVerifyPref, userVerifySupported, type UserVerifyAvailability, type UserVerifyRunner } from "./user-verify"
import { BROWSER_ACTS, EDIT_ACTIONS, VIEW_ACTIONS, WINDOW_ACTIONS, actionOf, clipboardText, directoryAsk, panelBounds, titlebarMode } from "./ipc-input"
import { buildMenu, forgetQuitArm, requestAppQuit } from "./menu"
import { readMenuKeys, type MenuKeys } from "./menu-keys"
import { cancelPendingHide, claimDialog, dialogParent, hideWindow, micDecision, releaseDialog } from "./native-dialogs"
import { SHOW_FALLBACK_MS } from "./renderer-health"
import {
  activate,
  beginIntentionalQuit,
  captureConsole,
  currentWindow,
  markClosing,
  onRecoveryGaveUp,
  readyWindow,
  recordProcessError,
  relaunch,
  setRecoveryHost,
  wireProcessRecovery,
  wireRecovery,
} from "./recovery"
import { isKnownOpenWith } from "@shared/open-app"
import { installedDocApps, installedOpenAppIcons, installedOpenApps, launchTarget } from "./installed-apps"
import { DEFAULT_APP_ICON } from "@shared/app-icons"
import { SOUNDFONT } from "@shared/soundfont"
import { PICKER_BUSY } from "@shared/native-pick"
import { readOnlyInstall, type InstallAnswer } from "@shared/update-reason"
import { readSoundfont } from "./soundfont"
import { applyZoom } from "./zoom"
import { askForLocalNetwork } from "./local-network"
import { APP_NAME, WINDOW_MIN, badgeCount, noticeTitle, pinnedProfile, readTaskNotice, relaunchArgs, textMenuItems, wantsNotice } from "./desktop-rules"
import { registerOffice } from "./office"
import { COMPOSER_INPUT_FILE, registerComposerInput } from "./composer-input"
import { registerPasteFiles } from "./paste-files"
import { saveCopy } from "./save-copy"
import {
  DISPLAY_SERVER_FILE,
  displayServerPref,
  displaySwitches,
  ozonePlatform,
  readDisplayServerFile,
  type DisplayServerPref,
} from "./display-server"
import { registerMediaEmbeds } from "./media-embed"
import {
  act,
  clearBrowsingData,
  clearSiteData,
  closeTab,
  navigate,
  newTab,
  openPanel,
  panelState,
  screenshot,
  selectTab,
  setBounds,
} from "./browser"
import { captionOverlay, refreshTitlebar, setTitlebarMode } from "./titlebar"
import { EXECUTABLE_REFUSAL, isBundleProgram, isProgram } from "./paths"
import { fcitxEnvironment } from "./linux-ime"
import { linuxIconSync } from "./linux-icon-sync"
import { WINDOW_STATE_FILE, maximizeAtStart, restore, saveWindowState, toggleMaximize, track } from "./window-state"
import { keepWindowsOnScreen, repaintAfterWake } from "./displays"
import { boundsOnShow, closeBounds } from "./work-area"
import { HELPER_SWEEP_TIMEOUT_MS, createUpdater, helperSweep, staleInstallers, type AutoUpdaterLike, type UpdateState, type Updater } from "./updater"
import { TRANSACTION_FILE, createTransactions, fileTransactionStore } from "./update-transaction"
import { deliveryOf, waitForDelivery } from "./install-notice"
import pkg from "../../package.json"

/*
 * The id Windows files this process's notifications under.
 *
 * It has to be the appId electron-builder writes onto the Start Menu shortcut
 * (electron-builder.yml), because that is how a toast finds a name and an icon
 * to show. Left at Electron's default, "electron.app.MCode", it matched nothing
 * the installer registered, and every notification was headed by that raw
 * string with a blank where the icon goes. The reference sets its own first
 * thing, the same way (`app.setAppUserModelId(appId)`). smoke holds this id
 * and the installer's to each other.
 *
 * An unpackaged run gets an id of its own, as the reference's does
 * ("ai.opencode.desktop.dev" beside its packaged ones). Sharing the installed
 * app's would group a development window under its taskbar button and head
 * its notifications with the installed app's name and icon.
 *
 * Windows only. Electron declares the call `@platform win32`, beside
 * setJumpList and setUserTasks; whether it exists as a no-op elsewhere cannot
 * be shown from here, and the macOS build must not find out at launch.
 */
const APP_ID = "dev.mcode.app"
if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`)

/*
 * The profile stays where every release kept it, and an unpackaged run keeps
 * one of its own (see pinnedProfile), before anything below reads it.
 */
const pinned = pinnedProfile(app.getPath("userData"), app.getPath("appData"), app.getName(), path.join, app.isPackaged)
if (pinned) app.setPath("userData", pinned)

/*
 * One running copy per profile, so a link clicked while the app is open lands
 * in that copy instead of starting a second one beside it. The lock is keyed on
 * the profile, and a development build has its own (pinnedProfile), so the two
 * run side by side. Packaged builds only, as MiMo skips it in development: a
 * development run is restarted by its tooling and must not find the one it
 * replaces still holding the lock.
 *
 * Taken as soon as the profile is known, as MiMo takes it (I13-6): a second
 * launch hands its arguments over and is gone before the log, the crash
 * reporter or the environment refresh (a login shell on macOS and Linux) start.
 * process.exit rather than app.exit, which only queues the exit and lets the
 * rest of this module run first.
 */
if (app.isPackaged && !app.requestSingleInstanceLock()) process.exit(0)

const here = path.dirname(fileURLToPath(import.meta.url))

/*
 * MiMo's 显示服务器 (Linux). Chromium takes these switches only before the app
 * is ready, so the choice is read here, as the module loads, from its own file.
 */
const displayServerFile = path.join(app.getPath("userData"), DISPLAY_SERVER_FILE)
let displayServer: DisplayServerPref = "auto"
if (process.platform === "linux") {
  try {
    displayServer = readDisplayServerFile(readFileSync(displayServerFile, "utf8"))
  } catch {
    // No file yet is 自动.
  }
  for (const entry of displaySwitches(process.platform, displayServer, process.env)) {
    if (entry.value === undefined) app.commandLine.appendSwitch(entry.name)
    else app.commandLine.appendSwitch(entry.name, entry.value)
  }
  /*
   * MiMo's: shared memory in /tmp rather than /dev/shm, which containers and
   * some distributions keep too small for Chromium. MiMo also passes
   * no-zygote; Chromium refuses that while its sandbox is on, so it waits for
   * a check on real Linux hardware (round10-platforms M10-12).
   */
  app.commandLine.appendSwitch("disable-dev-shm-usage")
  /*
   * The speak tool reads with the system's voices (lib/voice.ts). Chromium on
   * Linux reaches them only through speech-dispatcher, and only when asked to;
   * without it there are no voices and nothing is heard. Unverified on a
   * Linux machine (round10-platforms M10-28).
   */
  app.commandLine.appendSwitch("enable-speech-dispatcher")
}

/* MiMo's fcitx fill-in (see linux-ime.ts), before any window reads the environment. */
const imeFilled = fcitxEnvironment(process.platform, process.env, () => {
  try {
    return readFileSync(path.join(app.getPath("home"), ".xinputrc"), "utf8")
  } catch {
    return undefined
  }
})
Object.assign(process.env, imeFilled)

/*
 * MiMo's log files, opened as the module loads so that whatever is said on the
 * way up - Chromium switches, the backend starting, a failure to start - is on
 * disk. Old days are pruned here and on each day change.
 */
const logs = new DailyLog({ dir: path.join(app.getPath("userData"), LOG_DIR) })
captureConsole(logs)
if (Object.keys(imeFilled).length) console.info(`[linux-ime] filled in for fcitx: ${Object.keys(imeFilled).join(", ")}`)
app.on("will-quit", () => {
  void remoteGateway?.close()
  void logs.close()
})

/** MCode Remote's gateway, when the config's remote switch has it on. Closed on quit. */
let remoteGateway: RemoteGateway | undefined
process.on("uncaughtException", (error) => recordProcessError("uncaught exception", error))
process.on("unhandledRejection", (reason) => recordProcessError("unhandled rejection", reason))

/*
 * MiMo's local crash dumps: Crashpad writes a minidump for a native crash and
 * uploads nothing; ten seconds after launch the old ones are pruned.
 */
const crashFolder = startLocalCrashDumps({
  reporter: crashReporter,
  setCrashFolder: (folder) => app.setPath("crashDumps", folder),
  profile: app.getPath("userData"),
  log: (line) => console.info(line),
})
if (crashFolder) {
  void app.whenReady().then(() => {
    setTimeout(() => {
      const files = { readdir: (directory: string) => fs.readdir(directory, { withFileTypes: true }), stat: fs.stat, unlink: fs.unlink }
      void pruneCrashDumps(crashFolder, files).then((removed) => {
        if (removed.length) console.info(`[crash] pruned ${removed.length} old crash dump(s)`)
      })
    }, PRUNE_DELAY_MS).unref()
  })
}

/*
 * MiMo's environment refresh (shell-env.ts): the registry's or the login
 * shell's PATH and variables, before the backend, a terminal or a tool runs.
 */
const refreshed = refreshEnvironment({
  env: process.env,
  platform: process.platform,
  exec: (file, args, options) => execFileSync(file, args, options),
  development: Boolean(process.env.ELECTRON_RENDERER_URL),
  home: app.getPath("home"),
})
console.info(`[env] environment from ${refreshed.source}${refreshed.added.length ? `; added ${refreshed.added.join(", ")}` : ""}`)

/*
 * MiMo's bundled runtimes (runtimes.ts): Node.js, Python and ripgrep beside the
 * app, named to every child process. An unpackaged run looks in the repository.
 */
const runtimeNames = applyRuntimeEnv(
  process.env,
  bundledRuntimeEnv({
    resourcesDir: app.isPackaged ? process.resourcesPath : undefined,
    devDir: app.isPackaged ? undefined : path.join(here, "..", "..", "resources", "runtimes"),
    platform: process.platform,
    arch: process.arch,
    exists: existsSync,
  }),
)
if (runtimeNames.length) console.info(`[runtimes] bundled runtimes named in ${runtimeNames.join(", ")}`)

/*
 * MiMo's native theme at boot: the saved app theme is applied before any
 * window exists, so the first paint, the text context menu, the tray menu and
 * message boxes already match a dark app on a light system (and the reverse).
 */
const bootPrefsFile = path.join(app.getPath("userData"), BOOT_PREFS_FILE)
let bootPrefs: BootPrefs = { ...BOOT_DEFAULTS }
/** Set when boot-prefs.json could not be read or kept aside; nothing may be written over it. */
let bootPrefsBlocked: string | undefined
try {
  const text = readFileSync(bootPrefsFile, "utf8")
  const loaded = inspectBootPrefsText(text)
  if (loaded.corrupt) {
    let aside: string | undefined
    for (let attempt = 0; attempt < 4 && aside === undefined; attempt++) {
      const target = `${bootPrefsFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}${attempt ? `-${attempt}` : ""}`
      try {
        renameSync(bootPrefsFile, target)
        aside = target
      } catch (error) {
        if ((error as { code?: string } | undefined)?.code !== "EEXIST") break
      }
    }
    if (aside === undefined) {
      bootPrefsBlocked = `boot-prefs.json could not be read and could not be kept aside, so nothing is saved over it`
      console.warn("[boot-prefs] " + bootPrefsBlocked)
    } else {
      console.warn(`[boot-prefs] boot-prefs.json could not be read; kept as ${aside}`)
    }
  } else {
    bootPrefs = readBootPrefs(text)
  }
} catch (error) {
  if ((error as { code?: string } | undefined)?.code !== "ENOENT") {
    bootPrefsBlocked = `boot-prefs.json could not be read (${error instanceof Error ? error.message : String(error)}), so nothing is saved over it`
    console.warn("[boot-prefs] " + bootPrefsBlocked)
  }
  // No file yet: follow the system.
}
nativeTheme.themeSource = bootPrefs.theme

/* MiMo's 硬件加速: Chromium only takes this before ready, so a change waits for the next launch. */
if (!bootPrefs.hardwareAcceleration) app.disableHardwareAcceleration()

/* 开机自启 without an OS entry to ask (a development build): the choice alone, in a file of its own. */
const loginItemFile = path.join(app.getPath("userData"), LOGIN_ITEM_FILE)
/** Set when login-item.json could not be read; nothing may be written over it. */
let loginItemBlocked: string | undefined
const loginItemStore: LoginItemStore = {
  read: () => {
    try {
      return parseLoginItem(readFileSync(loginItemFile, "utf8"))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
      loginItemBlocked =
        "login-item.json could not be read, so nothing is saved over it until it is fixed or removed."
      console.warn("[login-item] could not be read:", err instanceof Error ? err.message : err)
      return false
    }
  },
  write: (enabled) => {
    if (loginItemBlocked) {
      console.warn("[login-item] not saving:", loginItemBlocked)
      return
    }
    try {
      writeAtomicSync(loginItemFile, JSON.stringify({ openAtLogin: enabled }))
    } catch (err) {
      console.warn("[login-item] the choice could not be saved:", err instanceof Error ? err.message : err)
    }
  },
}

/*
 * Windows Hello as a reveal gate (user-verify.ts): an extra UI unlock in front
 * of showing credentials, never a replacement for DPAPI, which still seals
 * them. Off unless turned on, and Windows only - there is no Hello elsewhere.
 */
const userVerifyFile = path.join(app.getPath("userData"), USER_VERIFY_FILE)
let userVerifyRequireGate = false
try {
  userVerifyRequireGate = parseUserVerifyPref(readFileSync(userVerifyFile, "utf8"))
} catch {
  // No file yet: the gate is off.
}
const userVerifySession = new UserVerifySession()
/** What Hello said the last time it was asked; asked once, since a device does not appear mid-session. */
let userVerifyAvailable: UserVerifyAvailability | undefined

/*
 * The only way to reach WinRT's UserConsentVerifier from here. Unused off
 * Windows, where the handlers answer unsupported before it is ever called.
 */
const userVerifyRunner: UserVerifyRunner = {
  run: (script) =>
    new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { windowsHide: true, timeout: 120000 },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })
        },
      )
    }),
}

/*
 * Started by the login item on Windows: the window is made but not shown, as
 * MiMo keeps it in the tray. The tray setting is only known once the window
 * has read the settings, so should it be off the window is shown after all
 * (see mcode:tray) - there would be no other way to reach it.
 */
let hiddenAtLogin = startsHidden(process.platform, process.argv)

/* Written for the next launch; a failed write only means the next boot uses the old choice. */
function saveBootPrefs(patch: Partial<BootPrefs>): void {
  bootPrefs = { ...bootPrefs, ...patch }
  if (bootPrefsBlocked) {
    console.warn("[boot-prefs] not saved: " + bootPrefsBlocked)
    return
  }
  try {
    writeAtomicSync(bootPrefsFile, writeBootPrefs(bootPrefs))
  } catch (error) {
    console.warn("[boot-prefs] not saved", error)
  }
}

let backend: Backend | undefined
/*
 * The same backend before it has finished starting. `backend` is only assigned
 * once startBackend resolves, and MCP's stdio children are already being
 * spawned well before that - so a quit inside the start window used to skip the
 * whole teardown and orphan them (N11-30).
 */
let startingBackend: Promise<Backend> | undefined

const windows = new Set<BrowserWindow>()
const loadedWindows = new WeakSet<BrowserWindow>()
let credentialUnlockFallback: ReturnType<typeof setTimeout> | undefined
let credentialUnlockStarted = false

function unlockStartupCredentials() {
  if (!backend || credentialUnlockStarted || leaving()) return
  credentialUnlockStarted = true
  clearTimeout(credentialUnlockFallback)
  void backend.credentials.unlock().catch(() => console.error("[boot] credential initialization failed"))
}

function unlockAfterWindowShow() {
  if (!backend || credentialUnlockStarted) return
  const visible = () => [...windows].some((window) => !window.isDestroyed() && window.isVisible() && loadedWindows.has(window))
  if (!visible()) return
  // Give the compositor a turn after show and let did-finish-load clear
  // the startup watchdog before a synchronous system prompt can block us.
  setTimeout(() => {
    if (visible()) unlockStartupCredentials()
  }, 50)
}

/* MiMo's update transaction record (update-transaction.ts), in the profile's updates folder. */
const transactionFile = path.join(app.getPath("userData"), "updates", TRANSACTION_FILE)
const updateTransactions = createTransactions(fileTransactionStore(transactionFile))

/*
 * Temps a killed write of an earlier run left beside main's own files (D12-7):
 * each folder is listed with the files written into it, and only their temps
 * whose process is gone are taken. The backend sweeps the rest of storage/.
 */
void app.whenReady().then(async () => {
  const profile = app.getPath("userData")
  const swept = [
    ...(await sweepWriterTemps(profile, { names: [BOOT_PREFS_FILE, DISPLAY_SERVER_FILE, LOGIN_ITEM_FILE, USER_VERIFY_FILE, WINDOW_STATE_FILE] })),
    ...(await sweepWriterTemps(path.dirname(transactionFile), { names: [TRANSACTION_FILE] })),
    ...(await sweepWriterTemps(path.join(profile, "storage"), { names: [COMPOSER_INPUT_FILE], pidOnly: [COMPOSER_INPUT_FILE] })),
  ]
  if (swept.length) console.info(`[storage] removed ${swept.length} temp file(s) an earlier run left behind: ${swept.join(", ")}`)
})

/* An install the person asked for, run by the quit path once the backend has closed. */
let pendingInstall: (() => void) | undefined
function runPendingInstall() {
  const run = pendingInstall
  pendingInstall = undefined
  run?.()
}

/*
 * N9-16: installers an earlier update left behind - the old updater's copies
 * in the temporary folder, and electron-updater's pending installer once that
 * version (or a newer one) is running. The cache folder is electron-updater's,
 * named in app-update.yml; its installer.exe (the base for the next
 * differential download) is kept.
 */
async function removeStaleInstallers() {
  const temp = app.getPath("temp")
  const cacheRoot =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local")
      : process.platform === "darwin"
        ? path.join(app.getPath("home"), "Library", "Caches")
        : process.env.XDG_CACHE_HOME || path.join(app.getPath("home"), ".cache")
  const pending = path.join(cacheRoot, `${pkg.name}-updater`, "pending")
  const names = await fs.readdir(temp).catch(() => [] as string[])
  const info = await fs
    .readFile(path.join(pending, "update-info.json"), "utf8")
    .then((text) => JSON.parse(text) as { fileName?: unknown })
    .catch(() => ({}) as { fileName?: unknown })
  const stale = staleInstallers({ tempNames: names, pendingFile: typeof info.fileName === "string" ? info.fileName : undefined, currentVersion: pkg.version })
  for (const name of stale.temp) await fs.rm(path.join(temp, name), { force: true }).catch(() => {})
  if (stale.pending) await fs.rm(pending, { recursive: true, force: true }).catch(() => {})
  if (stale.temp.length || stale.pending) console.info(`[update] removed ${stale.temp.length} old installer(s)${stale.pending ? " and the installed pending update" : ""}`)
}

/*
 * A session link that arrived before a window could show it: the one the app
 * was started with, or one handed over while it was still starting. The window
 * asks for it once it has connected.
 */
let pendingLink: string | undefined = linkInArgs(process.argv)

/*
 * MiMo's raise: a moment always on top around the show, because Windows' focus
 * rules otherwise leave a window called up from a notification behind whatever
 * has the foreground. Any taskbar flash is spent once the window is up.
 */
function raise(window: BrowserWindow) {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.setAlwaysOnTop(true)
  window.show()
  window.setAlwaysOnTop(false)
  window.focus()
  window.flashFrame(false)
}

/**
 * Brings the window up for a link, as MiMo does whatever the link says, then
 * shows the linked session in it (I13-5). A renderer that is still loading, or
 * one that has failed and is being replaced, cannot take it yet: the link is
 * kept, and the page asks for it once it has connected (mcode:take-link).
 * Before the app is ready there is no window to raise; the first one takes it.
 */
function deliverLink(raw: string) {
  const target = parseSessionLink(raw)
  if (!app.isReady()) {
    if (target) pendingLink = raw
    return
  }
  activate(raise)
  if (!target) return
  const window = readyWindow()
  if (!window) {
    pendingLink = raw
    return
  }
  window.webContents.send("mcode:open-link", target)
}

/*
 * A launch that arrives while this copy is quitting (I13-2). The lock is held
 * until the process ends, and the quit holds the process for up to five seconds
 * while the backend closes, so the new copy has already handed over and gone.
 * Raising the window the quit has just hidden only flashed it up before the
 * teardown took it away again, and nothing opened. Instead the launch is
 * queued, with its own arguments (a link among them), to start once this copy
 * has exited and let go of the lock.
 */
let relaunchQueued = false
function relaunchAfterQuit(argv: readonly string[], link?: string) {
  if (relaunchQueued) return
  relaunchQueued = true
  console.info("[quit] a launch arrived while quitting; it starts once the quit is done")
  app.relaunch({ args: relaunchArgs(argv, link) })
}

app.on("second-instance", (_event, argv) => {
  if (closing) return relaunchAfterQuit(argv)
  const raw = linkInArgs(argv)
  if (raw) return deliverLink(raw)
  // Before ready the first window is on its way up anyway, and none can be made yet.
  if (app.isReady()) activate(raise)
})

/*
 * How recovery makes a replacement window: MiMo's createRendererWindow, shown
 * or kept hidden as the one it replaces was. A hidden one is only wanted for a
 * turn still running, whose notification has to come from somewhere.
 */
setRecoveryHost({
  create: (show) => createWindow(show),
  hasPendingWork: () => (backend?.runtime.runner.busySessions().length ?? 0) > 0,
})

// macOS delivers links as an event rather than as arguments.
app.on("open-url", (event, url) => {
  event.preventDefault()
  if (closing) return relaunchAfterQuit(process.argv, url)
  deliverLink(url)
})

/** Files written through the save dialog, and so safe to show in the shell. */
const savedFiles = new Set<string>()

/*
 * The tray, if the reader has asked for one.
 *
 * Held at module scope because it outlives any one window: a window replaced
 * after its renderer failed must not take the icon in the corner with it. The
 * colourway is remembered so the icon can be rebuilt when either the switch or
 * the chosen artwork changes.
 */
let tray: Tray | undefined
let trayIcon = DEFAULT_APP_ICON

/** MCode's own monochrome mark for the macOS menu bar, drawn by scripts/tray-icon.mjs. */
function trayTemplateFile(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "tray", "trayTemplate.png")
    : path.join(here, "../../resources/tray/trayTemplate.png")
}

/** Windows' window icon for a colourway - title bar, taskbar, Alt+Tab - as its multi-size .ico, or nothing if it has none. */
function windowIcoFile(id: string): string | undefined {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) return undefined
  const file = app.isPackaged ? path.join(process.resourcesPath, "app-icons", id + ".ico") : path.join(here, "../../resources/app-icons", id + ".ico")
  return existsSync(file) ? file : undefined
}

/**
 * macOS: whether this run has put a colourway's picture on the Dock. Until it
 * has, the bundle's own icon stays - on macOS 26 and later the Icon Composer
 * package, drawn with Liquid Glass and its dark appearance - which a flat PNG
 * handed to the Dock would cover.
 */
let dockCustomised = false

/** Windows' tray icon for a colourway: its multi-size .ico, or nothing if it has none. */
function trayIcoFile(id: string): string | undefined {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) return undefined
  const file = app.isPackaged ? path.join(process.resourcesPath, "tray", id + ".ico") : path.join(here, "../../resources/tray", id + ".ico")
  return existsSync(file) ? file : undefined
}

/**
 * Linux' tray icon for a colourway, as every size scripts/icons.mjs drew.
 *
 * nativeImage does not read an .ico, so this platform had been taking the 512
 * app tile and cutting it to a single 16 - a reduction a HiDPI panel then
 * stretched back up, which is the soft icon the user put beside another app's
 * crisp one (round 34 recorded it; round 78 gave the generator a PNG per size
 * and this the reader to go with it).
 *
 * `createFromPath` takes the first file's size; `addRepresentation` is what
 * lets one image carry all of them, and the panel picks the one it draws at.
 * The representation goes in as a data URL rather than a `buffer`: a buffer
 * is read as raw pixels, so handing it a PNG would put noise on the panel.
 * Only sizes that exist are added, so a stale resources folder still produces
 * a usable icon rather than an empty one.
 */
function trayLinuxImage(id: string): Electron.NativeImage | undefined {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) return undefined
  const folder = app.isPackaged ? path.join(process.resourcesPath, "tray") : path.join(here, "../../resources/tray")
  const at = (size: number) => path.join(folder, `${id}-${size}.png`)
  if (!existsSync(at(16))) return undefined
  const image = nativeImage.createFromPath(at(16))
  if (image.isEmpty()) return undefined
  for (const size of [16, 22, 24, 32, 44, 48, 64]) {
    if (size === 16 || !existsSync(at(size))) continue
    image.addRepresentation({ scaleFactor: size / 16, dataURL: `data:image/png;base64,${readFileSync(at(size)).toString("base64")}` })
  }
  return image
}

/**
 * The file an id names, or nothing if it names none. The Dock takes the macOS
 * cut (`app-icons-mac`, on Apple's icon grid, drawn by scripts/icons.mjs), as
 * MiMo picks its macOS artwork there; everything else takes the full tile.
 */
function appIconFile(id: string, dock = false): string | undefined {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) return undefined
  const folder = dock ? "app-icons-mac" : "app-icons"
  const file = app.isPackaged ? path.join(process.resourcesPath, folder, id + ".png") : path.join(here, "../../resources", folder, id + ".png")
  return existsSync(file) ? file : undefined
}

/* MiMo's launcher icon sync on Linux (see linux-icon-sync.ts); a no-op elsewhere. */
const syncLinuxIcon = linuxIconSync({
  platform: process.platform,
  appImage: process.env.APPIMAGE,
  home: app.getPath("home"),
  xdgDataHome: process.env.XDG_DATA_HOME,
  xdgDataDirs: process.env.XDG_DATA_DIRS,
  chromeDesktop: process.env.CHROME_DESKTOP,
  appName: app.getName(),
  readBinary: (file) => fs.readFile(file).catch(() => undefined),
  writeBinary: (file, bytes) => fs.writeFile(file, bytes),
  readText: (file) => fs.readFile(file, "utf8").catch(() => undefined),
  listDir: (folder) => fs.readdir(folder).catch(() => []),
  exists: (file) =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  mkdirp: async (folder) => {
    await fs.mkdir(folder, { recursive: true })
  },
  touch: (file) => fs.utimes(file, new Date(), new Date()),
  resizePng: (bytes, size) => {
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) throw new Error("the icon is not an image")
    return image.resize({ width: size, height: size, quality: "best" }).toPNG()
  },
})

/**
 * Builds or rebuilds the tray.
 *
 * Electron cannot relabel a tray menu in place any more than it can a menu bar,
 * so a language change rebuilds this the same way it rebuilds that one.
 */
function refreshTray(enabled: boolean): void {
  if (!enabled) {
    tray?.destroy()
    tray = undefined
    return
  }
  /*
   * MiMo picks its tray artwork per platform, and so does this: macOS's menu
   * bar wants a template image - one flat colour over transparency that the
   * system paints light or dark itself - so a colourway would be ignored there
   * and look wrong while it was. Windows and Linux keep the coloured icon the
   * reader chose. 16 logical pixels is what all three draw; the @2x file beside
   * the template is what a Retina bar actually shows.
   */
  let image: Electron.NativeImage
  if (process.platform === "darwin") {
    // Not resized: the file is already 16, and resizing would throw away the @2x beside it that a Retina bar draws.
    image = nativeImage.createFromPath(trayTemplateFile())
    if (image.isEmpty()) return
    image.setTemplateImage(true)
  } else if (process.platform === "win32" && trayIcoFile(trayIcon)) {
    /*
     * The colourway's own tray .ico, every size from 16 to 64 drawn for that
     * size (scripts/icons.mjs), and Windows picks the one its scaling needs.
     * Cutting the 512 tile to a single 16 here left a 125% or 150% screen to
     * stretch it back up - the soft, small icon the user compared with another
     * app's crisp one.
     */
    image = nativeImage.createFromPath(trayIcoFile(trayIcon)!)
    if (image.isEmpty()) return
  } else {
    // Linux: every size the generator drew, so a HiDPI panel has one to draw
    // rather than a 16 it has to stretch (see trayLinuxImage).
    const linux = process.platform === "linux" ? trayLinuxImage(trayIcon) : undefined
    if (linux) {
      image = linux
    } else {
      const file = appIconFile(trayIcon)
      if (!file) return
      // The source is 512, so this is a reduction rather than a stretch.
      image = nativeImage.createFromPath(file).resize({ width: 16, height: 16 })
    }
  }
  /*
   * MiMo's tray opens the window on a click and on a double-click alike; it
   * never hides it. Nothing while quitting: the window would only flash up
   * before the teardown takes it away (I13-2).
   */
  const open = () => {
    if (!closing) activate((window) => {
      cancelPendingHide(window)
      raise(window)
    })
  }
  const menu = Menu.buildFromTemplate([
    { label: label("tray.open", "Show Main Window"), click: open },
    {
      label: label("tray.newConversation", "New Conversation"),
      click: () => {
        if (leaving()) return
        open()
        const window = currentWindow()
        if (!window) return
        const contents = window.webContents
        const send = () => {
          if (!leaving() && !contents.isDestroyed()) contents.send("menu:new-session")
        }
        if (readyWindow() === window) send()
        else contents.once("did-finish-load", send)
      },
    },
    { type: "separator" },
    {
      label: label("tray.quit", "Quit"),
      click: () => {
        beginIntentionalQuit()
        app.quit()
      },
    },
  ])
  if (!tray) {
    try {
      tray = new Tray(image)
      tray.on("click", open)
      tray.on("double-click", open)
    } catch (err) {
      console.error("[mcode] system tray unavailable:", err)
      tray = undefined
      return
    }
  } else tray.setImage(image)

  tray.setToolTip(APP_NAME)
  if (process.platform === "darwin") {
    // Keep the left-click action separate from the native context menu.
    tray.removeAllListeners("right-click")
    tray.on("right-click", () => tray?.popUpContextMenu(menu))
  } else {
    tray.setContextMenu(menu)
  }
}

/**
 * Taskbar icon for unpackaged runs. macOS takes its icon from the app bundle
 * and ignores this, so it is only worth resolving on the other platforms.
 */
function windowIcon(): string | undefined {
  if (process.platform === "darwin") return undefined
  const file = process.platform === "win32" ? "icon.ico" : "icons/512x512.png"
  return path.join(here, "../../build", file)
}

/**
 * The save sheet's file-type row, named after what is actually being written.
 *
 * Three callers share this dialog and they write three different formats; a
 * filter that disagrees with the extension lets the OS rewrite the name.
 */
function saveFilter(suggested: string): Electron.FileFilter {
  const extension = path.extname(suggested).replace(".", "").toLowerCase()
  const known: Record<string, string> = { md: "Markdown", html: "HTML", json: "JSON", txt: "Text" }
  if (!extension) return { name: "All files", extensions: ["*"] }
  return { name: known[extension] ?? extension.toUpperCase(), extensions: [extension] }
}

/* `show` is false only for a replacement of a hidden window (renderer recovery). */
function createWindow(show = true): BrowserWindow {
  const saved = restore()

  const window = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    show: false,
    // The renderer draws its own title bar so the window matches the app's
    // dark chrome instead of the OS default.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    /*
     * MiMo starts the group at x=20, and the row below it centres on y=25: the
     * side column's control row is 24px tall with 13px above it, so a 12px
     * light wants its top at 25 - 6 = 19 to sit on that line. x=5 put the group
     * further left than macOS itself and y=15 sat it four pixels high, which is
     * what "not lining up" was.
     */
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 20, y: 19 } } : {}),
    /*
     * Windows keeps its own caption buttons, drawn into the bar as an overlay.
     *
     * A hand-drawn set looks close but is not the same control: it misses the
     * snap-layouts menu that appears when the pointer rests on maximise, and
     * its hit targets do not line up with what the OS believes the buttons to
     * be. The renderer reserves the room with env(titlebar-area-width).
     */
    ...(process.platform === "win32"
      ? { frame: false, titleBarOverlay: captionOverlay() }
      : {}),
    // MiMo's main plane before the first paint; the native theme already follows the saved app theme.
    backgroundColor: windowBackground(nativeTheme.shouldUseDarkColors),
    // Only used before packaging - a packaged build takes its icon from the
    // bundle (.icns) or the executable resource (.ico). macOS ignores this.
    icon: windowIcon(),
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      // Sandboxed, as MiMo's windows are: a compromised page is further from the main process.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  /*
   * Attached before anything is loaded into the window, because the first thing
   * that can fail is the load itself: a missing renderer bundle, or a dev server
   * that is not up yet, both fail before this function has finished running.
   */
  wireRecovery(window)
  // A hidden replacement still has a turn to report on; it must not be throttled into silence.
  if (!show) window.webContents.setBackgroundThrottling(false)

  // The renderer paints over this, but it is what shows during a resize or
  // before the first frame - so it has to track the native theme, which the
  // app theme sets (mcode:native-theme), not just sample it once at creation.
  const paintBackground = () => {
    if (window.isDestroyed()) return
    window.setBackgroundColor(windowBackground(nativeTheme.shouldUseDarkColors))
    // The overlay is painted by the OS and does not follow the page's colours.
    refreshTitlebar(window)
  }
  nativeTheme.on("updated", paintBackground)
  window.on("closed", () => nativeTheme.off("updated", paintBackground))

  // A notification that could not be shown flashes the taskbar instead; coming back ends it.
  window.on("focus", () => window.flashFrame(false))

  // MiMo's winFullscreen event: the renderer offers a way out while the caption buttons are gone.
  window.on("enter-full-screen", () => window.webContents.send("mcode:fullscreen", true))
  window.on("leave-full-screen", () => window.webContents.send("mcode:fullscreen", false))

  /*
   * MiMo's right-click on text and pictures: the OS menu, with only the rows
   * that can act. The app's own drawn menus cancel the event in the page, and a
   * cancelled contextmenu never reaches here, so those keep theirs.
   */
  window.webContents.on("context-menu", (_event, params) => {
    const rows = textMenuItems(params)
    if (!rows.length) return
    const L = label
    const template: Electron.MenuItemConstructorOptions[] = rows.map((row) => {
      if (row === "copyImage") {
        return { label: L("edit.copyImage", "Copy Image"), click: () => window.webContents.copyImageAt(params.x, params.y) }
      }
      if (row === "copyImageUrl") {
        return { label: L("edit.copyImageAddress", "Copy Image Address"), click: () => clipboard.writeText(params.srcURL) }
      }
      const names = { copy: ["edit.copy", "Copy"], cut: ["edit.cut", "Cut"], paste: ["edit.paste", "Paste"], selectAll: ["edit.selectAll", "Select All"] } as const
      return { role: row, label: L(names[row][0], names[row][1]) }
    })
    Menu.buildFromTemplate(template).popup({ window })
  })

  // Maximise before the first paint, so the window does not appear at its
  // restored size and then jump.
  // getNormalBounds covers the first run, where the OS picked the position. MiMo saves as the last window goes.
  const requested = saved.x !== undefined && saved.y !== undefined ? ({ x: saved.x, y: saved.y, width: saved.width, height: saved.height } as Rectangle) : window.getNormalBounds()
  if (saved.maximized) maximizeAtStart(window, requested)
  track(window, requested, () => ![...windows].some((entry) => entry !== window && !entry.isDestroyed()))

  // A pinch or Ctrl+wheel scales the page without going through applyZoom, so
  // the band has to follow that as well as the menu and keyboard paths. A
  // browser tab's page is not re-placed here; see setBounds in browser.ts.
  window.webContents.on("zoom-changed", () => refreshTitlebar(window))
  window.webContents.on("did-finish-load", () => refreshTitlebar(window))

  /*
   * MiMo's addDefaultShow: the same show bound to `ready-to-show`, to
   * `did-finish-load` and to a three-second timer, whichever arrives first.
   * This window used to wait on `ready-to-show` alone, so a first load that
   * never finished showed nothing until renderer-health's 30s startup timeout
   * built a replacement - half a minute of no window at all.
   */
  let shownOnce = false
  const showFallback = setTimeout(() => showWindowOnce(), SHOW_FALLBACK_MS)
  function showWindowOnce() {
    if (shownOnce) return
    shownOnce = true
    clearTimeout(showFallback)
    if (show && !window.isDestroyed()) window.show()
  }
  window.once("ready-to-show", showWindowOnce)
  window.on("show", unlockAfterWindowShow)
  window.webContents.once("did-finish-load", () => {
    loadedWindows.add(window)
    showWindowOnce()
    unlockAfterWindowShow()
  })
  window.on("closed", () => {
    clearTimeout(showFallback)
    windows.delete(window)
  })

  /*
   * Windows shutting down, restarting or logging off (I13-3). Electron emits
   * neither before-quit nor quit when Windows ends the app that way, so the
   * teardown those run never happened: a window moved since it last hid came
   * back at its old place after a reboot, and the final writes, the MCP
   * children, the cron lock and a pending install were left as they were.
   *
   * query-session-end, the first word of it, now asks for the quit itself -
   * without preventDefault, so the shutdown is never held up - and before-quit
   * runs its teardown as for any quit. If another program then cancels the
   * shutdown, MCode has still quit; Windows asks only once. Either way it is a
   * quit, so the close rule below lets the window go instead of hiding it to
   * the tray (MiMo's session-end).
   */
  window.on("query-session-end", () => {
    console.info("[quit] query-session-end (OS shutdown or logoff ahead)")
    noteOsQuit()
    app.quit()
  })
  /*
   * The last word: the process may end as soon as this returns. The window
   * state is written now, synchronously, in case the teardown does not get
   * that far; the teardown is started if query-session-end never came.
   */
  window.on("session-end", () => {
    console.info("[quit] session-end (OS shutdown or logoff)")
    noteOsQuit()
    for (const each of windows) saveWindowState(each)
    if (!closing) app.quit()
  })

  /*
   * The last window hides when the tray is available. During quit, or with
   * another window open, it closes normally. The window-state listener has
   * already saved the bounds for the next show.
   */
  /*
   * MiMo's hidden bounds: a window hidden to the tray records exactly where it
   * was and gets that back when it is shown again - pulled onto a screen if
   * that one has gone, and applied once more after 150 ms if the show moved it.
   */
  let hiddenBounds: Rectangle | undefined
  let confirmBounds: ReturnType<typeof setTimeout> | undefined
  window.on("show", () => {
    const recorded = hiddenBounds
    hiddenBounds = undefined
    if (confirmBounds) clearTimeout(confirmBounds)
    confirmBounds = undefined
    const target = boundsOnShow(recorded, window.isFullScreen(), screen.getAllDisplays().map((display) => display.workArea))
    // Where the OS kept it, give or take scaling noise, is left alone rather than nudged a pixel larger.
    if (!target || closeBounds(window.getBounds(), target)) return
    window.setBounds(target)
    confirmBounds = setTimeout(() => {
      confirmBounds = undefined
      if (window.isDestroyed() || window.isFullScreen() || closeBounds(window.getBounds(), target)) return
      console.info("[hidden-bounds] the window drifted after show; bounds applied again")
      window.setBounds(target)
    }, 150)
  })

  window.on("close", (event) => {
    const others = [...windows].filter((entry) => entry !== window && !entry.isDestroyed()).length
    const hide = closeHidesToTray({
      quitting: leaving(),
      otherWindows: others,
      trayEnabled: Boolean(tray),
    })
    if (!hide) {
      // The close goes ahead, so the contents going away next is not a failure to recover from.
      markClosing(window)
      return
    }
    event.preventDefault()
    hiddenBounds = window.isFullScreen() ? undefined : window.getBounds()
    hideWindow(window, process.platform)
  })

  // Anything the page tries to open externally goes to the real browser, never
  // into an Electron window with preload access.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url)
    return { action: "deny" }
  })

  const devServer = process.env.ELECTRON_RENDERER_URL
  const rendererPage = path.join(here, "../renderer/index.html")

  /*
   * This window holds the preload bridge, so its top frame only ever shows the
   * app itself: the dev server's origin, or the packaged renderer page (its own
   * reloads included). A served page or a link asking to take the window over
   * is refused. Frames below it - the page preview - navigate as they like; they
   * get no preload, and the frame CSP bounds where they can go.
   */
  const isAppPage = (target: string) => {
    try {
      const parsed = new URL(target)
      if (devServer) return parsed.origin === new URL(devServer).origin
      return parsed.protocol === "file:" && path.relative(rendererPage, fileURLToPath(parsed)) === ""
    } catch {
      return false
    }
  }
  window.webContents.on("will-navigate", (event) => {
    if (event.isMainFrame && !isAppPage(event.url)) event.preventDefault()
  })
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame && !isAppPage(event.url)) event.preventDefault()
  })

  if (devServer) void window.loadURL(devServer)
  else void window.loadFile(rendererPage)

  windows.add(window)
  return window
}

app.whenReady().then(async () => {
  /*
   * Before the backend starts, so that a process failing on the way up is
   * already being recorded by the time it happens.
   */
  wireProcessRecovery()
  registerMacOSControl()
  /*
   * Early, so the macOS Local Network permission is settled while the user is
   * still setting the app up rather than on the click that connects a runtime
   * on another machine, with the request already failing behind it.
   */
  askForLocalNetwork()
  // Packaged only: a development build would register the bare Electron binary.
  if (app.isPackaged) app.setAsDefaultProtocolClient(LINK_SCHEME)

  // MiMo makes an oversized picture smaller rather than dropping it; the decoder lives here, so the backend is handed one.
  setImageShrinker(shrinkImage)

  /*
   * MiMo's one source for the language nobody chose: `app.getLocale()`, the
   * display language Chromium runs in. The backend's reply language and the
   * window's interface read it from here, rather than one of them from the
   * region format this process's Intl defaults to.
   */
  setMachineLocale(app.getLocale())
  ipcMain.on("mcode:system-locale", (event) => {
    event.returnValue = app.getLocale()
  })

  /*
   * MiMo creates its main window first and only then starts the pieces that
   * take time, none of them awaited: the database prewarm, auth, the tray, the
   * updater and the engine. This awaited the whole backend instead, so the
   * window's appearance was hostage to it - `startBackend` reads every
   * conversation's info.json, opens the full-text index and reconciles it,
   * starts cron and automations and waits for the socket to listen, and
   * nothing was on screen for any of it. Measured: the first window existed at
   * 166ms with two conversations and 223-236ms with two hundred.
   *
   * Everything below registers its handlers in this same tick and reads
   * `backend` only when a handler is actually called, and the window is created
   * at the end of the tick - so no message the page sends can arrive before its
   * channel exists, and a slow disk or a long history now delays the content
   * inside the window rather than the window itself.
   */
  // Only this app's own page may open the socket from a browser context.
  const starting = startBackend(app.getPath("userData"), { origins: rendererOrigins(process.env.ELECTRON_RENDERER_URL), secrets: safeStorageBox, installationDirectory: app.isPackaged ? path.dirname(process.execPath) : undefined, deferCredentialUnseal: true }).then((started) => {
    backend = started
    // Hidden launches still unlock. Give the startup watchdog time to show
    // a replacement first if the original window failed to load.
    credentialUnlockFallback = setTimeout(unlockStartupCredentials, 35_000)
    credentialUnlockFallback.unref()
    unlockAfterWindowShow()
    /*
     * MiMo keeps the machine from suspending while a turn runs. The runner's busy
     * set is the truth; every backend event is a moment it may have changed, and
     * re-reading a handful of ids costs nothing next to the event itself.
     */
    const powerHold = new PowerHold(powerSaveBlocker, (line) => console.info(line))
    const runtime = started.runtime
    runtime.bus.subscribe(() => powerHold.sync(runtime.runner.busySessions()))
    /*
     * MCode Remote (docs/remote-design.md): a gateway for paired phones,
     * started and stopped by the config's `remote` switch - on by hand in
     * config.json for now, a settings switch later. The pairing token lives
     * beside the storage, never in the config, so an edit to the config alone
     * never opens the machine. The loopback backend socket stays bound: the
     * gateway is one more subscriber, not a wider hole.
     */
    const syncGateway = async () => {
      const remote = runtime.config.get().remote
      if (remote?.enabled && !remoteGateway) {
        try {
          remoteGateway = await startRemoteGateway(runtime, {
            host: remote.host ?? "127.0.0.1",
            port: remote.port ?? 0,
            token: loadOrCreateToken(app.getPath("userData")),
          })
          console.info(`[remote] gateway listening on ${remote.host ?? "127.0.0.1"}:${remoteGateway.port}; the pairing token is in storage/remote-token.json`)
        } catch (error) {
          console.error("[remote] the gateway did not start", error)
        }
      } else if (!remote?.enabled && remoteGateway) {
        await remoteGateway.close().catch(() => {})
        remoteGateway = undefined
        console.info("[remote] gateway stopped")
      }
    }
    runtime.bus.subscribe((event) => {
      if (event.type === "config.updated") void syncGateway()
    })
    void syncGateway()
    return started
  })
  startingBackend = starting
  // Handled here so a backend that will not start is the page's error screen rather than an unhandled rejection.
  starting.catch((error: unknown) => console.error("[boot] the backend did not start", error))

  /*
   * The renderer has no Node access; this is how it learns where to connect.
   * It is the one channel that has to wait for the backend, and it waits with
   * the window already up and its connecting state on screen.
   *
   * The socket secret goes only to the top frame of one of the app's own
   * windows. No other frame holds the preload, but the check costs nothing and
   * keeps the secret from ever reaching a page that found a way to ask.
   */
  ipcMain.handle("mcode:bootstrap", async (event) => {
    const started = await starting
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || !windows.has(owner) || event.senderFrame !== event.sender.mainFrame) throw new Error("not the app window")
    return {
      port: started.port,
      secret: started.secret,
      platform: process.platform,
      home: app.getPath("home"),
      // app.getVersion() reports Electron's version until the app is packaged,
      // so take the real one from package.json - the bundler inlines it.
      version: pkg.version,
    }
  })

  /*
   * The title arrives from the renderer because only the renderer knows the
   * language - this was a hard-coded English sentence, so the one piece of
   * chrome the app cannot translate at render time was the one it never
   * translated at all.
   *
   * The reference asks for several at once when it is opening projects
   * (`pickDirectory({ multiple: true })`) and for one when it is setting a
   * single path, so the caller says which.
   */
  /* Folders dropped onto the project list: only the paths that are directories come back. */
  ipcMain.handle("mcode:directories-of", async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return []
    const found: string[] = []
    for (const entry of paths) {
      if (typeof entry !== "string" || !path.isAbsolute(entry)) continue
      // Resolved, so a folder named with forward slashes is the same project as one named the native way.
      const resolved = path.resolve(entry)
      const stat = await fs.stat(resolved).catch(() => undefined)
      if (stat?.isDirectory() && !found.includes(resolved)) found.push(resolved)
    }
    return found
  })

  /*
   * What a dropped path is, for the paths a drag names in its `text/uri-list`
   * rather than as files.
   *
   * MiMo hands every path a drop produced to the main process, keeps the ones
   * that exist and describes each before deciding between an @mention and an
   * attachment. The window cannot stat anything itself, so it asks here; a path
   * that is gone simply does not come back.
   */
  ipcMain.handle("mcode:describe-files", async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return []
    const found: { path: string; name: string; size: number; directory: boolean }[] = []
    for (const entry of paths) {
      if (typeof entry !== "string" || !path.isAbsolute(entry)) continue
      const resolved = path.resolve(entry)
      if (found.some((seen) => seen.path === resolved)) continue
      const stat = await fs.stat(resolved).catch(() => undefined)
      if (!stat) continue
      found.push({ path: resolved, name: path.basename(resolved), size: stat.size, directory: stat.isDirectory() })
    }
    return found
  })

  /*
   * MiMo's default project location, made if need be: the folder chosen in
   * settings, else the one under the home folder; nothing when neither can be made.
   */
  const projectLocation = async (): Promise<string | undefined> => {
    const chosen = backend?.runtime.config.get().projectRoot ?? ""
    for (const candidate of [scratchRoot(chosen), scratchRoot()]) {
      try {
        await backend?.runtime.config.projectLocations.assert(candidate)
        await fs.mkdir(candidate, { recursive: true })
        return candidate
      } catch {
        // The chosen folder may be on a drive since unplugged; try the default.
      }
    }
    return undefined
  }

  /* `project` is MiMo's 选择或新建项目文件夹: it opens at the default project location. */
  ipcMain.handle("mcode:pick-directory", async (event, rawTitle: unknown, rawMultiple?: unknown, rawProject?: unknown) => {
    const { title, multiple, project } = directoryAsk(rawTitle, rawMultiple, rawProject)
    // MiMo lets one native dialog up at a time: a second ask while one is open is answered busy.
    const asking = BrowserWindow.fromWebContents(event.sender)
    const claim = claimDialog(process.platform, asking)
    if (!claim) return PICKER_BUSY
    try {
      const owner = dialogParent(process.platform, asking)
      const options: Electron.OpenDialogOptions = {
        properties: multiple
          ? ["openDirectory", "createDirectory", "multiSelections"]
          : ["openDirectory", "createDirectory"],
        title,
      }
      const location = project ? await projectLocation() : undefined
      if (location) options.defaultPath = location
      const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    } finally {
      releaseDialog(claim)
    }
  })

  /**
   * Resolves a path the renderer named, or nothing if it escapes the project.
   *
   * The renderer holds paths relative to the project root. Joining them here
   * rather than there keeps separators right on every platform, and the
   * containment check means a crafted `../..` cannot walk out of the project
   * through a channel that hands paths to the shell.
   */
  /* A file inside the folder by spelling and by where it really leads: a junction in the folder does not pass. */
  const inside = async (directory: unknown, relative: unknown): Promise<string | undefined> => {
    if (typeof directory !== "string" || typeof relative !== "string" || !path.isAbsolute(directory)) return undefined
    const root = path.resolve(directory)
    const target = path.resolve(root, relative)
    const within = target === root || target.startsWith(root + path.sep)
    return within && (await insideReal(root, target)) ? target : undefined
  }

  ipcMain.on("mcode:menu-labels", (_event, next: unknown) => {
    if (!setLabels(next)) return
    // Rebuilt rather than patched: Electron has no way to relabel in place.
    buildMenu()
    // The tray's menu has the same problem and the same answer.
    if (tray) refreshTray(true)
  })

  /*
   * MiMo's task notification: a finished task or one waiting on a confirmation,
   * shown only while the window is minimised, hidden or in the background.
   *
   * Titled "project · conversation" and worded by kind; silent only when the
   * renderer says a chime is playing instead. Where the OS cannot show one, or
   * showing it fails, the taskbar flashes. Clicking raises the window and opens
   * the conversation it is about.
   */
  ipcMain.on("mcode:task-notice", (event, raw: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner) return
    const state = {
      destroyed: owner.isDestroyed(),
      minimized: owner.isMinimized(),
      visible: owner.isVisible(),
      focused: owner.isFocused(),
    }
    if (!wantsNotice(state)) return
    if (!Notification.isSupported()) {
      owner.flashFrame(true)
      return
    }
    const notice = readTaskNotice(raw)
    const body =
      notice.kind === "confirm"
        ? label("notify.confirm", "Your confirmation is needed before the task can continue")
        : notice.kind === "failed"
          ? label("notify.failed", "A scheduled task failed to run")
          : notice.kind === "chat"
            ? label("notify.chat", "A reply is ready")
            : label("notify.done", "Task completed")
    try {
      const note = new Notification({ title: noticeTitle(notice), body, silent: notice.silent })
      note.on("click", () => {
        raise(owner)
        if (notice.sessionID && !owner.isDestroyed()) owner.webContents.send("mcode:notify-click", notice.sessionID)
      })
      note.show()
    } catch {
      owner.flashFrame(true)
    }
  })

  /* MiMo's badge: conversations with an unseen finish or waiting on a confirmation. A no-op on Windows. */
  let badge = -1
  ipcMain.on("mcode:badge", (_event, raw: unknown) => {
    const count = badgeCount(raw)
    if (count === badge) return
    badge = count
    app.setBadgeCount(count)
  })

  ipcMain.handle("mcode:clipboard-text", () => clipboard.readText())

  // The link the app was started with, handed over once, when the window has connected.
  ipcMain.handle("mcode:take-link", () => {
    const raw = pendingLink
    pendingLink = undefined
    return raw ? parseSessionLink(raw) : undefined
  })

  ipcMain.on("mcode:clipboard-write", (_event, raw: unknown) => {
    const text = clipboardText(raw)
    if (text !== undefined) clipboard.writeText(text)
  })

  /*
   * A link clicked in the terminal.
   *
   * Terminal output is not the app's own text - it is whatever a build tool,
   * a test runner or a remote script decided to print - so the scheme is
   * checked here rather than trusted from the renderer, and only the two that
   * a browser can be handed are allowed. This is deliberately the same policy
   * the window-open handler above applies, for the same reason: shell.openExternal
   * on an arbitrary scheme is a way to start a program, and no printed line
   * should be able to do that.
   */
  ipcMain.on("mcode:open-external", (_event, url: string) => {
    if (typeof url !== "string") return
    if (!url.startsWith("https://") && !url.startsWith("http://")) return
    void shell.openExternal(url)
  })

  /*
   * MiMo opens the OS microphone privacy page after a refusal. The page is
   * chosen here, never named by the renderer, so this cannot open anything else.
   */
  ipcMain.on("mcode:open-mic-settings", () => {
    const page =
      process.platform === "win32"
        ? "ms-settings:privacy-microphone"
        : process.platform === "darwin"
          ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
          : undefined
    if (page) void shell.openExternal(page).catch(() => {})
  })

  /*
   * MiMo's micAccess before capture: macOS asks for the microphone; Windows
   * refuses when its privacy setting is off, so the guide to that setting
   * shows; other systems answer in getUserMedia.
   */
  ipcMain.handle("mcode:mic-access", async () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return true
    let status = "unknown"
    try {
      status = systemPreferences.getMediaAccessStatus("microphone")
    } catch {
      // Unknown: macOS guides, Windows lets getUserMedia answer.
    }
    const decision = micDecision(process.platform, status)
    if (decision === "ask") return systemPreferences.askForMediaAccess("microphone").catch(() => false)
    return decision === "allow"
  })

  ipcMain.on("mcode:edit", (event, raw: unknown) => {
    const contents = event.sender
    switch (actionOf(EDIT_ACTIONS, raw)) {
      case "undo":
        return contents.undo()
      case "redo":
        return contents.redo()
      case "cut":
        return contents.cut()
      case "copy":
        return contents.copy()
      case "paste":
        return contents.paste()
      case "delete":
        return contents.delete()
      case "selectAll":
        return contents.selectAll()
    }
  })

  /*
   * The window's own view commands.
   *
   * These have to run out here rather than in the page: a page cannot reload
   * itself from a menu click without losing the click, cannot open the devtools
   * at all, and cannot go full screen without the user gesture the browser
   * demands. The in-window menu is the only menu on Windows, so without these
   * three the items simply would not exist.
   */
  /*
   * MiMo's automatic updates, through electron-updater (see updater.ts): the
   * first check 5 s after launch, then every 3 h, silent on failure, with a
   * newer installer downloaded in the background and verified against the
   * sha512 in the feed. Every phase change goes to the windows; the capsule and
   * the settings row react to a ready update.
   *
   * The feed is fetched out here. The window is served under a content policy
   * that reaches the local backend and nothing else, which is right for a page
   * that renders model output.
   *
   * electron-updater is loaded on first use, the way MiMo loads it, so a
   * library that fails to load costs updates and nothing else.
   *
   * Not on macOS: mac auto-update was declined (M10-8), and on an unsigned app
   * Squirrel.Mac would refuse every download it made. There the updater is
   * never loaded and a check says no feed is configured.
   */
  const updateFeed = () => process.env.MCODE_UPDATE_URL?.trim() || backend?.runtime.config.get().updateFeed || ""
  const autoUpdates = process.platform !== "darwin"
  const updaterReady: Promise<Updater | undefined> = (autoUpdates ? import("electron-updater") : Promise.reject(new Error("macOS has no automatic updates")))
    .then((loaded) => {
      const autoUpdater = (loaded as { autoUpdater?: unknown; default?: { autoUpdater?: unknown } }).autoUpdater ?? (loaded as { default?: { autoUpdater?: unknown } }).default?.autoUpdater
      if (!autoUpdater) throw new Error("electron-updater has no autoUpdater")
      const library = autoUpdater as AutoUpdaterLike & { logger: unknown }
      library.logger = {
        info: (text: unknown) => console.info(`[update] ${String(text)}`),
        warn: (text: unknown) => console.warn(`[update] ${String(text)}`),
        error: (text: unknown) => console.warn(`[update] ${String(text)}`),
        debug: () => {},
      }
      const created = createUpdater({
        currentVersion: pkg.version,
        feedURL: updateFeed,
        autoUpdater: library,
        emit: (state: UpdateState) => {
          for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("mcode:update-state", state)
        },
        log: (line) => console.info(line),
      })
      liveUpdater = created
      if (osQuitting) created.holdInstallOnQuit()
      created.start()
      app.on("before-quit", () => {
        created.stop()
        // An ordinary quit (the OS not ending the session) installs as normal,
        // even after a held install from a session end that was cancelled.
        if (!osQuitting) created.resumeInstallOnQuit()
      })
      return created
    })
    .catch((error: unknown) => {
      if (autoUpdates) console.warn("[update] electron-updater did not load; updates are off for this run", error)
      return undefined
    })
  const idleUpdate: UpdateState = { phase: "idle", ready: null }

  /*
   * MiMo's update transaction: the last install's record, compared with the
   * version that is running now. An interruption is reported to the first
   * window that asks, once.
   */
  let interrupted = updateTransactions.reconcile(pkg.version)
  if (interrupted) console.warn(`[update] the update to ${interrupted.targetVersion || "a new version"} did not finish (${interrupted.error})`)
  ipcMain.handle("mcode:update-status", async () => {
    const report = interrupted
    interrupted = undefined
    const state = (await updaterReady)?.state() ?? idleUpdate
    return report ? { ...state, interrupted: report } : state
  })
  ipcMain.handle("mcode:update-check", async () => {
    const updater = await updaterReady
    if (!updater && !autoUpdates) return { ...idleUpdate, outcome: "no-feed" }
    if (!updater) return { ...idleUpdate, outcome: "failed", during: "check", error: "the updater is not available" }
    return updater.checkNow()
  })
  if (app.isPackaged) void removeStaleInstallers()

  /*
   * Only what the updater downloaded and verified. The renderer names no path
   * here - it asks to install "the one that is ready" - so a window cannot talk
   * the app into launching an arbitrary executable.
   *
   * The installer itself starts only after the backend has shut down (the quit
   * path below calls runPendingInstall): a silent installer run with --updated
   * ends a running MCode after a second, which could cut the backend off while
   * it writes.
   *
   * What cannot install says why, as one of MiMo 26.920's reasons, rather than
   * throwing: a copy that cannot replace itself, a build with updates off, an
   * update still downloading, or none at all.
   */
  ipcMain.handle("mcode:install-update", async (): Promise<InstallAnswer> => {
    if (readOnlyInstall(process.execPath, process.platform)) return { ok: false, reason: "read-only-volume" }
    if (!autoUpdates) return { ok: false, reason: "disabled" }
    const updater = await updaterReady
    if (!updater) return { ok: false, reason: "unknown", hint: "electron-updater did not load" }
    const target = updater.readyVersion()
    if (!target) return { ok: false, reason: updater.state().phase === "downloading" ? "staging" : "no-ready" }
    if (!updateTransactions.begin(pkg.version, target)) {
      return { ok: false, reason: "unknown", hint: "update-transaction.json could not be written" }
    }
    /*
     * MiMo's installing notice: shown before the app goes, and given up to 1.5 s
     * to be delivered so it is on screen as the window disappears. Worded in the
     * window's language through the published labels.
     */
    try {
      if (Notification.isSupported()) {
        const notice = new Notification({
          title: label("update.installingTitle", "Installing the MCode update"),
          body: label("update.installingBody", "MCode closes to finish installing and then opens again by itself. This can take a few minutes."),
        })
        const delivered = deliveryOf(notice)
        notice.show()
        await waitForDelivery(delivered)
      }
    } catch {
      // No notice is no reason not to install.
    }
    pendingInstall = () => {
      try {
        // MiMo's sweep: a helper still running from resources\ (a bundled python, say) would hold files the installer replaces.
        const sweep = helperSweep(process.execPath, process.platform, app.isPackaged)
        if (sweep) {
          const swept = spawnSync(sweep.file, sweep.args, { timeout: HELPER_SWEEP_TIMEOUT_MS, windowsHide: true, stdio: "ignore" })
          console.info(`[update] helper sweep under ${sweep.prefix} exited ${swept.status ?? swept.error?.message}`)
        }
      } catch (error) {
        console.warn("[update] helper sweep failed (the install goes on)", error)
      }
      try {
        if (updater.install(process.execPath)) updateTransactions.markInstallerStarted()
        else updateTransactions.markFailed("no-ready")
      } catch (error) {
        updateTransactions.markFailed(error)
        console.warn("[update] the installer did not start", error)
      }
    }
    beginIntentionalQuit()
    // With no backend to wait for, the quit path goes straight to the installer.
    app.quit()
    return { ok: true }
  })

  /*
   * Restarts the app. The renderer's error page is the caller: once the page
   * has failed to render, reloading it runs into whatever broke it the first
   * time, and a page that cannot draw cannot ask a person to quit and reopen.
   */
  ipcMain.on("mcode:relaunch", () => relaunch())

  /* A renderer diagnostics line (MiMo's diagLog): capped, and redacted on its way into the file. */
  ipcMain.on("mcode:diag-log", (_event, line: unknown) => {
    if (typeof line === "string" && line) logs.write("renderer", line.slice(0, 4000))
  })

  /*
   * Quits from the footer menu. Said to be intended first, like the tray's Quit,
   * so the recovery handlers do not take the closing windows for a crash; the
   * quit itself still goes through before-quit, which waits for the terminals.
   */
  ipcMain.on("mcode:quit", (_event, fromShortcut: unknown) => requestAppQuit(fromShortcut === true))

  ipcMain.on("mcode:view", (event, raw: unknown) => {
    const contents = event.sender
    switch (actionOf(VIEW_ACTIONS, raw)) {
      case "reload":
        return contents.reload()
      case "devtools":
        return contents.toggleDevTools()
      case "fullscreen": {
        const window = BrowserWindow.fromWebContents(contents)
        return window?.setFullScreen(!window.isFullScreen())
      }
    }
  })

  /*
   * Only paths this process handed back from a save dialog. The renderer is
   * never the authority on where something may be shown from.
   */
  ipcMain.handle("mcode:reveal-saved", (_event, target: string) => {
    if (!savedFiles.has(target)) return
    shell.showItemInFolder(target)
  })

  ipcMain.handle("mcode:open-saved", async (_event, target: string) => {
    if (!savedFiles.has(target)) return "unknown file"
    return await shell.openPath(target)
  })

  /* Says why nothing was shown, so the artifacts page can tell a moved file from a refusal (MiMo's toasts). */
  ipcMain.handle("mcode:reveal-file", async (_event, directory: string, relative: string) => {
    const target = await inside(directory, relative)
    if (!target) return { ok: false, error: "outside the project" }
    if (!existsSync(target)) return { ok: false, missing: true }
    shell.showItemInFolder(target)
    return { ok: true }
  })

  // MiMo's Office tab: document bytes, watching, versions, legacy conversion.
  // A document is written back only inside a folder the app works in.
  registerOffice(ipcMain, app.getPath("userData"), async () => (backend ? workingRoots(backend.runtime) : []))
  registerComposerInput(ipcMain, app.getPath("userData"))
  // MiMo's pasted pictures and large pastes: written to disk, then attached by path.
  registerPasteFiles(ipcMain, app.getPath("userData"))

  /* Which open-with apps are installed, for the settings row and the open-location menu. */
  ipcMain.handle("mcode:installed-apps", () => installedOpenApps(process.platform))
  // MiMo's 默认打开目标 draws each app's own icon; small icons, as data URLs the renderer can show.
  ipcMain.handle("mcode:installed-app-icons", () =>
    installedOpenAppIcons(async (file) => (await app.getFileIcon(file, { size: "small" })).toDataURL(), process.platform),
  )
  // MiMo's 打开方式 on a delivered document: that kind's installed apps (macOS only), with their icons.
  ipcMain.handle("mcode:doc-apps", (_event, kind: unknown) =>
    typeof kind === "string"
      ? installedDocApps(kind, async (file) => (await app.getFileIcon(file, { size: "small" })).toDataURL(), process.platform)
      : [],
  )

  // MiMo's 下载副本 on a delivered file: a copy in Downloads, no dialog.
  ipcMain.handle("mcode:save-copy", (_event, file: unknown) => saveCopy(file, app.getPath("downloads")))

  ipcMain.handle("mcode:open-file", async (_event, directory: string, relative: string, openWith?: unknown) => {
    const target = await inside(directory, relative)
    if (!target) return "outside the project"
    // No app named: hand it to the desktop, which is the default choice.
    if (openWith === undefined || openWith === null) {
      /*
       * Except a program. `inside` only checks the path against a root the
       * caller itself nominated, so it settles nothing about what the file is,
       * and this branch handed the name straight to the desktop - which on
       * Windows runs it. The named-app branch below has always checked; this
       * one did not, so `openFile("C:\\Windows\\System32", "cmd.exe")` started
       * a shell with no dialog and no question (R25-E1). Same refusal as the
       * other channel that opens a file for the reader.
       */
      const stat = await fs.stat(target).catch(() => undefined)
      // A directory opens as itself: 打开位置 hands the project folder over,
      // and a folder needs no app chosen. But a macOS .app bundle is a
      // directory on disk and shell.openPath would launch it - the exact
      // thing R25-E1 keeps this channel from doing - so the bundle check
      // runs on folders too (isProgram itself cannot: a folder always has
      // the execute bits its unix arm reads).
      if (stat?.isDirectory()) {
        if (await isBundleProgram(target)) return EXECUTABLE_REFUSAL
        return await shell.openPath(target)
      }
      if (!stat?.isFile()) return "not a file"
      if (await isProgram(target, stat)) return EXECUTABLE_REFUSAL
      // A non-empty return is the shell's reason for refusing; it is worth showing.
      return await shell.openPath(target)
    }
    /*
     * A named app is started rather than handed over, the way the reference's
     * `open-path` does it (out/main/index.js @89250): `open -a <app> <path>` on
     * macOS, and the app itself with the path as its argument everywhere else.
     *
     * Unlike the reference, the name is checked against the table first. It
     * passes whatever its window sends straight to execFile because it trusts
     * its own renderer; here a compromised page would otherwise have a way to
     * run an arbitrary executable, which is the same reason the external-URL
     * channel checks the scheme instead of believing the caller checked it.
     */
    if (!isKnownOpenWith(openWith, process.platform)) return "unknown application"
    // The bundle or program that was found for that name (MiMo opens the bundle it found).
    const launched = await launchTarget(openWith, process.platform)
    const [command, args] =
      process.platform === "darwin" ? ["open", ["-a", launched, target]] : [launched, [target]]
    return await new Promise<string>((resolve) => {
      execFile(command, args, { windowsHide: true }, (error) => resolve(error ? error.message : ""))
    })
  })

  /**
   * Writes text somewhere the user chooses.
   *
   * The renderer has no filesystem, and a transcript that can only be read
   * inside the app is not much of an export.
   */
  ipcMain.handle("mcode:save-text", async (event, suggested: string, text: string) => {
    const asking = BrowserWindow.fromWebContents(event.sender)
    const claim = claimDialog(process.platform, asking)
    if (!claim) return PICKER_BUSY
    const owner = dialogParent(process.platform, asking)
    const options = {
      defaultPath: suggested,
      // Taken from the name the caller suggested. A fixed Markdown filter used
      // to be applied to all three callers, and Windows would then coerce .md
      // onto the shared HTML page - a file the browser would no longer open.
      filters: [saveFilter(suggested)],
    }
    /*
     * try/finally, not `.finally` on the result. A `showSaveDialog` that throws
     * on the way in - most plausibly an owner window destroyed between
     * `fromWebContents` and this line, which renderer recovery does - never
     * produced a promise to hang the release on, so the claim was held for the
     * rest of the session and every later picker, save sheet and export in the
     * window answered PICKER_BUSY (R25-E5).
     */
    let result
    try {
      // Attached to the window where there is one (not on macOS, as MiMo), so it cannot be lost behind it.
      result = await (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options))
    } finally {
      releaseDialog(claim)
    }
    if (result.canceled || !result.filePath) return undefined
    await fs.writeFile(result.filePath, text, "utf8")
    savedFiles.add(result.filePath)
    return result.filePath
  })

  ipcMain.on("mcode:zoom", (event, action: "in" | "out" | "reset") => {
    if (action === "in" || action === "out" || action === "reset") applyZoom(action, event.sender)
  })

  // The window's zoom as a whole percent, asked once at load for MiMo's startup notice.
  ipcMain.handle("mcode:zoom-percent", (event) => Math.round(event.sender.getZoomFactor() * 100))

  /*
   * The icon the window and the taskbar wear.
   *
   * Only the renderer knows which one is chosen - the config document is the
   * server's, and main never reads it - so main is told rather than asking. An
   * id that names no file leaves the icon alone instead of blanking it.
   */
  /*
   * The browser panel. The window owns the layout and says where the page
   * goes; main owns the page itself, for the reasons at the top of browser.ts.
   */
  ipcMain.handle("mcode:browser-open", (event, raw: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const bounds = panelBounds(raw)
    if (!window || !bounds) return undefined
    openPanel(window, bounds, (state) => {
      if (!window.isDestroyed()) window.webContents.send("mcode:browser-state", state)
    })
    return panelState(window)
  })

  ipcMain.on("mcode:browser-bounds", (event, raw: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const bounds = panelBounds(raw)
    if (window && bounds) setBounds(window, bounds)
  })

  ipcMain.handle("mcode:browser-navigate", (event, input: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window ? navigate(window, String(input)) : undefined
  })

  ipcMain.handle("mcode:browser-act", (event, raw: unknown, id?: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const what = actionOf(BROWSER_ACTS, raw)
    return window && what ? act(window, what, typeof id === "string" && id ? id : undefined) : undefined
  })

  ipcMain.handle("mcode:browser-screenshot", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window ? screenshot(window).catch(() => false) : false
  })

  // The page menu's clears: an empty answer is success, anything else is the reason.
  ipcMain.handle("mcode:browser-clear-site", async (_event, what: "cookies" | "cache") => {
    try {
      await clearSiteData(what === "cookies" ? "cookies" : "cache")
      return ""
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })

  // Settings' clear-browsing-data: an empty answer is success, anything else is the reason.
  ipcMain.handle("mcode:browser-clear-data", async () => {
    try {
      await clearBrowsingData()
      return ""
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })

  ipcMain.handle("mcode:browser-tab", (event, what: "new" | "select" | "close", id?: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return undefined
    if (what === "new") return newTab(window)
    if (what === "select") return selectTab(window, String(id ?? ""))
    return closeTab(window, String(id ?? ""))
  })

  /* The switch itself. The renderer holds the config document, so it says. */
  /*
   * What the window is allowed to ask the machine for.
   *
   * Electron grants nothing unless asked, and asked here rather than in the
   * window: a page that could answer its own permission questions is not a
   * permission system. The microphone is allowed because the composer has a
   * button for it that a reader presses; everything else - the camera, the
   * screen, the location, notifications through the web API - is refused,
   * because nothing in this app has a reason to want them.
   */
  session.defaultSession.setPermissionRequestHandler((_contents, permission, done) => {
    done(permission === "media")
  })

  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === "media")

  // The video card switch in settings; before the backend answers, the default (on).
  registerMediaEmbeds(() => backend?.runtime.config.get().videoCardDetails !== false)

  ipcMain.on("mcode:tray", (_event, enabled: boolean) => {
    refreshTray(Boolean(enabled))
    if (hiddenAtLogin && !enabled) {
      hiddenAtLogin = false
      const window = currentWindow()
      if (window && !window.isDestroyed() && !window.isVisible()) window.show()
    }
  })

  /* 开机自启: whether it is offered here, and whether it is on; a change answers with what the OS now says. */
  ipcMain.handle("mcode:launch-at-login", () => {
    const supported = loginItemSupported(process.platform)
    return { supported, enabled: supported && readLaunchAtLogin(app, process.platform, loginItemStore) }
  })
  ipcMain.handle("mcode:set-launch-at-login", (_event, enabled: unknown) => {
    if (!loginItemSupported(process.platform)) return { ok: false, enabled: false }
    return { ok: true, enabled: writeLaunchAtLogin(app, process.platform, loginItemStore, enabled === true) }
  })

  /*
   * Windows Hello's reveal gate. The status asks Hello once and remembers the
   * answer; the switch is written for the next launch and locks this session,
   * so turning it on makes the next reveal ask; the unlock is the prompt itself.
   */
  ipcMain.handle("mcode:user-verify-status", async () => {
    const supported = userVerifySupported(process.platform)
    if (!supported) return { supported, requireGate: false, unlocked: false }
    if (userVerifyAvailable === undefined) userVerifyAvailable = await checkUserVerifyAvailable(userVerifyRunner)
    return { supported, requireGate: userVerifyRequireGate, unlocked: userVerifySession.unlocked, available: userVerifyAvailable }
  })
  ipcMain.handle("mcode:user-verify-set-gate", (_event, enabled: unknown) => {
    if (!userVerifySupported(process.platform)) return { ok: false, requireGate: false }
    const next = enabled === true
    try {
      writeAtomicSync(userVerifyFile, renderUserVerifyPref(next))
    } catch (err) {
      console.warn("[user-verify] the choice could not be saved:", err instanceof Error ? err.message : err)
    }
    userVerifyRequireGate = next
    // Either way the session starts over: turning it on must ask next time, and turning it off has nothing left to unlock.
    userVerifySession.clear()
    return { ok: true, requireGate: next }
  })
  ipcMain.handle("mcode:user-verify-unlock", async (_event, reason: unknown) => {
    if (!userVerifySupported(process.platform)) return { ok: false, outcome: "unsupported" }
    const text = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : "MCode"
    return userVerifySession.ensureUnlocked(userVerifyRunner, userVerifyRequireGate, text)
  })

  /* Answers whether the icon took, so Settings can say so or keep the old one (MiMo's setAppIcon). */
  ipcMain.handle("mcode:app-icon", (event, id: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || typeof id !== "string") return { ok: false }
    const file = appIconFile(id, process.platform === "darwin")
    if (!file) return { ok: false }
    const image = nativeImage.createFromPath(file)
    if (image.isEmpty()) return { ok: false }
    /*
     * MiMo's Dock icon follows the chosen icon (app.dock.setIcon). The window
     * asks at load as well as on a change, so this covers startup too. A macOS
     * window has no icon of its own, and its menu bar tray is left as it was.
     */
    if (process.platform === "darwin") {
      /*
       * The default is the bundle's own icon, so the window's ask at load
       * leaves the Dock alone. Choosing a colourway sets its cut; going back to
       * the default after that sets the default's cut, until the next start
       * shows the bundle's icon again.
       */
      if (id === DEFAULT_APP_ICON && !dockCustomised) return { ok: true }
      app.dock?.setIcon(image)
      dockCustomised = true
      return { ok: true }
    }
    /*
     * Windows takes the colourway's .ico, every size drawn for its size, so the
     * taskbar and title bar pick the one they draw; the 512 PNG this used to
     * set left Windows to shrink it to 16 or 24 itself, softly (R34).
     */
    const ico = process.platform === "win32" ? windowIcoFile(id) : undefined
    const windowImage = ico ? nativeImage.createFromPath(ico) : image
    window.setIcon(windowImage.isEmpty() ? image : windowImage)
    void syncLinuxIcon(file).then((result) => {
      if (result.changed || !result.ok) console.info(`[linux-app-icon-sync] ${result.reason}`)
    })
    /* The corner and the taskbar are the same app; they wear the same icon. */
    trayIcon = id
    if (tray) refreshTray(true)
    return { ok: true }
  })

  /* A reply's score plays through the soundfont beside the asar; the window gets its bytes only once they verify. */
  ipcMain.handle("mcode:soundfont", () =>
    readSoundfont(
      app.isPackaged
        ? path.join(process.resourcesPath, "soundfont", SOUNDFONT.file)
        : path.join(here, "../../resources/soundfont", SOUNDFONT.file),
    ),
  )

  /* MiMo's 显示服务器 (Linux): the saved choice and what it resolves to; elsewhere, unsupported. */
  ipcMain.handle("mcode:display-server", () =>
    process.platform === "linux"
      ? { supported: true, pref: displayServer, effective: ozonePlatform(displayServer, process.env) ?? null }
      : { supported: false, pref: "auto", effective: null },
  )

  /* MiMo's 硬件加速 row: the saved choice. */
  ipcMain.handle("mcode:hardware-acceleration", () => ({ enabled: bootPrefs.hardwareAcceleration }))

  /* Written for the next launch; Chromium has already started with the old one. */
  ipcMain.handle("mcode:set-hardware-acceleration", (_event, raw: unknown) => {
    const enabled = raw !== false
    saveBootPrefs({ hardwareAcceleration: enabled })
    return { ok: true, enabled }
  })

  /* Written for the next launch; the running one keeps the switches it started with. */
  ipcMain.handle("mcode:set-display-server", (_event, raw: unknown) => {
    if (process.platform !== "linux") return { ok: false }
    const pref = displayServerPref(raw)
    writeAtomicSync(displayServerFile, JSON.stringify({ displayServer: pref }))
    displayServer = pref
    return { ok: true, pref }
  })

  /*
   * MiMo's setNativeTheme. Setting the source raises nativeTheme's "updated",
   * which repaints every window's background and caption band; the choice is
   * kept so the next launch paints right before any page has loaded.
   */
  ipcMain.on("mcode:native-theme", (_event, raw: unknown) => {
    const theme = themePref(raw)
    if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme
    if (bootPrefs.theme !== theme) saveBootPrefs({ theme })
  })

  ipcMain.on("mcode:titlebar-mode", (event, raw: unknown) => {
    const mode = titlebarMode(raw)
    if (mode) setTitlebarMode(BrowserWindow.fromWebContents(event.sender), mode)
  })

  /* MiMo's winIsFullscreen / winExitFullscreen, answered for the window that asks. */
  ipcMain.handle("mcode:is-fullscreen", (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false)
  ipcMain.on("mcode:exit-fullscreen", (event) => BrowserWindow.fromWebContents(event.sender)?.setFullScreen(false))

  /*
   * Whether Chromium has found assistive technology (a screen reader, or
   * another client of the accessibility tree) - the terminal only builds its
   * row-by-row reading view while one is there. Beyond MiMo, whose terminal
   * never builds it.
   */
  ipcMain.handle("mcode:screen-reader", () => app.accessibilitySupportEnabled)
  app.on("accessibility-support-changed", (_event, enabled) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("mcode:screen-reader", enabled)
  })

  /* MiMo's menu follows the shortcuts as bound, and drops them while one is being recorded. */
  const windowMenuKeys = new WeakMap<Electron.WebContents, MenuKeys>()
  app.on("browser-window-focus", (_event, window) => {
    buildMenu(windowMenuKeys.get(window.webContents) ?? { binds: {}, recording: false })
  })
  ipcMain.on("mcode:menu-keys", (event, raw: unknown) => {
    const keys = readMenuKeys(raw)
    if (!keys) return
    windowMenuKeys.set(event.sender, keys)
    event.sender.setIgnoreMenuShortcuts(keys.recording)
    const focused = BrowserWindow.getFocusedWindow()
    if (!focused || focused.webContents === event.sender) buildMenu(keys)
  })

  ipcMain.on("mcode:window", (event, raw: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    switch (actionOf(WINDOW_ACTIONS, raw)) {
      case "minimize":
        return window.minimize()
      case "close":
        return window.close()
      case "maximize":
        return toggleMaximize(window)
    }
  })

  buildMenu()
  createWindow(!hiddenAtLogin)
  if (hiddenAtLogin) console.info("[login-item] started at login: the window stays in the tray")
  keepWindowsOnScreen()
  repaintAfterWake(leaving)

  /*
   * session-end is a window event, so it is registered per window (see
   * createWindow). Two cases have no window to register it on: macOS and Linux,
   * which have no session-end at all, and a renderer recovery that has given
   * up. powerMonitor covers the first; onRecoveryGaveUp covers the second.
   */
  powerMonitor.on("shutdown", () => {
    console.info("[quit] powerMonitor shutdown")
    noteOsQuit()
  })

  /*
   * The reveal gate is for this session only: a locked screen or a suspend
   * ends it, so whoever comes back is asked again before credentials show.
   */
  powerMonitor.on("lock-screen", () => userVerifySession.clear())
  powerMonitor.on("suspend", () => userVerifySession.clear())

  /*
   * N11-16: waking up. A provider stream that was open when the machine slept
   * is dead on the other side and looks alive from here, so the turn used to
   * wait out the eight-minute quiet bound with the spinner turning; and a wait
   * between attempts had no reason to keep waiting either. Both are ended here,
   * and the retry ladder takes it from there.
   */
  const woke = (why: string) => {
    const cut = cutLiveStreams(why)
    if (cut) console.info(`[power] ${why}: ${cut} provider stream(s) cut`)
    wakeWaiters(why)
  }
  powerMonitor.on("resume", () => woke("the machine woke"))
  /* The network coming back, which only the window can see (navigator.onLine). */
  ipcMain.on("mcode:network-back", () => woke("the network came back"))
  onRecoveryGaveUp(() => {
    console.info("[quit] renderer recovery gave up; no window is left to notice an OS shutdown")
    noteOsQuit()
  })

  app.on("activate", () => {
    if (closing) return
    // Asked for again while leaving full screen to hide: it stays (MiMo's).
    for (const window of BrowserWindow.getAllWindows()) cancelPendingHide(window)
    // A window hidden to the tray or menu bar comes back; one whose renderer is gone is replaced.
    activate(raise)
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

/*
 * Two different questions, which used to share one flag and so answered each
 * other wrongly (N11-1).
 *
 * `osQuitting`: the OS is taking the app away - Windows query-session-end or
 * session-end, or powerMonitor's shutdown elsewhere. It only tells the close
 * rule below to let the last window go instead of hiding it to the tray, and
 * tells the wake repaint to stay out of the way.
 *
 * `closing`: before-quit has already run once. It is nothing but a reentry
 * guard, so that the second app.quit() at the end of the teardown does not
 * start the teardown again, and it tells a launch arriving meanwhile to wait
 * for the quit (I13-2).
 *
 * This comment used to say that the shared flag made a Windows shutdown skip
 * backend.close(). The flag was not what did it: Electron emits no before-quit
 * at all when Windows ends the app, so the teardown never ran whatever the flag
 * said. It runs now because query-session-end asks for the quit (I13-3).
 */
let osQuitting = false
let closing = false

/** Either kind of going away, for the close rule and the wake repaint. */
const leaving = () => osQuitting || closing

/*
 * The updater, once electron-updater has loaded; noteOsQuit needs it
 * synchronously, before the quit it announces reaches electron-updater's own
 * quit handler.
 */
let liveUpdater: Updater | undefined

/**
 * The OS is taking the app away; the last window must not hide to the tray,
 * and a downloaded update must not start installing while Windows ends the
 * session (it could be killed halfway and leave no MCode.exe). MiMo never
 * quits there at all; MCode quits to run its teardown, so it holds the
 * install instead, and the update installs on the next ordinary quit.
 */
function noteOsQuit(): void {
  osQuitting = true
  liveUpdater?.holdInstallOnQuit()
  beginIntentionalQuit()
}

/**
 * Electron does not await an async `before-quit` listener, so the previous
 * version raced the shutdown: whatever sat after an `await` inside close() was
 * not guaranteed to run before the process went away. Today that is only the
 * socket server, which the OS would tear down anyway - but the teardown that
 * does matter (killing spawned shells, dropping clients) happens to run
 * synchronously ahead of it, and relying on that is a trap for the next thing
 * added to close(). Hold the quit, close, then quit for real.
 */
app.on("before-quit", (event) => {
  /* A quit asked for elsewhere (the tray, the system, a session ending) ends a Cmd+Q that is still waiting for its second press. */
  forgetQuitArm()
  if (closing) return
  // Nothing has been started at all: an install asked for goes ahead at once.
  if (!startingBackend) return runPendingInstall()
  event.preventDefault()
  closing = true
  // MiMo saves every window's state as the app quits, while they are still where the person left them.
  for (const window of windows) saveWindowState(window)
  /*
   * Out of sight while the backend closes. Ending the terminals takes about
   * three seconds on Windows, and a window left standing through that looks
   * as if the app has frozen rather than as if it is quitting.
   */
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.hide()
  // Bounded, so a backend that will not close cannot trap the app open; above
  // the terminals' own four-second bound so that bound is the one that applies.
  const teardown = startingBackend.then(
    (started) => started.close(),
    // A backend that never started has nothing to close, and the error is already reported.
    () => undefined,
  )
  const closed = Promise.race([teardown, new Promise((resolve) => setTimeout(resolve, 5000))])
  // Then the installer, if the person asked for one (MiMo quits into it; see mcode:install-update).
  void closed.finally(() => {
    runPendingInstall()
    app.quit()
  })
})
