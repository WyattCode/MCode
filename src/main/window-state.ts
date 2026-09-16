import fs from "node:fs"
import path from "node:path"
import { app, screen, type BrowserWindow, type Rectangle } from "electron"
import { WINDOW_MIN, firstRunSize, readSavedWindow, windowStateToSave, type SavedWindow } from "./desktop-rules"

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
 * Keeps the window somewhere it can actually be seen.
 *
 * Saved coordinates go stale: a monitor gets unplugged, a laptop leaves its
 * dock, the resolution changes. Restoring them blindly puts the window off the
 * edge of the world, where it looks like the app failed to start.
 */
function visible(bounds: Rectangle): Rectangle {
  const width = Math.max(MIN.width, Math.round(bounds.width))
  const height = Math.max(MIN.height, Math.round(bounds.height))
  const display = screen.getDisplayMatching({ ...bounds, width, height })
  const area = display.workArea

  // A window is usable as long as a decent strip of its title bar is on screen.
  const overlapX = Math.min(bounds.x + width, area.x + area.width) - Math.max(bounds.x, area.x)
  const overlapY = Math.min(bounds.y + height, area.y + area.height) - Math.max(bounds.y, area.y)
  const reachable = overlapX >= 120 && overlapY >= 40

  if (reachable) {
    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.min(width, area.width),
      height: Math.min(height, area.height),
    }
  }

  const fitted = { width: Math.min(width, area.width), height: Math.min(height, area.height) }
  return {
    x: Math.round(area.x + (area.width - fitted.width) / 2),
    y: Math.round(area.y + (area.height - fitted.height) / 2),
    ...fitted,
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
  return { ...visible(saved.bounds), maximized: saved.maximized }
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
    fs.mkdirSync(path.dirname(file()), { recursive: true })
    fs.writeFileSync(file(), JSON.stringify(state, null, 2), "utf8")
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
