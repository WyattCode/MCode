import fs from "node:fs/promises"
import path from "node:path"
import type { Storage } from "./storage"
import { runGit } from "./git-process"

/**
 * The main repository each conversation folder belongs to, as MiMo's
 * `repoRoots` answers it.
 *
 * A conversation opened in a linked worktree or in a subdirectory of a
 * repository is filed under the repository's own project rather than becoming
 * a project of its own. The root is the folder holding the repository's shared
 * `.git` (`rev-parse --git-common-dir`), so every worktree of one repository
 * answers the same folder. Anything else - a bare repository's worktree, a
 * submodule, a folder outside git - answers nothing and keeps its own folder.
 *
 * Answers are kept for five minutes and in a small document, so a restart does
 * not ask git about every folder again; an older answer is used at once while a
 * fresh one is asked for in the background. Folders that no longer exist are
 * reported, never cached: a deleted worktree's conversations are not filed
 * under anything.
 */

export const REPO_ROOTS_FRESH_MS = 5 * 60_000
const CACHE_KEY = "repo-roots-cache"
const CONCURRENCY = 8
const SAVE_DELAY_MS = 200

interface Entry {
  /** The main repository's folder, or null for a folder that has none. */
  root: string | null
  at: number
}

/** The repository folder `--git-common-dir` points into, or null when it is not a `.git` folder. */
export function rootFromCommonDir(output: string): string | null {
  const line = output.split(/\r?\n/)[0]?.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (!line) return null
  const parts = line.split("/")
  if (parts[parts.length - 1] !== ".git") return null
  parts.pop()
  const joined = parts.join("/")
  return joined ? path.resolve(joined.endsWith(":") ? `${joined}/` : joined) : null
}

async function inBatches<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) await work(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane))
}

/**
 * The key one folder shares with its other spellings.
 *
 * A folder arrives as a Windows 8.3 short name (`C:\Users\RUNNER~1\...`) from
 * the environment and as its long name from git - one folder, two strings,
 * measured inside one cache document on run 44933235897; macOS has the same
 * with `/var` and `/private/var`. Storing by the string asked with gave one
 * folder several answers; the physical path is the key, letter case folded
 * where the file system folds it.
 */
async function folderKey(folder: string): Promise<string> {
  const resolved = path.resolve(folder)
  const physical = await fs.realpath(resolved).catch(() => resolved)
  return process.platform === "win32" ? physical.toLowerCase() : physical
}

export class RepoRoots {
  private readonly entries = new Map<string, Entry>()
  private loaded: Promise<void> | undefined
  private saving: ReturnType<typeof setTimeout> | undefined
  private blocked: string | undefined

  constructor(
    private readonly storage?: Storage,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.storage) return
      const read = await this.storage.readOrCorrupt<{ v?: number; e?: Record<string, Partial<Entry>> }>(CACHE_KEY)
      /*
       * A cache the disk would not hand over is whole, not damaged, so it is
       * neither moved aside nor written over: the answers are asked for again
       * this run rather than replacing a file that may still be readable.
       */
      if (read.unreadable) {
        this.blocked = read.unreadable
        console.warn(`[repo-roots] the cache could not be read (${read.unreadable}); nothing is saved over it`)
        return
      }
      if (read.corrupt) {
        const aside = await this.storage.quarantine(CACHE_KEY)
        if (aside === undefined) {
          this.blocked = read.corrupt
          console.warn(`[repo-roots] the cache is damaged and could not be moved aside; nothing is saved over it`)
          return
        }
        console.warn(`[repo-roots] the cache was damaged; the file was kept as ${aside}`)
      }
      const stored = read.value
      for (const [directory, entry] of Object.entries(stored?.e ?? {})) {
        if (!directory || !entry || typeof entry !== "object") continue
        const root = typeof entry.root === "string" ? entry.root : null
        const at = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0
        const known = this.entries.get(directory)
        if (!known || known.at < at) this.entries.set(directory, { root, at })
      }
    })()
    return this.loaded
  }

  private save(): void {
    if (!this.storage || this.saving || this.blocked) return
    this.saving = setTimeout(() => {
      this.saving = undefined
      const e: Record<string, Entry> = {}
      for (const [directory, entry] of this.entries) e[directory] = entry
      void this.storage?.write(CACHE_KEY, { v: 1, e }).catch(() => undefined)
    }, SAVE_DELAY_MS)
    this.saving.unref?.()
  }

  private async ask(directory: string): Promise<string | null> {
    const out = await runGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "")
    const root = rootFromCommonDir(out)
    this.entries.set(await folderKey(directory), { root, at: this.now() })
    this.save()
    return root
  }

  /**
   * Each folder's main repository, for the folders whose root is another
   * folder, and the folders that are gone.
   */
  async resolve(directories: readonly string[]): Promise<{ roots: Record<string, string>; missing: string[] }> {
    await this.load()
    const unique = [...new Set(directories.filter((entry) => typeof entry === "string" && entry))]
    const roots: Record<string, string> = {}
    const missing: string[] = []
    const unknown: string[] = []
    const stale: string[] = []
    // One folder is one entry whatever spelling it arrived in.
    const note = async (directory: string, root: string | null) => {
      if (root && (await folderKey(root)) !== (await folderKey(directory))) roots[directory] = root
    }
    for (const directory of unique) {
      const exists = await fs.stat(directory).then((stat) => stat.isDirectory(), () => false)
      if (!exists) {
        missing.push(directory)
        continue
      }
      const entry = this.entries.get(await folderKey(directory))
      if (!entry) unknown.push(directory)
      else {
        await note(directory, entry.root)
        if (this.now() - entry.at >= REPO_ROOTS_FRESH_MS) stale.push(directory)
      }
    }
    if (stale.length) void inBatches(stale, CONCURRENCY, async (directory) => void (await this.ask(directory))).catch(() => undefined)
    await inBatches(unknown, CONCURRENCY, async (directory) => void (await note(directory, await this.ask(directory))))
    return { roots, missing }
  }

  /** One folder's main repository when it is another folder, for a conversation about to be filed. */
  async rootOf(directory: string): Promise<string | undefined> {
    return (await this.resolve([directory])).roots[directory]
  }
}
