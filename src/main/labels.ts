/**
 * The strings the main process puts on screen, in the language the window is
 * showing.
 *
 * Every translation in this app lives in the renderer's table. The main process
 * has none of its own and no way to read that one, so the window sends the
 * finished strings across whenever the language changes and this holds them
 * until it does again. A key the window has not sent falls back to the English
 * written beside the call, which is what happens for a key nobody has added to
 * the renderer's published list yet: the menu or the dialog still reads
 * correctly, it just reads in English.
 *
 * This lives apart from the menu because the menu is no longer the only thing
 * out here with words in it - the recovery dialogs have them too, and they must
 * not have to import the menu to get at them.
 */
let table: Record<string, string> = {}

/**
 * The window's table, checked the way the menu's key message is: only a plain
 * object passes, and only its string values are kept. Anything else keeps the
 * table already held and answers false - `label()` reads this table for every
 * menu item, tray row and dialog, so a bad message must not reach it.
 */
export function setLabels(next: unknown): boolean {
  if (!next || typeof next !== "object" || Array.isArray(next)) return false
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(next)) if (typeof value === "string") out[key] = value
  table = out
  return true
}

/**
 * A label, with `{{name}}` substitution.
 *
 * The placeholder syntax matches the renderer's own table so a string can move
 * between the two without being rewritten. A placeholder with no value given is
 * left standing rather than blanked, because in a dialog that exists to explain
 * a failure, "Code: {{code}}" at least names what could not be determined,
 * whereas "Code: " reads like the answer was genuinely empty.
 */
export function label(key: string, fallback: string, values?: Record<string, string | number>): string {
  const message = table[key] ?? fallback
  if (!values) return message
  return message.replace(/\{\{([^{}]+)\}\}/g, (whole, name: string) => {
    const value = values[name]
    return value === undefined ? whole : String(value)
  })
}
