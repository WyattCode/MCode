import { app, dialog, Menu, BrowserWindow, Notification, type MenuItemConstructorOptions } from "electron"
import { fillQuitNotice } from "@shared/chord"
import { label } from "./labels"
import { applyZoom } from "./zoom"
import { toggleMaximize } from "./window-state"
import { APP_NAME, QUIT_ARM_MS, quitPress } from "./desktop-rules"
import { beginIntentionalQuit } from "./recovery"
import pkg from "../../package.json"
import { menuAccelerator, menuCommandChord, type MenuCommand, type MenuKeys } from "./menu-keys"

/* When the first Cmd+Q was pressed, while it is still waiting for a second. */
let quitArmedAt: number | undefined
/* Forgets the arm when the window closed on it, and with it the menu row's wording. */
let quitArmTimer: NodeJS.Timeout | undefined

export function requestAppQuit(fromShortcut = false): void {
  /* A press may only promise "one more like this" when the row can name the key it
     is promising. With the quit unbound (or bound to something that cannot be
     spelled) there is no second press to wait for, so nothing arms and this leaves. */
  const notice = fromShortcut && process.platform === "darwin" ? quitArmedNotice() : ""
  if (notice) {
    const press = quitPress(quitArmedAt, Date.now())
    quitArmedAt = press.armedAt
    if (!press.quit) {
      sayQuitArmed()
      return
    }
  }
  forgetQuitArm()
  beginIntentionalQuit()
  app.quit()
}

/** Puts the arm away - the waiting timer with the state - so no quit path can leave the row wrongly worded. */
export function forgetQuitArm(): void {
  clearTimeout(quitArmTimer)
  quitArmTimer = undefined
  quitArmedAt = undefined
}

/**
 * Says "a second press is wanted" on every surface that can hold it.
 *
 * The window's toast is the quiet half: a window hidden in the tray can receive it
 * and show nothing, which is how a Cmd+Q that had been armed looked dead to a
 * person with no window on screen. The menu bar's own quit row is the surface that
 * stays visible then, so the arm also rebuilds the menu (this app relabels by
 * rebuilding, never in place) and the row carries the hint until the arm expires.
 */
function sayQuitArmed(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("mcode:quit-hint")
  }
  /*
   * A window tucked away in the tray holds that toast out of sight, and the menu row
   * that also carries the notice sits behind a click on the menu bar. With no window
   * on screen the system's own notice is the last surface that can speak by itself,
   * so the arm goes there too — and only then, so a window that did show the toast is
   * not told the same thing twice.
   */
  if (!windowsThatCanToast().length) notifyQuitArmed()
  /*
   * Scheduled before the rebuild: should building the menu throw, the arm still
   * expires by itself instead of leaving the row reading "press again" indefinitely.
   */
  clearTimeout(quitArmTimer)
  quitArmTimer = setTimeout(expireQuitArm, QUIT_ARM_MS)
  quitArmTimer.unref()
  buildMenu()
}

/**
 * The windows whose page could actually draw the toast right now.
 *
 * Not `isVisible()` alone: measured on Electron 42 (this Mac), a window covered by
 * another window still reports `isVisible() === true` while its page reports
 * `visibilityState === "hidden"` — the renderer drops the toast on exactly that
 * signal, so a covered window is a window the notice would vanish into. The page's
 * own visibility is the transport the toast rides, so that is what is asked.
 */
function windowsThatCanToast(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((window) => {
    if (window.isDestroyed() || !window.isVisible()) return false
    try {
      return window.webContents.mainFrame.visibilityState === "visible"
    } catch {
      // A frame that cannot be asked is a frame that cannot draw the toast.
      return false
    }
  })
}

/**
 * The same promise, on the system's own surface, for an arm raised with nothing on
 * screen. Silent: a quit that has not happened yet is a warning, not news.
 *
 * Nothing is posted when the notice has no key to name. The row already declined to
 * speak for that same reason, and a system notice with no words would be a banner
 * that tells a person nothing at all.
 */
function notifyQuitArmed(): void {
  const body = quitArmedNotice()
  if (!body || !Notification.isSupported()) return
  try {
    /* No title: the banner already carries the app's name as its source, and a title
       of "MCode" beside it would say the name twice in a row. */
    new Notification({ body, silent: true }).show()
  } catch {
    // A notice this system will not post is no reason not to arm the quit.
  }
}

