import { ref } from "vue"

/**
 * How a keystroke is written down, so a stored binding and a live event can be
 * compared as strings.
 *
 * The order is fixed rather than following the order the modifiers were
 * pressed. As MiMo does, the key is read from where it sits (`event.code`), so
 * Shift does not change it: Ctrl+Shift+[ is recorded as that, not as Ctrl+Shift+{.
 */
const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Space: "Space",
  Tab: "Tab",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
}

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
])

/** The printed name for a physical key, or undefined when the code says nothing useful. */
export function keyOfCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return CODE_KEYS[code]
}

/** The key as printed, for an event that carries no usable code. */
function keyOfKey(key: string): string {
  if (key === " ") return "Space"
  if (key === "ArrowUp") return "↑"
  if (key === "ArrowDown") return "↓"
  if (key === "ArrowLeft") return "←"
  if (key === "ArrowRight") return "→"
  return key.length === 1 ? key.toUpperCase() : key
}

/*
 * The stored modifier names, as MiMo's `mod` and `ctrl` split them.
 *
 * "Ctrl" is MiMo's `mod`: the command key on macOS and Ctrl elsewhere, which
 * is what every chord saved so far means. "Meta" is the other key: Control on
 * macOS, and the Windows or Super key elsewhere. The two are never folded
 * together, so Control+K in a macOS text field stays the editing key it is.
 */
export function isMac(platform: string): boolean {
  return platform === "darwin"
}

/** MiMo's `mod` held on its own: Command on macOS, Ctrl elsewhere, and not the other key. */
export function modHeld(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">, platform: string): boolean {
  return isMac(platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** MiMo's `ctrl`: the Control key on every system, with the command key up. */
export function controlHeld(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">): boolean {
  return event.ctrlKey && !event.metaKey
}

const ORDER = ["Ctrl", "Alt", "Shift", "Meta"]

/**
 * A stored chord for one of MiMo's `ctrl+` bindings (the terminal, the recent
 * conversations): Control on macOS, which is this app's "Meta" there, and the
 * same Ctrl as `mod` elsewhere. `rest` is the chord without that key.
 */
export function controlChord(rest: string, platform: string): string {
  const parts = [isMac(platform) ? "Meta" : "Ctrl", ...rest.split("+")]
  const key = parts.pop() ?? ""
  return [...parts.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)), key].join("+")
}

/**
 * Whether a key press belongs to an input method rather than to the page, as
 * MiMo tests it before acting on Enter in a field: Enter that commits a pinyin
 * candidate must not also save, pick or submit.
 */
export function composing(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing === true || event.keyCode === 229
}

export function chordOf(event: KeyboardEvent, platform = ""): string {
  // A key still being composed by an input method is not a shortcut yet.
  if (composing(event)) return ""
  // A bare modifier is not a chord, and capturing one would bind nothing.
  if (MODIFIER_CODES.has(event.code) || ["Control", "Alt", "Shift", "Meta"].includes(event.key)) return ""
  const mac = isMac(platform)
  const parts: string[] = []
  if (mac ? event.metaKey : event.ctrlKey) parts.push("Ctrl")
  if (event.altKey) parts.push("Alt")
  if (event.shiftKey) parts.push("Shift")
  if (mac ? event.ctrlKey : event.metaKey) parts.push("Meta")
  parts.push(keyOfCode(event.code) ?? keyOfKey(event.key))
  return parts.join("+")
}

/**
 * Whether a chord is worth storing. MiMo's rule: at least one modifier and a
 * key, so Shift+key is allowed and a bare key - an F-key included - is not.
 */
export function isBindable(chord: string): boolean {
  if (!chord) return false
  const parts = chord.split("+")
  const key = parts[parts.length - 1]
  return Boolean(key) && parts.length >= 2 && parts.slice(0, -1).every((part) => ORDER.includes(part))
}

const DISPLAY_KEYS: Record<string, string> = {
  Tab: "⇥",
  Space: "␣",
  Enter: "↵",
  Escape: "Esc",
}

/*
 * The chord as MiMo writes it on a key cap. Windows and Linux spell the
 * modifiers out with plus signs (Win+ or Super+ for Meta); macOS uses the
 * glyphs with no separators, where this app's Ctrl is the command key and
 * Meta the Control key. Tab, Space, Enter and Escape get their symbols. The
 * stored form is unchanged.
 */
export function formatChord(chord: string, platform: string): string {
  if (!chord) return ""
  const parts = chord.split("+")
  // A chord ending in "+" (Ctrl++) splits into an empty last part.
  const key = parts[parts.length - 1] || "+"
  const mods = parts.slice(0, -1).filter((part) => ORDER.includes(part))
  const shown = DISPLAY_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  if (platform === "darwin") {
    const glyph: Record<string, string> = { Alt: "⌥", Shift: "⇧", Meta: "⌃", Ctrl: "⌘" }
    const order = ["Meta", "Alt", "Shift", "Ctrl"]
    return mods.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((part) => glyph[part]).join("") + shown
  }
  const order = ["Ctrl", "Alt", "Shift", "Meta"]
  const name: Record<string, string> = {
    Ctrl: "Ctrl+",
    Alt: "Alt+",
    Shift: "Shift+",
    Meta: platform === "linux" ? "Super+" : "Win+",
  }
  return mods.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((part) => name[part]).join("") + shown
}

/** Whether the shortcuts page is recording a chord; the application menu drops its own chords meanwhile. */
export const recordingChord = ref(false)

/* The system chords are drawn for, set once the main process has said which it is. */
const shownOn = ref("")

export function setChordPlatform(platform: string): void {
  shownOn.value = platform
}

/**
 * A stored chord as this system writes it, for every place a shortcut is shown
 * (tips, menus, the launcher): ⌘K on macOS where the stored form is Ctrl+K.
 * Reactive, so what was drawn before the platform was known is redrawn.
 */
export function shownChord(chord: string): string {
  return formatChord(chord, shownOn.value)
}
