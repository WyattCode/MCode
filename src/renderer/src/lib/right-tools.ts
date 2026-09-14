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

export function iconOf(type: RightTabType): string[] {
  if (type === "diff") return DIFF_ICON
  if (type === "office") return DOCUMENT_ICON
  if (type === "html") return PAGE_ICON
  return TOOL_INFO[type].icon
}

/* MiMo's launcher order, and its plus menu's (which lists the terminal second). */
export const LAUNCH_ORDER: RightTool[] = ["review", "files", "chat", "browser", "terminal"]
export const ADD_MENU_ORDER: RightTool[] = ["review", "terminal", "browser", "files", "chat"]

/* The shortcut beside each tool: in the launcher only files and browser carry one, the menu names all it can. */
export const LAUNCH_KEYS: Partial<Record<RightTool, string>> = { files: "Ctrl+P", browser: "Ctrl+T" }
export const MENU_KEYS: Partial<Record<RightTool, string>> = {
  review: "Ctrl+Shift+G",
  browser: "Ctrl+T",
  files: "Ctrl+P",
  chat: "Ctrl+Alt+S",
}
