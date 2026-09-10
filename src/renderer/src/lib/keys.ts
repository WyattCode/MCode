/**
 * How a keystroke is written down, so a stored binding and a live event can be
 * compared as strings.
 *
 * Bindings are stored against `Mod`, not against a physical modifier: it is
 * Command on macOS and Control everywhere else. Writing `Ctrl` for both is what
 * this used to do, and on macOS that cost the system its own keys - Control
 * there is not an application modifier at all but the text-editing one every
 * field inherits, where ^K deletes to the end of the line, ^A and ^E jump to its
 * ends, ^F and ^B step a character. An app that answers to ^K has taken those
 * away from every field it draws.
 *
 * So `Mod` is the app's modifier, `Ctrl` on macOS means the real Control key and
 * is left to the system, and the two are different chords rather than one.
 */

/** Whether Command is the modifier applications use here. */
export const IS_MAC = navigator.platform.toUpperCase().includes("MAC")

/** The token an app binding is written with, whichever key that turns out to be. */
export const MOD = "Mod"

export function chordOf(event: KeyboardEvent): string {
  const parts: string[] = []
  // On macOS the two are told apart; elsewhere Control is the only one there is.
  if (IS_MAC) {
    if (event.metaKey) parts.push(MOD)
    if (event.ctrlKey) parts.push("Ctrl")
  } else if (event.ctrlKey || event.metaKey) {
    parts.push(MOD)
  }
  if (event.altKey) parts.push("Alt")
  if (event.shiftKey) parts.push("Shift")

  let key = event.key
  if (key === " ") key = "Space"
  else if (key === "ArrowUp") key = "↑"
  else if (key === "ArrowDown") key = "↓"
  else if (key === "ArrowLeft") key = "←"
  else if (key === "ArrowRight") key = "→"
  else if (key.length === 1) key = key.toUpperCase()

  // A bare modifier is not a chord, and capturing one would bind nothing.
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return ""
  parts.push(key)
  return parts.join("+")
}

/** Whether a chord is worth storing: bare letters would swallow typing. */
export function isBindable(chord: string): boolean {
  if (!chord) return false
  return chord.includes(`${MOD}+`) || chord.includes("Ctrl+") || chord.includes("Alt+") || /^F\d+$/.test(chord)
}

/**
 * A stored chord in the spelling of the platform it is read on.
 *
 * macOS writes chords as symbols with nothing between them, in the order the
 * system fixes - ⌃⌥⇧⌘ - and every menu on screen beside this one is doing the
 * same. Everywhere else the words stay, joined by plus signs.
 */
const MAC_SYMBOLS: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  [MOD]: "⌘",
}

const MAC_ORDER = ["Ctrl", "Alt", "Shift", MOD]

const MAC_KEYS: Record<string, string> = {
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↩",
  Escape: "⎋",
  Tab: "⇥",
  Space: "␣",
}

export function chordLabel(chord: string): string {
  if (!chord) return ""
  const parts = chord.split("+")
  const key = parts.pop() ?? ""
  if (!IS_MAC) return [...parts.map((part) => (part === MOD ? "Ctrl" : part)), key].join("+")

  const modifiers = MAC_ORDER.filter((name) => parts.includes(name)).map((name) => MAC_SYMBOLS[name])
  return modifiers.join("") + (MAC_KEYS[key] ?? key)
}

/**
 * Reads a binding written before `Mod` existed.
 *
 * Anything stored as `Ctrl+` was written when the two were one string, and meant
 * "the key applications use here" - Command, on macOS. A binding the user made
 * under the old spelling keeps working, and keeps meaning what they chose.
 */
export function canonicalChord(chord: string): string {
  if (!chord) return ""
  if (chord.includes(`${MOD}+`)) return chord
  return chord.replace(/\bCtrl\+/, `${MOD}+`)
}
