import fs from "node:fs/promises"
import path from "node:path"
import { CodedError, diskErrorCode } from "@shared/errors"

/**
 * Flat JSON document store rooted at the app data directory.
 *
 * Keys are slash-separated paths ("session/ses_abc/info"); each maps to one
 * `.json` file. Writes go to a temp file first and are then renamed, so a crash
 * mid-write leaves the previous version intact rather than a truncated file.
 */
/** Distinguishes concurrent writes within one process. */
let ticket = 0

/**
 * Where a path stops being safe to lengthen.
 *
 * Windows refuses a path over 260 characters unless the process opts in, and
 * the temp file is necessarily longer than the document it stands in for. The
 * reference meets the same wall and answers it by shortening the name
 * (`truncate`, basename to 128) rather than by failing.
 */
const PATH_LIMIT = 240

/**
 * The temp file one write uses.
 *
 * Appending is the readable form and is used wherever it fits. Where it would
 * not, the suffix replaces the tail of the name instead, so the temp path is
 * never longer than the document's own - which is what made a save near
 * MAX_PATH fail for a file that fitted perfectly well itself. The suffix
 * carries the pid and a counter that only ever goes up, so no two writes in
 * flight - in this process or beside it - can land on one name.
 */
export function tempNameFor(target: string): string {
  const suffix = `.${process.pid}.${++ticket}.tmp`
  if (target.length + suffix.length <= PATH_LIMIT) return target + suffix
  const base = path.basename(target)
  const room = Math.max(1, base.length - suffix.length)
  return path.join(path.dirname(target), base.slice(0, room) + suffix)
}

/**
 * Writes a file by replacing it, never by truncating it.
 *
 * A direct write is not a small risk taken for simplicity: it is a window in
 * which the file on disk is neither the old contents nor the new ones, and a
 * crash inside that window loses both.
 *
 * The bytes are flushed before the rename, as the reference's full writer
 * flushes them. Renaming is atomic in the ordering sense and not in the
 * durable one: without this, power lost shortly after a save can leave some
 * filesystems showing the new name over no contents at all, which turns "the
 * old version survived" into "neither version did".
 */
export async function writeAtomic(target: string, data: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = tempNameFor(target)
  let written = false
  try {
    const handle = await fs.open(temp, "w", mode)
    try {
      await handle.writeFile(data, "utf8")
      written = true
      await handle.sync()
    } finally {
      await handle.close()
    }
    await renameOver(temp, target)
  } catch (err) {
    /*
     * Cleanup belongs here rather than on the rename alone.
     *
     * A full disk throws inside the write, which used to be outside the try -
     * so the one failure that leaves temp files behind was the one whose
     * cleanup never ran, and they piled up in the storage folder.
     */
    if (written || (err as NodeJS.ErrnoException)?.code !== "ENOENT") await fs.rm(temp, { force: true }).catch(() => {})
    const code = diskErrorCode(err)
    if (code) throw new CodedError(`${target} could not be written: ${(err as Error).message}`, code)
    throw err
  }
}

/** Lock errors Windows returns while another handle - a reader, a virus scanner - still has the target open. */
const TRANSIENT_LOCK = new Set(["EPERM", "EACCES", "EBUSY"])

/**
 * A rename that waits out a moment of sharing.
 *
 * Windows refuses to replace a file some other handle has open, and says so
 * with EPERM - even when that handle is this process reading the same session
 * a moment earlier. A turn failed on exactly this when the conversation's
 * record was saved while a list of sessions was being read. The lock lasts
 * milliseconds, so the rename is tried again a few times over about a second;
 * anything else, or a lock that outlasts that, still fails.
 */
async function renameOver(temp: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, target)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (process.platform !== "win32" || !code || !TRANSIENT_LOCK.has(code) || attempt >= 8) throw err
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** Math.min(attempt, 5)))
    }
  }
}

/**
 * Moves a file that will not parse out of the way, keeping it as evidence.
 *
 * Nothing in this app may write over a document it could not read. The contents
 * are the user's only copy of whatever was in it - scheduled tasks, settings, a
 * conversation - and an empty document written on top makes a recoverable
 * truncation into a permanent loss. The reference blocks the same way, holding
 * the raw text aside rather than starting empty.
 *
 * @returns where the file went, or undefined if it could not be moved, in which
 *   case the caller must refuse to write rather than carry on.
 */
