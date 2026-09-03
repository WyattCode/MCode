import { BrowserWindow, nativeTheme, type WebContents } from "electron"

/**
 * The band the title bar occupies, and the height the OS draws its caption
 * buttons at. The renderer reserves the same room at the right-hand end.
 */
export const TITLEBAR_HEIGHT = 40

/**
 * How the OS draws the caption buttons into our own title bar.
 *
 * The fill is fully transparent so the bar shows through: the buttons sit on
 * whatever the window is painted with, which includes whichever theme the user
 * picked. An opaque colour would leave a black strip in the corner of a
 * Dracula window.
 *
 * The height follows the zoom, because the buttons scale with the page and a
 * fixed band would leave their hit targets out of step with what is drawn once
 * the page grew past it.
 */
export function captionOverlay(zoom = 1, mode?: "dark" | "light") {
  const dark = mode ? mode === "dark" : nativeTheme.shouldUseDarkColors
  return {
    color: "#00000000",
    symbolColor: dark ? "white" : "black",
    height: Math.max(TITLEBAR_HEIGHT, Math.round(TITLEBAR_HEIGHT * zoom)),
  }
}

/*
 * What each window says it is showing. Kept here rather than passed around
 * because the zoom path re-draws the band too, and it has no idea about themes.
 */
const modes = new WeakMap<BrowserWindow, "dark" | "light">()

export function setTitlebarMode(window: BrowserWindow | null, mode: "dark" | "light"): void {
  if (!window || window.isDestroyed()) return
  modes.set(window, mode)
  refreshTitlebar(window)
}

/**
 * Re-draws the caption band for a window.
 *
 * Safe to call on any platform and at any time; only Windows draws an overlay,
 * and a destroyed window is simply skipped.
 */
export function refreshTitlebar(target: BrowserWindow | WebContents | null): void {
  if (process.platform !== "win32" || !target) return
  const window =
    "webContents" in target ? target : BrowserWindow.fromWebContents(target as WebContents)
  if (!window || window.isDestroyed()) return
  window.setTitleBarOverlay(captionOverlay(window.webContents.getZoomFactor(), modes.get(window)))
}
