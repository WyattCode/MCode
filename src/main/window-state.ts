import fs from "node:fs"
import path from "node:path"
import { app, screen, type BrowserWindow, type Rectangle } from "electron"
import { WINDOW_MIN, firstRunSize, readSavedWindow, windowStateToSave, type SavedWindow } from "./desktop-rules"
import { writeAtomicSync } from "./atomic-write"
import { startBounds } from "./work-area"

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

const FILE = "window.json"
/* MiMo's minimum; a remembered size smaller than it is grown to it. */
const MIN = WINDOW_MIN

function file(): string {
  return path.join(app.getPath("userData"), FILE)
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
  const state = windowStateToSave(
    {
      minimized: window.isMinimized(),
      fullScreen: window.isFullScreen(),
      maximized: window.isMaximized(),
      // The un-maximised geometry, which is what restoring needs.
      normalBounds: window.getNormalBounds(),
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
