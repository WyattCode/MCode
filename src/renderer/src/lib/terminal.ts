/**
 * The terminal's rules that need no DOM: MiMo's colours, how its bottom panel
 * numbers tabs, how tall that panel may be, and when a terminal in the wrong
 * folder is started again rather than flagged. Kept here so the smoke test can
 * hold them to MiMo's values.
 */

/* MiMo's light terminal (pty-term's ansiLight): readable on white, bright slots distinct. */
export const ANSI_LIGHT = {
  black: "#1f1f1f",
  red: "#c5221f",
  green: "#1a7f37",
  yellow: "#7a6100",
  blue: "#0b57d0",
  magenta: "#9a208c",
  cyan: "#0e7490",
  white: "#5f6368",
  brightBlack: "#80868b",
  brightRed: "#d93025",
  brightGreen: "#188038",
  brightYellow: "#8a6d00",
  brightBlue: "#1a73e8",
  brightMagenta: "#b4249e",
  brightCyan: "#1097b8",
  brightWhite: "#202124",
} as const

/*
 * MiMo gives dark no ANSI colours of its own, so xterm's built-in sixteen show.
 * Spelled out rather than omitted: a theme object replaces the whole theme, and
 * leaving these out after light would keep nothing to fall back on but xterm's
 * defaults anyway - this just says which ones they are.
 */
export const ANSI_DARK = {
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
} as const

/** Whether a colour is dark enough to be a dark theme's background. */
export function isDarkColour(colour: string): boolean {
  const hex = colour.trim().replace("#", "")
  if (hex.length < 6) return true
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16))
  if ([r, g, b].some((part) => Number.isNaN(part))) return true
  // Rec. 601 luma, which is what "is this dark" means to an eye.
  return (r * 299 + g * 587 + b * 114) / 1000 < 128
}

/**
 * The theme xterm is given: MiMo's terminalTheme, on the app's own surface.
 * Foreground, cursor and selection are MiMo's fixed values for each scheme.
 */
export function terminalPalette(background: string) {
  if (isDarkColour(background)) {
    return { background, foreground: "#ececec", cursor: "#ececec", selectionBackground: "#33415b", ...ANSI_DARK }
  }
  return { background, foreground: "#1f1f1f", cursor: "#1f1f1f", selectionBackground: "#d6e4ff", ...ANSI_LIGHT }
}

/**
 * The number a new bottom-panel tab takes, fixed for its life (MiMo's `add`).
 * 0 is the bare 「终端」, which only the first tab gets and which counts as 1;
 * every later one takes the lowest number no open tab holds.
 */
export function nextTerminalNumber(open: readonly number[]): number {
  if (!open.length) return 0
  const taken = new Set(open.map((n) => (n === 0 ? 1 : n)))
  let n = 1
  while (taken.has(n)) n += 1
  return n
}

export function terminalLabel(n: number, title: string): string {
  return n === 0 ? title : `${title} ${n}`
}

/* MiMo's `--bp-h`: 240 to start, never under 120 or over 640. */
export const PANEL_HEIGHT = { min: 120, max: 640, def: 240 } as const

export function clampPanelHeight(px: number): number {
  if (!Number.isFinite(px)) return PANEL_HEIGHT.def
  return Math.round(Math.min(PANEL_HEIGHT.max, Math.max(PANEL_HEIGHT.min, px)))
}

/** A height read back from storage, or the default when there is none. */
export function storedPanelHeight(raw: string | null): number {
  const parsed = parseInt(raw ?? "", 10)
  return Number.isNaN(parsed) ? PANEL_HEIGHT.def : clampPanelHeight(parsed)
}

/** Two folders compared the way Windows compares them: separators and drive case ignored. */
export function samePlace(a: string, b: string): boolean {
  const plain = (value: string) => {
    const flat = value.replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[a-zA-Z]:/.test(flat) ? flat.toLowerCase() : flat
  }
  return plain(a) === plain(b)
}

/* MiMo's YAe: an untouched terminal elsewhere is quietly started again here. */
export function shouldRespawn(cwd: string | undefined, here: string | undefined, used: boolean): boolean {
  return !used && Boolean(cwd && here) && !samePlace(cwd ?? "", here ?? "")
}

/* MiMo's WAe: only a terminal someone has typed into is worth asking about. */
export function showMismatch(cwd: string | undefined, here: string | undefined, used: boolean): boolean {
  return used && Boolean(cwd && here) && !samePlace(cwd ?? "", here ?? "")
}

/** MiMo's shouldPasteFromKeyboard: Ctrl+V (⌘V on a Mac) with no Shift or Alt. */
export function isPasteKey(
  event: { type: string; key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean },
  mac: boolean,
): boolean {
  if (event.type !== "keydown" || event.altKey || event.shiftKey) return false
  if (event.code !== "KeyV" && event.key.toLowerCase() !== "v") return false
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
