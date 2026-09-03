import fs from "node:fs/promises"
import path from "node:path"

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
 * Writes a file by replacing it, never by truncating it.
 *
 * A direct write is not a small risk taken for simplicity: it is a window in
 * which the file on disk is neither the old contents nor the new ones, and a
 * crash inside that window loses both.
 */
export async function writeAtomic(target: string, data: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${++ticket}.tmp`
  await fs.writeFile(temp, data, mode === undefined ? "utf8" : { encoding: "utf8", mode })
  try {
    await fs.rename(temp, target)
  } catch (err) {
    // Leaving a stray temp behind would be worse than the failure itself.
    await fs.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

export class Storage {
  constructor(private readonly root: string) {}

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
    await writeAtomic(this.file(key), JSON.stringify(value, null, 2))
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