/** The notice a waiting arm shows, named for the key that would actually quit; "" when none can be named. */
function quitArmedNotice(): string {
  /* The words and the accelerator column sit on the same row, so they answer to one
     rule: a key the menu cannot name — one whose chord holds a modifier Electron's
     menus have no spelling for — is a key this row must not ask for either. Without
     this, the right column goes blank while the notice still says "⌘+", and the two
     halves of one row disagree about whether a shortcut exists. */
  if (menuAccelerator("quit", keys, process.platform) === undefined) return ""
  return fillQuitNotice(label("quit.hint", "Press {key} again to Quit"), menuCommandChord("quit", keys), process.platform)
}

/** The quit row's words: the arm's notice while one waits, its own name otherwise — and never a notice that names no key. */
function quitRowLabel(L: typeof label): string {
  const notice = quitArmedAt === undefined ? "" : quitArmedNotice()
  return notice || L("menu.quitApp", "Quit MCode")
}

/** The arm's own ending: the state goes and the row gets its normal words back. */
function expireQuitArm(): void {
  forgetQuitArm()
  buildMenu()
}

/**
 * MiMo's 关于 box: a native message box naming the app, its version and the
 * runtime it is built on, with one OK button.
 *
 * The version comes from package.json because app.getVersion() reports
 * Electron's own version until the app is packaged.
 */
export async function showAbout(): Promise<void> {
  const L = label
  const detail = [
    `${L("menu.aboutVersion", "Version")}: ${pkg.version}`,
    `Electron: ${process.versions.electron}`,
    `Chrome: ${process.versions.chrome}`,
    `Node.js: ${process.versions.node}`,
  ].join("\n")
  const options: Electron.MessageBoxOptions = {
    type: "info",
    title: L("menu.about", "About MCode"),
    message: "MCode",
    detail,
    buttons: [L("menu.aboutOk", "OK")],
    noLink: true,
  }
  const owner = BrowserWindow.getFocusedWindow()
  await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options))
}

/**
 * Menu bar, laid out as MiMo's: the app's own menu, File, Edit, View and
 * Window. It exists for discoverability and to name the chord beside each
 * item; the commands themselves are reached by their keys. Items that act on
 * the conversation forward to the focused window rather than reaching into the
 * backend, so the renderer stays the single place that knows the current session.
 *
 * MiMo keeps one template for every platform, and on Windows it is never drawn
 * (the title bar is hidden), so the stepping, stopping and toggling commands
 * MCode's menu used to list are left to their keys, as MiMo leaves them.
 */
/**
 * A chord the menu names but does not claim.
 *
 * An accelerator is registered with the window, so it fires ahead of the
 * renderer's own keydown handler: past the check for an open dialog, past a
 * focused text field, past whether the command can run where the user is at
 * all. Ctrl+B would fold the sidebar out from under the settings window, and
 * Stop would fire on a home screen with no turn to stop.
 *
 * registerAccelerator is honoured on Windows and Linux only. macOS registers
 * the chord regardless.
 */
function shown(accelerator: string): MenuItemConstructorOptions {
  return { accelerator, registerAccelerator: false }
}

/* The bindings the menu was last built with; a relabel rebuilds with the same ones. */
let keys: MenuKeys = { binds: {}, recording: false }

/**
 * A command item's chord, as MiMo's menu takes it: the one the command answers
 * to now, and none while a chord is being recorded. Claimed only on macOS,
 * where the menu is the menu bar and registers its chords anyway; elsewhere it
 * is shown, for the reason `shown` gives.
 */
function command(item: MenuCommand): MenuItemConstructorOptions {
  const accelerator = menuAccelerator(item, keys, process.platform)
  if (!accelerator) return {}
  return process.platform === "darwin" ? { accelerator } : shown(accelerator)
}

/**
 * Grows the window to fill the screen, or puts it back.
 *
 * The same toggle the titlebar's own maximize button runs, so the two controls
 * cannot disagree about what state the window is in.
 */
function toggleFocusedMaximize(): void {
  const window = BrowserWindow.getFocusedWindow()
  if (window) toggleMaximize(window)
}

