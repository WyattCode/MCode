import fs from "node:fs/promises"
import path from "node:path"
import { BrowserWindow, dialog, shell, type IpcMain } from "electron"
import { PICKER_BUSY } from "@shared/native-pick"
import { claimDialog, releaseDialog } from "./native-dialogs"

/*
 * MiMo's path links in a reply: a file named in the answer opens with the
 * system's default program, a relative name is looked up first, a folder is
 * shown, and a picture can be copied. The renderer can only ask; every rule
 * that makes this safe is checked here.
 */

/* Past this a string is not a path anyone wrote by hand. */
const MAX_PATH = 4096
const MAX_CANDIDATES = 32
const IMAGE_LIMIT = 25 * 1024 * 1024

/*
 * Anything the shell would run rather than show. A click on a reply must never
 * start a program, whatever the file is called.
 */
const EXECUTABLE = new Set([
  ".exe", ".bat", ".cmd", ".com", ".msi", ".msp", ".msc", ".ps1", ".psm1", ".psd1", ".vbs", ".vbe", ".vb",
  ".js", ".jse", ".mjs", ".cjs", ".wsf", ".wsh", ".ws", ".wsc", ".scr", ".lnk", ".pif", ".cpl", ".hta", ".jar",
  ".reg", ".inf", ".url", ".website", ".application", ".appref-ms", ".gadget", ".scf", ".settingcontent-ms",
  ".sh", ".bash", ".zsh", ".fish", ".csh", ".ksh", ".command", ".tool", ".app", ".workflow", ".action",
  ".py", ".pyw", ".pyc", ".rb", ".pl", ".php", ".run", ".bin", ".appimage", ".desktop", ".deb", ".rpm", ".pkg",
])

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
}

export type OpenNativeResult =
  | { ok: true }
  | { ok: false; code: "invalid" | "missing" | "notFile" | "executable" | "failed"; error: string }

const usable = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PATH && !value.includes("\0") && path.isAbsolute(value)

/* Windows ignores trailing dots and spaces, so "run.exe. " is run.exe. */
function extensionOf(file: string): string {
  const name = path.basename(file)
  const trimmed = process.platform === "win32" ? name.replace(/[. ]+$/, "") : name
  return path.extname(trimmed).toLowerCase()
}

/** What the reader is told when the thing it asked to open turns out to be a program. */
export const EXECUTABLE_REFUSAL = "出于安全,不支持直接打开可执行文件"

/**
 * Whether this is a program, by the name it is written with and by the name of
 * what it really is.
 *
 * Exported because a second channel hands paths to the desktop - the file cards
 * in the conversation - and used to do so with no check at all, so a page that
 * could call it could start any executable on the machine (R25-E1).
 */
export async function isProgram(target: string, stat: { mode: number }): Promise<boolean> {
  // The name as written and the file it really is: a link called notes.txt may point at a program.
  const real = await fs.realpath(target).catch(() => target)
  const unixExecutable = process.platform !== "win32" && (stat.mode & 0o111) !== 0 && !extensionOf(real)
  return EXECUTABLE.has(extensionOf(target)) || EXECUTABLE.has(extensionOf(real)) || unixExecutable
}

/**
 * Whether a *directory* names something the shell would run rather than show.
 *
 * `isProgram` cannot be reused here: a folder always carries the execute bits,
 * so its unix-executable arm would call every extension-less directory a
 * program. But a macOS `.app` (or `.workflow`, `.action`) is a directory on
 * disk that `shell.openPath` launches - the exact thing the open channel must
 * never do (R25-E1) - so the name is all a folder is judged by, through the
 * same table.
 */
export async function isBundleProgram(target: string): Promise<boolean> {
  const real = await fs.realpath(target).catch(() => target)
  return EXECUTABLE.has(extensionOf(target)) || EXECUTABLE.has(extensionOf(real))
}

