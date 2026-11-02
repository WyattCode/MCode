import { openFileInViewer } from "./office-open"
import { notify, notifyFailure } from "./toast"
import { t } from "./i18n"
import type { MenuItem } from "./menu"
import { mediaOf, type PathKind } from "./markdown"
import { base64ToBlob, toPng, writeClipboardPng } from "./diagram"
import { writeText } from "./clipboard"
import { useApp } from "../stores/app"

/**
 * What a path in a reply does, as MiMo has it: a file goes to its default
 * program, a relative name is looked up first and then shown in the files tab
 * or its folder, and its right-click menu opens, copies or reveals it.
 */

const VIEWABLE = new Set([
  "md", "markdown", "mdx", "txt", "text", "rst", "org", "log", "csv", "tsv", "json", "jsonc", "jsonl", "yaml", "yml", "toml",
  "xml", "ini", "cfg", "conf", "tex", "adoc", "env", "abc",
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "vue", "svelte", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "ps1", "sql", "css", "scss", "less", "lua", "dart",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
])

const extensionOf = (file: string) => {
  const name = file.split(/[\\/]/).pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/** A reply's file: address or path, as a path on disk (relative ones against the conversation's folder). */
export function localPathOf(url: string, directory?: string): string {
  if (/^file:/i.test(url)) {
    try {
      const pathname = decodeURIComponent(new URL(url).pathname)
      // file:///C:/a/b.mp4 is C:\a\b.mp4 on Windows, written the way the rest of the app writes paths there.
      return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1).replace(/\//g, "\\") : pathname
    } catch {
      return ""
    }
  }
  if (/^([A-Za-z]:)?[\\/]/.test(url)) return url
  return directory ? `${directory}/${url}` : ""
}

/** Where a relative name might be: the conversation's folder and the folders above it, then the root. */
export function pathCandidates(file: string, directory?: string): string[] {
  const value = file.trim()
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(value) || /^file:/i.test(value)) return [localPathOf(value)]
  const relative = value.replace(/^\.[\\/]/, "")
  const out: string[] = []
  let base = directory?.replace(/[\\/]+$/, "") ?? ""
  for (let depth = 0; depth < 4 && base; depth += 1) {
    out.push(`${base}/${relative}`)
    const parent = base.replace(/[\\/][^\\/]*$/, "")
    if (parent === base) break
    base = parent
  }
  if (!/^\.\.[\\/]/.test(relative)) out.push(`/${relative}`)
  return out
}

export function fileManagerName(platform: string): string {
  return t(platform === "win32" ? "menu.fileManagerWin" : platform === "darwin" ? "menu.fileManagerMac" : "menu.fileManagerOther")
}

export async function openNative(file: string): Promise<boolean> {
  const result = await window.mcode.openNativePath(file).catch((error: unknown) => ({ ok: false as const, code: "failed", error: String(error) }))
  if (result.ok) return true
  notifyFailure(result.code === "missing" ? t("harnessRow.pathNotExist") : result.code === "invalid" ? t("markdown.openFailed") : result.error || t("markdown.openFailed"))
  return false
}

export async function revealPath(file: string, platform: string): Promise<void> {
  const result = await window.mcode.revealNativePath(file).catch((error: unknown) => ({ ok: false as const, error: String(error) }))
  const manager = fileManagerName(platform)
  if (result.ok) notify(t("menu.revealedIn", { manager }))
  else notifyFailure(t("officeCard.revealFailed", { error: result.error }))
}

/** A press on a path chip. */
export async function openPathLink(file: string, kind: string, directory: string | undefined, platform: string): Promise<void> {
  if (kind === "name") return
  if (kind === "open") {
    await openNative(file)
    return
  }
  const found = await window.mcode.resolveExistingPath(pathCandidates(file, directory)).catch(() => null)
  if (!found) {
    notifyFailure(t("harnessRow.revealFailed", { error: t("harnessRow.pathNotExist") }))
    return
  }
  if (found.directory) return revealPath(found.path, platform)
  const extension = extensionOf(found.path)
  if (extension === "html" || extension === "htm") {
    await openNative(found.path)
    return
  }
  if (VIEWABLE.has(extension)) {
    openFileInViewer(found.path, directory)
    return
  }
  await revealPath(found.path, platform)
}

export interface PathTarget {
  path: string
  directory: boolean
  image: boolean
}

/** What a right-click on a path is about; a bare name that cannot be found has no menu. */
export async function resolvePathTarget(file: string, kind: PathKind | string, directory: string | undefined, image = false): Promise<PathTarget | undefined> {
  if (kind === "open") return { path: file, directory: false, image: image || mediaOf(file) === "image" }
  const found = await window.mcode.resolveExistingPath(pathCandidates(file, directory)).catch(() => null)
  if (found) return { path: found.path, directory: found.directory, image: !found.directory && mediaOf(found.path) === "image" }
  if (kind === "name") return undefined
  return { path: file, directory: kind === "dir", image: false }
}

/* 16px glyphs on the menu's own grid. */
const ICON_OPEN = "M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6M9 2.5 12.5 6M9 2.5V6h3.5"
const ICON_IMAGE = "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM2.5 10.5l3-3 3 3 2-2 3 3M10.3 6h.01"
const ICON_COPY = "M6 5.5h6.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1ZM10.5 5.5V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5"
const ICON_FOLDER = "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z"

/** MiMo's menu: open (files only), copy image (pictures only), copy path, show in the file manager. */
export function pathMenuItems(target: PathTarget, platform: string): MenuItem[] {
  const items: MenuItem[] = []
  if (!target.directory) items.push({ key: "open", label: t("officeCard.openFile"), icon: ICON_OPEN })
  if (target.image) items.push({ key: "copyImage", label: t("officeCard.copyImage"), icon: ICON_IMAGE, divided: true })
  items.push({ key: "copyPath", label: t("officeCard.copyPath"), icon: ICON_COPY, divided: !target.directory && !target.image })
  items.push({ key: "reveal", label: t("menu.revealIn", { manager: fileManagerName(platform) }), icon: ICON_FOLDER })
  return items
}

export async function copyImageFile(file: string): Promise<void> {
  const data = await window.mcode.readImageData(file)
  if (!data.ok) throw new Error(data.error)
  await writeClipboardPng(await toPng(base64ToBlob(data.base64, data.mime)))
}

export async function runPathMenu(key: string, target: PathTarget, platform: string): Promise<void> {
  if (key === "open") {
    // hold the toast to the conversation the open started in; leaving mid-await must not flash it elsewhere
    const held = useApp().currentID
    const result = await window.mcode.openNativePath(target.path).catch((error: unknown) => ({ ok: false as const, code: "failed", error: String(error) }))
    if (useApp().currentID !== held) return
    if (!result.ok) notifyFailure(t("officeCard.openFailed", { error: result.code === "missing" ? t("harnessRow.pathNotExist") : result.error }))
    return
  }
  if (key === "copyImage") {
    try {
      await copyImageFile(target.path)
      notify(t("officeCard.copiedImage"))
    } catch {
      notifyFailure(t("officeCard.copyImageFailed"))
    }
    return
  }
  if (key === "copyPath") {
    try {
      await writeText(target.path)
      notify(t("officeCard.copied"))
    } catch {
      notifyFailure(t("officeCard.copyFailed"))
    }
    return
  }
  if (key === "reveal") await revealPath(target.path, platform)
}
