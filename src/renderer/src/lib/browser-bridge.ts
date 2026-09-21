import { watch } from "vue"
import { browserTabFace } from "@shared/browser-page"
import { useApp } from "../stores/app"
import { useRightPanel } from "../stores/right-panel"

/**
 * What the browser panel's pages send back to the window, once for the window.
 *
 * Three things arrive from the main process: a page opened a link in a new tab,
 * one of the app's chords was pressed while a page had focus, and the pages'
 * titles and icons changed. None belongs to any one browser tab, so they are
 * listened for here, from the
 * first browser tab on, and never let go - a page only exists once a tab has
 * asked for one.
 */
let installed = false

export function installBrowserBridge(): void {
  if (installed || !window.mcode) return
  installed = true
  const rp = useRightPanel()
  const app = useApp()

  /* MiMo's new tab for a popup: the page is already made, the tab takes it and shows it. */
  window.mcode.onBrowserOpenTab((pageId) => {
    const tab = rp.openTool("browser")
    rp.update(tab.id, { pageId })
  })

  /*
   * MiMo's tab face: a browser tab shows its page's favicon and is named by its
   * title. Every report lists all the panel's pages, so each tab holding one is
   * brought up to date from it, not only the tab on show.
   */
  window.mcode.onBrowserState((state) => {
    const pages = (state as { tabs?: { id: string; url?: string; title?: string; favicon?: string }[] } | undefined)?.tabs
    if (!Array.isArray(pages)) return
    for (const page of pages) {
      const tab = rp.tabs.find((entry) => entry.type === "browser" && entry.pageId === page.id)
      if (!tab) continue
      const face = browserTabFace(page)
      if (tab.faviconUrl !== face.faviconUrl || tab.pageTitle !== face.pageTitle) rp.update(tab.id, face)
    }
  })

  /*
   * An app chord from inside a page. It is replayed as a keydown on what the
   * window has focused, so App.vue's own handler - with its rebindings, its
   * dialog guard and everything else - decides what it does, exactly as for a
   * key pressed in the window.
   */
  window.mcode.onBrowserKey((key) => {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
    target.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }))
  })

  /* The reader's own chords, so a rebound command is reachable from inside a page too. */
  watch(
    () =>
      Object.values(app.config?.keybinds ?? {})
        .filter((chord): chord is string => typeof chord === "string" && chord.length > 0)
        .join("\n"),
    (joined) => window.mcode.browserKeys(joined ? joined.split("\n") : []),
    { immediate: true },
  )
}
