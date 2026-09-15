import fs from "node:fs/promises"
import path from "node:path"
import { clipboard, nativeImage, type IpcMain } from "electron"

/*
 * MiMo's "copy image" in the image preview: the picture file on disk goes onto
 * the clipboard as an image. Done here because the window's own clipboard needs
 * the document focused, and a file path is not something the window can read.
 */

const MAX_PATH = 4096
const LIMIT = 25 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svg"])

export async function copyImageFromPath(target: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof target !== "string" || !target || target.length > MAX_PATH || target.includes("\0") || !path.isAbsolute(target)) {
    return { ok: false, error: "invalid" }
  }
  // Only pictures are read: the path comes from the window, and any other file has no business in memory here.
  if (!IMAGE_EXTENSIONS.has(path.extname(target).toLowerCase())) return { ok: false, error: "unsupported" }
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat?.isFile()) return { ok: false, error: "missing" }
  if (stat.size > LIMIT) return { ok: false, error: "too big" }
  try {
    const image = nativeImage.createFromBuffer(await fs.readFile(target))
    // The system decoder reads PNG and JPEG; the window decodes the rest (WebP, SVG, AVIF) itself.
    if (image.isEmpty()) return { ok: false, error: "undecodable" }
    clipboard.writeImage(image)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerImageClipboard(ipcMain: IpcMain) {
  ipcMain.handle("mcode:copy-image-path", (_event, target: unknown) => copyImageFromPath(target))
}
