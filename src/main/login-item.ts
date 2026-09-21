/**
 * 开机自启, MiMo 26.920's launch-at-login row (R18-M2).
 *
 * Offered on Windows and macOS only, as MiMo offers it; there is no Linux
 * autostart entry in either app. Off unless turned on.
 *
 * A packaged build asks the OS - the login item is the truth, since the user
 * can remove it in the OS's own settings - and registers itself with
 * `--openAsHidden` on Windows (macOS takes `openAsHidden`). A development build
 * would register the bare Electron binary, so it only keeps the choice in a
 * file, as MiMo's does. Nothing here imports Electron: the app object is handed
 * in, so the checks can hand in a stub and read back what it was asked.
 */

export const OPEN_HIDDEN_ARG = "--openAsHidden"

export const LOGIN_ITEM_FILE = "login-item.json"

/** What this needs of Electron's `app`. */
export interface LoginItemHost {
  isPackaged: boolean
  getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean; wasOpenedAtLogin?: boolean }
  setLoginItemSettings(settings: { openAtLogin: boolean; openAsHidden?: boolean; args?: string[] }): void
}

/** Where the choice is kept when there is no OS entry to ask. */
export interface LoginItemStore {
  read(): boolean
  write(enabled: boolean): void
}

export function loginItemSupported(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin"
}

/** Windows keys its entry by the arguments, so it is asked with the same ones it was written with. */
function loginArgs(platform: NodeJS.Platform): { args: string[] } | undefined {
  return platform === "win32" ? { args: [OPEN_HIDDEN_ARG] } : undefined
}

export function readLaunchAtLogin(host: LoginItemHost, platform: NodeJS.Platform, store: LoginItemStore): boolean {
  if (!loginItemSupported(platform)) return false
  return host.isPackaged ? host.getLoginItemSettings(loginArgs(platform)).openAtLogin : store.read()
}

export function writeLaunchAtLogin(host: LoginItemHost, platform: NodeJS.Platform, store: LoginItemStore, enabled: boolean): boolean {
  if (!loginItemSupported(platform)) return false
  if (host.isPackaged) {
    if (!enabled) host.setLoginItemSettings({ openAtLogin: false, ...loginArgs(platform) })
    else if (platform === "win32") host.setLoginItemSettings({ openAtLogin: true, args: [OPEN_HIDDEN_ARG] })
    else host.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })
  }
  store.write(enabled)
  return readLaunchAtLogin(host, platform, store)
}

/**
 * Whether this start came from the login item and should stay in the tray.
 *
 * Windows only, as MiMo's: macOS hides the app itself when the entry says
 * `openAsHidden`. Whether the tray is on is only known once the window has
 * read the settings, so this answers "start hidden"; the caller shows the
 * window after all should the tray turn out to be off.
 */
export function startsHidden(platform: NodeJS.Platform, argv: readonly string[]): boolean {
  return platform === "win32" && argv.includes(OPEN_HIDDEN_ARG)
}

/** The stored choice, which a missing or unreadable file leaves off. */
export function parseLoginItem(text: string): boolean {
  try {
    return (JSON.parse(text) as { openAtLogin?: unknown })?.openAtLogin === true
  } catch {
    return false
  }
}
