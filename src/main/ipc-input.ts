/**
 * What the window's fire-and-forget messages may carry, checked.
 *
 * An `ipcMain.on` listener has no caller to reject to: a throw inside one is
 * not a failed request the renderer can see, it is an uncaught exception in
 * the main process. So each value is read here first, and a value that does
 * not fit is answered with undefined and the message is dropped. Kept free of
 * Electron so the smoke run can hold every reader to its rule.
 */

/** Text for the clipboard; only a string is text. */
export function clipboardText(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined
}

export interface PanelBounds {
  x: number
  y: number
  width: number
  height: number
}

/** The page panel's box: all four sides finite numbers, or nothing. */
export function panelBounds(raw: unknown): PanelBounds | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const { x, y, width, height } = raw as Record<string, unknown>
  const sides = [x, y, width, height]
  if (!sides.every((side) => typeof side === "number" && Number.isFinite(side))) return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/** The caption band's colours follow the page's own theme, which is one of two. */
export function titlebarMode(raw: unknown): "dark" | "light" | undefined {
  return raw === "dark" || raw === "light" ? raw : undefined
}
