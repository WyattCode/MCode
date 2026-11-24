import { boundShortcut, MENU_SHORTCUT_DEFAULTS } from "@shared/chord"

/**
 * The application menu's shortcuts, as MiMo builds them: the four items that
 * are commands (settings, new task, open folder, close) take the chord the
 * command answers to now - the user's own binding, or the built-in one - and
 * none at all while a shortcut is being recorded, so pressing Cmd+W to record
 * it does not close the window.
 */

/** The commands the menu names, by menu item, with their built-in chords. */
export const MENU_COMMANDS = {
  settings: { id: "app.settings", chord: MENU_SHORTCUT_DEFAULTS["app.settings"] },
  newTask: { id: "session.new", chord: MENU_SHORTCUT_DEFAULTS["session.new"] },
  openFolder: { id: "project.open", chord: MENU_SHORTCUT_DEFAULTS["project.open"] },
  close: { id: "window.close", chord: MENU_SHORTCUT_DEFAULTS["window.close"] },
  zoomIn: { id: "zoom.in", chord: MENU_SHORTCUT_DEFAULTS["zoom.in"] },
  zoomOut: { id: "zoom.out", chord: MENU_SHORTCUT_DEFAULTS["zoom.out"] },
  quit: { id: "app.quit", chord: MENU_SHORTCUT_DEFAULTS["app.quit"] },
  zoomReset: { id: "zoom.reset", chord: MENU_SHORTCUT_DEFAULTS["zoom.reset"] },
} as const

export type MenuCommand = keyof typeof MENU_COMMANDS

export interface MenuKeys {
  /** The saved bindings, by command id; an empty string is a chord the user deleted. */
  binds: Record<string, string>
  /** Whether the shortcuts page is recording a chord. */
  recording: boolean
}

const KEYS: Record<string, string> = {
  "+": "Plus",
  "↑": "Up",
  "↓": "Down",
  "←": "Left",
  "→": "Right",
  Enter: "Return",
}

/*
 * Recordable keys an application menu has no trustworthy name for: the keypad's
 * arithmetic keys. Spelled with the input matcher's names ("numadd"), the menu row
 * promised a shortcut whose right-hand column came out bare or wrong, while the arm's
 * notice spelled the same key off the recorder's token ("⌘NumpadAdd") and the settings
 * list a third way — one binding, three stories, and no way to tell which key quits.
 *
 * Refusing is what keeps one row telling one thing: a chord built on these keys gets no
 * accelerator and no notice, so the row keeps its plain name and never asks for a press
 * the bar cannot show. Nothing is taken away from the key itself — a focused window
 * still answers it, the zoom commands keep their keypad alternates, and the settings
 * list reads the legend off the key (+, -, *, /).
 */
const NOT_FOR_MENUS = new Set(["NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadEnter", "NumpadDecimal", "NumpadEqual"])

/**
 * A stored chord as an Electron accelerator, or undefined when it cannot be
 * one. "Ctrl" is the app's `mod` (Command on macOS), and "Meta" the other key:
 * Control on macOS, Super elsewhere.
 */
export function acceleratorOf(chord: string, platform: string): string | undefined {
  if (!chord) return undefined
  const plus = chord.endsWith("++")
  const parts = plus ? [...chord.slice(0, -2).split("+").filter(Boolean), "+"] : chord.split("+")
  const key = parts.pop()
  if (!key || NOT_FOR_MENUS.has(key)) return undefined
  const mods: string[] = []
  for (const part of parts) {
    if (part === "Ctrl") mods.push("CmdOrCtrl")
    else if (part === "Meta") mods.push(platform === "darwin" ? "Control" : "Super")
    else if (part === "Alt" || part === "Shift") mods.push(part)
    else return undefined
  }
  return [...mods, KEYS[key] ?? key].join("+")
}

/** What a menu item shows and claims now; nothing while a chord is being recorded. */
export function menuAccelerator(command: MenuCommand, keys: MenuKeys, platform: string): string | undefined {
  if (keys.recording) return undefined
  const { id, chord } = MENU_COMMANDS[command]
  const bound = boundShortcut({ id, hint: chord }, keys.binds)
  return acceleratorOf(bound, platform)
}

/**
 * The chord a command answers to now, spelled the way it is stored — the same
 * string that becomes the accelerator above, before any platform renames it. The
 * arm's notice takes its key cap from here, so the row cannot name a key other
 * than the one that quits; unlike the accelerator, it survives a recording, which
 * is when the binding is unchanged and only its claim is withdrawn.
 */
export function menuCommandChord(command: MenuCommand, keys: MenuKeys): string {
  const { id, chord } = MENU_COMMANDS[command]
  return boundShortcut({ id, hint: chord }, keys.binds)
}

/** The renderer's message, checked: only string bindings and a boolean pass. */
export function readMenuKeys(raw: unknown): MenuKeys | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const { binds, recording } = raw as { binds?: unknown; recording?: unknown }
  if (!binds || typeof binds !== "object" || typeof recording !== "boolean") return undefined
  const out: Record<string, string> = {}
  for (const [id, chord] of Object.entries(binds)) if (typeof chord === "string") out[id] = chord
  return { binds: out, recording }
}
