import fs from "node:fs"
import path from "node:path"
import { tempNameFor } from "../server/storage"

/*
 * The main process's small settings files - boot preferences, the display
 * server, the window's place - written the way the backend writes its
 * documents: to a temp file beside the target, flushed, then renamed over it.
 *
 * A plain write truncates first, so a crash or a power cut inside it left an
 * empty file, and every reader here falls back to defaults on a file it cannot
 * parse. For boot-prefs.json that silently turned GPU acceleration back on for
 * someone who had turned it off because of GPU crashes. Synchronous because
 * the window's place is saved on the way out, when nothing waits for a promise.
 */

/** Lock errors Windows returns while another handle - a reader, a virus scanner - has the target open. */
const TRANSIENT_LOCK = new Set(["EPERM", "EACCES", "EBUSY"])
const RENAME_ATTEMPTS = 8

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** A rename that waits out a moment of sharing on Windows, over about a second, as the backend's does. */
function renameOverSync(temp: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temp, target)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (process.platform !== "win32" || !code || !TRANSIENT_LOCK.has(code) || attempt >= RENAME_ATTEMPTS) throw err
      pause(10 * 2 ** Math.min(attempt, 5))
    }
  }
}

/**
 * Replaces `file` with `text`, never truncating it in place: the file on disk
 * is always either the old contents or the new ones. Throws when the write
 * fails, after removing its temp file; a crash can only leave a stray temp
 * beside the target, which no reader opens.
 */
export function writeAtomicSync(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = tempNameFor(file)
  try {
    const handle = fs.openSync(temp, "w", mode)
    try {
      fs.writeFileSync(handle, text, "utf8")
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    renameOverSync(temp, file)
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // The write's own error is the one worth reporting.
    }
    throw err
  }
}
