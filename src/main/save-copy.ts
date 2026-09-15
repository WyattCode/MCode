import path from "node:path"
import fs from "node:fs"

/*
 * MiMo's 下载副本: the file is copied into the Downloads folder straight away,
 * with no dialog, under its own name or "name (1).ext", "name (2).ext" when that
 * is taken. Kept free of electron so the naming can be checked without a window.
 */

/** The first name in `directory` nothing is using yet. */
export function freeCopyName(directory: string, name: string, exists: (file: string) => boolean = fs.existsSync): string {
  const extension = path.extname(name)
  const stem = path.basename(name, extension)
  let candidate = path.join(directory, name)
  for (let n = 1; exists(candidate); n++) candidate = path.join(directory, `${stem} (${n})${extension}`)
  return candidate
}

export type SaveCopyResult = { ok: true; savedPath: string } | { ok: false; error: string }

export async function saveCopy(source: unknown, downloads: string | undefined): Promise<SaveCopyResult> {
  try {
    if (typeof source !== "string" || !path.isAbsolute(source) || !fs.existsSync(source)) return { ok: false, error: "the file no longer exists" }
    if (!fs.statSync(source).isFile()) return { ok: false, error: "not a file" }
    if (!downloads) return { ok: false, error: "no Downloads folder" }
    const target = freeCopyName(downloads, path.basename(source))
    // Exclusive, so a file that appeared since the name was picked is never overwritten.
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL)
    return { ok: true, savedPath: target }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
