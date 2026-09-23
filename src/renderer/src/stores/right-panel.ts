import { defineStore } from "pinia"
import { computed, ref } from "vue"

/**
 * MiMo's right panel: one panel beside the conversation holding tabs, one
 * shown at a time.
 *
 * The tabs belong to the conversation they were opened in. Leaving it puts
 * them aside with the selection and whether the panel was open, and coming
 * back hands them back; a conversation opened for the first time starts with
 * none and the panel shut. Tabs opened on the home screen belong to nothing
 * and are let go of when a conversation is entered. None of it outlives the
 * window - only the panel's width is kept.
 *
 * Most tools add a tab every time they are asked for (a second review, a
 * third terminal); the files tab is the one kept single. Closing a tab selects
 * its right-hand neighbour, else the left, and closing the last one shuts the
 * panel. Whatever a tab was holding - a shell, a page - is let go through the
 * disposer the panel registers, so the store stays free of those services.
 */

export type RightTool = "review" | "files" | "chat" | "browser" | "terminal"
/* subagents: MiMo's 子智能体 tab, opened from a subagent row rather than from the launcher. */
export type RightTabType = RightTool | "diff" | "office" | "html" | "subagents"
export type OfficeType = "xlsx" | "docx" | "pptx" | "pdf"

export interface RightTab {
  id: string
  type: RightTabType
  /** Its place among same-type tabs when it was opened; above one it is drawn after the name. */
  ord: number
  /** A title of its own - a file's name, a diff's - in place of the tool's. */
  name?: string
  /** Files: the file on show, relative to the project. */
  viewFile?: string
  /**
   * Files: a root of its own, for a file outside the project.
   *
   * MiMo opens such a file in the files tab with the file's own folder as the
   * root (`openFileInViewer(folder, name)`), rather than refusing it; absent
   * means the conversation's project, which is the ordinary case.
   */
  fileRoot?: string
  /** Side chat: the conversation it holds, once there is one. */
  convoId?: string
  /** Browser: the main process's id for this tab's page. */
  pageId?: string
  /** Browser: the page's favicon and title, which MiMo's tab draws in place of the globe and the tool's name. */
  faviconUrl?: string
  pageTitle?: string
  /** Browser: the address its page is on, or is to open first; MiMo takes up a tab by it. */
  url?: string
  /** Terminal: the shell the backend holds for it, and whether anything was typed into it. */
  shellID?: string
  cwd?: string
  used?: boolean
  /** Diff: the patch on show and who asked for it, so asking again updates the same tab. */
  diff?: string
  source?: string
  /** Office: the document, its kind and size, the conversation it was opened from, and whether an old format is being converted. */
  filePath?: string
  /** Office, old formats: the doc, xls or ppt the converted copy in `filePath` came from, so opening it again finds this tab. */
  sourcePath?: string
  fileType?: OfficeType
  size?: number
  origin?: string
  converting?: boolean
  /** Web page: the .html file on show, and whether its edit mode (picking modules to annotate) is on. */
  htmlPath?: string
  htmlEdit?: boolean
  /** subagents: the subagent whose transcript is on show, by its task call's id; absent for the overview. */
  subagentKey?: string
}

interface Kept {
  tabs: RightTab[]
  active: string | null
  open: boolean
}

const WIDTH_KEY = "mcode.rw"
export const PANEL_DEFAULT_WIDTH = 380
export const PANEL_MIN_WIDTH = 300

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH ? Math.round(stored) : PANEL_DEFAULT_WIDTH
  } catch {
    return PANEL_DEFAULT_WIDTH
  }
}

