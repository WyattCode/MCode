import type { WebContents } from "electron"
import { refreshTitlebar } from "./titlebar"

/**
 * The single place zoom is applied - keyboard, menu, and Ctrl+wheel all route
 * here, so the clamp is defined once.
 *
 * Lives in its own module so the menu can reach it without importing the app
 * entry, which imports the menu in turn.
 */
const STEP = 0.5
const MIN = -4
const MAX = 6

export function applyZoom(contents: WebContents, action: "in" | "out" | "reset"): void {
  const current = contents.getZoomLevel()
  const next = action === "reset" ? 0 : Math.max(MIN, Math.min(MAX, current + (action === "in" ? STEP : -STEP)))
  contents.setZoomLevel(next)
  // The caption band is drawn by the OS at whatever height it was last told,
  // so it has to be re-sent whenever the page scales under it.
  refreshTitlebar(contents)
}
