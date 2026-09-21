import fs from "node:fs"
import path from "node:path"
import { app, screen, type BrowserWindow, type Rectangle } from "electron"
import { WINDOW_MIN, WINDOW_PREFERRED, firstRunSize, readSavedWindow, windowStateToSave, type SavedWindow } from "./desktop-rules"
import { writeAtomicSync } from "./atomic-write"
import { fillsWorkArea, linuxMaximizeToggle, startBounds } from "./work-area"

/**
 * Remembers where the window was and how big it was.
 *
 * Kept out of the app config on purpose: this is a property of the machine and
 * its monitors, not of the user's preferences, and it must be readable before
 * the backend has started - the window is created first.
 *
 * MiMo's rule: the state is written when the last window closes (or hides to
 * the tray) and when the app quits, not on every move; a minimised or
 * full-screen window writes nothing, and full screen is never restored.
 */

export const WINDOW_STATE_FILE = "window.json"
/* MiMo's minimum; a remembered size smaller than it is grown to it. */
const MIN = WINDOW_MIN

function file(): string {
  return path.join(app.getPath("userData"), WINDOW_STATE_FILE)
}

function read(): SavedWindow | undefined {
  try {
    return readSavedWindow(JSON.parse(fs.readFileSync(file(), "utf8")))
  } catch {
    return undefined
  }
}

/**
 * Bounds and the maximised flag to pass to the BrowserWindow constructor.
 *
 * x and y come back undefined when there is nothing remembered, which is not a
 * gap to fill in: omitting them is what makes Electron centre the window. An
 * earlier version defaulted them to 0,0 and every first run opened jammed into
 * the top-left corner of the screen.
 */
export function restore(): {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
} {
  const saved = read()
  if (!saved) {
    // First run: MiMo's share of the primary work area; the position is left to the OS, which centres it.
    return { ...firstRunSize(screen.getPrimaryDisplay().workArea), maximized: false }
  }
  /*
   * Saved coordinates go stale: a monitor gets unplugged, a laptop leaves its
   * dock, the resolution or the scaling changes. The window is put wholly on a
   * screen that is there now.
   */
  const areas = screen.getAllDisplays().map((display) => display.workArea)
  return { ...startBounds(saved.bounds, areas, MIN), maximized: saved.maximized }
}

/** What is on disk for each window, so measurement noise never ratchets the size up. */
const baselines = new WeakMap<BrowserWindow, Rectangle>()

/** Writes this window's state now, unless it is minimised or full screen (MiMo keeps the older state then). */
export function saveWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const baseline = baselines.get(window)
  if (!baseline) return
  // On Linux a window that fills the work area is maximized (MiMo's); its normal bounds are the ones it had before.
  const fills = fillsItsWorkArea(window)
  const state = windowStateToSave(
    {
      minimized: window.isMinimized(),
      fullScreen: window.isFullScreen(),
      maximized: fills || window.isMaximized(),
      // The un-maximised geometry, which is what restoring needs.
      normalBounds: fills ? (beforeFill.get(window) ?? baseline) : window.getNormalBounds(),
    },
    baseline,
  )
  if (!state) return
  baselines.set(window, state.bounds)
  try {
    writeAtomicSync(file(), JSON.stringify(state, null, 2))
  } catch {
    // Losing the remembered size is not worth interrupting anything over.
  }
}

/*
 * Linux, MiMo's way (I13-7): maximize sizes the window to its display's work
 * area instead of asking the window manager. The bounds it had before are kept
 * here, as the OS keeps normal bounds for a native maximize.
 */
const beforeFill = new WeakMap<BrowserWindow, Rectangle>()

function fillsItsWorkArea(window: BrowserWindow): boolean {
  if (process.platform !== "linux") return false
  try {
    const bounds = window.getBounds()
    return fillsWorkArea(bounds, screen.getDisplayMatching(bounds).workArea)
  } catch {
    return false
  }
}

/** The maximize toggle of the title bar and the menu. */
export function toggleMaximize(window: BrowserWindow): void {
  if (process.platform !== "linux") {
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return
  }
  const current = window.getBounds()
  const area = screen.getDisplayMatching(current).workArea
  const next = linuxMaximizeToggle(current, area, beforeFill.get(window) ?? baselines.get(window), { min: MIN, preferred: WINDOW_PREFERRED })
  if (next.maximized) beforeFill.set(window, current)
  else beforeFill.delete(window)
  window.setBounds(next.bounds)
}

/** A window saved as maximized opens that way; on Linux, filling the work area of the display its bounds are on. */
export function maximizeAtStart(window: BrowserWindow, bounds: Rectangle): void {
  if (process.platform !== "linux") return window.maximize()
  beforeFill.set(window, bounds)
  window.setBounds(screen.getDisplayMatching(bounds).workArea)
}

/**
 * Saves this window's state when it closes or hides as the last window. The
 * quit path saves every window itself (saveWindowState), before it hides them.
 */
export function track(window: BrowserWindow, requested: Rectangle, isLast: () => boolean): void {
  baselines.set(window, requested)
  window.on("close", () => {
    if (isLast()) saveWindowState(window)
  })
}
