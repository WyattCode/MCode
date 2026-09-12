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
 * - http and https only, decided in @shared/web-address. A `file://` in the
 *   address bar would turn the panel into a file reader for anything the user
 *   can open, and internal schemes are not for a page to ask for.
 * - No permissions. The window's own handler allows a microphone because a
 *   button asks for it; a site in this panel gets nothing at all.
 * - New windows are handed to the real browser. A site that opens a popup
 *   should get the user's browser, with its extensions and its blocklists,
 *   rather than a second frameless view with no address bar.
 *
 * Tabs are views of their own, and only the open one is attached to the
 * window. A background tab keeps running - its process is alive and its page
 * carries on - it simply is not drawn, which is what a tab is.
 */

/** A partition of its own, so nothing it stores touches the app's session. */
const PARTITION = "persist:browser-panel"

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserTab {
  id: string
  title: string
  url: string
  loading: boolean
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  tabs: BrowserTab[]
  active: string
}

interface Tab {
  id: string
  view: WebContentsView
}

interface Panel {
  tabs: Tab[]
  active: string
  bounds: BrowserBounds
  publish: () => void
}

const panels = new Map<number, Panel>()
let counter = 0

const EMPTY: BrowserState = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  tabs: [],
  active: "",
}

function tabOf(panel: Panel, id: string): Tab | undefined {
  return panel.tabs.find((tab) => tab.id === id)
}

function activeTab(panel: Panel): Tab | undefined {
  return tabOf(panel, panel.active) ?? panel.tabs[0]
}

function describe(tab: Tab): BrowserTab {
  const contents = tab.view.webContents
  return {
    id: tab.id,
    title: contents.getTitle(),
    url: contents.getURL(),
    loading: contents.isLoading(),
  }
}

function stateOf(panel: Panel): BrowserState {
  const tab = activeTab(panel)
  const contents = tab?.view.webContents
  return {
    url: contents?.getURL() ?? "",
    title: contents?.getTitle() ?? "",
    loading: contents?.isLoading() ?? false,
    canGoBack: contents?.navigationHistory.canGoBack() ?? false,
    canGoForward: contents?.navigationHistory.canGoForward() ?? false,
    tabs: panel.tabs.map(describe),
    active: tab?.id ?? "",
  }
}

/**
 * A new page, in its own process.
 *
 * Every tab is built here, so the refusals above are written once rather than
 * once per path that happens to open one.
 */
function makeTab(panel: Panel): Tab {
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
  for (const event of [
    "did-navigate",
    "did-navigate-in-page",
    "did-start-loading",
    "did-stop-loading",
    "page-title-updated",
  ] as const) {
    contents.on(event as never, () => panel.publish())
  }

  counter += 1
  return { id: `tab-${counter}`, view }
}

/** Draws the open tab and only the open tab. */
function show(window: BrowserWindow, panel: Panel): void {
  for (const tab of panel.tabs) {
    const isActive = tab.id === panel.active
    const attached = window.contentView.children.includes(tab.view)
    if (isActive && !attached) window.contentView.addChildView(tab.view)
    if (!isActive && attached) window.contentView.removeChildView(tab.view)
  }
  setBounds(window, panel.bounds)
}

export function openPanel(
  window: BrowserWindow,
  bounds: BrowserBounds,
  onState: (state: BrowserState) => void,
): BrowserState {
  const existing = panels.get(window.id)
  if (existing) {
    existing.publish = () => onState(stateOf(existing))
    setBounds(window, bounds)
    return stateOf(existing)
  }

  const partition = session.fromPartition(PARTITION)
  /* A site in here is a stranger: it is given nothing it asks for. */
  partition.setPermissionRequestHandler((_contents, _permission, done) => done(false))
  partition.setPermissionCheckHandler(() => false)

  const panel: Panel = { tabs: [], active: "", bounds, publish: () => {} }
  panel.publish = () => onState(stateOf(panel))
  const first = makeTab(panel)
  panel.tabs.push(first)
  panel.active = first.id
  panels.set(window.id, panel)
  show(window, panel)
  window.once("closed", () => closePanel(window))
  return stateOf(panel)
}

/** Where the panel sits. The renderer measures it; only it knows the layout. */
export function setBounds(window: BrowserWindow, bounds: BrowserBounds): void {
  const panel = panels.get(window.id)
  if (!panel) return
  panel.bounds = bounds
  activeTab(panel)?.view.setBounds({
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
  for (const tab of panel.tabs) {
    try {
      window.contentView.removeChildView(tab.view)
    } catch {
      /* The window may already be gone; the views go with it either way. */
    }
    tab.view.webContents.close()
  }
}

export function newTab(window: BrowserWindow): BrowserState | undefined {
  const panel = panels.get(window.id)
  if (!panel) return undefined
  const tab = makeTab(panel)
  panel.tabs.push(tab)
  panel.active = tab.id
  show(window, panel)
  return stateOf(panel)
}

export function selectTab(window: BrowserWindow, id: string): BrowserState | undefined {
  const panel = panels.get(window.id)
  if (!panel || !tabOf(panel, id)) return undefined
  panel.active = id
  show(window, panel)
  return stateOf(panel)
}

/**
 * Closes one tab.
 *
 * The neighbour to the right takes over, which is where the eye already is
 * after closing something; the left one is taken only at the end of the row.
 * Closing the last one leaves the panel with nothing to be a frame around, so
 * the panel goes too and the window is told it has.
 */
export function closeTab(window: BrowserWindow, id: string): BrowserState | undefined {
  const panel = panels.get(window.id)
  if (!panel) return undefined
  const at = panel.tabs.findIndex((tab) => tab.id === id)
  if (at === -1) return stateOf(panel)
  const [gone] = panel.tabs.splice(at, 1)
  try {
    window.contentView.removeChildView(gone.view)
  } catch {
    /* Already detached, which is the state this wanted anyway. */
  }
  gone.view.webContents.close()
  if (!panel.tabs.length) {
    closePanel(window)
    return EMPTY
  }
  if (panel.active === id) panel.active = (panel.tabs[at] ?? panel.tabs[at - 1]).id
  show(window, panel)
  return stateOf(panel)
}

export function navigate(window: BrowserWindow, input: string): BrowserState | undefined {
  const panel = panels.get(window.id)
  if (!panel) return undefined
  const tab = activeTab(panel)
  const url = addressToURL(input)
  if (!tab || !url) return stateOf(panel)
  void tab.view.webContents.loadURL(url).catch(() => {
    /* A page that will not load says so in the view itself, which is where a
       reader is already looking; there is nothing useful to add out here. */
  })
  return stateOf(panel)
}

export function act(
  window: BrowserWindow,
  what: "back" | "forward" | "reload" | "stop",
): BrowserState | undefined {
  const panel = panels.get(window.id)
  if (!panel) return undefined
  const contents = activeTab(panel)?.view.webContents
  if (!contents) return stateOf(panel)
  if (what === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  if (what === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  if (what === "reload") contents.reload()
  if (what === "stop") contents.stop()
  return stateOf(panel)
}

export function panelState(window: BrowserWindow): BrowserState | undefined {
  const panel = panels.get(window.id)
  return panel ? stateOf(panel) : undefined
}

export function hasPanel(window: BrowserWindow): boolean {
  return panels.has(window.id)
}