export async function quarantine(target: string): Promise<string | undefined> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  for (let attempt = 0; attempt < 4; attempt++) {
    const aside = attempt === 0 ? `${target}.corrupt-${stamp}` : `${target}.corrupt-${stamp}-${attempt}`
    try {
      // Refuses rather than replacing: a second damaged copy must not erase the first.
      await fs.rename(target, aside)
      return aside
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") return undefined
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") return undefined
      const exists = await fs
        .access(aside)
        .then(() => true)
        .catch(() => false)
      if (!exists) return undefined
    }
  }
  return undefined
}

export class Storage {
  constructor(private readonly root: string) {}

  /**
   * A document, or the reason it could not be read.
   *
   * `read` throws, which is right for a caller that cannot go on without the
   * document. A caller that can - the settings, the list of conversations -
   * needs to tell "there is no such file" from "there is one and it is damaged",
   * because those call for opposite answers: the first is a fresh install, the
   * second must never be written over.
   */
  async readOrCorrupt<T>(key: string): Promise<{ value?: T; corrupt?: string }> {
    try {
      return { value: await this.read<T>(key) }
    } catch (err) {
      return { corrupt: err instanceof Error ? err.message : String(err) }
    }
  }

  /** Where an unreadable document was moved to, so it is kept rather than replaced. */
  quarantine(key: string): Promise<string | undefined> {
    return quarantine(this.file(key))
  }

  /** Where everything this app stores actually sits, for the page that says so. */
  get directory(): string {
    return this.root
  }

  /**
   * The last write queued for each key.
   *
   * Unique temp names stop the crash; ordering stops the quieter problem, where
   * two overlapping saves of the same message land in the wrong order and the
   * older one wins.
   */
  private readonly queued = new Map<string, Promise<void>>()

  private file(key: string): string {
    return path.join(this.root, ...key.split("/")) + ".json"
  }

  /** Where a key's document sits on disk, for something that has to watch it. */
  fileOf(key: string): string {
    return this.file(key)
  }

  /**
   * Where a key's directory sits on disk, for data this store cannot hold.
   *
   * Everything else here is one JSON document per key. Undo needs somewhere to
   * keep a git repository, which is a directory of its own and is written by
   * git rather than by this app.
   */
  folder(key: string): string {
    return path.join(this.root, ...key.split("/"))
  }

  async read<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await fs.readFile(this.file(key), "utf8")
      /*
       * A leading byte-order mark is dropped rather than parsed.
       *
       * Nothing here writes one, but these files are plain JSON in a folder a
       * person can open, and most Windows editors - Notepad, and PowerShell's
       * own Set-Content and Out-File - add a BOM as a matter of course. Node
       * hands it back as a U+FEFF character, JSON.parse throws on it, and this
       * store is read while the backend is starting: the whole app then fails
       * to open with a syntax error about a character nobody typed, and there
       * is no interface left to fix it from. Observed on a config.json that had
       * been edited by hand.
       */
      return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as T
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw err
    }
  }

  async write(key: string, value: unknown): Promise<void> {
    // Serialised per key, so a later save cannot be overtaken by an earlier one.
    const previous = this.queued.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.writeNow(key, value))
    this.queued.set(key, next)
    try {
      await next
    } finally {
      // Only the newest queue entry is worth remembering.
      if (this.queued.get(key) === next) this.queued.delete(key)
    }
  }

  private async writeNow(key: string, value: unknown): Promise<void> {
    /*
     * Owner-only, as the credential file is: config.json holds MCP bearer
     * headers and gateway keys, mcp-auth.json the MCP sign-ins, and the rest
     * is the user's conversations. (On Windows the mode only sets the
     * read-only bit; there the profile folder's own ACL is what keeps others out.)
     */
    await writeAtomic(this.file(key), JSON.stringify(value, null, 2), 0o600)
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true })
  }

  async removeDirectory(key: string): Promise<void> {
    await fs.rm(path.join(this.root, ...key.split("/")), { recursive: true, force: true })
  }

  /** Keys directly under `prefix`, sorted ascending. Ids sort chronologically. */
  async list(prefix: string): Promise<string[]> {
    const dir = path.join(this.root, ...prefix.split("/"))
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .sort()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
  }

  async listDirectories(prefix: string): Promise<string[]> {
    const dir = path.join(this.root, ...prefix.split("/"))
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      throw err
    }
  }
}