/** Rebuilds the menu; new bindings (and whether one is being recorded) replace the last ones. */
export function buildMenu(next?: MenuKeys): void {
  if (next) {
    /* A row that promised a key the app no longer answers to is a lie, and the old
       promise is not owed to the new binding either: rebinding the quit, or starting
       to record a chord (which withdraws the running one), puts the arm — and the
       timer that would rebuild the row behind it — away entirely. */
    if (next.binds["app.quit"] !== keys.binds["app.quit"] || next.recording) forgetQuitArm()
    keys = next
  }
  /** The translated label, or the English written here as the fallback. */
  const L = label

  const send = (channel: string) => () => BrowserWindow.getFocusedWindow()?.webContents.send(channel)

  const zoom = (action: "in" | "out" | "reset") => () => applyZoom(action, BrowserWindow.getFocusedWindow()?.webContents)

  const isMac = process.platform === "darwin"
  /* Reloading and the developer tools are for a development build, as MiMo keeps them. */
  const development = Boolean(process.env.ELECTRON_RENDERER_URL)
  const separator: MenuItemConstructorOptions = { type: "separator" }

  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        /* Not Electron's stock about panel: MiMo's version box, on every platform. */
        { label: L("menu.about", "About MCode"), click: () => void showAbout() },
        { label: L("menu.settings", "Settings"), ...command("settings"), click: send("menu:settings") },
        /* Hiding is a macOS idea; elsewhere these roles would be rows that do nothing. */
        ...(isMac
          ? ([
              separator,
              { role: "hide", label: L("menu.hide", "Hide MCode") },
              { role: "hideOthers", label: L("menu.hideOthers", "Hide Others") },
              { role: "unhide", label: L("menu.unhide", "Show All") },
            ] as MenuItemConstructorOptions[])
          : []),
        separator,
        {
          /* While an arm waits, the row is the notice: it is rebuilt even with every window hidden,
             and it names the key this row's own accelerator answers to, not the sentence's default. */
          label: quitRowLabel(L),
          id: "app-quit",
          ...command("quit"),
          click: (_item, _window, event) => requestAppQuit(event.triggeredByAccelerator),
        },
      ],
    },
    {
      label: L("menu.file", "File"),
      submenu: [
        { label: L("menu.newTask", "New Task"), ...command("newTask"), click: send("menu:new-session") },
        separator,
        { label: L("menu.openFolder", "Open Folder"), ...command("openFolder"), click: send("menu:open-project") },
        separator,
        /*
         * MiMo's Ctrl+W / Cmd+W closes the window, which hides to the tray when
         * that is on. Shown rather than claimed: the window answers the key itself,
         * after its check for an open dialog.
         */
        { label: L("menu.fileClose", "Close"), ...command("close"), click: () => BrowserWindow.getFocusedWindow()?.close() },
      ],
    },
    {
      label: L("menu.edit", "Edit"),
      submenu: [
        { role: "undo", label: L("menu.undo", "Undo") },
        { role: "redo", label: L("menu.redo", "Redo") },
        separator,
        { role: "cut", label: L("edit.cut", "Cut") },
        { role: "copy", label: L("edit.copy", "Copy") },
        { role: "paste", label: L("edit.paste", "Paste") },
        { role: "selectAll", label: L("edit.selectAll", "Select All") },
      ],
    },
    {
      label: L("menu.view", "View"),
      submenu: [
        ...(development
          ? ([
              /*
               * Shown, not claimed: MiMo gives Ctrl+R to the browser panel, and a
               * role's registered chord would reload this whole window ahead of that.
               */
              { role: "reload", label: L("menu.reload", "Reload"), ...shown("CmdOrCtrl+R") },
              { role: "forceReload", label: L("menu.forceReload", "Force Reload"), ...shown("CmdOrCtrl+Shift+R") },
              { role: "toggleDevTools", label: L("menu.developerTools", "Developer Tools") },
              separator,
            ] as MenuItemConstructorOptions[])
          : []),
        // Not the built-in roles: those apply Chromium's own page zoom, which
        // knows nothing about the clamp in zoom.ts or the caption band that has
        // to be redrawn under a rescaled page. The renderer answers these keys
        // ahead of any dialog guard, so it still shows the zoom indicator.
        { label: L("menu.resetZoom", "Actual Size"), ...command("zoomReset"), click: zoom("reset") },
        { label: L("menu.zoomIn", "Zoom In"), ...command("zoomIn"), click: zoom("in") },
        { label: L("menu.zoomOut", "Zoom Out"), ...command("zoomOut"), click: zoom("out") },
        /* macOS brings its own full screen item to the View menu. */
        ...(isMac
          ? []
          : ([
              separator,
              { role: "togglefullscreen", label: L("menu.enterFullscreen", "Enter Full Screen") },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: L("menu.window", "Window"),
      /*
       * On macOS MiMo's roles, which bring Cmd+M (the model picker is
       * Cmd+Shift+M, so the chord is free) and the system's own zoom. Written
       * out elsewhere, where the menu is never drawn and a role would register
       * Ctrl+M behind the window's back.
       */
      submenu: isMac
        ? [
            { role: "minimize", label: L("menu.minimize", "Minimize") },
            { role: "zoom", label: L("menu.zoomWindow", "Zoom") },
          ]
        : [
            { label: L("menu.minimize", "Minimize"), click: () => BrowserWindow.getFocusedWindow()?.minimize() },
            { label: L("menu.zoomWindow", "Zoom"), click: toggleFocusedMaximize },
          ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
