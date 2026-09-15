/**
 * A stored chord in the spelling the recorder writes now.
 *
 * Recording used to read the printed character, so Ctrl+Shift+[ was saved as
 * Ctrl+Shift+{. It now reads the physical key, as MiMo does, and a chord saved
 * the old way would never match a keystroke again. The shifted characters of a
 * US layout go back to the key they sit on; anything else is left as it was.
 */
const SHIFTED: Record<string, string> = {
  "{": "[",
  "}": "]",
  "?": "/",
  "+": "=",
  _: "-",
  ":": ";",
  '"': "'",
  "~": "`",
  "|": "\\",
  "<": ",",
  ">": ".",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
}

export function normalizeChord(chord: string): string {
  if (!chord) return chord
  let mods: string[]
  let key: string
  // "Ctrl+Shift++" names the plus key itself, which a split on "+" would lose.
  if (chord.endsWith("++")) {
    mods = chord.slice(0, -2).split("+")
    key = "+"
  } else {
    const at = chord.lastIndexOf("+")
    mods = at < 0 ? [] : chord.slice(0, at).split("+")
    key = chord.slice(at + 1)
  }
  if (!key) return chord
  const mapped = SHIFTED[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...mods, mapped].join("+")
}
