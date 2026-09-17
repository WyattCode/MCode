/**
 * The application menu's shortcuts, as MiMo builds them: the four items that
 * are commands (settings, new task, open folder, close) take the chord the
 * command answers to now - the user's own binding, or the built-in one - and
 * none at all while a shortcut is being recorded, so pressing Cmd+W to record
 * it does not close the window.
 */

/** The commands the menu names, by menu item, with their built-in chords. */
export const MENU_COMMANDS = {
  settings: { id: "app.settings", chord: "Ctrl+," },
  newTask: { id: "session.new", chord: "Ctrl+N" },
  openFolder: { id: "project.open", chord: "Ctrl+O" },
  close: { id: "window.close", chord: "Ctrl+W" },
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
  if (!key) return undefined
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
  const bound = Object.hasOwn(keys.binds, id) ? keys.binds[id] : chord
  return acceleratorOf(bound, platform)
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