export const useRightPanel = defineStore("rightPanel", () => {
  const tabs = ref<RightTab[]>([])
  const active = ref<string | null>(null)
  const open = ref(false)
  const fullscreen = ref(false)
  const width = ref(readWidth())

  let seq = 0
  /** The conversation the tabs on show belong to; undefined on the home screen. */
  let scope: string | undefined
  const kept = new Map<string, Kept>()
  let disposer: ((tab: RightTab) => void) | undefined

  const activeTab = computed(() => tabs.value.find((tab) => tab.id === active.value))

  function setDisposer(next: (tab: RightTab) => void) {
    disposer = next
  }

  function dispose(list: RightTab[]) {
    for (const tab of list) disposer?.(tab)
  }

  function show(id: string) {
    const stay = open.value && fullscreen.value
    active.value = id
    open.value = true
    fullscreen.value = stay
  }

  function add(type: RightTabType, fields: Partial<RightTab> = {}): RightTab {
    seq += 1
    /*
     * The lowest number this kind is not already using, not "how many there
     * are plus one" - which hands out a number that is taken whenever an
     * earlier tab has been closed. Three terminals, close the first, open
     * another, and the strip showed two tabs both called 终端 3 with nothing to
     * tell them apart (R25-C2). The drawer's terminals have always done it this
     * way; this path simply never asked.
     */
    const taken = new Set(tabs.value.filter((entry) => entry.type === type).map((entry) => entry.ord))
    let ord = 1
    while (taken.has(ord)) ord += 1
    const tab: RightTab = {
      id: `rt${seq}`,
      type,
      ord,
      ...fields,
    }
    tabs.value = [...tabs.value, tab]
    show(tab.id)
    return tab
  }

  /** A tool from the launcher, the plus menu or a shortcut. */
  function openTool(type: RightTool): RightTab {
    if (type === "files") {
      const found = tabs.value.find((tab) => tab.type === "files")
      if (found) {
        active.value = found.id
        open.value = true
        fullscreen.value = false
        return found
      }
    }
    return add(type)
  }

  /*
   * MiMo's openTool("browser", url, { reuse }): a browser tab at an address.
   * Reuse takes up a browser tab already on exactly that address; otherwise a
   * new tab opens there. The tab's page loads the address once it has a page.
   */
  function openBrowser(url: string, options: { reuse?: boolean } = {}): RightTab {
    if (options.reuse && url && url !== "about:blank") {
      const found = tabs.value.find((tab) => tab.type === "browser" && tab.url === url)
      if (found) {
        show(found.id)
        return found
      }
    }
    return add("browser", { url })
  }

  /** MiMo's Office tab: one per document, taken up again when the same file is opened. */
  function openOffice(file: { path: string; name: string; fileType: OfficeType; size?: number; sourcePath?: string }): RightTab {
    const found = tabs.value.find((tab) => tab.type === "office" && (tab.filePath === file.path || (tab.sourcePath !== undefined && tab.sourcePath === file.path)))
    if (found) {
      update(found.id, { name: file.name, fileType: file.fileType, size: file.size ?? found.size, origin: scope ?? found.origin })
      show(found.id)
      return tabs.value.find((tab) => tab.id === found.id) ?? found
    }
    return add("office", { name: file.name, filePath: file.path, sourcePath: file.sourcePath, fileType: file.fileType, size: file.size, origin: scope })
  }

  /** MiMo's web page tab: one per page, taken up again (from this conversation) when the same page is opened; edit mode starts off. */
  function openHtml(page: { path: string; title?: string }): RightTab {
    const name = page.title || "网页"
    const found = tabs.value.find((tab) => tab.type === "html" && tab.htmlPath === page.path)
    if (found) {
      update(found.id, { name, origin: scope ?? found.origin })
      show(found.id)
      return tabs.value.find((tab) => tab.id === found.id) ?? found
    }
    return add("html", { name, htmlPath: page.path, htmlEdit: false, origin: scope })
  }

  /** subagents: MiMo's openSubagents - the one 子智能体 tab, taken up again, on a subagent or on the overview. */
  function openSubagents(key?: string): RightTab {
    const found = tabs.value.find((tab) => tab.type === "subagents")
    if (found) {
      update(found.id, { subagentKey: key })
      show(found.id)
      return tabs.value.find((tab) => tab.id === found.id) ?? found
    }
    return add("subagents", { subagentKey: key })
  }

  function toggleHtmlEdit(id: string) {
    const tab = tabs.value.find((entry) => entry.id === id)
    if (tab) update(id, { htmlEdit: !tab.htmlEdit })
  }

  /** A diff with a title of its own; a source's tab is updated rather than doubled. */
  function openDiff(name: string, diff: string, source?: string): RightTab {
    const found = tabs.value.find((tab) =>
      tab.type === "diff" && (source ? tab.source === source : tab.name === name && tab.diff === diff),
    )
    if (found) {
      update(found.id, { name, diff })
      show(found.id)
      return found
    }
    return add("diff", { name, diff, source })
  }

  /** The same, except that asking while that very tab is on show puts the panel away. */
  function toggleDiff(name: string, diff: string, source: string) {
    const current = activeTab.value
    if (open.value && current?.type === "diff" && current.source === source) {
      setOpen(false)
      return
    }
    openDiff(name, diff, source)
  }

  function update(id: string, fields: Partial<RightTab>) {
    tabs.value = tabs.value.map((tab) => (tab.id === id ? { ...tab, ...fields } : tab))
  }

  function activate(id: string) {
    if (active.value === id || !tabs.value.some((tab) => tab.id === id)) return
    active.value = id
  }

  function close(ids: string[]) {
    const before = tabs.value
    const removed = before.filter((tab) => ids.includes(tab.id))
    if (!removed.length) return
    const after = before.filter((tab) => !ids.includes(tab.id))
    if (active.value && ids.includes(active.value)) {
      const at = before.findIndex((tab) => tab.id === active.value)
      active.value = (after[at] ?? after[at - 1] ?? after[0])?.id ?? null
    }
    tabs.value = after
    if (!after.length) {
      active.value = null
      open.value = false
      fullscreen.value = false
    }
    dispose(removed)
  }

  function closeOthers(id: string) {
    close(tabs.value.filter((tab) => tab.id !== id).map((tab) => tab.id))
  }

  function closeRight(id: string) {
    const at = tabs.value.findIndex((tab) => tab.id === id)
    if (at >= 0) close(tabs.value.slice(at + 1).map((tab) => tab.id))
  }

  function setOpen(next: boolean) {
    open.value = next
    if (!next) fullscreen.value = false
  }

  function toggleOpen() {
    setOpen(!open.value)
  }

  function toggleFullscreen() {
    if (fullscreen.value) fullscreen.value = false
    else if (open.value) fullscreen.value = true
  }

  function setWidth(px: number) {
    width.value = Math.round(px)
    try {
      localStorage.setItem(WIDTH_KEY, String(width.value))
    } catch {
      /* A private window keeps the width for this run only. */
    }
  }

  /*
   * MiMo's Nge: the project the tabs work in changed under them (a project
   * picked on the home screen). The files tab goes back to 打开文件 with the
   * new project as its root rather than reading the old file's path there; the
   * review follows the new root by itself.
   */
  function reroot() {
    tabs.value = tabs.value.map((tab) =>
      tab.type === "files" && (tab.viewFile !== undefined || tab.fileRoot !== undefined || tab.name !== undefined)
        ? { ...tab, viewFile: undefined, fileRoot: undefined, name: undefined }
        : tab,
    )
  }

  /** The conversation on show changed; undefined is the home screen. */
  function setScope(next: string | undefined) {
    if (next === scope) return
    if (scope !== undefined) {
      if (tabs.value.length) {
        const selected = tabs.value.some((tab) => tab.id === active.value) ? active.value : tabs.value[0].id
        kept.set(scope, { tabs: tabs.value, active: selected, open: open.value })
      } else kept.delete(scope)
    } else dispose(tabs.value)
    const restored = next !== undefined ? kept.get(next) : undefined
    if (next !== undefined) kept.delete(next)
    tabs.value = restored?.tabs ?? []
    active.value = restored?.active ?? null
    open.value = restored?.open ?? false
    fullscreen.value = false
    scope = next
  }

  /** A conversation that is gone takes the tabs it was keeping with it. */
  function forget(conversationID: string) {
    const entry = kept.get(conversationID)
    if (entry) dispose(entry.tabs)
    kept.delete(conversationID)
  }

  return {
    tabs,
    active,
    open,
    fullscreen,
    width,
    activeTab,
    setDisposer,
    openTool,
    openBrowser,
    openOffice,
    openHtml,
    openSubagents,
    toggleHtmlEdit,
    openDiff,
    toggleDiff,
    update,
    activate,
    close,
    closeOthers,
    closeRight,
    setOpen,
    toggleOpen,
    toggleFullscreen,
    setWidth,
    setScope,
    reroot,
    forget,
  }
})
