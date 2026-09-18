/**
 * The desktop rules MiMo's main process applies, as plain functions.
 *
 * Kept free of Electron so the smoke run can hold each of them to MiMo's
 * numbers without starting a window: the size a first window opens at, how far
 * one zoom step goes, what a system notification is titled and when it is shown,
 * which rows the native text menu offers, and the macOS double Cmd+Q.
 */

/** MiMo's smallest window, which a remembered size is also held to. */
export const WINDOW_MIN = { width: 720, height: 640 }
/* MiMo's preferred first size, its ceiling, and the share of the work area it takes. */
const PREFERRED = { width: 1340, height: 880 }
const CEILING = { width: 1920, height: 1200 }
const SHARE = 0.8

function firstSide(area: number, preferred: number, ceiling: number, minimum: number): number {
  const low = Math.min(preferred, area)
  const high = Math.min(ceiling, area)
  const wanted = Math.round(area * SHARE)
  return Math.max(minimum, Math.min(high, Math.max(low, wanted)))
}

/**
 * A first run's size: 80% of the work area on each side, held between MiMo's
 * preferred size and its ceiling, never past the work area and never below the
 * minimum.
 */
export function firstRunSize(area: { width: number; height: number }): { width: number; height: number } {
  if (!(area.width > 0) || !(area.height > 0)) return { ...PREFERRED }
  return {
    width: firstSide(area.width, PREFERRED.width, CEILING.width, WINDOW_MIN.width),
    height: firstSide(area.height, PREFERRED.height, CEILING.height, WINDOW_MIN.height),
  }
}

/* MiMo's zoom: a factor in whole ten-point steps between 25% and 300%. */
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 3
const ZOOM_STEP_PERCENT = 10

export function clampZoom(factor: number): number {
  const value = Number.isFinite(factor) ? factor : 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value))
}

/** The factor after one step, rounded to a whole percent so steps never drift. */
export function nextZoom(current: number, action: "in" | "out" | "reset"): number {
  if (action === "reset") return 1
  const percent = Math.round(clampZoom(current) * 100) + (action === "in" ? ZOOM_STEP_PERCENT : -ZOOM_STEP_PERCENT)
  return clampZoom(percent / 100)
}

/**
 * What a task notification is about, as MiMo's four kinds (N11-3).
 *
 * `done` and `failed` were one kind here, so a scheduled task that failed
 * overnight still said "task completed"; `chat` is a conversation answering a
 * message another conversation sent it.
 */
export type TaskNoticeKind = "done" | "confirm" | "failed" | "chat"

export interface TaskNotice {
  kind: TaskNoticeKind
  sessionID?: string
  title?: string
  project?: string
  silent: boolean
}

