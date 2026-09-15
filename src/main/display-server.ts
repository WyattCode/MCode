/**
 * MiMo's 显示服务器 (Linux): which graphics backend Chromium runs on.
 *
 * Chromium takes these switches only before the app is ready, long before the
 * backend reads config.json, so the choice is kept in a small file of its own
 * in the profile. Nothing here touches Electron, so smoke can hold the rules.
 */

export type DisplayServerPref = "auto" | "wayland" | "x11"

export const DISPLAY_SERVER_PREFS: readonly DisplayServerPref[] = ["auto", "wayland", "x11"]

/** The file in the profile the choice is written to. */
export const DISPLAY_SERVER_FILE = "display-server.json"

export interface DisplayEnv {
  XDG_SESSION_TYPE?: string
  WAYLAND_DISPLAY?: string
}

export interface ChromiumSwitch {
  name: string
  value?: string
}

/** Anything unknown is 自动, as MiMo reads it. */
export function displayServerPref(raw: unknown): DisplayServerPref {
  return DISPLAY_SERVER_PREFS.find((entry) => entry === raw) ?? "auto"
}

export function readDisplayServerFile(text: string): DisplayServerPref {
  try {
    const parsed: unknown = JSON.parse(text)
    return displayServerPref(parsed && typeof parsed === "object" ? (parsed as { displayServer?: unknown }).displayServer : undefined)
  } catch {
    return "auto"
  }
}

/*
 * The platform to force: the one chosen, or for 自动 a Wayland session's.
 * Undefined leaves Chromium on its own default, which is X11.
 */
export function ozonePlatform(pref: DisplayServerPref, env: DisplayEnv): "wayland" | "x11" | undefined {
  if (pref !== "auto") return pref
  return env.XDG_SESSION_TYPE === "wayland" || Boolean(env.WAYLAND_DISPLAY) ? "wayland" : undefined
}

/* A Linux launch's switches, as MiMo sets them: GTK 3 always, and Wayland's input method when on Wayland. */
export function displaySwitches(platform: string, pref: DisplayServerPref, env: DisplayEnv): ChromiumSwitch[] {
  if (platform !== "linux") return []
  const ozone = ozonePlatform(pref, env)
  const switches: ChromiumSwitch[] = [{ name: "gtk-version", value: "3" }]
  if (ozone) switches.push({ name: "ozone-platform", value: ozone })
  if (ozone === "wayland") switches.push({ name: "enable-wayland-ime" }, { name: "wayland-text-input-version", value: "3" })
  return switches
}
