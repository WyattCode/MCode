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
 *
 * `verify`, when given, reads the written temp file back before it replaces
 * anything, and a throw from it leaves the target as it was - for a write
 * that must be proved readable before the old version goes (L12-3). `data`
 * may be bytes, for a file that is not text (R18-A1).
 */
export async function writeAtomic(target: string, data: string | Uint8Array, mode?: number, durable = true, verify?: (written: string) => Promise<void>): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = tempNameFor(target)
  let written = false
  try {
    const handle = await fs.open(temp, "w", mode)
    try {
      await handle.writeFile(data, "utf8")
      written = true
      /*
       * Skipped only for the half-second saves of a reply still streaming
       * (N11-29): N turns in flight meant 2N fsyncs a second of documents up
       * to a quarter of a megabyte, and each of them is overwritten half a
       * second later. The rename is still atomic, so a crash can only cost the
       * last half-second of a reply that was never finished anyway; the save
       * at the end of the step is durable as ever.
       */
      if (durable) await handle.sync()
    } finally {
      await handle.close()
    }
    if (verify) await verify(temp)
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
 * A read that waits out a moment of sharing.
 *
 * The mirror of renameOver, and for the same handles: a virus scanner, a
 * backup agent or the Search indexer opens a file for a few milliseconds
 * without sharing, and Windows answers every other reader with EBUSY. Every
 * caller that reads a document here treats a throw as damage - the settings,
 * the remembered approvals, a conversation's undo - so a lock lasting one blink
 * used to be read as a corrupt file. Waiting it out is what keeps that from
 * being the common case; readOrCorrupt still tells a lock that outlasts this
 * from a file that genuinely will not parse.
 */
async function readWaiting(file: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.readFile(file, "utf8")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT") return undefined
      if (process.platform !== "win32" || !code || !TRANSIENT_LOCK.has(code) || attempt >= 8) throw err
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** Math.min(attempt, 5)))
    }
  }
}

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
  let taken = 0
  for (let attempt = 0; attempt < 8; attempt++) {
    const aside = taken === 0 ? `${target}.corrupt-${stamp}` : `${target}.corrupt-${stamp}-${taken}`
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
      // That name is already a quarantined copy: step to the next one, at once.
      if (exists) {
        if (++taken >= 4) return undefined
        continue
      }
      /*
       * The name is free, so it was the document itself that would not move:
       * the same transient Windows lock renameOver waits out, and the worst
       * moment to give up. Giving up here is what lets a caller write over a
       * file it never managed to keep, so the lock is waited out here too.
       */
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** Math.min(attempt, 5)))
    }
  }
  return undefined
}

/** How long a quarantined copy is kept once a newer one of the same document exists. */
export const QUARANTINE_KEEP_DAYS = 30

/**
 * A copy `quarantine` (or the SQLite stores' own) made: the document's name,
 * `.corrupt-`, the moment as an ISO time with `:` and `.` made `-`, a counter
 * when that name was taken, and a journal's suffix for a database's.
 */
const QUARANTINED = /^(.+)\.corrupt-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(-\d+)?(-wal|-shm|-journal)?$/

/**
 * Removes old quarantined copies from a folder, once at start-up (L12-15).
 *
 * Nothing ever deleted a `.corrupt-*` file, so a document that kept being
 * damaged - or a store that kept being moved aside - piled copies up for the
 * life of the profile. A copy goes once it is more than 30 days old, by the
 * time in its own name; the newest copy of each document is always kept,
 * however old, since it may be the only evidence left of what happened.
 * Journal files go with the copy they belong to.
 *
 * @returns how many files were removed.
 */
export async function pruneQuarantined(directory: string, options: { recursive?: boolean; now?: number } = {}): Promise<number> {
  const now = options.now ?? Date.now()
  let removed = 0
  const sweep = async (folder: string): Promise<void> => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    const copies = new Map<string, Map<string, { at: number; files: string[] }>>()
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (options.recursive) await sweep(path.join(folder, entry.name))
        continue
      }
      const match = QUARANTINED.exec(entry.name)
      if (!match) continue
      const [, document, stamp, attempt = ""] = match
      const at = Date.parse(stamp!.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z"))
      if (!Number.isFinite(at)) continue
      const byCopy = copies.get(document!) ?? new Map<string, { at: number; files: string[] }>()
      copies.set(document!, byCopy)
      const copy = byCopy.get(stamp + attempt) ?? { at, files: [] }
      copy.files.push(entry.name)
      byCopy.set(stamp + attempt, copy)
    }
    for (const byCopy of copies.values()) {
      const newest = [...byCopy.entries()].sort((a, b) => b[1].at - a[1].at || b[0].localeCompare(a[0]))[0]?.[0]
      for (const [id, copy] of byCopy) {
        if (id === newest || now - copy.at <= QUARANTINE_KEEP_DAYS * 24 * 60 * 60 * 1000) continue
        for (const name of copy.files) await fs.rm(path.join(folder, name), { force: true }).then(() => removed++, () => undefined)
      }
    }
  }
  await sweep(directory)
  return removed
}