export async function openNativePath(target: unknown): Promise<OpenNativeResult> {
  if (!usable(target)) return { ok: false, code: "invalid", error: "路径无效" }
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    return { ok: false, code: "missing", error: "路径不存在(可能已被删除)" }
  }
  if (!stat.isFile()) return { ok: false, code: "notFile", error: "不是文件,无法打开" }
  if (await isProgram(target, stat)) {
    return { ok: false, code: "executable", error: EXECUTABLE_REFUSAL }
  }
  const error = await shell.openPath(target)
  return error ? { ok: false, code: "failed", error } : { ok: true }
}

/* The first of these that exists; relative names are resolved by the renderer against the conversation's folder. */
export async function resolveExistingPath(candidates: unknown): Promise<{ path: string; directory: boolean } | null> {
  if (!Array.isArray(candidates)) return null
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (!usable(candidate)) continue
    const stat = await fs.stat(candidate).catch(() => undefined)
    if (stat) return { path: path.normalize(candidate), directory: stat.isDirectory() }
  }
  return null
}

/* A file is shown selected in its folder; a folder is opened, as MiMo does. */
export async function revealNativePath(target: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!usable(target)) return { ok: false, error: "not found" }
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat) return { ok: false, error: "not found" }
  // A macOS .app is a folder that openPath would launch, so it is only ever selected.
  if (stat.isDirectory() && !(process.platform === "darwin" && extensionOf(target) === ".app")) {
    const error = await shell.openPath(target)
    return error ? { ok: false, error } : { ok: true }
  }
  shell.showItemInFolder(target)
  return { ok: true }
}

/* A picture's bytes, for copying it: the window cannot read the disk, and a served copy would taint the canvas. */
export async function readImageData(target: unknown): Promise<{ ok: true; mime: string; base64: string } | { ok: false; error: string }> {
  if (!usable(target)) return { ok: false, error: "invalid" }
  const mime = IMAGE_TYPES[extensionOf(target)]
  if (!mime) return { ok: false, error: "unsupported" }
  const stat = await fs.stat(target).catch(() => undefined)
  if (!stat?.isFile()) return { ok: false, error: "missing" }
  if (stat.size > IMAGE_LIMIT) return { ok: false, error: "too big" }
  try {
    return { ok: true, mime, base64: (await fs.readFile(target)).toString("base64") }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerPaths(ipcMain: IpcMain) {
  ipcMain.handle("mcode:open-native-path", (_event, target: unknown) => openNativePath(target))
  ipcMain.handle("mcode:resolve-existing-path", (_event, candidates: unknown) => resolveExistingPath(candidates))
  ipcMain.handle("mcode:reveal-native-path", (_event, target: unknown) => revealNativePath(target))
  ipcMain.handle("mcode:read-image-data", (_event, target: unknown) => readImageData(target))
  /* A diagram saved as a picture: only a PNG, only where the person chose in the dialog. */
  ipcMain.handle("mcode:save-png", async (event, suggested: unknown, base64: unknown) => {
    if (typeof base64 !== "string") return undefined
    /*
     * \x00- was a range nobody finished, so the class matched a literal
     * hyphen - "sequence-diagram.png" reached the dialog as
     * "sequence_diagram.png" - while every control character it was meant to
     * catch went straight through to defaultPath (R25-E6).
     */
    const name = typeof suggested === "string" ? path.basename(suggested).replace(/[<>:"|?*\x00-\x1f]/g, "_") : ""
    const options = {
      defaultPath: /\.png$/i.test(name) ? name : "diagram.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    }
    const owner = BrowserWindow.fromWebContents(event.sender)
    // One native dialog at a time, as every other picker here: a second ask is answered busy.
    const claim = claimDialog(process.platform, owner)
    if (!claim) return PICKER_BUSY
    // try/finally, not `.finally` on the result: a call that throws on the way in leaves no promise to release on (R25-E5).
    let result
    try {
      result = await (owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options))
    } finally {
      releaseDialog(claim)
    }
    if (result.canceled || !result.filePath) return undefined
    await fs.writeFile(result.filePath, Buffer.from(base64, "base64"))
    return result.filePath
  })
}
