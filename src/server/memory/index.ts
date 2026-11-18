import fs from "node:fs/promises"
import path from "node:path"
import type { IndexDatabase } from "../history/database"
import { ftsQuery, plainSnippet, searchColumn } from "../history/text"
import { memoryLocation, withMemoryLock, type MemoryScope } from "./paths"

/**
 * memory: MiMo's memory search - BM25 over the memory markdown files, any of
 * the query's words matching, the best result always kept and the rest only
 * while they score at least 15% of it.
 *
 * The files are the record; the index is brought level with them before every
 * search by comparing each file's size and modification time with what was
 * indexed, as MiMo does.
 */

export const MEMORY_DEFAULT_LIMIT = 10
/** A result must score this share of the best one to be kept. */
export const MEMORY_SCORE_FLOOR = 0.15
/** At most this many candidates are ranked before the floor and the limit apply. */
const MEMORY_FETCH_CAP = 50

export interface MemoryHit {
  path: string
  snippet: string
  score: number
  scope: MemoryScope
  scope_id: string
  type: string
}

export interface MemorySearch {
  query: string
  scope?: MemoryScope
  scope_id?: string
  type?: string
  limit?: number
}

async function markdownFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(full)
    }
  }
  await walk(root)
  return found
}

export class MemoryIndex {
  constructor(
    private readonly database: IndexDatabase,
    readonly root: string,
  ) {}

  private get db() {
    return this.database.db
  }

  /** Removes the memory files, the previous layout backups, and the derived search records. */
  reset(): Promise<void> {
    return withMemoryLock(this.root, async () => {
      await fs.rm(this.root, { recursive: true, force: true })
      await fs.mkdir(this.root, { recursive: true })
      const backups = path.join(path.dirname(this.root), "backup")
      const entries = await fs.readdir(backups).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      for (const entry of entries) {
        if (/^memory-projects-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(entry)) {
          await fs.rm(path.join(backups, entry), { recursive: true, force: true })
        }
      }
      await this.db.run("DELETE FROM memory_doc")
    })
  }

  /** Indexes new and changed files and drops the ones that are gone; returns how many of each. */
  reconcile(): Promise<{ indexed: number; pruned: number }> {
    return withMemoryLock(this.root, () => this.reconcileNow())
  }

  private async reconcileNow(): Promise<{ indexed: number; pruned: number }> {
    const files = await markdownFiles(this.root)
    const onDisk = new Set(files)
    const known = new Map((await this.db.all<{ path: string; fingerprint: string }>("SELECT path, fingerprint FROM memory_doc")).map((row) => [row.path, row.fingerprint]))
    let pruned = 0
    for (const file of known.keys()) {
      if (onDisk.has(file)) continue
      await this.db.run("DELETE FROM memory_doc WHERE path = ?", file)
      pruned++
    }
    let indexed = 0
    const upsert = `INSERT INTO memory_doc (path, scope, scope_id, type, body, search_body, fingerprint, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET scope = excluded.scope, scope_id = excluded.scope_id, type = excluded.type, body = excluded.body, search_body = excluded.search_body, fingerprint = excluded.fingerprint, indexed_at = excluded.indexed_at`
    for (const file of files) {
      const location = memoryLocation(this.root, file)
      if (!location) continue
      const stat = await fs.stat(file).catch(() => undefined)
      if (!stat) continue
      const fingerprint = `${stat.size}-${stat.mtimeMs}`
      if (known.get(file) === fingerprint) continue
      const body = await fs.readFile(file, "utf8").catch(() => undefined)
      if (body === undefined) continue
      await this.db.run(upsert, file, location.scope, location.scope_id, location.type, body, searchColumn(body), fingerprint, Date.now())
      indexed++
    }
    return { indexed, pruned }
  }

  search(input: MemorySearch): Promise<MemoryHit[]> {
    return withMemoryLock(this.root, () => this.searchNow(input))
  }

  private async searchNow(input: MemorySearch): Promise<MemoryHit[]> {
    await this.reconcileNow()
    const expression = ftsQuery(input.query, "OR")
    if (!expression) return []
    const limit = Math.max(1, Math.floor(input.limit ?? MEMORY_DEFAULT_LIMIT))
    const where: string[] = []
    const params: (string | number)[] = [expression]
    if (input.scope) {
      where.push("d.scope = ?")
      params.push(input.scope)
    }
    if (input.scope_id) {
      where.push("d.scope_id = ?")
      params.push(input.scope_id)
    }
    if (input.type) {
      where.push("d.type = ?")
      params.push(input.type)
    }
    params.push(Math.min(limit * 3, MEMORY_FETCH_CAP))
    const rows = await this.db.all<Omit<MemoryHit, "score"> & { rank: number }>(
      `SELECT d.path, d.scope, d.scope_id, d.type, snippet(memory_doc_fts, 0, '<<', '>>', '...', 32) AS snippet, bm25(memory_doc_fts) AS rank
       FROM memory_doc_fts JOIN memory_doc d ON d.id = memory_doc_fts.rowid
       WHERE memory_doc_fts MATCH ? ${where.length ? `AND ${where.join(" AND ")}` : ""}
       ORDER BY rank LIMIT ?`,
      ...params,
    )
    // Read back out of the indexed column, so the spaces cut into CJK writing come out of the snippet.
    const hits = rows.map(({ rank, ...row }) => ({ ...row, snippet: plainSnippet(row.snippet), score: -rank }))
    if (!hits.length) return []
    const cutoff = hits[0]!.score * MEMORY_SCORE_FLOOR
    return hits.filter((hit, at) => at === 0 || hit.score >= cutoff).slice(0, limit)
  }
}
