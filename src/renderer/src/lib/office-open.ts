import { useRightPanel, type OfficeType } from "../stores/right-panel"
import { notifyFailure } from "./toast"
import { t } from "./i18n"

/*
 * Where MiMo sends a document: a web page to its own tab; xlsx, docx, pptx and pdf to the Office tab; the
 * old doc, xls and ppt there too, once LibreOffice has turned them into the
 * new forms (the tab says it is converting meanwhile, and gives way to the
 * files tab if that fails); anything else to the files tab.
 */

const extensionOf = (name: string) => (name.split(/[\\/]/).pop() ?? "").split(".").pop()?.toLowerCase() ?? ""
const nameOf = (file: string) => file.split(/[\\/]/).pop() ?? file

export function officeTypeOf(name: string): OfficeType | null {
  const extension = extensionOf(name)
  return extension === "xlsx" || extension === "docx" || extension === "pptx" || extension === "pdf" ? extension : null
}

export function legacyTypeOf(name: string): OfficeType | null {
  const extension = extensionOf(name)
  return extension === "doc" ? "docx" : extension === "xls" ? "xlsx" : extension === "ppt" ? "pptx" : null
}

/**
 * A file outside the Office tab: the files tab, as MiMo opens one.
 *
 * Inside the project it is shown under the project root, with the tree still
 * on the project. Outside it - an attachment dragged in from the desktop, a
 * path the model named - the tab moves to the file's own folder
 * (`openFileInViewer(folder, name)`), and the viewer itself says when the file
 * is not there or cannot be previewed; a file straight off a drive root moves
 * the tree to that root. Only a name with no folder at all is left to the
 * system.
 *
 * MiMo moves the tree for every absolute path, the project's own files
 * included; keeping the project root for those is the user's choice of
 * 2026-09-21, and it is in HANDOFF's list of deliberate differences.
 *
 * The tab is named after the file however it was opened - from the tree, from
 * an attachment card, from a step row, from an info card - which is what MiMo
 * does in the one effect behind all of them.
 */
export function openFileInViewer(file: string, directory?: string) {
  const rp = useRightPanel()
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  const full = norm(file)
  if (directory) {
    const base = `${norm(directory)}/`
    if (full.toLowerCase().startsWith(base.toLowerCase())) {
      const tab = rp.openTool("files")
      const rel = full.slice(base.length)
      rp.update(tab.id, { viewFile: rel, fileRoot: undefined, name: nameOf(rel) })
      return
    }
  }
  const cut = full.lastIndexOf("/")
  if (cut >= 0) {
    // A drive letter or the posix root is a folder only with its separator on it.
    const folder = cut === 0 ? "/" : full.slice(0, cut)
    const tab = rp.openTool("files")
    rp.update(tab.id, { viewFile: full.slice(cut + 1), fileRoot: /^[a-zA-Z]:$/.test(folder) ? `${folder}/` : folder, name: nameOf(full) })
    return
  }
  void window.mcode.revealPath(file)
}

/** MiMo's "open this file" from an attachment chip or an annotation. */
export async function openDocument(file: { path: string; name?: string }, directory?: string) {
  const rp = useRightPanel()
  const name = file.name || nameOf(file.path)
  if (/\.html?$/i.test(file.path)) {
    rp.openHtml({ path: file.path, title: name })
    return
  }
  const type = officeTypeOf(name) ?? officeTypeOf(file.path)
  if (type) {
    const size = await window.mcode.fileSize(file.path).catch(() => 0)
    rp.openOffice({ path: file.path, name, fileType: type, size })
    return
  }
  const legacy = legacyTypeOf(name) ?? legacyTypeOf(file.path)
  if (legacy) {
    const tab = rp.openOffice({ path: file.path, sourcePath: file.path, name, fileType: legacy })
    /*
     * A tab already showing the converted copy keeps it on screen while the
     * (cached) conversion is checked. A tab that has just been made is not
     * showing anything: `filePath` is not set yet, which used to satisfy the
     * `!== file.path` test, so a first open of a .doc never entered the
     * converting state and sat on 无文件 - "no file" - for the several seconds
     * LibreOffice took, which reads as a failure (R25-C1).
     */
    const shown = tab.sourcePath === file.path && tab.filePath !== undefined && tab.filePath !== file.path && !tab.converting
    if (!shown) rp.update(tab.id, { converting: true })
    /*
     * The reader may close this tab (or the panel) while LibreOffice works.
     * Hold the id and path, and after each await only act if that very tab is
     * still there and still this conversion - a late result for a dismissed
     * tab must not pop a viewer or touch a newer tab for the same file.
     */
    const tabId = tab.id
    const heldPath = file.path
    const stillOurs = (): boolean => {
      const current = rp.tabs.find((entry) => entry.id === tabId)
      return current !== undefined && current.sourcePath === heldPath
    }
    const result = await window.mcode.officeConvertLegacy(file.path)
    if (!result.ok) {
      if (!stillOurs()) return
      rp.close([tabId])
      notifyFailure(t("office.convertFailed", { err: result.error }))
      openFileInViewer(file.path, directory)
      return
    }
    const size = await window.mcode.fileSize(result.output).catch(() => 0)
    if (!stillOurs()) return
    rp.update(tabId, { converting: false, filePath: result.output, sourcePath: file.path, fileType: legacy, size, name })
    return
  }
  openFileInViewer(file.path, directory)
}
