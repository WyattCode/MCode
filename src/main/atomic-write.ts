import fs from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"
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
 *
 * `durable: false` skips the flush, for a write the next one supersedes within
 * the second: the rename still orders it, so a crashed process leaves the old
 * file or the new one whole, and only a power cut can cost that write.
 */
export function writeAtomicSync(file: string, text: string, mode?: number, durable = true): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = tempNameFor(file)
  try {
    const handle = fs.openSync(temp, "w", mode)
    try {
      fs.writeFileSync(handle, text, "utf8")
      if (durable) fs.fsyncSync(handle)
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

/**
 * Past this age a leftover temp goes even when a live process carries its id:
 * no write here takes more than a moment, so by then the id belongs to some
 * other program the system has since handed it to.
 */
export const TEMP_KEEP_MS = 60 * 60 * 1000

/** Whether a process with this id exists; one we may not signal still does. */
export function processAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export interface TempSweep {
  /** The files written here, by name; only their temps are looked at. */
  names: readonly string[]
  /** Names whose earlier writer named its temp `<name>.<pid>.tmp`, without the counter. */
  pidOnly?: readonly string[]
}

/**
 * Removes the temps killed writes left in one folder (D12-7), once at start-up.
 *
 * A write that dies between creating `<name>.<pid>.<n>.tmp` and renaming it
 * leaves the temp for good: its own cleanup never ran, and nothing else looks
 * for it. The backend sweeps its storage the same way (N11-30); these are the
 * main process's folders. Nothing is taken but a temp of one of `names`, in
 * the writer's own form, whose process is gone - or which is over an hour old,
 * whoever holds its id now. Never recursive: each writer's folder is listed.
 *
 * @returns the names removed.
 */
export async function sweepWriterTemps(directory: string, sweep: TempSweep, options: { now?: number; alive?: (pid: number) => boolean } = {}): Promise<string[]> {
  const now = options.now ?? Date.now()
  const alive = options.alive ?? processAlive
  const removed: string[] = []
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const match = /^(.+?)\.(\d+)(\.\d+)?\.tmp$/.exec(entry.name)
    if (!match) continue
    const [, name, pidText, counter] = match
    if (!(counter ? sweep.names : (sweep.pidOnly ?? [])).includes(name!)) continue
    const full = path.join(directory, entry.name)
    const pid = Number(pidText)
    if (alive(pid)) {
      const modified = await stat(full).then((found) => found.mtimeMs, () => now)
      if (now - modified < TEMP_KEEP_MS) continue
    }
    await rm(full, { force: true }).then(() => removed.push(entry.name), () => undefined)
  }
  return removed
}
