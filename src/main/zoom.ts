import { BrowserWindow, type WebContents } from "electron"
import { refreshTitlebar } from "./titlebar"
import { nextZoom } from "./desktop-rules"

/**
 * The single place zoom is applied - keyboard, menu, and Ctrl+wheel all route
 * here, so the steps are defined once.
 *
 * MiMo's zoom is a factor in ten-point steps from 25% to 300%, and it scales
 * every window at once. The step is worked out from one window and the same
 * factor is given to all: windows on the same page origin already share a zoom
 * in Chromium, so stepping each from its own reading would step twice.
 *
 * Lives in its own module so the menu can reach it without importing the app
 * entry, which imports the menu in turn.
 */
export function applyZoom(action: "in" | "out" | "reset", from?: WebContents): void {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
  const source = from && !from.isDestroyed() ? from : (BrowserWindow.getFocusedWindow() ?? windows[0])?.webContents
  if (!source) return
  const factor = nextZoom(source.getZoomFactor(), action)
  const percent = Math.round(factor * 100)
  for (const window of windows) {
    window.webContents.setZoomFactor(factor)
    // The caption band is drawn by the OS at whatever height it was last told,
    // so it has to be re-sent whenever the page scales under it.
    refreshTitlebar(window)
    // Each window says it with its own toast, as MiMo's do.
    window.webContents.send("mcode:zoom-changed", percent)
  }
}
