import { contextBridge, ipcRenderer, webUtils } from "electron"

export type OfficeVersionSource = "initial" | "ai" | "ai_local" | "user" | "external"
export interface OfficeVersionState {
  versions: { id: string; ts: number; source: OfficeVersionSource; note: string }[]
  cursor: number
}
export type OfficeVersionResult = { ok: true; state: OfficeVersionState } | { ok: false; reason: string }

/**
 * The only surface the renderer gets. Everything else - sessions, files, the
 * agent - travels over the WebSocket, which keeps the privileged bridge small
 * enough to audit at a glance.
 */
const api = {
  bootstrap: (): Promise<{ port: number; platform: string; home: string; version: string }> =>
    ipcRenderer.invoke("mcode:bootstrap"),

  /** Every directory chosen, in order; empty when the dialog was dismissed. */
  /** Where a dropped file lives on disk; empty for one that is not a file on disk. */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ""
    }
  },
  /** Which of these paths are folders, for a drop onto the project list. */
  directoriesOf: (paths: string[]): Promise<string[]> => ipcRenderer.invoke("mcode:directories-of", paths),
  pickDirectory: (title: string, multiple = false): Promise<string[]> =>
    ipcRenderer.invoke("mcode:pick-directory", title, multiple),
  saveText: (suggested: string, text: string): Promise<string | undefined> =>
    ipcRenderer.invoke("mcode:save-text", suggested, text),

  /** Menu bar labels; the translations live here, the menu is built there. */
  menuLabels: (labels: Record<string, string>): void => ipcRenderer.send("mcode:menu-labels", labels),

  /**
   * MiMo's task notification: the main process titles and words it, and shows
   * it only while the window is in the background.
   */
  taskNotice: (notice: { kind: "done" | "confirm"; sessionID?: string; title?: string; project?: string; silent: boolean }): void =>
    ipcRenderer.send("mcode:task-notice", notice),

  /** The launcher badge: conversations with an unseen finish or awaiting a confirmation. */
  badge: (count: number): void => ipcRenderer.send("mcode:badge", count),

  /** The zoom every window now has, as a whole percent, after any step. */
  onZoomChanged: (handler: (percent: number) => void): (() => void) => {
    const listener = (_event: unknown, percent: number) => handler(percent)
    ipcRenderer.on("mcode:zoom-changed", listener)
    return () => ipcRenderer.off("mcode:zoom-changed", listener)
  },
  /** This window's zoom as a whole percent. */
  zoomPercent: (): Promise<number> => ipcRenderer.invoke("mcode:zoom-percent"),

  /** macOS: a first Cmd+Q armed the quit. */
  onQuitHint: (handler: () => void): (() => void) => {
    const listener = () => handler()
    ipcRenderer.on("mcode:quit-hint", listener)
    return () => ipcRenderer.off("mcode:quit-hint", listener)
  },

  /**
   * The session a clicked notification came from, if it named one.
   *
   * The reference navigates to the session the banner is about rather than
   * only raising the window, so a turn that finished in a session you are not
   * looking at is one click away instead of a hunt through the tabs.
   */
  onNotificationClick: (handler: (sessionID: string) => void): (() => void) => {
    const listener = (_event: unknown, sessionID: string) => handler(sessionID)
    ipcRenderer.on("mcode:notify-click", listener)
    return () => ipcRenderer.off("mcode:notify-click", listener)
  },

  /** A session link clicked while the app was already open. */
  onOpenLink: (handler: (link: { sessionID: string; directory?: string }) => void): (() => void) => {
    const listener = (_event: unknown, link: { sessionID: string; directory?: string }) => handler(link)
    ipcRenderer.on("mcode:open-link", listener)
    return () => ipcRenderer.off("mcode:open-link", listener)
  },

  /** The session link the app was started with, if any; asked once, after connecting. */
  takeLink: (): Promise<{ sessionID: string; directory?: string } | undefined> => ipcRenderer.invoke("mcode:take-link"),

  clipboardText: (): Promise<string> => ipcRenderer.invoke("mcode:clipboard-text"),
  setClipboardText: (text: string): void => ipcRenderer.send("mcode:clipboard-write", text),

  /** Hands a link to the real browser. Only http and https survive the main process. */
  openExternal: (url: string): void => ipcRenderer.send("mcode:open-external", url),

  /** MiMo's guide after a refused microphone: the OS privacy page for it, where the OS has one. */
  openMicSettings: (): void => ipcRenderer.send("mcode:open-mic-settings"),
  /** Whether the OS lets the app use the microphone; macOS asks the first time. */
  micAccess: (): Promise<boolean> => ipcRenderer.invoke("mcode:mic-access"),

  /** Editing commands, which act on whatever the renderer has focused. */
  edit: (action: "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "selectAll"): void =>
    ipcRenderer.send("mcode:edit", action),

  /** Reload, devtools and full screen, which only the window itself can do. */
  view: (action: "reload" | "devtools" | "fullscreen"): void => ipcRenderer.send("mcode:view", action),

  /**
   * Asks the main process to read the update feed.
   *
   * The window cannot fetch it: its content policy allows a socket to the local
   * backend and nothing else.
   */
  checkUpdates: (feed: string): Promise<{ version: string; url: string; sha256: string; notes: string }> =>
    ipcRenderer.invoke("mcode:check-updates", feed),

  /** Fetches the installer the feed named, and answers where it was put. */
  downloadUpdate: (url: string, version: string, sha256?: string): Promise<string> =>
    ipcRenderer.invoke("mcode:download-update", url, version, sha256),

  /**
   * Runs the installer that was fetched, and quits.
   *
   * Takes no path: the window asks to install what was downloaded, and the main
   * process is the only thing that knows what that was.
   */
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke("mcode:install-update"),

  /** A second window on the same backend. */
  newWindow: (): void => ipcRenderer.send("mcode:new-window"),

  /**
   * Restarts the app.
   *
   * The renderer's error page has this as its only way out. Whatever broke the
   * page is still broken after a reload, and a page that cannot draw cannot ask
   * a person to quit and reopen it themselves. The main process closes the
   * backend on the way through.
   */
  relaunch: (): void => ipcRenderer.send("mcode:relaunch"),
  /** The footer menu's Quit app: every window, the backend and its terminals. */
  quitApp: (): void => ipcRenderer.send("mcode:quit"),

  /** Both take a project root and a path relative to it; see the main process. */
  revealFile: (directory: string, relative: string): Promise<{ ok: boolean; missing?: boolean; error?: string }> =>
    ipcRenderer.invoke("mcode:reveal-file", directory, relative),
  /**
   * `openWith` names the application to start, for the review panel's "Open in"
   * menu; without it the path goes to whatever the OS opens it with, which is
   * what every other caller wants.
   *
   * The name is forwarded rather than acted on. Which names exist, and whether
   * this one is among them, is settled in the main process against
   * @shared/open-app - the same rule `mcode:open-external` follows for schemes,
   * and for the same reason: a renderer that can name an executable is a
   * renderer that can start one.
   */
  openFile: (directory: string, relative: string, openWith?: string): Promise<string> =>
    ipcRenderer.invoke("mcode:open-file", directory, relative, openWith),
  /** The ids from @shared/open-app of the apps actually installed here. */
  installedApps: (): Promise<string[]> => ipcRenderer.invoke("mcode:installed-apps"),
  /** The installed open-with apps' own icons as data URLs, keyed by app id. */
  installedAppIcons: (): Promise<Record<string, string>> => ipcRenderer.invoke("mcode:installed-app-icons"),

  /** Shows a file the save dialog wrote; other paths are refused by the main process. */
  revealSaved: (target: string): Promise<void> => ipcRenderer.invoke("mcode:reveal-saved", target),
  openSaved: (target: string): Promise<string> => ipcRenderer.invoke("mcode:open-saved", target),

  window: (action: "minimize" | "maximize" | "close"): void => ipcRenderer.send("mcode:window", action),

  zoom: (action: "in" | "out" | "reset"): void => ipcRenderer.send("mcode:zoom", action),

  /*
   * Which scheme the window is actually showing. The caption buttons are drawn
   * by the OS, which knows only what the OS theme is - so a light window under
   * a dark system would otherwise be given white glyphs on a white bar.
   */
  titlebarMode: (mode: "dark" | "light"): void => ipcRenderer.send("mcode:titlebar-mode", mode),

  /** Which colourway the window and the taskbar should wear. */
  appIcon: (id: string): void => ipcRenderer.send("mcode:app-icon", id),

  /*
   * The browser panel. The window says where it goes and what to load; the
   * page itself is out of its reach by design.
   */
  browserOpen: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("mcode:browser-open", bounds),
  browserBounds: (bounds: { x: number; y: number; width: number; height: number }): void =>
    ipcRenderer.send("mcode:browser-bounds", bounds),
  browserClose: (): void => ipcRenderer.send("mcode:browser-close"),
  browserNavigate: (input: string) => ipcRenderer.invoke("mcode:browser-navigate", input),
  /** Acts on the open page, or on the page `id` names when given. */
  browserAct: (what: "back" | "forward" | "reload" | "forceReload" | "stop" | "zoomIn" | "zoomOut" | "zoomReset", id?: string) =>
    ipcRenderer.invoke("mcode:browser-act", what, id),
  /** The open page onto the clipboard; false when there was nothing to take. */
  browserScreenshot: (): Promise<boolean> => ipcRenderer.invoke("mcode:browser-screenshot"),
  /** Clears the browser's cookies or its cache; resolves to "" or the reason it failed. */
  browserClearSite: (what: "cookies" | "cache"): Promise<string> => ipcRenderer.invoke("mcode:browser-clear-site", what),
  browserTab: (what: "new" | "select" | "close", id?: string) =>
    ipcRenderer.invoke("mcode:browser-tab", what, id),
  /** Clears the browser panel's site data and cache; resolves to "" or the reason it failed. */
  browserClearData: (): Promise<string> => ipcRenderer.invoke("mcode:browser-clear-data"),
  /** A document's bytes, or that they have not changed since `ifUnchanged`. */
  readFileBytes: (
    root: string,
    rel?: string,
    ifUnchanged?: { size: number; mtimeMs: number },
  ): Promise<
    | { ok: true; unchanged: true; size: number; mtimeMs: number }
    | { ok: true; unchanged?: undefined; base64: string; size: number; mtimeMs: number }
    | { ok: false; reason: string }
  > => ipcRenderer.invoke("mcode:read-file-bytes", root, rel, ifUnchanged),
  /** Writes a document the view edited back in place, answering its new size and time. */
  writeFileBytes: (
    root: string,
    rel: string | undefined,
    base64: string,
  ): Promise<{ ok: true; size: number; mtimeMs: number } | { ok: false; reason: string }> => ipcRenderer.invoke("mcode:write-file-bytes", root, rel, base64),
  fileSize: (target: string): Promise<number> => ipcRenderer.invoke("mcode:file-size", target),
  officeVersionInit: (target: string, base64: string, assumeAi: boolean, note: string): Promise<OfficeVersionResult> =>
    ipcRenderer.invoke("mcode:office-version-init", target, base64, assumeAi, note),
  officeVersionRecord: (target: string, base64: string, source: OfficeVersionSource, note: string): Promise<OfficeVersionResult> =>
    ipcRenderer.invoke("mcode:office-version-record", target, base64, source, note),
  officeVersionRestore: (target: string, id: string): Promise<OfficeVersionResult> =>
    ipcRenderer.invoke("mcode:office-version-restore", target, id),
  officeConvertLegacy: (target: string): Promise<{ ok: true; output: string; cached: boolean } | { ok: false; error: string }> =>
    ipcRenderer.invoke("mcode:office-convert-legacy", target),
  revealPath: (target: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("mcode:reveal-path", target),
  /** A reply's path link: opens a file with its default program; executables and folders are refused there. */
  openNativePath: (target: string): Promise<{ ok: true } | { ok: false; code: string; error: string }> =>
    ipcRenderer.invoke("mcode:open-native-path", target),
  /** The first absolute candidate that exists, and whether it is a folder. */
  resolveExistingPath: (candidates: string[]): Promise<{ path: string; directory: boolean } | null> =>
    ipcRenderer.invoke("mcode:resolve-existing-path", candidates),
  /** Selects a file in its folder, or opens a folder. */
  revealNativePath: (target: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke("mcode:reveal-native-path", target),
  /** A picture on disk as base64, for copying it to the clipboard. */
  readImageData: (target: string): Promise<{ ok: true; mime: string; base64: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke("mcode:read-image-data", target),
  /** A picture file straight onto the clipboard; fails for formats the system decoder cannot read. */
  copyImageFromPath: (target: string): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke("mcode:copy-image-path", target),
  /** Saves a PNG where the person chooses; the path, or undefined when dismissed. */
  savePng: (suggested: string, base64: string): Promise<string | undefined> => ipcRenderer.invoke("mcode:save-png", suggested, base64),
  /** A loopback address a web page is served at, with its folder beside it. */
  officeServe: (target: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> => ipcRenderer.invoke("mcode:office-serve", target),
  /** Watches an open document so its view can reload when it changes on disk. */
  watchFile: (target: string): Promise<boolean> => ipcRenderer.invoke("mcode:watch-file", target),
  unwatchFile: (target: string): Promise<void> => ipcRenderer.invoke("mcode:unwatch-file", target),
  onFileChanged: (handler: (target: string) => void): (() => void) => {
    const listener = (_event: unknown, target: string) => handler(target)
    ipcRenderer.on("mcode:file-changed", listener)
    return () => ipcRenderer.off("mcode:file-changed", listener)
  },
  onBrowserState: (handler: (state: unknown) => void): (() => void) => {
    const listener = (_event: unknown, state: unknown) => handler(state)
    ipcRenderer.on("mcode:browser-state", listener)
    return () => ipcRenderer.off("mcode:browser-state", listener)
  },
  /** The chords the reader has bound, so the same keys pressed inside a page reach the window. */
  browserKeys: (chords: string[]): void => ipcRenderer.send("mcode:browser-keys", chords),
  /** A page opened a link in a new tab; the id is the page the main process already made for it. */
  onBrowserOpenTab: (handler: (pageId: string) => void): (() => void) => {
    const listener = (_event: unknown, pageId: string) => handler(pageId)
    ipcRenderer.on("mcode:browser-open-tab", listener)
    return () => ipcRenderer.off("mcode:browser-open-tab", listener)
  },
  /** One of the app's chords, pressed while a page had focus. */
  onBrowserKey: (
    handler: (key: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }) => void,
  ): (() => void) => {
    const listener = (_event: unknown, key: { key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }) =>
      handler(key)
    ipcRenderer.on("mcode:browser-key", listener)
    return () => ipcRenderer.off("mcode:browser-key", listener)
  },

  /** Whether to keep an icon in the system tray. */
  tray: (enabled: boolean): void => ipcRenderer.send("mcode:tray", enabled),

  /** The tray's 配置切换 list: the models the picker offers, the one in use checked. */
  trayProfiles: (profiles: { key: string; label: string; checked: boolean }[]): void =>
    ipcRenderer.send("mcode:tray-profiles", profiles),

  /** A model chosen from the tray's 配置切换, as its "provider/model" key. */
  onTrayProfile: (handler: (key: string) => void): (() => void) => {
    const listener = (_event: unknown, key: string) => handler(key)
    ipcRenderer.on("mcode:tray-profile", listener)
    return () => ipcRenderer.off("mcode:tray-profile", listener)
  },



  /** Menu accelerators the renderer turns into in-app commands. */
  onMenu: (handler: (command: string) => void): (() => void) => {
    /*
     * Every channel the menu sends. A command missing from this list is not an
     * error anywhere - the menu item builds, the accelerator binds, the click
     * sends - it simply never arrives, so the item does nothing at all. The
     * whole Go menu and Toggle File Tree were dead this way. Kept in step with
     * src/main/menu.ts by the menu section of the theme check.
     */
    const commands = [
      "new-session",
      "open-project",
      "settings",
    ]
    const listeners = commands.map((command) => {
      const channel = `menu:${command}`
      const listener = () => handler(command)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.off(channel, listener)
    })
    return () => listeners.forEach((off) => off())
  },
}

contextBridge.exposeInMainWorld("mcode", api)

export type MCodeBridge = typeof api
