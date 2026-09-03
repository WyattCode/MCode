/**
 * The applications the review panel offers to open a project directory in.
 *
 * One table, read from both ends: the panel builds its menu from it, and the
 * main process validates against it before it starts anything. That is the
 * point of the file - the renderer is not the authority on what may be
 * launched, so the two lists have to be the same list rather than two lists
 * that agree today.
 *
 * The entries are the reference's own, verbatim from `WINDOWS_APPS` at
 * main-8t-QUXax.js @4011989: the id it stores the remembered choice under, the
 * i18n key it labels the row with, and the `openWith` name it hands the
 * platform. It also ships a `MAC_APPS` of twelve and a `LINUX_APPS` of four -
 * see the note at the bottom of this file for why neither is here.
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
 * The file manager, which is the default choice and has no `openWith`.
 *
 * The reference calls this option "finder" on every platform - that is the id
 * its remembered choice starts at - and only its label changes with the OS
 * (`fileManagerApp`, main-8t-QUXax.js @3986107). Having no `openWith` is what
 * makes it the plain "hand it to the shell" path rather than a launch.
 */
export const FILE_MANAGER_ID = "finder"

/**
 * Which apps this platform offers.
 *
 * Empty away from Windows, and that is a shortfall rather than a decision: the
 * reference has twelve macOS entries and four Linux ones, but MCode's string
 * tables carry only the Windows five plus "File Explorer". A row cannot be
 * drawn without a label, and inventing one is the one thing this project does
 * not do, so those platforms keep the single shell button they have today.
 */
export function openApps(platform: string): OpenApp[] {
  return platform === "win32" ? WINDOWS_APPS : []
}

/**
 * Whether a name may be launched at all.
 *
 * Asked in the main process, on the way in from the renderer. The reference
 * passes whatever the window sends straight to `execFile` (its "open-path"
 * handler, out/main/index.js @89250) because it treats its own renderer as
 * trusted; this app does not, for the same reason `mcode:open-external` checks
 * the scheme rather than believing the caller checked it. Nothing outside this
 * table can be started, whatever the window asks for.
 */
export function isKnownOpenWith(value: unknown): value is string {
  return typeof value === "string" && WINDOWS_APPS.some((app) => app.openWith === value)
}