/** The notice as it arrives over IPC, checked field by field. */
export function readTaskNotice(raw: unknown): TaskNotice {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
  const text = (field: unknown) => (typeof field === "string" && field ? field.slice(0, 500) : undefined)
  return {
    kind: value.kind === "confirm" || value.kind === "failed" || value.kind === "chat" ? value.kind : "done",
    sessionID: text(value.sessionID),
    title: text(value.title),
    project: text(value.project),
    silent: value.silent === true,
  }
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** What window.json holds: the normal bounds and whether the window was maximised. Never full screen, as MiMo. */
export interface SavedWindow {
  bounds: Box
  maximized: boolean
}

/**
 * window.json as read back. A `fullScreen` an earlier release wrote is ignored:
 * MiMo never reopens full screen, where Windows shows no caption buttons.
 */
export function readSavedWindow(raw: unknown): SavedWindow | undefined {
  const value = raw && typeof raw === "object" ? (raw as { bounds?: Partial<Box>; maximized?: unknown }) : undefined
  const { x, y, width, height } = value?.bounds ?? {}
  if (![x, y, width, height].every((side) => Number.isFinite(side))) return undefined
  return { bounds: { x: x!, y: y!, width: width!, height: height! }, maximized: value?.maximized === true }
}

/**
 * How far the measured window may sit from what was asked for before it counts
 * as the user having resized it. Restoring bounds does not reproduce them
 * exactly - fractional display scaling rounds the round-trip by a pixel or three -
 * and saving the measured value fed that error back in, so the window grew a
 * little on every launch.
 */
export const WINDOW_JITTER = 4

/**
 * MiMo's save rule: nothing is written for a minimised or full-screen window -
 * what is on disk from before stands - and otherwise the normal bounds and the
 * maximised flag. `baseline` is what is on disk; a measurement within the jitter
 * of it keeps it. Undefined means "write nothing".
 */
export function windowStateToSave(
  window: { minimized: boolean; fullScreen: boolean; maximized: boolean; normalBounds: Box },
  baseline: Box,
): SavedWindow | undefined {
  if (window.minimized || window.fullScreen) return undefined
  const measured = window.normalBounds
  const settled = (["x", "y", "width", "height"] as const).every((side) => Math.abs(measured[side] - baseline[side]) <= WINDOW_JITTER)
  return { bounds: settled ? { ...baseline } : { ...measured }, maximized: window.maximized }
}

/**
 * The product name the tray and notifications show. A constant, as MiMo's tray
 * uses its brand constant: `app.getName()` is whatever the running package.json
 * says, which for an unpackaged run is not the product at all.
 */
export const APP_NAME = "MCode"

/**
 * The profile folder under the OS application-data folder: `mcode`, the name
 * every MCode release has used. Electron derives its default from the product
 * name, which is now `MCode`; on Windows and a default macOS volume the two
 * spellings are one folder, but Linux (and a case-sensitive macOS volume) would
 * start an empty profile beside the old one. So the default is pinned back to
 * the old folder - and only the default: a profile chosen on purpose
 * (`--user-data-dir`, or `app.setPath` before the main module runs) is left
 * alone. Returns the folder to set, or undefined to leave userData as it is.
 */
export const PROFILE_FOLDER = "mcode"
export function pinnedProfile(current: string, appData: string, appName: string, join: (...parts: string[]) => string): string | undefined {
  if (current !== join(appData, appName)) return undefined
  const pinned = join(appData, PROFILE_FOLDER)
  return pinned === current ? undefined : pinned
}

/** MiMo's title: "project · conversation", or whichever exists, cut at 40; the product name when neither does. */
export function noticeTitle(notice: { title?: string; project?: string }): string {
  const fallback = APP_NAME
  const title = (notice.title ?? "").trim()
  const project = (notice.project ?? "").trim()
  const joined = project && title ? `${project} · ${title}` : title || project
  if (!joined) return fallback
  return joined.length > 40 ? `${joined.slice(0, 39)}…` : joined
}

/** Only a window the person is not looking at: minimised, hidden or in the background. */
export function wantsNotice(state: { destroyed: boolean; minimized: boolean; visible: boolean; focused: boolean }): boolean {
  if (state.destroyed) return false
  return state.minimized || !state.visible || !state.focused
}

export type TextMenuItem = "copyImage" | "copyImageUrl" | "copy" | "cut" | "paste" | "selectAll"

export interface TextMenuParams {
  isEditable?: boolean
  selectionText?: string
  mediaType?: string
  srcURL?: string
  editFlags?: { canCopy?: boolean; canCut?: boolean; canPaste?: boolean; canSelectAll?: boolean }
}

function editRows(params: TextMenuParams): TextMenuItem[] {
  const flags = params.editFlags ?? {}
  const editable = Boolean(params.isEditable)
  const selected = typeof params.selectionText === "string" && params.selectionText.trim().length > 0
  const rows: TextMenuItem[] = []
  // MiMo's order: a field reads 剪切, 复制, 粘贴; plain text only 复制.
  if (editable && (flags.canCut ?? selected)) rows.push("cut")
  if (flags.canCopy ?? selected) rows.push("copy")
  if (editable && (flags.canPaste ?? true)) rows.push("paste")
  // A field always offers select all, as MiMo does; Chromium reports canSelectAll false for an empty one.
  if (editable || selected) rows.push("selectAll")
  return rows
}

/**
 * MiMo's native text menu: only the rows that can act, never a greyed one.
 * An image with an address leads with its two rows; an image under the pointer
 * with nothing selected offers no copy of text.
 */
export function textMenuItems(params: TextMenuParams): TextMenuItem[] {
  const image = params.mediaType === "image" && String(params.srcURL ?? "").trim().length > 0
  const selected = typeof params.selectionText === "string" && params.selectionText.trim().length > 0
  const rows: TextMenuItem[] = image ? ["copyImage", "copyImageUrl"] : []
  const quiet = image && !selected && !params.isEditable
  rows.push(...editRows(quiet ? { ...params, editFlags: { ...params.editFlags, canCopy: false, canCut: false } } : params))
  return rows
}

/** How long a first Cmd+Q stays armed on macOS. */
export const QUIT_ARM_MS = 2000

/** A second press inside the window quits; any other press arms it again. */
export function quitPress(armedAt: number | undefined, now: number): { quit: boolean; armedAt?: number } {
  if (armedAt !== undefined && now - armedAt <= QUIT_ARM_MS) return { quit: true }
  return { quit: false, armedAt: now }
}

/** A badge count as a whole number, zero for anything unusable. */
export function badgeCount(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
