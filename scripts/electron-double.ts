/**
 * A stand-in for Electron's main-process surface, for a check that has to see what
 * a module *does* rather than what its source says.
 *
 * `scripts/rounds-check.mjs` refuses any smoke module that imports `"electron"`, and
 * for good reason: a round that drives a real window is slow, needs a screen, and is
 * left holding a running app when it fails. What it was refusing along with that was
 * the middle case — an app module bundled against an object that is not Electron at
 * all, which is how the menu bar's own behaviour was tested for the first time. No
 * window exists here, nothing is drawn, and every call is only written down.
 *
 * Bundled, not imported: the entry the check bundles names this file where Electron
 * would have been, so the module under test and this file share one instance.
 */

export type Call = { kind: string; [detail: string]: unknown }

interface FakeWindow {
  shown?: boolean
  minimized?: boolean
  destroyed?: boolean
  focused?: boolean
}

const calls: Call[] = []
let windows: FakeWindow[] = []
let templates: unknown[][] = []
let menus: unknown[] = []

const sendCalls = (): Call[] => calls.filter((call) => call.kind === "send")

/** What the module under test handed Electron, and nothing else. */
export const double = {
  reset(): void {
    calls.length = 0
    templates = []
    menus = []
    windows = []
  },
  /** `shown` is whether the window is on screen; `minimized` and `destroyed` speak for themselves. */
  setWindows(next: FakeWindow[]): void {
    windows = next
  },
  calls,
  /** The channels every window was sent, in order. */
  sent(): string[] {
    return sendCalls().map((call) => String(call.channel))
  },
  /** The last template the menu bar was rebuilt from. */
  template(): Record<string, unknown>[] {
    return (templates[templates.length - 1] ?? []) as Record<string, unknown>[]
  },
  /** The row that quits a macOS app, wherever the template hides it. */
  quitRow(): Record<string, unknown> | undefined {
    for (const item of double.template()) {
      const nested = Array.isArray(item.submenu) ? (item.submenu as Record<string, unknown>[]) : []
      const found = nested.find((row) => typeof row.click === "function" && String(row.label).includes("Quit"))
      if (found) return found
    }
    return undefined
  },
  /** How many times the application menu was replaced. */
  menuSets(): number {
    return menus.length
  },
  record(call: Call): void {
    calls.push(call)
  },
}

export const Menu = {
  buildFromTemplate(template: unknown[]): { template: unknown[]; popup(): void } {
    templates.push(template)
    return {
      template,
      popup(): void {
        calls.push({ kind: "popup" })
      },
    }
  },
  setApplicationMenu(menu: unknown): void {
    menus.push(menu)
  },
}

export const BrowserWindow = {
  getAllWindows(): unknown[] {
    return windows.map((window) => ({
      isDestroyed: () => window.destroyed === true,
      isVisible: () => window.shown === true,
      isMinimized: () => window.minimized === true,
      webContents: {
        send: (channel: string, ...args: unknown[]) => {
          calls.push({ kind: "send", channel, args })
        },
        getURL: () => "file:///index.html",
      },
    }))
  },
  getFocusedWindow(): unknown {
    const focused = windows.find((window) => window.focused && window.destroyed !== true)
    return focused ? BrowserWindow.getAllWindows()[windows.indexOf(focused)] ?? null : null
  },
}

/* Anything a module might call on these is written down and answers with the shape
   a confirm dialog would give ({response: 0} is the default button), because a check
   that only arms a quit never reaches for the answer and a check that does reach it
   would rather not have this file invent a decision. */
function recorder(name: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_obj, key) => {
        const asString = String(key)
        if (asString === "then") return undefined
        return (...args: unknown[]) => {
          calls.push({ kind: "app", method: `${name}.${asString}`, args })
          return { response: 0, checkboxChecked: false }
        }
      },
    },
  )
}

export const app = recorder("app")
export const dialog = recorder("dialog")
export const screen = recorder("screen")
/* The titlebar reads whether the system is dark; a check here never changes the
   theme, so the answer is a fixed light one rather than an imitation. */
export const nativeTheme = {
  shouldUseDarkColors: false,
  themeSource: "system" as string,
  on(): void {},
  once(): void {},
  off(): void {},
}
export const ipcMain = recorder("ipcMain")
export const shell = recorder("shell")
export const session = recorder("session")
export const systemPreferences = recorder("systemPreferences")
export const powerMonitor = recorder("powerMonitor")
export const clipboard = recorder("clipboard")
export const nativeImage = recorder("nativeImage")
export const Tray = recorder("Tray")
export const MenuItem = recorder("MenuItem")
