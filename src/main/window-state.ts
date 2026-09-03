import fs from "node:fs"
import path from "node:path"
import { app, screen, type BrowserWindow, type Rectangle } from "electron"

/**
 * Remembers where the window was and how big it was.
 *
 * Kept out of the app config on purpose: this is a property of the machine and
 * its monitors, not of the user's preferences, and it must be readable before
 * the backend has started - the window is created first.
 */

interface State {
  bounds: Rectangle
  maximized: boolean
  fullScreen: boolean
}

const FILE = "window.json"
/** First-run size only; the position is left to the OS, which centres it. */
const DEFAULT = { width: 1280, height: 840 }
const MIN = { width: 720, height: 480 }
/** Writes are cheap but pointless mid-drag; settle first. */
const SETTLE = 400
/**
 * How far the measured window may sit from what was asked for before it counts
 * as the user having resized it.
 *
 * Restoring bounds does not reproduce them exactly - fractional display scaling
 * rounds the round-trip by a pixel or three. Saving the measured value fed that
 * error back in, so the window grew a little on every launch and kept growing.
 */
const JITTER = 4

function file(): string {
  return path.join(app.getPath("userData"), FILE)
}

function read(): State | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"))
    const { x, y, width, height } = raw?.bounds ?? {}
    if (![x, y, width, height].every((value) => Number.isFinite(value))) return undefined
    return {
      bounds: { x, y, width, height },
      maximized: Boolean(raw.maximized),
      fullScreen: Boolean(raw.fullScreen),
    }
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
 * Bounds and flags to pass to the BrowserWindow constructor.
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
  fullScreen: boolean
} {
  const saved = read()
  const flags = { maximized: saved?.maximized ?? false, fullScreen: saved?.fullScreen ?? false }
  if (!saved) {
    const area = screen.getPrimaryDisplay().workArea
    return {
      width: Math.min(DEFAULT.width, area.width),
      height: Math.min(DEFAULT.height, area.height),
      ...flags,
    }
  }
  return { ...visible(saved.bounds), ...flags }
}

/**
 * Where an additional window should open.
 *
 * Restoring the remembered bounds for every window put each new one exactly on
 * top of the last, which looks like nothing happened. Stepping down and across
 * is the long-standing convention, and it wraps back to the corner rather than
 * marching off the screen.
 */
export function cascade(from: Rectangle): Rectangle {
  const STEP = 28
  const area = screen.getDisplayMatching(from).workArea
  const next = { ...from, x: from.x + STEP, y: from.y + STEP }
  const past = next.x + from.width > area.x + area.width || next.y + from.height > area.y + area.height
  if (!past) return next
  return { ...from, x: area.x + STEP, y: area.y + STEP }
}

/** Starts saving position, size and maximised state for this window. */
export function track(window: BrowserWindow, requested: Rectangle): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  /** What is on disk, so measurement noise never ratchets the size up. */
  let baseline = requested

  const write = () => {
    if (window.isDestroyed()) return
    // getNormalBounds is the un-maximised geometry, which is what restoring
    // needs; getBounds while maximised would pin the window to full screen
    // for good.
    const measured = window.getNormalBounds()
    const settled =
      Math.abs(measured.x - baseline.x) <= JITTER &&
      Math.abs(measured.y - baseline.y) <= JITTER &&
      Math.abs(measured.width - baseline.width) <= JITTER &&
      Math.abs(measured.height - baseline.height) <= JITTER

    baseline = settled ? baseline : measured

    const state: State = {
      bounds: baseline,
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    }
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true })
      fs.writeFileSync(file(), JSON.stringify(state, null, 2), "utf8")
    } catch {
      // Losing the remembered size is not worth interrupting anything over.
    }
  }

  const later = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(write, SETTLE)
  }

  // Listed one by one: the overloaded signature does not accept a union.
  window.on("resize", later)
  window.on("move", later)
  window.on("maximize", later)
  window.on("unmaximize", later)
  window.on("enter-full-screen", later)
  window.on("leave-full-screen", later)

  // A debounce that never fires is a debounce that loses the last change.
  window.on("close", () => {
    if (timer) clearTimeout(timer)
    write()
  })
}
