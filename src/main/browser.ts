import { BrowserWindow, WebContentsView, clipboard, shell, session } from "electron"
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
  /** The open page's zoom, in percent. */
  zoom: number
  /** Why the open page did not load, until the next load starts. */
  error?: { code: number; url: string }
}

interface Tab {
  id: string
  view: WebContentsView
  failure?: { code: number; url: string }
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
  zoom: 100,
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
    zoom: Math.round((contents?.getZoomFactor() ?? 1) * 100),
    ...(tab?.failure ? { error: tab.failure } : {}),
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
    "did-stop-loading",
    "page-title-updated",
  ] as const) {
    contents.on(event as never, () => panel.publish())
  }

  counter += 1
  const tab: Tab = { id: `tab-${counter}`, view }
  /* A new load forgets the last failure; a failed main frame is kept for the tab to say so. */
  contents.on("did-start-loading", () => {
    tab.failure = undefined
    panel.publish()
  })
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    // -3 is a load the page itself abandoned for another, which is not a failure.
    if (!isMainFrame || code === -3) return
    tab.failure = { code, url }
    panel.publish()
  })
  return tab
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
  /*
   * A page for a browser tab of the right panel. Each tab there holds a page of
   * its own, so asking again - once the panel is up - adds one rather than
   * handing back the page some other tab already holds.
   */
  const existing = panels.get(window.id)
  if (existing) {
    existing.publish = () => onState(stateOf(existing))
    existing.bounds = bounds
    return newTab(window) ?? stateOf(existing)
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

export type BrowserAct = "back" | "forward" | "reload" | "forceReload" | "stop" | "zoomIn" | "zoomOut" | "zoomReset"

/* Zoom moves in tenths, from a quarter of the page to five times it. */
const ZOOM_STEP = 0.1
const ZOOM_MIN = 0.25
const ZOOM_MAX = 5

export function act(window: BrowserWindow, what: BrowserAct): BrowserState | undefined {
  const panel = panels.get(window.id)
  if (!panel) return undefined
  const contents = activeTab(panel)?.view.webContents
  if (!contents) return stateOf(panel)
  if (what === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  if (what === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  if (what === "reload") contents.reload()
  if (what === "forceReload") contents.reloadIgnoringCache()
  if (what === "stop") contents.stop()
  if (what === "zoomIn" || what === "zoomOut") {
    const next = contents.getZoomFactor() + (what === "zoomIn" ? ZOOM_STEP : -ZOOM_STEP)
    contents.setZoomFactor(Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)) * 10) / 10)
  }
  if (what === "zoomReset") contents.setZoomFactor(1)
  return stateOf(panel)
}

/** The open page, as it is drawn, onto the clipboard. False when there is nothing to take. */
export async function screenshot(window: BrowserWindow): Promise<boolean> {
  const panel = panels.get(window.id)
  const contents = panel ? activeTab(panel)?.view.webContents : undefined
  if (!contents) return false
  const image = await contents.capturePage()
  if (image.isEmpty()) return false
  clipboard.writeImage(image)
  return true
}

/** One of MiMo's two clears from the page's own menu: the cookies, or the cache. */
export async function clearSiteData(what: "cookies" | "cache"): Promise<void> {
  const partition = session.fromPartition(PARTITION)
  if (what === "cookies") await partition.clearStorageData({ storages: ["cookies"] })
  else await partition.clearCache()
}

export function panelState(window: BrowserWindow): BrowserState | undefined {
  const panel = panels.get(window.id)
  return panel ? stateOf(panel) : undefined
}

/**
 * Clears what sites have stored in the panel's partition, and its cache.
 *
 * Settings' clear-browsing-data. The partition is the panel's own, so the
 * app's session - its storage, its socket to the backend - is not touched.
 */
export async function clearBrowsingData(): Promise<void> {
  const partition = session.fromPartition(PARTITION)
  await partition.clearStorageData()
  await partition.clearCache()
}

export function hasPanel(window: BrowserWindow): boolean {
  return panels.has(window.id)
}
