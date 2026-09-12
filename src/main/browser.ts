import { BrowserWindow, WebContentsView, shell, session } from "electron"
import { addressToURL, safeURL } from "@shared/web-address"

/**
 * The in-app browser panel.
 *
 * The page is a `WebContentsView` owned by the main process rather than a
 * `<webview>` inside the window. Both would draw the same rectangle; the
 * difference is where an arbitrary site runs. A webview tag would mean turning
 * `webviewTag` on for the window that draws this app's entire interface, and a
 * page loaded from the internet would then live inside that renderer's
 * process tree. A view is its own web contents with its own process, its own
 * session, and no preload at all - it has no way to reach this app.
 *
 * What it may do is narrow on purpose:
 *
 * - http and https only. A `file://` in the address bar would turn the panel
 *   into a file reader for anything the user can open, and `mcode://`-style
 *   internal schemes are not for a page to ask for.
 * - No permissions. The window's own handler allows a microphone because a
 *   button asks for it; a site in this panel gets nothing at all.
 * - New windows are handed to the real browser. A site that opens a popup
 *   should get the user's browser, with its extensions and its blocklists,
 *   rather than a second frameless view with no address bar.
 */

/** A partition of its own, so nothing it stores touches the app's session. */
const PARTITION = "persist:browser-panel"

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

interface Panel {
  view: WebContentsView
  bounds: BrowserBounds
}

const panels = new Map<number, Panel>()

function stateOf(view: WebContentsView): BrowserState {
  const contents = view.webContents
  return {
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  }
}

/**
 * Opens the panel for a window, or returns the one it already has.
 *
 * `onState` is called whenever the page moves, so the address bar the reader
 * is looking at describes the page they are looking at.
 */
export function openPanel(
  window: BrowserWindow,
  bounds: BrowserBounds,
  onState: (state: BrowserState) => void,
): Panel {
  const existing = panels.get(window.id)
  if (existing) {
    setBounds(window, bounds)
    return existing
  }

  const partition = session.fromPartition(PARTITION)
  /* A site in here is a stranger: it is given nothing it asks for. */
  partition.setPermissionRequestHandler((_contents, _permission, done) => done(false))
  partition.setPermissionCheckHandler(() => false)

  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /* No preload: there is nothing in this app a page here should reach. */
      webSecurity: true,
    },
  })

  const contents = view.webContents
  contents.setWindowOpenHandler(({ url }) => {
    const safe = safeURL(url)
    if (safe) void shell.openExternal(safe)
    return { action: "deny" }
  })
  /* A navigation to anything but the web is refused rather than followed. */
  contents.on("will-navigate", (event, url) => {
    if (!safeURL(url)) event.preventDefault()
  })

  const publish = () => onState(stateOf(view))
  for (const event of [
    "did-navigate",
    "did-navigate-in-page",
    "did-start-loading",
    "did-stop-loading",
    "page-title-updated",
  ] as const) {
    contents.on(event as never, publish)
  }

  window.contentView.addChildView(view)
  const panel: Panel = { view, bounds }
  panels.set(window.id, panel)
  setBounds(window, bounds)
  window.once("closed", () => closePanel(window))
  return panel
}

/** Where the panel sits. The renderer measures it; only it knows the layout. */
export function setBounds(window: BrowserWindow, bounds: BrowserBounds): void {
  const panel = panels.get(window.id)
  if (!panel) return
  panel.bounds = bounds
  panel.view.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  })
}

export function closePanel(window: BrowserWindow): void {
  const panel = panels.get(window.id)
  if (!panel) return
  panels.delete(window.id)
  try {
    window.contentView.removeChildView(panel.view)
  } catch {
    /* The window may already be gone; the view goes with it either way. */
  }
  panel.view.webContents.close()
}

export function hasPanel(window: BrowserWindow): boolean {
  return panels.has(window.id)
}

export function navigate(window: BrowserWindow, input: string): BrowserState | undefined {
  const panel = panels.get(window.id)
  if (!panel) return undefined
  const url = addressToURL(input)
  if (!url) return stateOf(panel.view)
  void panel.view.webContents.loadURL(url).catch(() => {
    /* A page that will not load says so in the view itself, which is where a
       reader is already looking; there is nothing useful to add out here. */
  })
  return stateOf(panel.view)
}

export function act(window: BrowserWindow, what: "back" | "forward" | "reload" | "stop"): BrowserState | undefined {
  const panel = panels.get(window.id)
  if (!panel) return undefined
  const contents = panel.view.webContents
  if (what === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  if (what === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  if (what === "reload") contents.reload()
  if (what === "stop") contents.stop()
  return stateOf(panel.view)
}

export function panelState(window: BrowserWindow): BrowserState | undefined {
  const panel = panels.get(window.id)
  return panel ? stateOf(panel.view) : undefined
}
