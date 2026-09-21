import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { IpcMain } from "electron"

/*
 * What a paste leaves on disk, as MiMo's does.
 *
 * A picture goes into <userData>/attachments/images with the folder owner-only
 * and the file owner-read; a large block of text goes into the system temp
 * folder. Both are then attached by path, so the message carries a file that
 * can be opened, located and read at any size rather than a base64 copy of it.
 */

/** MiMo's names: mimo-paste-<time>-<random>; this app writes its own. */
const stamp = () => `mcode-paste-${Date.now()}-${randomBytes(4).toString("hex")}`

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
}

/**
 * A large paste is written whole.
 *
 * A picture off the clipboard has no ceiling of its own: MiMo writes whatever
 * the clipboard held, and refusing at 25 MB only sent a very large screenshot
 * back to the window to be carried as base64 instead, which is worse in every
 * way. Text keeps a ceiling because it is held in memory as a string first.
 */
const TEXT_LIMIT = 64 * 1024 * 1024

export type PasteResult = { ok: true; path: string } | { ok: false; error: string }

function imagesDirectory(userData: string): string {
  return path.join(userData, "attachments", "images")
}

async function writeImage(userData: string, mime: string, bytes: Buffer): Promise<PasteResult> {
  const extension = IMAGE_EXTENSIONS[mime]
  if (!extension) return { ok: false, error: "unsupported" }
  if (!bytes.length) return { ok: false, error: "size" }
  const directory = imagesDirectory(userData)
  try {
    // Owner-only, as MiMo writes them: a pasted screenshot can hold anything.
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const target = path.join(directory, `${stamp()}${extension}`)
    await fs.writeFile(target, bytes, { mode: 0o600 })
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** A data URL the window read off the clipboard, written where it can be opened from. */
export async function savePastedImage(userData: string, dataUrl: unknown): Promise<PasteResult> {
  if (typeof dataUrl !== "string") return { ok: false, error: "invalid" }
  const match = /^data:([a-z+/-]+);base64,([\s\S]+)$/i.exec(dataUrl)
  if (!match) return { ok: false, error: "invalid" }
  return writeImage(userData, match[1].toLowerCase(), Buffer.from(match[2], "base64"))
}

/**
 * MiMo's fallback when the clipboard says it holds a picture but hands the page
 * no file: the main process reads the bitmap itself.
 */
export async function saveClipboardImage(userData: string): Promise<PasteResult & { dataUrl?: string }> {
  // Imported here rather than at the top, so the rest of this file can be read by a check with no Electron around it.
  const { clipboard } = await import("electron")
  const image = clipboard.readImage()
  if (image.isEmpty()) return { ok: false, error: "empty" }
  const bytes = image.toPNG()
  const written = await writeImage(userData, "image/png", Buffer.from(bytes))
  if (!written.ok) return written
  return { ...written, dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` }
}

/** A paste too large to type into the box, kept as a file beside the message. */
export async function savePastedText(text: unknown): Promise<PasteResult> {
  if (typeof text !== "string" || !text) return { ok: false, error: "invalid" }
  if (Buffer.byteLength(text, "utf8") > TEXT_LIMIT) return { ok: false, error: "size" }
  try {
    const target = path.join(os.tmpdir(), `${stamp()}.txt`)
    await fs.writeFile(target, text, { encoding: "utf8", mode: 0o600 })
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Whether the clipboard holds a picture at all, asked before the page decides
 * how to read a paste.
 *
 * Only ever a yes or a no: the bitmap itself is read by `saveClipboardImage`
 * and written to disk, so nothing of what the user copied is handed to the
 * window here.
 */
export async function clipboardHasImage(): Promise<boolean> {
  // Imported here rather than at the top, so the rest of this file can be read by a check with no Electron around it.
  const { clipboard } = await import("electron")
  return clipboard.availableFormats().some((format) => format.startsWith("image/"))
}

export function registerPasteFiles(ipcMain: IpcMain, userData: string) {
  ipcMain.handle("mcode:clipboard-has-image", () => clipboardHasImage().catch(() => false))
  ipcMain.handle("mcode:save-pasted-image", (_event, dataUrl: unknown) => savePastedImage(userData, dataUrl))
  ipcMain.handle("mcode:save-clipboard-image", () => saveClipboardImage(userData))
  ipcMain.handle("mcode:save-pasted-text", (_event, text: unknown) => savePastedText(text))
}
