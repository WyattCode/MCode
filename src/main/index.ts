import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { execFile } from "node:child_process"
import path from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, clipboard, ipcMain, dialog, shell, nativeImage, nativeTheme, Notification, type Rectangle } from "electron"
import { startBackend, type Backend } from "../server/index"
import { setLabels } from "./labels"
import { buildMenu } from "./menu"
import { beginIntentionalQuit, captureConsole, relaunch, wireProcessRecovery, wireRecovery } from "./recovery"
import { isKnownOpenWith } from "@shared/open-app"
import { applyZoom } from "./zoom"
import { captionOverlay, refreshTitlebar, setTitlebarMode } from "./titlebar"
import { cascade, restore, track } from "./window-state"
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

let backend: Backend | undefined

/*
 * Where the last downloaded installer went. Held here rather than passed back
 * and forth, so installing can only ever run the file this process fetched.
 */
let installerPath: string | undefined
const windows = new Set<BrowserWindow>()

/** Files written through the save dialog, and so safe to show in the shell. */
const savedFiles = new Set<string>()

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

function createWindow(): BrowserWindow {
  const saved = restore()
  // Only the first window inherits the remembered geometry - and only it writes
  // it back, so "where I left it" keeps meaning the main window rather than
  // whichever extra window happened to close last.
  const existing = [...windows].find((entry) => !entry.isDestroyed())
  const spot = existing ? cascade(existing.getNormalBounds()) : saved

  const window = new BrowserWindow({
    x: spot.x,
    y: spot.y,
    width: spot.width,
    height: spot.height,
    minWidth: 720,
    minHeight: 480,
    show: false,
    // The renderer draws its own title bar so the window matches the app's
    // dark chrome instead of the OS default.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
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
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
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
  wireRecovery(window, String(window.id))

  // The renderer paints over this, but it is what shows during a resize or
  // before the first frame - so it has to track the OS theme, not just sample
  // it once at creation.
  const paintBackground = () => {
    if (window.isDestroyed()) return
    window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff")
    // The overlay is painted by the OS and does not follow the page's colours.
    refreshTitlebar(window)
  }
  nativeTheme.on("updated", paintBackground)
  window.on("closed", () => nativeTheme.off("updated", paintBackground))

  // Maximise before the first paint, so the window does not appear at its
  // restored size and then jump.
  if (!existing) {
    if (saved.maximized) window.maximize()
    if (saved.fullScreen) window.setFullScreen(true)
    // getNormalBounds covers the first run, where the OS picked the position.
    track(window, saved.x !== undefined && saved.y !== undefined ? (spot as Rectangle) : window.getNormalBounds())
  }

  // A pinch or Ctrl+wheel scales the page without going through applyZoom, so
  // the band has to follow that as well as the menu and keyboard paths.
  window.webContents.on("zoom-changed", () => refreshTitlebar(window))
  window.webContents.on("did-finish-load", () => refreshTitlebar(window))

  window.once("ready-to-show", () => window.show())
  window.on("closed", () => windows.delete(window))

  // Anything the page tries to open externally goes to the real browser, never
  // into an Electron window with preload access.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url)
    return { action: "deny" }
  })

  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) void window.loadURL(devServer)
  else void window.loadFile(path.join(here, "../renderer/index.html"))

  windows.add(window)
  return window
}

