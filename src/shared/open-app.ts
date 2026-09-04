/**
 * The applications the review panel offers to open a project directory in.
 *
 * One table, read from both ends: the panel builds its menu from it, and the
 * main process validates against it before it starts anything. That is the
 * point of the file - the renderer is not the authority on what may be
 * launched, so the two lists have to be the same list rather than two lists
 * that agree today.
 *
 * The entries are the reference's own, verbatim from its `WINDOWS_APPS`,
 * `MAC_APPS` and `LINUX_APPS`: the id it stores the remembered choice under,
 * the i18n key it labels the row with, and the `openWith` name it hands the
 * platform.
 */
export interface OpenApp {
  /** Stored as the remembered choice, and the value the menu radio carries. */
  id: string
  /** i18n key for the row's label. */
  label: string
  /**
   * What the OS is asked to open with.
   *
   * On Windows this is a command name to be found on PATH, and on macOS the
   * name of an application bundle for `open -a`. The reference draws the same
   * distinction with the same values.
   */
  openWith: string
}

/**
 * Windows, exactly as the reference lists it.
 *
 * The reference shows all five whether or not they are installed: its
 * `checkAppExists` (out/main/index.js @1801) returns `true` outright on win32
 * and on linux, and only does any work on macOS, where it looks for the bundle
 * under /Applications. So there is nothing to probe for here, and a machine
 * without Sublime Text still sees the row - choosing it falls back to the
 * shell, which is the reference's behaviour and is described at the call site.
 */
export const WINDOWS_APPS: OpenApp[] = [
  { id: "vscode", label: "session.header.open.app.vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", openWith: "zed" },
  { id: "powershell", label: "session.header.open.app.powershell", openWith: "powershell" },
  { id: "sublime-text", label: "session.header.open.app.sublimeText", openWith: "Sublime Text" },
]

/**
 * macOS, exactly as the reference lists it.
 *
 * Twelve, and the longest of the three because a Mac is where the editors and
 * the terminals both live. `openWith` here is a bundle name for `open -a`, not
 * a command on PATH - "Visual Studio Code", not "code" - which is the same
 * split the reference draws.
 *
 * Unlike the other two this list is filtered before it is drawn: the
 * reference's `checkAppExists` does real work only on macOS, where it looks
 * for the bundle under /Applications, and shows a row only for what is there.
 */
export const MAC_APPS: OpenApp[] = [
  { id: "vscode", label: "session.header.open.app.vscode", openWith: "Visual Studio Code" },
  { id: "cursor", label: "session.header.open.app.cursor", openWith: "Cursor" },
  { id: "zed", label: "session.header.open.app.zed", openWith: "Zed" },
  { id: "textmate", label: "session.header.open.app.textmate", openWith: "TextMate" },
  { id: "antigravity", label: "session.header.open.app.antigravity", openWith: "Antigravity" },
  { id: "terminal", label: "session.header.open.app.terminal", openWith: "Terminal" },
  { id: "iterm2", label: "session.header.open.app.iterm2", openWith: "iTerm" },
  { id: "ghostty", label: "session.header.open.app.ghostty", openWith: "Ghostty" },
  { id: "warp", label: "session.header.open.app.warp", openWith: "Warp" },
  { id: "xcode", label: "session.header.open.app.xcode", openWith: "Xcode" },
  { id: "android-studio", label: "session.header.open.app.androidStudio", openWith: "Android Studio" },
  { id: "sublime-text", label: "session.header.open.app.sublimeText", openWith: "Sublime Text" },
]

/** Linux, exactly as the reference lists it: the four that ship a CLI. */
export const LINUX_APPS: OpenApp[] = [
  { id: "vscode", label: "session.header.open.app.vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", openWith: "zed" },
  { id: "sublime-text", label: "session.header.open.app.sublimeText", openWith: "Sublime Text" },
]

/**
 * The file manager, which is the default choice and has no `openWith`.
 *
 * The reference calls this option "finder" on every platform - that is the id
 * its remembered choice starts at - and only its label changes with the OS.
 * Having no `openWith` is what makes it the plain "hand it to the shell" path
 * rather than a launch.
 */
export const FILE_MANAGER_ID = "finder"

/** What to call that option here, which is the only part the OS changes. */
export function fileManagerLabel(platform: string) {
  if (platform === "darwin") return "session.header.open.finder"
  if (platform === "win32") return "session.header.open.fileExplorer"
  return "session.header.open.fileManager"
}

/** Which apps this platform offers. */
export function openApps(platform: string): OpenApp[] {
  if (platform === "win32") return WINDOWS_APPS
  if (platform === "darwin") return MAC_APPS
  return LINUX_APPS
}

/**
 * Whether a name may be launched on this platform.
 *
 * Asked in the main process, on the way in from the renderer. The reference
 * passes whatever the window sends straight to `execFile` because it treats
 * its own renderer as trusted; this app does not, for the same reason
 * `mcode:open-external` checks the scheme rather than believing the caller
 * checked it.
 *
 * The platform is required rather than optional, and only its own table is
 * consulted. An earlier version here read all three on the reasoning that the
 * question was "what may ever be run" and that one table was one fewer thing
 * to get wrong. That reasoning was about tidiness and it was answering the
 * wrong question: away from macOS the name goes to `execFile` as a command on
 * PATH, so accepting the macOS table on Windows would have let a compromised
 * window ask for `Xcode`, `Terminal` or `Ghostty` by name. The guard should be
 * as narrow as the truth allows, and the truth is one platform at a time.
 */
export function isKnownOpenWith(value: unknown, platform: string): value is string {
  if (typeof value !== "string") return false
  return openApps(platform).some((app) => app.openWith === value)
}
