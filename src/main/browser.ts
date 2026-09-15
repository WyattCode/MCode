import { BrowserWindow, WebContentsView, clipboard, session } from "electron"
import { addressToURL, pageMayNavigate } from "@shared/web-address"
import { pageFavicon, stepZoom } from "@shared/browser-page"
import { wirePage } from "./browser-page"

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
 * - http and https, decided in @shared/web-address, and a local file typed
 *   into the address bar - the user chose (2026-09-15) to open local files as
 *   MiMo does. A page may follow a link to a file only from a local page, never
 *   from the web, and internal schemes are not for a page to ask for.
 * - No permissions. The window's own handler allows a microphone because a
 *   button asks for it; a site in this panel gets nothing at all.
 * - A popup becomes a tab of the panel, with the panel's address bar, as MiMo
 *   opens them; mailto and tel go to the system, and nothing else goes
 *   anywhere (browser-page.ts, which also holds the page's menu and keys).
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
  /** The icon the page names for itself, once it has: an http(s) address or an inline image. */
  favicon?: string
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
  error?: { code: number; url: string; description: string }
}

interface Tab {
  id: string
  view: WebContentsView
  failure?: { code: number; url: string; description: string }
  favicon?: string
}

interface Panel {
  window: BrowserWindow
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
    ...(tab.favicon ? { favicon: tab.favicon } : {}),
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
  wirePage(contents, {
    window: panel.window,
    openTab: (url) => openFromPage(panel, url),
    changed: () => panel.publish(),
  })
  /* The web is followed; a file only from a local page (MiMo's local pages link to their neighbours); the rest is refused. */
  contents.on("will-navigate", (event, url) => {
    if (!pageMayNavigate(contents.getURL(), url)) event.preventDefault()
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
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is a load the page itself abandoned for another, which is not a failure.
    if (!isMainFrame || code === -3) return
    // The name is kept too: MiMo sorts an error by its name as well as its number.
    tab.failure = { code, url, description }
    panel.publish()
  })
  /*
   * MiMo's tab face. The event hands over the addresses the page names; the
   * window only ever gets one of the kinds its own policy lets an image load,
   * and a page that commits forgets the last one's until it names its own.
   */
  contents.on("did-navigate", () => {
    tab.favicon = undefined
    panel.publish()
  })
  contents.on("page-favicon-updated", (_event, favicons) => {
    tab.favicon = pageFavicon(favicons)
    panel.publish()
  })
  return tab
}

/**
 * A page's popup or "open link in new tab": a page of its own, loading, and not
 * yet on show. The window is told its id and gives it a tab, whose claim is what
 * selects it - so the page is never drawn without a tab around it.
 */
function openFromPage(panel: Panel, url: string): void {
  if (panel.window.isDestroyed()) return
  const tab = makeTab(panel)
  panel.tabs.push(tab)
  void tab.view.webContents.loadURL(url).catch(() => {
    /* A failure is shown by the tab itself once it is selected. */
  })
  panel.window.webContents.send("mcode:browser-open-tab", tab.id)
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

  const panel: Panel = { window, tabs: [], active: "", bounds, publish: () => {} }
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

/* `id` names a page other than the open one: MiMo's Ctrl+R reloads a browser tab even while another tab is on show. */
export function act(window: BrowserWindow, what: BrowserAct, id?: string): BrowserState | undefined {
  const panel = panels.get(window.id)
  if (!panel) return undefined
  const contents = (id ? tabOf(panel, id) : activeTab(panel))?.view.webContents
  if (!contents) return stateOf(panel)
  if (what === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  if (what === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  if (what === "reload") contents.reload()
  if (what === "forceReload") contents.reloadIgnoringCache()
  if (what === "stop") contents.stop()
  /* MiMo's steps: ten percent at a time, from a quarter of the page to three times it. */
  if (what === "zoomIn" || what === "zoomOut") contents.setZoomFactor(stepZoom(contents.getZoomFactor(), what === "zoomIn" ? 1 : -1))
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

/*
 * MiMo's "cookies" are everything a site keeps about a visit, not only the
 * cookie jar: a site that signs in with local storage stays signed in otherwise.
 */
const SITE_STORAGES: ("cookies" | "localstorage" | "indexdb" | "websql" | "serviceworkers" | "cachestorage")[] = [
  "cookies",
  "localstorage",
  "indexdb",
  "websql",
  "serviceworkers",
  "cachestorage",
]

/* Every page in the panel, in every window, loaded again so none is left holding what was cleared. */
function reloadAllPages(): void {
  for (const panel of panels.values()) {
    for (const tab of panel.tabs) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload()
    }
  }
}

/** One of MiMo's two clears from the page's own menu: what sites stored (and every page reloads), or the cache. */
export async function clearSiteData(what: "cookies" | "cache"): Promise<void> {
  const partition = session.fromPartition(PARTITION)
  if (what === "cache") {
    await partition.clearCache()
    return
  }
  await partition.clearStorageData({ storages: SITE_STORAGES })
  reloadAllPages()
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
  reloadAllPages()
}

export function hasPanel(window: BrowserWindow): boolean {
  return panels.has(window.id)
}
