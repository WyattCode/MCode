import fs from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { execFile } from "node:child_process"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, clipboard, ipcMain, dialog, shell, nativeImage, nativeTheme, Notification, powerSaveBlocker, screen, Tray, Menu, session, systemPreferences, type Rectangle } from "electron"
import { PowerHold } from "./power"
import { DailyLog, LOG_DIR } from "./log-file"
import { BOOT_DEFAULTS, BOOT_PREFS_FILE, readBootPrefs, themePref, windowBackground, writeBootPrefs, type BootPrefs } from "./boot-prefs"
import { startBackend, type Backend } from "../server/index"
import { scratchRoot } from "../server/scratch"
import { LINK_SCHEME, linkInArgs, parseSessionLink } from "@shared/session-link"
import { closeHidesToTray } from "@shared/protocol"
import { label, setLabels } from "./labels"
import { buildMenu } from "./menu"
import {
  activate,
  beginIntentionalQuit,
  captureConsole,
  currentWindow,
  markClosing,
  recordProcessError,
  relaunch,
  setRecoveryHost,
  wireProcessRecovery,
  wireRecovery,
} from "./recovery"
import { isKnownOpenWith } from "@shared/open-app"
import { installedOpenAppIcons, installedOpenApps } from "./installed-apps"
import { DEFAULT_APP_ICON } from "@shared/app-icons"
import { applyZoom } from "./zoom"
import { WINDOW_MIN, badgeCount, noticeTitle, readTaskNotice, textMenuItems, wantsNotice } from "./desktop-rules"
import { registerOffice } from "./office"
import { registerComposerInput } from "./composer-input"
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
  closePanel,
  closeTab,
  navigate,
  newTab,
  openPanel,
  panelState,
  screenshot,
  selectTab,
  setBounds,
  type BrowserAct,
  type BrowserBounds,
} from "./browser"
import { captionOverlay, refreshTitlebar, setTitlebarMode } from "./titlebar"
import { restore, track } from "./window-state"
import { keepWindowsOnScreen, repaintAfterWake } from "./displays"
import { boundsOnShow, closeBounds } from "./work-area"
import { createUpdater, parseFeed, type FeedEntry, type UpdateState } from "./updater"
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
}

/*
 * MiMo's log files, opened as the module loads so that whatever is said on the
 * way up - Chromium switches, the backend starting, a failure to start - is on
 * disk. Old days are pruned here and on each day change.
 */
const logs = new DailyLog({ dir: path.join(app.getPath("userData"), LOG_DIR) })
captureConsole(logs)
app.on("will-quit", () => void logs.close())
process.on("uncaughtException", (error) => recordProcessError("uncaught exception", error))
process.on("unhandledRejection", (reason) => recordProcessError("unhandled rejection", reason))

/*
 * MiMo's native theme at boot: the saved app theme is applied before any
 * window exists, so the first paint, the text context menu, the tray menu and
 * message boxes already match a dark app on a light system (and the reverse).
 */
const bootPrefsFile = path.join(app.getPath("userData"), BOOT_PREFS_FILE)
let bootPrefs: BootPrefs = { ...BOOT_DEFAULTS }
try {
  bootPrefs = readBootPrefs(readFileSync(bootPrefsFile, "utf8"))
} catch {
  // No file yet: follow the system.
}
nativeTheme.themeSource = bootPrefs.theme

/* MiMo's 硬件加速: Chromium only takes this before ready, so a change waits for the next launch. */
if (!bootPrefs.hardwareAcceleration) app.disableHardwareAcceleration()

/* Written for the next launch; a failed write only means the next boot uses the old choice. */
function saveBootPrefs(patch: Partial<BootPrefs>): Promise<void> {
  bootPrefs = { ...bootPrefs, ...patch }
  return fs.writeFile(bootPrefsFile, writeBootPrefs(bootPrefs), "utf8").catch((error) => console.warn("[boot-prefs] not saved", error))
}

let backend: Backend | undefined

const windows = new Set<BrowserWindow>()

/*
 * A session link that arrived before a window could show it: the one the app
 * was started with, or one handed over while it was still starting. The window
 * asks for it once it has connected.
 */
let pendingLink: string | undefined = linkInArgs(process.argv)

