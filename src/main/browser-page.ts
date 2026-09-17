import { BrowserWindow, Menu, clipboard, ipcMain, shell, type MenuItemConstructorOptions, type WebContents } from "electron"
import { label } from "./labels"
import { pageKeyAction, pageMenuGroups, routeWindowOpen, stepZoom, type PageMenuItem } from "@shared/browser-page"

/**
 * What a page in the browser panel may ask of the window around it, beyond
 * drawing itself: a popup, a right-click, Ctrl and the wheel, and the app's own
 * keys while the page has focus.
 *
 * Kept beside browser.ts rather than in it because these are the page's
 * conversations with the app; browser.ts is the panel's bookkeeping. The window's
 * own right-click menu lives elsewhere and knows nothing of these.
 */

/*
 * The chords the reader has bound on the shortcuts page. Only the renderer holds
 * the config document, so it sends them whenever they change.
 */
let boundChords: ReadonlySet<string> = new Set()
ipcMain.on("mcode:browser-keys", (_event, chords: unknown) => {
  const list = Array.isArray(chords) ? chords.filter((chord): chord is string => typeof chord === "string" && chord.length > 0) : []
  boundChords = new Set(list)
})

export interface PageHooks {
  window: BrowserWindow
  /** A web address this page asked to open, as a new tab of the panel. */
  openTab: (url: string) => void
  /** Something the address bar shows has changed. */
  changed: () => void
}

/* The menu's words: MiMo's own for the page rows, the Edit menu's for the editing ones. */
const LABELS: Record<PageMenuItem, [key: string, fallback: string]> = {
  openLinkNewTab: ["rp.browser.ctx.openLinkNewTab", "Open Link in New Tab"],
  copyLink: ["rp.browser.ctx.copyLink", "Copy Link Address"],
  copyImage: ["rp.browser.ctx.copyImage", "Copy Image"],
  copyImageUrl: ["rp.browser.ctx.copyImageUrl", "Copy Image Address"],
  copy: ["edit.copy", "Copy"],
  cut: ["edit.cut", "Cut"],
  paste: ["edit.paste", "Paste"],
  selectAll: ["edit.selectAll", "Select All"],
  back: ["rp.browser.ctx.back", "Back"],
  forward: ["rp.browser.ctx.forward", "Forward"],
  reload: ["rp.browser.ctx.reload", "Reload"],
}

export function wirePage(contents: WebContents, hooks: PageHooks): void {
  /* MiMo's popups: the web opens as a tab of the panel; mailto and tel go to the system. */
  contents.setWindowOpenHandler(({ url }) => {
    const route = routeWindowOpen(url)
    if (route.type === "newtab") hooks.openTab(route.url)
    else if (route.type === "external") void shell.openExternal(route.url)
    return { action: "deny" }
  })

  /* Ctrl and the wheel: a view does not zoom itself, so each notch is a step. */
  contents.on("zoom-changed", (_event, direction) => {
    contents.setZoomFactor(stepZoom(contents.getZoomFactor(), direction === "in" ? 1 : -1))
    hooks.changed()
  })

  /* A native menu, as MiMo pops for its pages: the rows that apply, groups between separators. */
  contents.on("context-menu", (_event, params) => {
    const history = contents.navigationHistory
    const groups = pageMenuGroups({
      isEditable: params.isEditable,
      selectionText: params.selectionText,
      editFlags: params.editFlags,
      linkURL: params.linkURL,
      srcURL: params.srcURL,
      mediaType: params.mediaType,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    })
    const run: Record<PageMenuItem, () => void> = {
      openLinkNewTab: () => {
        const route = routeWindowOpen(params.linkURL)
        if (route.type === "newtab") hooks.openTab(route.url)
      },
      copyLink: () => clipboard.writeText(params.linkURL),
      copyImage: () => contents.copyImageAt(params.x, params.y),
      copyImageUrl: () => clipboard.writeText(params.srcURL),
      copy: () => contents.copy(),
      cut: () => contents.cut(),
      paste: () => contents.paste(),
      selectAll: () => contents.selectAll(),
      back: () => {
        if (history.canGoBack()) history.goBack()
      },
      forward: () => {
        if (history.canGoForward()) history.goForward()
      },
      reload: () => contents.reload(),
    }
    const template: MenuItemConstructorOptions[] = []
    groups.forEach((group, index) => {
      if (index) template.push({ type: "separator" })
      for (const item of group) {
        const [key, fallback] = LABELS[item.id]
        template.push({ label: label(key, fallback), enabled: item.enabled, click: run[item.id] })
      }
    })
    if (hooks.window.isDestroyed()) return
    Menu.buildFromTemplate(template).popup({ window: hooks.window })
  })

  /*
   * The app's keys, from inside the page. A focused page receives every key, so
   * Ctrl+L, Ctrl+T, Ctrl+period and the rest would stop at it. The window is
   * focused and told which key it was, and runs it through its own keydown
   * handler as if it had been pressed there.
   */
  contents.on("before-input-event", (event, input) => {
    const action = pageKeyAction(input, boundChords, process.platform)
    if (action.kind === "none") return
    event.preventDefault()
    if (action.kind === "reload") {
      if (action.force) contents.reloadIgnoringCache()
      else contents.reload()
      return
    }
    const window = hooks.window
    if (window.isDestroyed()) return
    window.webContents.focus()
    window.webContents.send("mcode:browser-key", {
      key: input.key,
      code: input.code,
      ctrlKey: input.control,
      shiftKey: input.shift,
      altKey: input.alt,
      metaKey: input.meta,
    })
  })
}
