import { BrowserWindow, screen } from "electron"
import { clampToWorkAreas } from "./work-area"

/**
 * MiMo's pull-back when displays change: a monitor unplugged, a laptop leaving
 * its dock, a resolution change. Every visible window that is not minimised,
 * maximised or full screen is moved back inside a work area; the rest are
 * placed by the OS when they are restored. Call once the app is ready.
 */
export function keepWindowsOnScreen(): void {
  const pull = () => {
    const areas = screen.getAllDisplays().map((display) => display.workArea)
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (window.isDestroyed() || window.isMinimized() || window.isFullScreen() || window.isMaximized() || !window.isVisible()) continue
        const next = clampToWorkAreas(window.getBounds(), areas)
        if (next) window.setBounds(next)
      } catch {
        // A window going away mid-change has nowhere to be pulled to.
      }
    }
  }
  screen.on("display-added", pull)
  screen.on("display-removed", pull)
  screen.on("display-metrics-changed", pull)
}