/*
 * One running copy per profile, so a link clicked while the app is open lands
 * in that copy instead of starting a second one beside it. Packaged builds
 * only: a development build shares its profile with the installed app and must
 * not quit because the installed one happens to be open.
 */
if (app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0)

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

/** Shows a linked session in the window that is up, or keeps it for the first one. */
function deliverLink(raw: string) {
  const target = parseSessionLink(raw)
  if (!target) return
  const window = [...windows].find((entry) => !entry.isDestroyed())
  if (!window || window.webContents.isLoading()) {
    pendingLink = raw
    return
  }
  raise(window)
  window.webContents.send("mcode:open-link", target)
}

app.on("second-instance", (_event, argv) => {
  const raw = linkInArgs(argv)
  if (raw) return deliverLink(raw)
  activate(raise)
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

/** The file an id names, or nothing if it names none. */
function appIconFile(id: string): string | undefined {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) return undefined
  const file = app.isPackaged
    ? path.join(process.resourcesPath, "app-icons", id + ".png")
    : path.join(here, "../../resources/app-icons", id + ".png")
  return existsSync(file) ? file : undefined
}

/*
 * What the tray's 配置切换 offers: the models the window's picker offers, with
 * the one in use checked. The window holds the config, so it sends the list.
 */
interface TrayProfile {
  key: string
  label: string
  checked: boolean
}
let trayProfiles: TrayProfile[] = []

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
  const file = appIconFile(trayIcon)
  if (!file) return
  // 16 logical pixels is what Windows and Linux draw; macOS takes the same and
  // scales it. The source is 512, so this is a reduction rather than a stretch.
  const image = nativeImage.createFromPath(file).resize({ width: 16, height: 16 })
  /* MiMo's tray opens the window on a click and on a double-click alike; it never hides it. */
  const open = () => activate(raise)
  if (!tray) {
    tray = new Tray(image)
    tray.on("click", open)
    tray.on("double-click", open)
  } else tray.setImage(image)

  /*
   * MiMo's 配置切换 presentation: entries grouped (MiMo by app, here by the
   * provider each key starts with) with a rule between groups.
   */
  const grouped = new Map<string, TrayProfile[]>()
  for (const entry of trayProfiles) {
    const provider = entry.key.slice(0, Math.max(0, entry.key.indexOf("/")))
    grouped.set(provider, [...(grouped.get(provider) ?? []), entry])
  }
  const profiles: Electron.MenuItemConstructorOptions[] = trayProfiles.length
    ? [...grouped.values()].flatMap((group, index): Electron.MenuItemConstructorOptions[] => [
        ...(index > 0 ? [{ type: "separator" as const }] : []),
        ...group.map((entry) => ({
          label: entry.label,
          type: "radio" as const,
          checked: entry.checked,
          click: () => {
            const window = currentWindow() ?? createWindow()
            window.webContents.send("mcode:tray-profile", entry.key)
          },
        })),
      ])
    : [{ label: label("tray.profilesEmpty", "(None)"), enabled: false }]

  tray.setToolTip(app.getName())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: label("tray.open", "Open MCode"), click: open },
      // MiMo puts a rule before 配置切换 as well as before quit.
      { type: "separator" },
      { label: label("tray.profiles", "Switch Profile"), submenu: profiles },
      { type: "separator" },
      {
        // A real quit, past the close-to-tray rule below.
        label: label("menu.quitApp", "Quit MCode"),
        click: () => {
          beginIntentionalQuit()
          app.quit()
        },
      },
    ]),
  )
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
    // MiMo's traffic lights, 5 in and 15 down.
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 5, y: 15 } } : {}),
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
      preload: path.join(here, "../preload/index.mjs"),
      sandbox: false,
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
  if (saved.maximized) window.maximize()
  if (saved.fullScreen) window.setFullScreen(true)
  // getNormalBounds covers the first run, where the OS picked the position.
  track(window, saved.x !== undefined && saved.y !== undefined ? (saved as Rectangle) : window.getNormalBounds())

  // A pinch or Ctrl+wheel scales the page without going through applyZoom, so
  // the band has to follow that as well as the menu and keyboard paths.
  window.webContents.on("zoom-changed", () => refreshTitlebar(window))
  window.webContents.on("did-finish-load", () => refreshTitlebar(window))

  window.once("ready-to-show", () => {
    if (show) window.show()
  })
  window.on("closed", () => windows.delete(window))

  /*
   * MiMo's session-end: Windows is shutting down or logging off. That is a
   * quit, so the close rule below lets the window go instead of hiding it to
   * the tray, which would otherwise hold up the shutdown.
   */
  window.on("session-end", () => {
    console.info("[quit] session-end (OS shutdown or logoff)")
    quitting = true
    beginIntentionalQuit()
  })

  /*
   * MiMo's close rule: the last window hides to the tray (always, on macOS)
   * instead of closing, and the app keeps running. A quit in progress, or any
   * other window still open, closes as usual. window-state's own close listener
   * has already saved the bounds, and a hidden window keeps them for its next show.
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
      quitting,
      otherWindows: others,
      platform: process.platform,
      trayEnabled: Boolean(tray),
    })
    if (!hide) {
      // The close goes ahead, so the contents going away next is not a failure to recover from.
      markClosing(window)
      return
    }
    event.preventDefault()
    hiddenBounds = window.isFullScreen() ? undefined : window.getBounds()
    if (process.platform === "darwin" && window.isFullScreen()) {
      window.once("leave-full-screen", () => window.hide())
      window.setFullScreen(false)
    } else window.hide()
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
  // Packaged only: a development build would register the bare Electron binary.
  if (app.isPackaged) app.setAsDefaultProtocolClient(LINK_SCHEME)

  backend = await startBackend(app.getPath("userData"))

  /*
   * MiMo keeps the machine from suspending while a turn runs. The runner's busy
   * set is the truth; every backend event is a moment it may have changed, and
   * re-reading a handful of ids costs nothing next to the event itself.
   */
  const powerHold = new PowerHold(powerSaveBlocker, (line) => console.info(line))
  const runtime = backend.runtime
  runtime.bus.subscribe(() => powerHold.sync(runtime.runner.busySessions()))

  // The renderer has no Node access; this is how it learns where to connect.
  ipcMain.handle("mcode:bootstrap", () => ({
    port: backend!.port,
    platform: process.platform,
    home: app.getPath("home"),
    // app.getVersion() reports Electron's version until the app is packaged,
    // so take the real one from package.json - the bundler inlines it.
    version: pkg.version,
  }))

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
   * MiMo's default project location, made if need be: the folder chosen in
   * settings, else the one under the home folder; nothing when neither can be made.
   */
  const projectLocation = async (): Promise<string | undefined> => {
    const chosen = backend?.runtime.config.get().projectRoot ?? ""
    for (const candidate of [scratchRoot(chosen), scratchRoot()]) {
      try {
        await fs.mkdir(candidate, { recursive: true })
        return candidate
      } catch {
        // The chosen folder may be on a drive since unplugged; try the default.
      }
    }
    return undefined
  }

  /* MiMo lets one folder dialog up at a time: a second ask while one is open gets nothing. */
  let folderDialogOpen = false

  /* `project` is MiMo's 选择或新建项目文件夹: it opens at the default project location. */
  ipcMain.handle("mcode:pick-directory", async (event, title: string, multiple?: boolean, project?: boolean) => {
    if (folderDialogOpen) return []
    folderDialogOpen = true
    try {
      const owner = BrowserWindow.fromWebContents(event.sender)
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
      folderDialogOpen = false
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
  const inside = (directory: string, relative: string): string | undefined => {
    const root = path.resolve(directory)
    const target = path.resolve(root, relative)
    const within = target === root || target.startsWith(root + path.sep)
    return within ? target : undefined
  }

  ipcMain.on("mcode:menu-labels", (_event, next: Record<string, string>) => {
    setLabels(next)
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
        : label("notify.done", "Task completed")
    try {
      const note = new Notification({ title: noticeTitle(app.getName(), notice), body, silent: notice.silent })
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

  ipcMain.on("mcode:clipboard-write", (_event, text: string) => clipboard.writeText(text))

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

  /* MiMo's micAccess before capture: macOS asks for the microphone; other systems answer in getUserMedia. */
  ipcMain.handle("mcode:mic-access", async () => {
    if (process.platform !== "darwin") return true
    const status = systemPreferences.getMediaAccessStatus("microphone")
    if (status === "granted") return true
    if (status === "not-determined") return systemPreferences.askForMediaAccess("microphone")
    return false
  })

  ipcMain.on(
    "mcode:edit",
    (event, action: "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "selectAll") => {
      const contents = event.sender
      if (action === "undo") contents.undo()
      else if (action === "redo") contents.redo()
      else if (action === "cut") contents.cut()
      else if (action === "copy") contents.copy()
      else if (action === "paste") contents.paste()
      else if (action === "delete") contents.delete()
      else contents.selectAll()
    },
  )

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
   * MiMo's automatic updates, on MCode's own JSON feed: the first check 5 s
   * after launch, then every 3 h, silent on failure, with a newer installer
   * downloaded in the background (see updater.ts). Every phase change goes to
   * the windows; the capsule and the settings row react to a ready update.
   *
   * The feed and the installer are fetched out here. The window is served under
   * a content policy that reaches the local backend and nothing else, which is
   * right for a page that renders model output; relaxing it for one command
   * would open every other path with it.
   */
  const MAX_INSTALLER = 400_000_000
  const updater = createUpdater({
    currentVersion: pkg.version,
    feedURL: () => backend?.runtime.config.get().updateFeed ?? "",
    fetchFeed: async (address) => {
      if (!/^https?:\/\//.test(address)) throw new Error("the feed must be an http address")
      const response = await fetch(address, { cache: "no-store" })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return parseFeed(await response.json())
    },
    /*
     * The OS temporary directory, under a name taken from the version rather
     * than the URL: a name that came over the network does not decide where a
     * file is written.
     */
    installerFile: (entry: FeedEntry) => {
      const safe = entry.version.replace(/[^0-9A-Za-z._-]/g, "") || "update"
      const suffix = process.platform === "win32" ? ".exe" : process.platform === "darwin" ? ".dmg" : ".AppImage"
      return path.join(app.getPath("temp"), `mcode-${safe}${suffix}`)
    },
    readFile: (file) => fs.readFile(file).catch(() => undefined),
    sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    download: async (entry, file) => {
      /*
       * https, not http. The feed may be plain http - it is only read. This
       * file is run, and fetching an executable over a connection anyone on the
       * path can rewrite is remote code execution with extra steps.
       */
      if (!/^https:\/\//.test(entry.url)) throw new Error("the installer must be at an https address")
      const response = await fetch(entry.url, { cache: "no-store" })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      // A ceiling, checked before the body is in memory, and again as chunks arrive for a server that declares no length.
      const declared = Number(response.headers.get("content-length") ?? "")
      if (Number.isFinite(declared) && declared > MAX_INSTALLER) throw new Error("the installer is too large")
      const chunks: Buffer[] = []
      let seen = 0
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        seen += chunk.byteLength
        if (seen > MAX_INSTALLER) throw new Error("the installer is too large")
        chunks.push(Buffer.from(chunk))
      }
      const body = Buffer.concat(chunks)

      /*
       * If the feed said what it should hash to, it has to: https alone says the
       * bytes arrived unaltered from whoever answered, not that they are the
       * right bytes.
       */
      if (entry.sha256 && createHash("sha256").update(body).digest("hex") !== entry.sha256) {
        throw new Error("the installer does not match the checksum the feed gave")
      }
      await fs.writeFile(file, body)
    },
    emit: (state: UpdateState) => {
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send("mcode:update-state", state)
    },
    log: (line) => console.info(line),
  })
  ipcMain.handle("mcode:update-status", () => updater.state())
  ipcMain.handle("mcode:update-check", () => updater.checkNow())
  updater.start()
  app.on("before-quit", () => updater.stop())

  /*
   * Only what the updater downloaded or verified. The renderer names no path
   * here - it asks to install "the one that is ready" - so a window cannot talk
   * the app into launching an arbitrary executable.
   */
  ipcMain.handle("mcode:install-update", async () => {
    const file = updater.readyFile()
    if (!file) throw new Error("no update has been downloaded")
    /*
     * MiMo's installing notice: shown before the app goes, and given up to 1.5 s
     * to be delivered so it is on screen as the window disappears. Worded in the
     * window's language through the published labels.
     */
    let notice: Notification | undefined
    try {
      if (Notification.isSupported()) {
        notice = new Notification({
          title: label("update.installingTitle", "Installing the MCode update"),
          body: label(
            "update.installingBody",
            "MCode closes so the installer can put the new version in place. When it finishes, the installer can open MCode again.",
          ),
        })
        const delivered = deliveryOf(notice)
        notice.show()
        await waitForDelivery(delivered)
      }
    } catch {
      // No notice is no reason not to install.
    }
    const failure = await shell.openPath(file)
    if (failure) {
      notice?.close()
      throw new Error(failure)
    }
    beginIntentionalQuit()
    app.quit()
    return true
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
  ipcMain.on("mcode:quit", () => {
    beginIntentionalQuit()
    app.quit()
  })

  ipcMain.on("mcode:view", (event, action: "reload" | "devtools" | "fullscreen") => {
    const contents = event.sender
    if (action === "reload") {
      contents.reload()
      return
    }
    if (action === "devtools") {
      contents.toggleDevTools()
      return
    }
    const window = BrowserWindow.fromWebContents(contents)
    window?.setFullScreen(!window.isFullScreen())
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
  ipcMain.handle("mcode:reveal-file", (_event, directory: string, relative: string) => {
    const target = inside(directory, relative)
    if (!target) return { ok: false, error: "outside the project" }
    if (!existsSync(target)) return { ok: false, missing: true }
    shell.showItemInFolder(target)
    return { ok: true }
  })

  // MiMo's Office tab: document bytes, watching, versions, legacy conversion.
  registerOffice(ipcMain, app.getPath("userData"))
  registerComposerInput(ipcMain, app.getPath("userData"))

  /* Which open-with apps are installed, for the settings row and the open-location menu. */
  ipcMain.handle("mcode:installed-apps", () => installedOpenApps(process.platform))
  // MiMo's 默认打开目标 draws each app's own icon; small icons, as data URLs the renderer can show.
  ipcMain.handle("mcode:installed-app-icons", () =>
    installedOpenAppIcons(async (file) => (await app.getFileIcon(file, { size: "small" })).toDataURL(), process.platform),
  )

  // MiMo's 下载副本 on a delivered file: a copy in Downloads, no dialog.
  ipcMain.handle("mcode:save-copy", (_event, file: unknown) => saveCopy(file, app.getPath("downloads")))

  ipcMain.handle("mcode:open-file", async (_event, directory: string, relative: string, openWith?: unknown) => {
    const target = inside(directory, relative)
    if (!target) return "outside the project"
    // No app named: hand it to the desktop, which is the default choice.
    if (openWith === undefined || openWith === null) {
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
    const [command, args] =
      process.platform === "darwin" ? ["open", ["-a", openWith, target]] : [openWith, [target]]
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
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      defaultPath: suggested,
      // Taken from the name the caller suggested. A fixed Markdown filter used
      // to be applied to all three callers, and Windows would then coerce .md
      // onto the shared HTML page - a file the browser would no longer open.
      filters: [saveFilter(suggested)],
    }
    // Sheeted to the window when there is one, so it cannot be lost behind it.
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
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
  ipcMain.handle("mcode:browser-open", (event, bounds: BrowserBounds) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return undefined
    openPanel(window, bounds, (state) => {
      if (!window.isDestroyed()) window.webContents.send("mcode:browser-state", state)
    })
    return panelState(window)
  })

  ipcMain.on("mcode:browser-bounds", (event, bounds: BrowserBounds) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) setBounds(window, bounds)
  })

  ipcMain.on("mcode:browser-close", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) closePanel(window)
  })

  ipcMain.handle("mcode:browser-navigate", (event, input: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window ? navigate(window, String(input)) : undefined
  })

  ipcMain.handle("mcode:browser-act", (event, what: BrowserAct, id?: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window ? act(window, what, typeof id === "string" && id ? id : undefined) : undefined
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

  registerMediaEmbeds()

  ipcMain.on("mcode:tray", (_event, enabled: boolean) => {
    refreshTray(Boolean(enabled))
  })

  /* The 配置切换 list, checked here because it arrives from a window. */
  ipcMain.on("mcode:tray-profiles", (_event, list: unknown) => {
    if (!Array.isArray(list)) return
    trayProfiles = list
      .filter(
        (entry): entry is TrayProfile =>
          Boolean(entry) &&
          typeof entry.key === "string" &&
          typeof entry.label === "string" &&
          typeof entry.checked === "boolean",
      )
      .slice(0, 40)
      .map((entry) => ({ key: entry.key, label: entry.label.slice(0, 120), checked: entry.checked }))
    if (tray) refreshTray(true)
  })

  /* Answers whether the icon took, so Settings can say so or keep the old one (MiMo's setAppIcon). */
  ipcMain.handle("mcode:app-icon", (event, id: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || typeof id !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(id)) return { ok: false }
    const file = app.isPackaged
      ? path.join(process.resourcesPath, "app-icons", id + ".png")
      : path.join(here, "../../resources/app-icons", id + ".png")
    if (!existsSync(file)) return { ok: false }
    const image = nativeImage.createFromPath(file)
    if (image.isEmpty()) return { ok: false }
    /*
     * MiMo's Dock icon follows the chosen icon (app.dock.setIcon). The window
     * asks at load as well as on a change, so this covers startup too. A macOS
     * window has no icon of its own, and its menu bar tray is left as it was.
     */
    if (process.platform === "darwin") {
      app.dock?.setIcon(image)
      return { ok: true }
    }
    window.setIcon(image)
    /* The corner and the taskbar are the same app; they wear the same icon. */
    trayIcon = id
    if (tray) refreshTray(true)
    return { ok: true }
  })

  /* MiMo's 显示服务器 (Linux): the saved choice and what it resolves to; elsewhere, unsupported. */
  ipcMain.handle("mcode:display-server", () =>
    process.platform === "linux"
      ? { supported: true, pref: displayServer, effective: ozonePlatform(displayServer, process.env) ?? null }
      : { supported: false, pref: "auto", effective: null },
  )

  /* MiMo's 硬件加速 row: the saved choice. */
  ipcMain.handle("mcode:hardware-acceleration", () => ({ enabled: bootPrefs.hardwareAcceleration }))

  /* Written for the next launch; Chromium has already started with the old one. */
  ipcMain.handle("mcode:set-hardware-acceleration", async (_event, raw: unknown) => {
    const enabled = raw !== false
    await saveBootPrefs({ hardwareAcceleration: enabled })
    return { ok: true, enabled }
  })

  /* Written for the next launch; the running one keeps the switches it started with. */
  ipcMain.handle("mcode:set-display-server", async (_event, raw: unknown) => {
    if (process.platform !== "linux") return { ok: false }
    const pref = displayServerPref(raw)
    await fs.writeFile(displayServerFile, JSON.stringify({ displayServer: pref }), "utf8")
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
    if (bootPrefs.theme !== theme) void saveBootPrefs({ theme })
  })

  ipcMain.on("mcode:titlebar-mode", (event, mode: "dark" | "light") => {
    setTitlebarMode(BrowserWindow.fromWebContents(event.sender), mode)
  })

  /* MiMo's winIsFullscreen / winExitFullscreen, answered for the window that asks. */
  ipcMain.handle("mcode:is-fullscreen", (event) => BrowserWindow.fromWebContents(event.sender)?.isFullScreen() ?? false)
  ipcMain.on("mcode:exit-fullscreen", (event) => BrowserWindow.fromWebContents(event.sender)?.setFullScreen(false))

  ipcMain.on("mcode:window", (event, action: "minimize" | "maximize" | "close") => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (action === "minimize") window.minimize()
    else if (action === "close") window.close()
    else if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  buildMenu()
  createWindow()
  keepWindowsOnScreen()
  repaintAfterWake(() => quitting)

  app.on("activate", () => {
    // A window hidden to the tray or menu bar comes back; one whose renderer is gone is replaced.
    activate(raise)
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

let quitting = false

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
  if (quitting || !backend) return
  event.preventDefault()
  quitting = true
  /*
   * Out of sight while the backend closes. Ending the terminals takes about
   * three seconds on Windows, and a window left standing through that looks
   * as if the app has frozen rather than as if it is quitting.
   */
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.hide()
  // Bounded, so a backend that will not close cannot trap the app open; above
  // the terminals' own four-second bound so that bound is the one that applies.
  const closed = Promise.race([backend.close(), new Promise((resolve) => setTimeout(resolve, 5000))])
  void closed.finally(() => app.quit())
})