app.whenReady().then(async () => {
  /*
   * Both before the backend starts, so that whatever it says on the way up -
   * and a failure to come up at all - is already being kept by the time it
   * happens. That record is the only thing a packaged build has to offer when
   * someone asks what went wrong.
   */
  captureConsole()
  wireProcessRecovery()

  backend = await startBackend(app.getPath("userData"))

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
  ipcMain.handle("mcode:pick-directory", async (event, title: string, multiple?: boolean) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(owner!, {
      properties: multiple
        ? ["openDirectory", "createDirectory", "multiSelections"]
        : ["openDirectory", "createDirectory"],
      title,
    })
    return result.canceled ? [] : result.filePaths
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
    buildMenu(createWindow)
  })

  /*
   * A desktop notification, raised only while the window is in the background.
   *
   * Telling someone their turn finished while they are watching it finish is
   * noise; the point of the notification is to reach them when they have gone
   * to do something else. Clicking it brings the window back.
   */
  ipcMain.on("mcode:notify", (event, title: string, body: string, sessionID?: string) => {
    if (!Notification.isSupported()) return
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner && owner.isFocused()) return
    const note = new Notification({ title, body, silent: true })
    note.on("click", () => {
      if (!owner || owner.isDestroyed()) return
      if (owner.isMinimized()) owner.restore()
      owner.show()
      owner.focus()
      // And on to what it was about. Raising the window left the reader on
      // whatever session they had open, which is the one they already knew
      // about; the reference navigates to the session that spoke.
      if (sessionID) owner.webContents.send("mcode:notify-click", sessionID)
    })
    note.show()
  })

  ipcMain.handle("mcode:clipboard-text", () => clipboard.readText())

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
   * The update feed, fetched out here.
   *
   * The window is served under a content policy that allows it to open a socket
   * to the local backend and reach nothing else, which is the right policy for
   * a page that renders model output - but it also meant the renderer's fetch
   * of the update feed could never leave the process. Relaxing the policy to
   * let one command reach the network would open every other path with it, so
   * the request runs here instead and the window is handed the answer.
   */
  ipcMain.handle("mcode:check-updates", async (_event, feed: string) => {
    const address = String(feed ?? "").trim()
    if (!/^https?:\/\//.test(address)) throw new Error("the feed must be an http address")
    const response = await fetch(address, { cache: "no-store" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = (await response.json()) as { version?: string; url?: string; sha256?: string }
    return {
      version: payload.version?.trim() ?? "",
      url: payload.url?.trim() ?? "",
      // Optional, and checked only when the feed offers one.
      sha256: payload.sha256?.trim() ?? "",
    }
  })

  /*
   * The rest of an update: fetch the installer the feed named, then hand it to
   * the shell and quit so it can replace the app that is running.
   *
   * The download lands in the OS temporary directory under a name taken from
   * the version rather than from the URL, because a name that came over the
   * network should not decide where a file is written. What it will and will
   * not fetch is argued at the checks themselves.
   */
  ipcMain.handle("mcode:download-update", async (_event, url: string, version: string, digest?: unknown) => {
    const address = String(url ?? "").trim()
    /*
     * https, not http.
     *
     * The feed itself may be plain http - it is read, and a wrong answer there
     * makes the app say the wrong version. This file is *run*. Fetching an
     * executable over a connection anyone on the path can rewrite, and then
     * launching it, is remote code execution with extra steps, so the one
     * place that ends in `openPath` insists on a connection that cannot be
     * rewritten.
     */
    if (!/^https:\/\//.test(address)) throw new Error("the installer must be at an https address")

    const response = await fetch(address, { cache: "no-store" })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    /*
     * A ceiling, checked before the body is in memory. `arrayBuffer()` on a
     * feed that names a multi-gigabyte file would otherwise buy whatever it
     * asked for. A server that declines to say how long the body is gets the
     * same ceiling applied as the chunks arrive.
     */
    const MAX_INSTALLER = 400_000_000
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
     * And if the feed said what it should hash to, it has to. This is the only
     * check that survives a feed being served correctly but pointing somewhere
     * it should not; https alone says the bytes arrived unaltered from whoever
     * answered, not that they are the right bytes.
     */
    const expected = typeof digest === "string" ? digest.trim().toLowerCase() : ""
    if (expected) {
      const actual = createHash("sha256").update(body).digest("hex")
      if (actual !== expected) throw new Error("the installer does not match the checksum the feed gave")
    }

    const safe = String(version ?? "").replace(/[^0-9A-Za-z._-]/g, "") || "update"
    const suffix = process.platform === "win32" ? ".exe" : process.platform === "darwin" ? ".dmg" : ".AppImage"
    const target = path.join(app.getPath("temp"), `mcode-${safe}${suffix}`)
    await fs.writeFile(target, body)
    installerPath = target
    return target
  })

  /*
   * Only what this process downloaded. The renderer names no path here - it
   * asks to install "the one that was fetched" - so a window cannot talk the
   * app into launching an arbitrary executable, which is the same rule the
   * open-with table enforces for editors.
   */
  ipcMain.handle("mcode:install-update", async () => {
    if (!installerPath) throw new Error("no update has been downloaded")
    const failure = await shell.openPath(installerPath)
    if (failure) throw new Error(failure)
    beginIntentionalQuit()
    app.quit()
    return true
  })

  // The in-window menu's File > New Window. The native menu calls createWindow
  // directly; the drawn menu has to ask for it.
  ipcMain.on("mcode:new-window", () => createWindow())

  /*
   * Restarts the app. The renderer's error page is the caller: once the page
   * has failed to render, reloading it runs into whatever broke it the first
   * time, and a page that cannot draw cannot ask a person to quit and reopen.
   */
  ipcMain.on("mcode:relaunch", () => relaunch())

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

  ipcMain.handle("mcode:reveal-file", (_event, directory: string, relative: string) => {
    const target = inside(directory, relative)
    if (target) shell.showItemInFolder(target)
  })

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

  ipcMain.on("mcode:zoom", (event, action: "in" | "out" | "reset") => applyZoom(event.sender, action))

  /*
   * The icon the window and the taskbar wear.
   *
   * Only the renderer knows which one is chosen - the config document is the
   * server's, and main never reads it - so main is told rather than asking. An
   * id that names no file leaves the icon alone instead of blanking it.
   */
  ipcMain.on("mcode:app-icon", (event, id: string) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || process.platform === "darwin") return
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) return
    const file = app.isPackaged
      ? path.join(process.resourcesPath, "app-icons", id + ".png")
      : path.join(here, "../../resources/app-icons", id + ".png")
    if (!existsSync(file)) return
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) window.setIcon(image)
  })

  ipcMain.on("mcode:titlebar-mode", (event, mode: "dark" | "light") => {
    setTitlebarMode(BrowserWindow.fromWebContents(event.sender), mode)
  })

  ipcMain.on("mcode:window", (event, action: "minimize" | "maximize" | "close") => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (action === "minimize") window.minimize()
    else if (action === "close") window.close()
    else if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  buildMenu(createWindow)
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
  // Bounded, so a backend that will not close cannot trap the app open.
  const closed = Promise.race([backend.close(), new Promise((resolve) => setTimeout(resolve, 3000))])
  void closed.finally(() => app.quit())
})
