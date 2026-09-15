/**
 * The choices main has to act on before the app is ready, long before the
 * backend reads config.json: the app theme (so the native theme, and with it
 * the window's first paint, already matches) and hardware acceleration (which
 * Chromium only takes before ready). Kept in a small file of its own, as
 * display-server.json is. Nothing here touches Electron, so smoke holds it.
 */

export type ThemePref = "system" | "light" | "dark"

export interface BootPrefs {
  theme: ThemePref
  hardwareAcceleration: boolean
}

export const BOOT_PREFS_FILE = "boot-prefs.json"

export const BOOT_DEFAULTS: BootPrefs = { theme: "system", hardwareAcceleration: true }

/** Anything unknown follows the system, as MiMo's native theme does. */
export function themePref(raw: unknown): ThemePref {
  return raw === "light" || raw === "dark" ? raw : "system"
}

/* MiMo's reading: on unless it was explicitly turned off. */
function enabled(raw: unknown): boolean {
  return !(raw === false || raw === "0")
}

export function readBootPrefs(text: string): BootPrefs {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...BOOT_DEFAULTS }
    const entry = parsed as { theme?: unknown; hardwareAcceleration?: unknown }
    return { theme: themePref(entry.theme), hardwareAcceleration: enabled(entry.hardwareAcceleration) }
  } catch {
    return { ...BOOT_DEFAULTS }
  }
}

export function writeBootPrefs(prefs: BootPrefs): string {
  return JSON.stringify({ theme: prefs.theme, hardwareAcceleration: prefs.hardwareAcceleration })
}

/** MiMo's main plane before the first paint, and behind a resize. */
export function windowBackground(dark: boolean): string {
  return dark ? "#181818" : "#ffffff"
}