/** A temp file tempNameFor made: `.<pid>.<counter>.tmp` at the end of the name. The pid is captured. */
export const TEMP_NAME = /\.(\d+)\.\d+\.tmp$/

/** How long a temp belonging to a process that is still running is left alone. */
const TEMP_KEEP_MS = 60 * 60 * 1000

/** Whether a process id is still running, for a temp that may still be being written. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means someone else owns it - which is still someone.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
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
   *
   * There is a third answer, and folding it into the second was a way to lose
   * data. `unreadable` is a document the operating system would not hand over -
   * a lock that outlasted readWaiting, a permission, a failing disk - and it is
   * the opposite of damage: the contents are almost certainly intact. It must
   * not be quarantined (the rename would fail for the same reason) and above
   * all it must not be written over, because "I could not read it" would
   * otherwise become "it is now empty". A caller that gets this must refuse to
   * write for the rest of the run.
   */
  async readOrCorrupt<T>(key: string): Promise<{ value?: T; corrupt?: string; unreadable?: string }> {
    try {
      return { value: await this.read<T>(key) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // An errno is the disk answering; a parse failure carries none.
      return typeof (err as NodeJS.ErrnoException).code === "string" ? { unreadable: message } : { corrupt: message }
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
    const raw = await readWaiting(this.file(key))
    if (raw === undefined) return undefined
    {
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
    }
  }

  async write(key: string, value: unknown, options: { durable?: boolean } = {}): Promise<void> {
    // Serialised per key, so a later save cannot be overtaken by an earlier one.
    const previous = this.queued.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.writeNow(key, value, options.durable ?? true))
    this.queued.set(key, next)
    try {
      await next
    } finally {
      // Only the newest queue entry is worth remembering.
      if (this.queued.get(key) === next) this.queued.delete(key)
    }
  }

  /**
   * Settles every write queued so far, and any queued while waiting (L12-6).
   *
   * For quit: a write is atomic, so one cut off leaves the old version, but a
   * setting or an approval made in the last moment before quit was lost with
   * it. A failed write is not this caller's to report; its own caller was told.
   */
  async drain(): Promise<void> {
    const awaited = new Set<Promise<void>>()
    for (;;) {
      const pending = [...this.queued.values()].filter((write) => !awaited.has(write))
      if (!pending.length) return
      for (const write of pending) awaited.add(write)
      await Promise.allSettled(pending)
    }
  }

  /** A document's text as it sits on disk, or undefined when there is none. */
  async readText(key: string): Promise<string | undefined> {
    return readWaiting(this.file(key))
  }

  /**
   * Writes whatever `render` makes of the file as it stands at the moment of
   * writing, in this key's queue - for a document edited in place rather than
   * replaced, whose current text has to be read after any earlier save landed.
   */
  async writeText(key: string, render: (current: string | undefined) => string): Promise<void> {
    const previous = this.queued.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(async () => writeAtomic(this.file(key), render(await this.readText(key)), 0o600))
    this.queued.set(key, next)
    try {
      await next
    } finally {
      if (this.queued.get(key) === next) this.queued.delete(key)
    }
  }

  private async writeNow(key: string, value: unknown, durable: boolean): Promise<void> {
    /*
     * Owner-only, as the credential file is: config.json holds MCP bearer
     * headers and gateway keys, mcp-auth.json the MCP sign-ins, and the rest
     * is the user's conversations. (On Windows the mode only sets the
     * read-only bit; there the profile folder's own ACL is what keeps others out.)
     */
    await writeAtomic(this.file(key), JSON.stringify(value, null, 2), 0o600, durable)
  }

  /**
   * Temp files a previous run of the app left behind (N11-30).
   *
   * A write killed between creating its temp file and renaming it over the
   * document leaves `<name>.<pid>.<n>.tmp` in place, and nothing ever looked
   * for them: this run's own failed writes clean up after themselves, the
   * previous process's cannot.
   *
   * "Not my pid" is not enough to call a temp abandoned. Two instances may
   * share one profile - sql-worker waits out the other's lock for exactly that
   * reason - and the other one's write sits under a name like this for the
   * moment between creating the temp and renaming it. Taking it makes that
   * rename fail with ENOENT, which for a message is a turn lost and for the
   * remembered approvals is a save swallowed by its own catch. So a temp whose
   * process is still running is left alone until it is an hour old, whoever
   * holds that id by then - the test the main process's sweep already makes.
   */
  async sweepTemps(options: { now?: number; alive?: (pid: number) => boolean } = {}): Promise<number> {
    const now = options.now ?? Date.now()
    const alive = options.alive ?? processAlive
    let removed = 0
    const walk = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
          continue
        }
        const match = TEMP_NAME.exec(entry.name)
        if (!match || Number(match[1]) === process.pid) continue
        if (alive(Number(match[1]))) {
          const modified = await fs.stat(full).then((found) => found.mtimeMs, () => now)
          if (now - modified < TEMP_KEEP_MS) continue
        }
        await fs.rm(full, { force: true }).then(() => removed++, () => undefined)
      }
    }
    await walk(this.root)
    return removed
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
