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

/**
 * The default chords round five dropped because MiMo's table has none, by the
 * command that carried them. Most commands stayed and only the chord went;
 * round nine deleted a few of them too (reopen tab, auto-accept, the scheme
 * cycle), and a saved default for those is dropped all the same.
 */
export const RETIRED_DEFAULTS: Readonly<Record<string, string>> = {
  "permissions.autoaccept": "Ctrl+Shift+A",
  "workspace.new": "Ctrl+Shift+W",
  "composer.promptMode": "Ctrl+Shift+E",
  "composer.shellMode": "Ctrl+Shift+X",
  "app.attachFile": "Ctrl+U",
  "app.searchProjects": "Ctrl+Shift+O",
  "session.prevUnread": "Alt+Shift+↑",
  "session.nextUnread": "Alt+Shift+↓",
  "session.prevMessage": "Ctrl+Alt+[",
  "session.nextMessage": "Ctrl+Alt+]",
  "session.reopenTab": "Ctrl+Shift+T",
  "app.mcp": "Ctrl+;",
  "agent.cycle": "Ctrl+.",
  "agent.cycle.reverse": "Ctrl+Shift+.",
  "project.previous": "Ctrl+Alt+↑",
  "project.next": "Ctrl+Alt+↓",
  "theme.scheme.cycle": "Ctrl+Shift+S",
}

/* The numbered project slots (Ctrl+Alt+1-9), which went with their chords. */
const RETIRED_COMMAND = /^project\.[1-9]$/

/**
 * Saved bindings after those chords went. A chord of the user's own choosing
 * stays and keeps working, since its command is still there. A binding that
 * only restated the old default, or cleared it (""), no longer says anything
 * and goes, so a chord MiMo lacks cannot live on through the config; so do the
 * bindings of the commands that no longer exist.
 */
export function retireKeybinds(binds: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, chord] of Object.entries(binds)) {
    if (RETIRED_COMMAND.test(id)) continue
    const old = RETIRED_DEFAULTS[id]
    if (old !== undefined && (!chord || normalizeChord(chord) === normalizeChord(old))) continue
    out[id] = chord
  }
  return out
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

export const KEYBINDS_VERSION = 1
export const FIND_SHORTCUT_DEFAULT = "Ctrl+F"

export function boundShortcut(
  command: { id: string; hint?: string },
  binds: Readonly<Record<string, string>>,
): string {
  return normalizeChord(Object.hasOwn(binds, command.id) ? binds[command.id] : command.hint ?? "")
}

/** Additional spellings accepted by the default keyboard actions. */
export const SHORTCUT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "zoom.in": ["Ctrl+Shift+=", "Ctrl+NumpadAdd"],
  "zoom.out": ["Ctrl+Shift+-", "Ctrl+NumpadSubtract"],
  "zoom.reset": ["Ctrl+Shift+0"],
  "composer.send": ["Alt+Enter", "Ctrl+Enter"],
  "notifications.focus": [
    "Ctrl+Alt+T", "Alt+Shift+T", "Alt+Meta+T",
    "Ctrl+Alt+Shift+T", "Ctrl+Alt+Meta+T", "Alt+Shift+Meta+T", "Ctrl+Alt+Shift+Meta+T",
  ],
}

export function shortcutChords(
  command: { id: string; hint?: string },
  binds: Readonly<Record<string, string>>,
): readonly string[] {
  const chord = boundShortcut(command, binds)
  if (!chord) return []
  return Object.hasOwn(binds, command.id) ? [chord] : [chord, ...(SHORTCUT_ALIASES[command.id] ?? [])]
}

/** Resolves the active keyboard commands. An explicit override takes priority over an older default. */
export function shortcutDispatch<Command extends { id: string; hint?: string }>(
  commands: readonly Command[],
  binds: Readonly<Record<string, string>>,
): Map<string, Command> {
  const active = new Map<string, Command>()
  for (const command of commands) {
    if (Object.hasOwn(binds, command.id)) continue
    for (const chord of shortcutChords(command, binds)) active.set(chord, command)
  }
  for (const command of commands) {
    if (!Object.hasOwn(binds, command.id)) continue
    const chord = boundShortcut(command, binds)
    if (chord) active.set(chord, command)
  }
  return active
}

export function sameShortcutBindings(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([id, chord]) => Object.hasOwn(right, id) && right[id] === chord)
}

/** Default shortcuts also displayed by the operating system's application menu. */
export const MENU_SHORTCUT_DEFAULTS = {
  "app.settings": "Ctrl+,",
  "session.new": "Ctrl+N",
  "project.open": "Ctrl+O",
  "window.close": "Ctrl+W",
  "zoom.in": "Ctrl+=",
  "zoom.out": "Ctrl+-",
  "zoom.reset": "Ctrl+0",
  "app.quit": "Ctrl+Q",
} as const

/* The four names a stored chord may put in front of a key, in the order the
   settings screen lists them. Lives here because both the window that records a
   chord and the menu bar that shows one spell a chord the same way. */
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"]

/* Keys whose cap shows a symbol rather than a letter, the numeric keypad's operators
   included: their legends are the symbols on the keys themselves, which is also what
   the menu bar draws for the documented accelerator names ("Plus", "Subtract"), so the
   row in the bar and the window's own words name one key rather than two. */
const KEY_CAPS: Record<string, string> = {
  Tab: "⇥",
  Space: "␣",
  Enter: "↵",
  Escape: "Esc",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadMultiply: "*",
  NumpadDivide: "/",
}

/**
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
  const mods = parts.slice(0, -1).filter((part) => MODIFIERS.includes(part))
  const shown = KEY_CAPS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
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

/** The hole the armed-quit notice leaves for the key cap, the same one every language's copy carries. */
export const QUIT_NOTICE_KEY = "{key}"

/**
 * The armed-quit notice spelled with the key that would actually quit, or nothing
 * when no key can be named for it.
 *
 * The copy holds {key} rather than a key cap of its own: the binding is the
 * person's, and both the menu bar's quit row and the window's toast must name the
 * key that row's own accelerator answers to. Naming a hole inside the sentence —
 * instead of hunting for a "⌘Q" a translator might have spelled differently — is
 * what keeps the words and the accelerator column saying one thing in all
 * eighteen languages.
 *
 * Nothing comes back when the binding cannot be spelled, or when a translation
 * lost the hole it was written with. Saying nothing beats naming a key that does
 * not quit: the caller keeps its plain quit row and shows no notice at all.
 */
export function fillQuitNotice(notice: string, bound: string, platform: string): string {
  const shown = formatChord(bound, platform)
  if (!shown || !notice.includes(QUIT_NOTICE_KEY)) return ""
  return notice.split(QUIT_NOTICE_KEY).join(shown)
}
