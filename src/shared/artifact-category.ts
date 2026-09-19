/*
 * MiMo's three artifact tabs, decided by a file's name alone. Shared so the
 * page's tabs and the store's paged query (S13-3) put a file in the same one.
 */

/** MiMo's three buckets: documents, pages that run as apps, and everything else. */
export type ArtifactCategory = "doc" | "app" | "other"

/** A file name's extension, lower case; none for a name that only starts with a dot. */
export const extensionOf = (file: string) => {
  const name = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1)
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

export const DOC_EXTENSIONS: readonly string[] = ["md", "markdown", "txt", "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "rtf", "csv"]
export const APP_EXTENSIONS: readonly string[] = ["html", "htm"]

const DOCS = new Set(DOC_EXTENSIONS)
const APPS = new Set(APP_EXTENSIONS)

export function artifactCategory(file: string): ArtifactCategory {
  const extension = extensionOf(file)
  return DOCS.has(extension) ? "doc" : APPS.has(extension) ? "app" : "other"
}
