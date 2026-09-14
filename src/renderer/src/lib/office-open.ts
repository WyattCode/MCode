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

/** A file outside the Office tab: the files tab when it is in the project, else its folder. */
export function openFileInViewer(file: string, directory?: string) {
  const rp = useRightPanel()
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "")
  if (directory) {
    const base = `${norm(directory)}/`
    const full = norm(file)
    if (full.toLowerCase().startsWith(base.toLowerCase())) {
      const tab = rp.openTool("files")
      rp.update(tab.id, { viewFile: full.slice(base.length) })
      return
    }
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
    const tab = rp.openOffice({ path: file.path, name, fileType: legacy, size: 0 })
    rp.update(tab.id, { converting: true })
    const result = await window.mcode.officeConvertLegacy(file.path)
    if (!result.ok) {
      rp.close([tab.id])
      notifyFailure(t("office.convertFailed", { err: result.error }))
      openFileInViewer(file.path, directory)
      return
    }
    const size = await window.mcode.fileSize(result.output).catch(() => 0)
    rp.update(tab.id, { converting: false, filePath: result.output, fileType: legacy, size, name })
    return
  }
  openFileInViewer(file.path, directory)
}
