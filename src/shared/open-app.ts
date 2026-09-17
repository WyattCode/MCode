/**
 * The applications the review panel offers to open a project directory in.
 *
 * One table, read from both ends: the panel builds its menu from it, and the
 * main process validates against it before it starts anything. That is the
 * point of the file - the renderer is not the authority on what may be
 * launched, so the two lists have to be the same list rather than two lists
 * that agree today.
 *
 * Each entry is the id the remembered choice is stored under, the i18n key
 * the row is labelled with, and the `openWith` name handed to the platform.
 * Windows keeps the reference's five; macOS and Linux follow MiMo (round ten).
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
  /**
   * Where to look before offering it. On macOS the bundle names tried in
   * MiMo's five application folders (`<openWith>.app` when absent); elsewhere
   * the command names tried on PATH (`openWith` when absent), and the one
   * found is what is started.
   */
  find?: string[]
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
  // Its command is subl, and the editor itself is sublime_text; "Sublime Text" is on no PATH.
  { id: "sublime-text", label: "session.header.open.app.sublimeText", openWith: "subl", find: ["subl", "sublime_text"] },
]

/**
 * macOS, as MiMo lists its open targets: Terminal (always at
 * /System/Applications/Utilities), then its nineteen editors and terminals in
 * its order, each with the bundle names it tries. `openWith` is the name for
 * `open -a`; the bundle found is what is actually opened with.
 *
 * Filtered before it is drawn: only what is installed is shown.
 */
export const MAC_APPS: OpenApp[] = [
  { id: "terminal", label: "session.header.open.app.terminal", openWith: "Terminal" },
  { id: "vscode", label: "session.header.open.app.vscode", openWith: "Visual Studio Code" },
  { id: "cursor", label: "session.header.open.app.cursor", openWith: "Cursor" },
  { id: "sublime-text", label: "session.header.open.app.sublimeText", openWith: "Sublime Text" },
  { id: "zed", label: "session.header.open.app.zed", openWith: "Zed" },
  { id: "xcode", label: "session.header.open.app.xcode", openWith: "Xcode" },
  { id: "android-studio", label: "session.header.open.app.androidStudio", openWith: "Android Studio" },
  { id: "pycharm", label: "session.header.open.app.pycharm", openWith: "PyCharm", find: ["PyCharm.app", "PyCharm CE.app", "PyCharm Community Edition.app"] },
  {
    id: "intellij-idea",
    label: "session.header.open.app.intellijIdea",
    openWith: "IntelliJ IDEA",
    find: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"],
  },
  { id: "webstorm", label: "session.header.open.app.webstorm", openWith: "WebStorm" },
  { id: "goland", label: "session.header.open.app.goland", openWith: "GoLand" },
  { id: "clion", label: "session.header.open.app.clion", openWith: "CLion" },
  { id: "rustrover", label: "session.header.open.app.rustrover", openWith: "RustRover" },
  { id: "fleet", label: "session.header.open.app.fleet", openWith: "Fleet" },
  { id: "nova", label: "session.header.open.app.nova", openWith: "Nova" },
  { id: "iterm2", label: "session.header.open.app.iterm2", openWith: "iTerm" },
  { id: "ghostty", label: "session.header.open.app.ghostty", openWith: "Ghostty" },
  { id: "warp", label: "session.header.open.app.warp", openWith: "Warp" },
  { id: "kitty", label: "session.header.open.app.kitty", openWith: "kitty" },
  { id: "alacritty", label: "session.header.open.app.alacritty", openWith: "Alacritty" },
]

/**
 * Linux: none. MiMo looks only for macOS application bundles, so away from a
 * Mac its list holds the file manager alone.
 */
export const LINUX_APPS: OpenApp[] = []

/** The kinds of document a delivered-file card offers document apps for. */
export type DocKind = "pptx" | "docx" | "xlsx" | "pdf"

/**
 * MiMo's 打开方式 on a delivered document: the apps for its kind, macOS only
 * (MiMo looks for bundles, so the group is empty on Windows and Linux). The
 * names are the apps' own and are shown as they are.
 */
const WPS: OpenApp = { id: "wps", label: "WPS Office", openWith: "WPS Office", find: ["wpsoffice.app", "WPS Office.app"] }
const LIBREOFFICE: OpenApp = { id: "libreoffice", label: "LibreOffice", openWith: "LibreOffice" }
export const MAC_DOC_APPS: Record<DocKind, OpenApp[]> = {
  pptx: [
    { id: "keynote", label: "Keynote", openWith: "Keynote" },
    { id: "powerpoint", label: "Microsoft PowerPoint", openWith: "Microsoft PowerPoint" },
    WPS,
    LIBREOFFICE,
  ],
  docx: [{ id: "pages", label: "Pages", openWith: "Pages" }, { id: "word", label: "Microsoft Word", openWith: "Microsoft Word" }, WPS, LIBREOFFICE],
  xlsx: [
    { id: "numbers", label: "Numbers", openWith: "Numbers" },
    { id: "excel", label: "Microsoft Excel", openWith: "Microsoft Excel" },
    WPS,
    LIBREOFFICE,
  ],
  pdf: [
    { id: "preview", label: "Preview", openWith: "Preview" },
    {
      id: "acrobat",
      label: "Adobe Acrobat",
      openWith: "Adobe Acrobat",
      find: ["Adobe Acrobat.app", "Adobe Acrobat DC.app", "Adobe Acrobat Reader.app", "Adobe Acrobat Reader DC.app"],
    },
    WPS,
  ],
}

/** The document apps a platform offers for a kind; empty away from macOS. */
export function docApps(kind: string, platform: string): OpenApp[] {
  if (platform !== "darwin" || !Object.hasOwn(MAC_DOC_APPS, kind)) return []
  return MAC_DOC_APPS[kind as DocKind]
}

/** Every app a platform may open something with: the open targets and, on macOS, the document apps. */
export function launchableApps(platform: string): OpenApp[] {
  if (platform !== "darwin") return openApps(platform)
  return [...openApps(platform), ...Object.values(MAC_DOC_APPS).flat()]
}

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
  return launchableApps(platform).some((app) => app.openWith === value)
}
