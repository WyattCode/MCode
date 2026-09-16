import type { RightTabType, RightTool } from "../stores/right-panel"

/*
 * The right panel's tools as every place that lists them draws them: the
 * launcher, the plus menu and the tab strip. MCode's own icons, drawn on a 16
 * grid for MiMo's sizes (16 in the launcher, 14 on a tab).
 */

export interface ToolInfo {
  id: RightTool
  /** i18n key of the tool's name. */
  label: string
  icon: string[]
}

export const TOOL_INFO: Record<RightTool, ToolInfo> = {
  review: {
    id: "review",
    label: "launch.review",
    icon: [
      "M8.5 13.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v3.5",
      "M5 5.5h6M5 8h3",
      "M11 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
      "M12.5 12.5 14 14",
    ],
  },
  files: {
    id: "files",
    label: "launch.files",
    icon: [
      "M8.2 12.9H3c-.6 0-1.1-.5-1.1-1.1V4.2c0-.6.5-1.1 1.1-1.1h2.6l1.3 1.5h6.1c.6 0 1.1.5 1.1 1.1v2",
      "M11 8.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
      "M12.5 12 14 13.5",
    ],
  },
  chat: {
    id: "chat",
    label: "launch.chat",
    icon: ["M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"],
  },
  browser: {
    id: "browser",
    label: "launch.browser",
    icon: [
      "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z",
      "M2.5 8h11",
      "M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5z",
    ],
  },
  terminal: {
    id: "terminal",
    label: "launch.terminal",
    icon: ["M3 3h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M4.8 6.2 6.8 8l-2 1.8", "M8.5 10h2.7"],
  },
}

/* A diff tab's icon: two sheets, one struck through with a change. */
export const DIFF_ICON = ["M4 2.5h5.5L12.5 5.5v8H4z", "M6.5 8h3M8 6.5v3M6.5 11h3"]

/* A document tab's icon: a sheet with its corner turned and lines of text. */
export const DOCUMENT_ICON = ["M9.5 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7z", "M9.5 2.5v3h3", "M5.8 8.5h4.4M5.8 10.8h3"]

/* A web page tab's icon: a globe with its meridian and equator. */
export const PAGE_ICON = ["M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11z", "M2.5 8h11", "M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10.1 5.7 8S6.4 4.1 8 2.5z"]

/* subagents: the 子智能体 tab's icon, two figures side by side. */
export const SUBAGENTS_ICON = [
  "M6 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  "M2.5 12.5c0-2 1.6-3.5 3.5-3.5s3.5 1.5 3.5 3.5",
  "M11 7a1.7 1.7 0 1 0 0-3.4A1.7 1.7 0 0 0 11 7z",
  "M10.6 9.1c1.7-.2 3 1.1 3 3",
]

export function iconOf(type: RightTabType): string[] {
  if (type === "subagents") return SUBAGENTS_ICON
  if (type === "diff") return DIFF_ICON
  if (type === "office") return DOCUMENT_ICON
  if (type === "html") return PAGE_ICON
  return TOOL_INFO[type].icon
}

/* MiMo's launcher order, and its plus menu's (which lists the terminal second). */
export const LAUNCH_ORDER: RightTool[] = ["review", "files", "chat", "browser", "terminal"]
export const ADD_MENU_ORDER: RightTool[] = ["review", "terminal", "browser", "files", "chat"]

/* The command whose shortcut opens each tool, as App.vue's command table names it. */
export const TOOL_COMMANDS: Partial<Record<RightTool, string>> = {
  review: "view.review",
  files: "app.openFile",
  browser: "browser.tab",
  chat: "session.side",
}

/* In MiMo's launcher only files and browser carry a shortcut; its plus menu names every one there is. */
export const LAUNCH_HINTED: RightTool[] = ["files", "browser"]

/**
 * The chord a command answers to now: the user's binding if they set one, else
 * the built-in. A binding cleared on the shortcuts page is an empty string, and
 * names nothing.
 */
export function boundChord(id: string, builtIn: string | undefined, binds: Record<string, string>): string | undefined {
  return (id in binds ? binds[id] : builtIn) || undefined
}

/** Each tool's shortcut as bound now, so a rebinding shows in the launcher and the plus menu. */
export function toolHints(
  commands: readonly { id: string; hint?: string }[],
  binds: Record<string, string>,
): Partial<Record<RightTool, string>> {
  const out: Partial<Record<RightTool, string>> = {}
  for (const [tool, id] of Object.entries(TOOL_COMMANDS) as [RightTool, string][]) {
    const chord = boundChord(id, commands.find((command) => command.id === id)?.hint, binds)
    if (chord) out[tool] = chord
  }
  return out
}

/* MiMo's layout widths: the rail, the open side column past it (--sw), and the room a conversation keeps. */
export const RAIL_WIDTH = 62
export const SIDE_COLUMN_WIDTH = 194
export const MAIN_MIN_WIDTH = 480
/* MiMo's side column drag: 160 to 420 past the rail. */
export const SIDE_WIDTH_MIN = 160
export const SIDE_WIDTH_MAX = 420

/** The widest the side column may be dragged: 420, less where the conversation's 480 and an open panel need the room, never under 160. */
export function sideWidthMax(viewport: number, panelWidth: number): number {
  return Math.min(SIDE_WIDTH_MAX, Math.max(SIDE_WIDTH_MIN, viewport - RAIL_WIDTH - panelWidth - MAIN_MIN_WIDTH))
}

/** A stored or dragged width as the window allows it now; a value that is not a number is the default. */
export function clampSideWidth(value: number, viewport: number, panelWidth: number): number {
  const width = Number.isFinite(value) ? value : SIDE_COLUMN_WIDTH
  return Math.round(Math.min(sideWidthMax(viewport, panelWidth), Math.max(SIDE_WIDTH_MIN, width)))
}

/**
 * The panel's width as shown: the one dragged, narrowed to what leaves the
 * conversation its 480 beside the side column, but never under MiMo's 300. The
 * dragged width is kept, so a window that widens again gets it back.
 */
export function panelWidthShown(stored: number, viewport: number, sideWidth: number, floor: number): number {
  const room = Math.max(floor, viewport - RAIL_WIDTH - sideWidth - MAIN_MIN_WIDTH)
  return Math.min(room, Math.max(floor, stored))
}

export interface PanelRoom {
  viewport: number
  /** The side column's width past the rail while it is open. */
  sideWidth: number
  sideOpen: boolean
  panelOpen: boolean
  panelWidth: number
  fullscreen: boolean
}

/**
 * MiMo's narrow-window rule: with the side column and the panel both open
 * beside a conversation left under 480, the panel shuts when the column was
 * the one just opened, and otherwise the column folds.
 */
export function arbitratePanel(room: PanelRoom, sideJustOpened: boolean): "none" | "close-panel" | "collapse-side" {
  if (!room.sideOpen || !room.panelOpen || room.fullscreen) return "none"
  if (room.viewport - RAIL_WIDTH - room.sideWidth - room.panelWidth >= MAIN_MIN_WIDTH) return "none"
  return sideJustOpened ? "close-panel" : "collapse-side"
}

/** Whether an automatically folded side column fits again beside the panel as it stands. */
export function sideFits(room: PanelRoom): boolean {
  const panel = room.panelOpen && !room.fullscreen ? room.panelWidth : 0
  return room.viewport - RAIL_WIDTH - room.sideWidth - panel >= MAIN_MIN_WIDTH
}
