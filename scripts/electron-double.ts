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
  /* Shown, but entirely behind another window: what `isVisible()` still calls true and
     the page's own visibility calls hidden. */
  covered?: boolean
}

/** The id `src/main/menu.ts` gives its quit row, so a check can find it without reading English words. */
export const QUIT_ROW_ID = "app-quit"

const calls: Call[] = []
let windows: FakeWindow[] = []
/* Whether this system would post a notice at all: the arm has to hold either way. */
let noticesSupported = true
/* Whether `show()` throws, the way a system that refuses the banner would. */
let noticesThrow = false
let menus: unknown[] = []

const sendCalls = (): Call[] => calls.filter((call) => call.kind === "send")
const noticeCalls = (): Call[] => calls.filter((call) => call.kind === "notice")

/** What the module under test handed Electron, and nothing else. */
export const double = {
  reset(): void {
    calls.length = 0
    menus = []
    windows = []
    noticesSupported = true
    noticesThrow = false
  },
  /** `shown` is whether the window is on screen; `minimized` and `destroyed` speak for themselves. */
  setWindows(next: FakeWindow[]): void {
    windows = next
  },
  /** Whether the system this check runs on would post a notice; true unless a scenario says otherwise. */
  supportsNotices(yes: boolean): void {
    noticesSupported = yes
  },
  /** Whether showing a notice throws: a system that accepts the call and then refuses it. */
  noticesThrowOnShow(yes: boolean): void {
    noticesThrow = yes
  },
  calls,
  /** The channels every window was sent, in order. */
  sent(): string[] {
    return sendCalls().map((call) => String(call.channel))
  },
  /** The system notices posted, with the words they carry and whether they were silent. */
  notices(): { title: string; body: string; silent: boolean }[] {
    return noticeCalls().map((call) => call as unknown as { title: string; body: string; silent: boolean })
  },
  /**
   * The template behind the menu the app *installed* last.
   *
   * Built is not installed: a module may rebuild a menu and never hand it over, and
   * a check that read the last build would then be reading words nobody sees.
   */
  installedTemplate(): Record<string, unknown>[] {
    const last = menus[menus.length - 1] as { template?: unknown[] } | undefined
    return (last?.template ?? []) as Record<string, unknown>[]
  },
  /** The row that quits the app, found by the id the menu gives it, in the installed menu. */
  quitRow(): Record<string, unknown> | undefined {
    for (const item of double.installedTemplate()) {
      const nested = Array.isArray(item.submenu) ? (item.submenu as Record<string, unknown>[]) : []
      const found = nested.find((row) => row.id === QUIT_ROW_ID)
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

/*
 * The system's own notice. Written down like every other call, and quiet about the
 * platform: a check that read the notice claims what the app asked for, never what
 * the desktop decided to draw.
 */
export class Notification {
  private readonly options: { title?: string; body?: string; silent?: boolean }
  static isSupported(): boolean {
    return noticesSupported
  }
  constructor(options: { title?: string; body?: string; silent?: boolean }) {
    this.options = options
  }
  /* Written down when it is shown, not when it is built: a notice that was constructed
     and never shown told nobody anything, and a check that counted constructions would
     stay green with the call deleted. */
  show(): void {
    if (noticesThrow) throw new Error("this system will not post the notice")
    calls.push({ kind: "notice", title: this.options.title ?? "", body: this.options.body ?? "", silent: this.options.silent === true })
  }
}

export const Menu = {
  buildFromTemplate(template: unknown[]): { template: unknown[]; popup(): void } {
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
      /* Measured on 42.x: minimized reads false; covered by another window still reads
         true — that gap is the reason the page's own visibility is asked below. */
      isVisible: () => window.shown === true && window.minimized !== true,
      isMinimized: () => window.minimized === true,
      webContents: {
        send: (channel: string, ...args: unknown[]) => {
          calls.push({ kind: "send", channel, args })
        },
        getURL: () => "file:///index.html",
        /* The page's own visibility: hidden when the window is gone from the screen —
           minimized, hidden to the tray, or shown but entirely covered. That last one
           is why `isVisible()` alone cannot answer this question (measured on 42.x). */
        mainFrame: {
          visibilityState: window.shown === true && window.covered !== true && window.minimized !== true ? "visible" : "hidden",
        },
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
