import fs from "node:fs"
import path from "node:path"
import type { IpcMain } from "electron"
import { writeAtomicSync } from "./atomic-write"

/*
 * MiMo's saved composer input: every conversation's draft, its files, skill
 * chips and waiting annotations, kept in one file beside the config. The
 * renderer hands over the whole document; this only reads and writes that one
 * file, and refuses anything that is not a JSON object of a sane size.
 */
export const COMPOSER_INPUT_FILE = "composer-input.json"
/*
 * A draft names the files it carries rather than copying them, as MiMo's does,
 * so this no longer has to swallow a photograph per conversation. What is left
 * is words, paths, and the bytes of anything pasted in that has no file of its
 * own - each of those already capped where it is taken in.
 */
const MAX_BYTES = 16 * 1024 * 1024

export function registerComposerInput(ipc: IpcMain, userData: string): void {
  const file = path.join(userData, "storage", COMPOSER_INPUT_FILE)
  /** Set when the file exists but could not be read; nothing may be written over it. */
  let blocked: string | undefined

  // Read synchronously, once, before the window's first composer is drawn.
  ipc.on("mcode:composer-input-load", (event) => {
    try {
      event.returnValue = { ok: true, text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        event.returnValue = { ok: true, text: "" }
        return
      }
      blocked =
        "composer-input.json could not be read, so nothing is saved over it until it is fixed or removed."
      console.warn("[composer-input] could not be read:", err instanceof Error ? err.message : err)
      event.returnValue = { ok: false }
    }
  })

  /*
   * Replaced through a temp file and a rename, never truncated in place, so a
   * crash mid-write leaves the previous document whole (D12-7). The temp is
   * named the way every other atomic write here names one, so the start-up
   * sweep can tell a dead run's leftover from a write in flight.
   *
   * Only the write on the way out is flushed. The saves while typing come
   * every 300 ms and each is superseded by the next, so the rename's ordering
   * is protection enough for them; the last one has nothing after it. Measured
   * on NVMe under Windows, the flush adds about 4 ms to a 16 MB write (8 ms
   * without, 12 ms with) - nothing next to closing a window.
   */
  const write = (text: unknown, durable: boolean): boolean => {
    if (blocked) {
      console.warn("[composer-input] not saving:", blocked)
      return false
    }
    if (typeof text !== "string" || !text.startsWith("{") || Buffer.byteLength(text, "utf8") > MAX_BYTES) return false
    try {
      writeAtomicSync(file, text, undefined, durable)
      return true
    } catch {
      return false
    }
  }

  ipc.handle("mcode:composer-input-save", (_event, text: unknown) => write(text, false))
  // The page is going away: the last write has to finish before it does.
  ipc.on("mcode:composer-input-flush", (event, text: unknown) => {
    event.returnValue = write(text, true)
  })
}
