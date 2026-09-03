import { app, Menu, BrowserWindow, type MenuItemConstructorOptions } from "electron"
import { label } from "./labels"
import { applyZoom } from "./zoom"

/**
 * Menu bar. Almost every command also lives in the command palette; this exists
 * for discoverability and to name the chord beside each item. Items that act on
 * the conversation forward to the focused window rather than reaching into the
 * backend, so the renderer stays the single place that knows the current session.
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
 * opencode's own menu makes the same split. Its Windows menu carries a real
 * accelerator only where Electron's edit and view roles bring one, plus
 * Settings and New Window; everything that maps to a command shows the chord
 * from the renderer's keymap and leaves the key itself to the renderer.
 *
 * registerAccelerator is honoured on Windows and Linux only. macOS registers
 * the chord regardless, which is what opencode does there too - it gives its
 * macOS menu the full set.
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

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: "about", label: L("menu.about", "About MCode") },
              { type: "separator" },
              { label: L("menu.settings", "Settings..."), accelerator: "Cmd+,", click: send("menu:settings") },
              { type: "separator" },
              { role: "hide", label: L("menu.hide", "Hide MCode") },
              { role: "hideOthers", label: L("menu.hideOthers", "Hide Others") },
              { type: "separator" },
              { role: "quit", label: L("menu.quit", "Quit") },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: L("menu.file", "File"),
      submenu: [
        { label: L("menu.newSession", "New Session"), ...shown("CmdOrCtrl+N"), click: send("menu:new-session") },
        // One of the two chords opencode does register on Windows, and the only
        // way to a second window from the keyboard - the renderer has no key
        // for it, because a window is not the renderer's to open.
        { label: L("menu.newWindow", "New Window"), accelerator: "CmdOrCtrl+Shift+N", click: () => createWindow() },
        { type: "separator" },
        { label: L("menu.openProject", "Open Project..."), ...shown("CmdOrCtrl+O"), click: send("menu:open-project") },
        ...(isMac
          ? []
          : ([
              { type: "separator" },
              // The other chord opencode registers on Windows.
              { label: L("menu.settings", "Settings"), accelerator: "Ctrl+,", click: send("menu:settings") },
              { type: "separator" },
              { role: "quit" },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: L("menu.edit", "Edit"),
      submenu: [
        { role: "undo", label: L("menu.undo", "Undo") },
        { role: "redo", label: L("menu.redo", "Redo") },
        { type: "separator" },
        { role: "cut", label: L("edit.cut", "Cut") },
        { role: "copy", label: L("edit.copy", "Copy") },
        { role: "paste", label: L("edit.paste", "Paste") },
        { role: "delete", label: L("edit.delete", "Delete") },
        { role: "selectAll", label: L("edit.selectAll", "Select All") },
      ],
    },
    {
      label: L("menu.view", "View"),
      submenu: [
        { label: L("menu.palette", "Command Palette"), ...shown("CmdOrCtrl+K"), click: send("menu:palette") },
        { label: L("menu.terminal", "Toggle Terminal"), ...shown("CmdOrCtrl+`"), click: send("menu:terminal") },
        { label: L("menu.sidebar", "Toggle Sidebar"), ...shown("CmdOrCtrl+B"), click: send("menu:sidebar") },
        { label: L("menu.files", "Toggle File Tree"), ...shown("CmdOrCtrl+\\"), click: send("menu:files") },
        { type: "separator" },
        { role: "reload", label: L("menu.reload", "Reload") },
        { role: "toggleDevTools", label: L("menu.devTools", "Toggle Developer Tools") },
        { type: "separator" },
        // Not the built-in roles: those apply Chromium's own page zoom, which
        // knows nothing about the clamp in zoom.ts or the caption band that has
        // to be redrawn under a rescaled page. The renderer answers these keys
        // ahead of any dialog guard, so it still shows the zoom indicator.
        { label: L("menu.resetZoom", "Reset Zoom"), ...shown("CmdOrCtrl+0"), click: zoom("reset") },
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
        { type: "separator" },
        { role: "togglefullscreen", label: L("menu.fullscreen", "Toggle Full Screen") },
      ],
    },
    {
      label: L("menu.session", "Session"),
      submenu: [
        { label: L("menu.stop", "Stop"), click: send("menu:abort") },
        { label: L("menu.switchModel", "Switch Model"), ...shown("CmdOrCtrl+M"), click: send("menu:model") },
        { type: "separator" },
        /*
         * No chord. Deleting a conversation is the one item here that cannot be
         * taken back, and Backspace is a key people press by reflex in a text
         * field. opencode puts nothing on Backspace but mod+shift+backspace,
         * which archives - reversible, and already bound in the renderer.
         */
        { label: L("menu.deleteSession", "Delete Session"), click: send("menu:delete-session") },
      ],
    },
    {
      /*
       * Moving about, rather than doing: back and forward walk where you have
       * been, and the arrow pairs step sideways through the conversations and
       * the projects holding them.
       */
      label: L("menu.go", "Go"),
      submenu: [
        { label: L("menu.back", "Back"), ...shown("CmdOrCtrl+["), click: send("menu:back") },
        { label: L("menu.forward", "Forward"), ...shown("CmdOrCtrl+]"), click: send("menu:forward") },
        { type: "separator" },
        { label: L("menu.prevSession", "Previous Session"), ...shown("Alt+Up"), click: send("menu:prev-session") },
        { label: L("menu.nextSession", "Next Session"), ...shown("Alt+Down"), click: send("menu:next-session") },
        { type: "separator" },
        { label: L("menu.prevProject", "Previous Project"), ...shown("CmdOrCtrl+Alt+Up"), click: send("menu:prev-project") },
        { label: L("menu.nextProject", "Next Project"), ...shown("CmdOrCtrl+Alt+Down"), click: send("menu:next-project") },
      ],
    },
    {
      label: L("menu.window", "Window"),
      /*
       * Written out rather than taken from the minimize, zoom and close roles.
       * A role brings the platform's own chord with it - Ctrl+W and Ctrl+M on
       * Windows, Cmd+W and Cmd+M on macOS - and those are two keys this app has
       * already spent: Ctrl+W closes the current tab, Ctrl+M opens the model
       * picker. Registered at the window, the roles won both, so neither of the
       * app's own commands could be reached by keyboard. opencode's Window menu
       * carries plain actions with no role and no accelerator for the same
       * reason.
       */
      submenu: [
        { label: L("menu.minimize", "Minimize"), click: () => BrowserWindow.getFocusedWindow()?.minimize() },
        { label: L("menu.zoom", "Zoom"), click: toggleMaximize },
        { label: L("menu.close", "Close"), click: () => BrowserWindow.getFocusedWindow()?.close() },
      ],
    },
    {
      /*
       * opencode's Help menu is links into its own documentation and issue
       * tracker. MCode has neither, and sending its users to another product's
       * would be worse than an absent menu - so this carries what MCode can
       * answer, and the same two items the drawn menu shows.
       */
      role: "help",
      label: L("rail.help", "Help"),
      submenu: [
        { label: L("set.shortcuts", "Keyboard shortcuts"), click: send("menu:shortcuts") },
        { label: L("update.check", "Check for updates"), click: send("menu:check-updates") },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
