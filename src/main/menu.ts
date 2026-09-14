import { app, Menu, BrowserWindow, type MenuItemConstructorOptions } from "electron"
import { label } from "./labels"
import { applyZoom } from "./zoom"

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

/**
 * Grows the window to fill the screen, or puts it back.
 *
 * The same toggle the titlebar's own maximize button runs, so the two controls
 * cannot disagree about what state the window is in.
 */
function toggleMaximize(): void {
  const window = BrowserWindow.getFocusedWindow()
  if (!window) return
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
}

export function buildMenu(createWindow: () => BrowserWindow): void {
  /** The translated label, or the English written here as the fallback. */
  const L = label

  const send = (channel: string) => () => BrowserWindow.getFocusedWindow()?.webContents.send(channel)

  const zoom = (action: "in" | "out" | "reset") => () => {
    const contents = BrowserWindow.getFocusedWindow()?.webContents
    if (contents) applyZoom(contents, action)
  }

  const isMac = process.platform === "darwin"
  /* Reloading and the developer tools are for a development build, as MiMo keeps them. */
  const development = Boolean(process.env.ELECTRON_RENDERER_URL)
  const separator: MenuItemConstructorOptions = { type: "separator" }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about", label: L("menu.about", "About MCode") },
        { label: L("menu.settings", "Settings"), accelerator: "CmdOrCtrl+,", click: send("menu:settings") },
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
        { role: "quit", label: L("menu.quitApp", "Quit MCode"), accelerator: "CmdOrCtrl+Q" },
      ],
    },
    {
      label: L("menu.file", "File"),
      submenu: [
        { label: L("menu.newTask", "New Task"), ...shown("CmdOrCtrl+N"), click: send("menu:new-session") },
        /*
         * Not in MiMo's menu. Kept until the user decides: it is the only way to
         * a second window from the keyboard, since a window is not the
         * renderer's to open.
         */
        { label: L("menu.newWindow", "New Window"), accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        separator,
        { label: L("menu.openFolder", "Open Folder"), ...shown("CmdOrCtrl+O"), click: send("menu:open-project") },
        separator,
        /*
         * A plain action rather than the close role, whose Ctrl+W / Cmd+W the
         * app already spends on closing the current tab.
         */
        { label: L("menu.fileClose", "Close"), click: () => BrowserWindow.getFocusedWindow()?.close() },
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
        { label: L("menu.resetZoom", "Actual Size"), ...shown("CmdOrCtrl+0"), click: zoom("reset") },
        { label: L("menu.zoomIn", "Zoom In"), ...shown("CmdOrCtrl+Plus"), click: zoom("in") },
        /*
         * Cmd+= is the unshifted spelling of Cmd+plus, and macOS registers a
         * menu accelerator whether or not the item is drawn - so this hidden
         * twin is what answers that key there. On Windows it registers nothing
         * and shows nothing; the renderer's keymap already knows both
         * spellings, and the numpad's besides.
         */
        { label: L("menu.zoomIn", "Zoom In"), ...shown("CmdOrCtrl+="), visible: false, click: zoom("in") },
        { label: L("menu.zoomOut", "Zoom Out"), ...shown("CmdOrCtrl+-"), click: zoom("out") },
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
       * Written out rather than taken from the minimize and zoom roles. A role
       * brings the platform's own chord with it - Ctrl+M on Windows, Cmd+M on
       * macOS - and the app has already spent that key on the model picker.
       */
      submenu: [
        { label: L("menu.minimize", "Minimize"), click: () => BrowserWindow.getFocusedWindow()?.minimize() },
        { label: L("menu.zoomWindow", "Zoom"), click: toggleMaximize },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
