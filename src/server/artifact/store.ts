import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ArtifactFile, Message, SessionArtifacts, SessionInfo } from "@shared/protocol"
import { sessionArtifacts } from "@shared/session-files"

/**
 * Where produced files are kept, rather than worked out again every time.
 *
 * The artifacts page used to be answered by walking every stored conversation's
 * transcript on each request (`handlers.ts` "artifact.list"), which meant three
 * things MiMo does not live with. Nothing was de-duplicated, so one file
 * produced by two conversations was two entries with nothing tying them
 * together. Nothing survived: deleting the conversation that made a file took
 * the file's whole record with it, although the file itself was still on disk.
 * And every request re-read every transcript.
 *
 * MiMo keeps a database for exactly this - `db/artifacts.db`, with
 * `artifact(identity_key UNIQUE, role, availability, last_checked_at, …)`,
 * `artifact_source`, an FTS index and four numbered migrations. This is that
 * store, at MCode's scale: one row per file, addressed by an identity key,
 * carrying which conversation produced it, whether it is something to hand over
 * or a step on the way, and whether it is still there.
 *
 * What it deliberately does NOT do is rebuild itself when it cannot read the
 * file, which is what the search index does. The search index is derived from
 * the transcripts and can always be made again; this holds the one record of
 * files whose conversations are gone, so a version it does not understand is
 * read as far as it goes and never written over.
 */

/** Bumped when the tables change in a way an older build would misread. */
export const ARTIFACT_SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS artifact (
  id INTEGER PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL DEFAULT '',
  session_title TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  absolute TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'intermediate',
  kind TEXT NOT NULL DEFAULT 'other',
  produced_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL DEFAULT 0,
  availability TEXT NOT NULL DEFAULT 'unknown',
  size_bytes INTEGER,
  modified_at INTEGER
);
CREATE INDEX IF NOT EXISTS artifact_session ON artifact (session_id, produced_at);
CREATE INDEX IF NOT EXISTS artifact_role ON artifact (role);
`

interface Row {
  identity_key: string
  session_id: string
  session_title: string
  directory: string
  path: string
  absolute: string
  role: string
  kind: string
  produced_at: number
  updated_at: number
  availability: string
  size_bytes: number | null
  modified_at: number | null
}

/** How two spellings of one path are told apart - the identity key MiMo dedupes on. */
export function identityKey(absolute: string): string {
  const resolved = path.resolve(absolute).replace(/[\\/]+$/, "")
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export class ArtifactStore {
  private constructor(
    private readonly db: DatabaseSync,
    /** False when the file was written by a later build: read it, never write it. */
    readonly writable: boolean,
  ) {}

  /**
   * Opens the store, making it if it is not there. Never throws: without it the
   * app still runs and the page falls back to reading the transcripts.
   */
  static open(file: string): ArtifactStore | undefined {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const db = new DatabaseSync(file)
      const check = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined
      if (check && Object.values(check)[0] !== "ok") throw new Error("the artifact store failed its integrity check")
      db.exec("PRAGMA journal_mode = WAL")
      db.exec(SCHEMA)
      const latest = (db.prepare("SELECT max(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined)?.v ?? 0
      if (latest > ARTIFACT_SCHEMA_VERSION) {
        // A newer build wrote this. Everything it holds is still readable; nothing here may write over it.
        return new ArtifactStore(db, false)
      }
      if (latest < ARTIFACT_SCHEMA_VERSION) {
        db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(ARTIFACT_SCHEMA_VERSION, Date.now())
      }
      return new ArtifactStore(db, true)
    } catch {
      return undefined
    }
  }

  /**
   * Brings the store up to date with what the conversations say, and re-checks
   * whether each file is still there.
   *
   * De-duplicated by identity key: the same file produced again - by this
   * conversation or another - updates the row it already has rather than adding
   * a second. A row whose conversation has since been deleted keeps its place
   * and simply stops being touched by this.
   */
  async reconcile(sessions: readonly SessionInfo[], messagesOf: (sessionID: string) => Promise<Message[]>): Promise<void> {
    if (!this.writable) return
    for (const session of sessions) {
      // subagents: a subagent's work belongs to its parent, not to a conversation of its own.
      if (session.parentID) continue
      const messages = await messagesOf(session.id).catch(() => [])
      if (!messages.length) continue
      for (const artifact of sessionArtifacts(messages, session.directory)) {
        const absolute = path.resolve(session.directory, artifact.path)
        this.upsert({
          identity_key: identityKey(absolute),
          session_id: session.id,
          session_title: session.title,
          directory: session.directory,
          path: artifact.path,
          absolute,
          role: artifact.role,
          kind: artifact.kind,
          produced_at: artifact.at,
        })
      }
    }
    await this.recheck()
  }

  /**
   * Writes one file's row, crediting whichever conversation produced it last.
   *
   * MiMo can hold several sources for one artifact (`artifact_source`); one row
   * per file cannot, so it has to name one conversation - and which one must not
   * depend on the order this happens to reconcile in. Taking the newest producer
   * is the answer that reads the same whenever it is run, and it is the one a
   * reader would expect: the conversation that last wrote the file is the one
   * that put its current contents there.
   */
  private upsert(entry: {
    identity_key: string
    session_id: string
    session_title: string
    directory: string
    path: string
    absolute: string
    role: string
    kind: string
    produced_at: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO artifact (identity_key, session_id, session_title, directory, path, absolute, role, kind, produced_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(identity_key) DO UPDATE SET
           session_id = CASE WHEN excluded.produced_at >= artifact.produced_at THEN excluded.session_id ELSE artifact.session_id END,
           session_title = CASE WHEN excluded.produced_at >= artifact.produced_at THEN excluded.session_title ELSE artifact.session_title END,
           directory = CASE WHEN excluded.produced_at >= artifact.produced_at THEN excluded.directory ELSE artifact.directory END,
           path = CASE WHEN excluded.produced_at >= artifact.produced_at THEN excluded.path ELSE artifact.path END,
           role = CASE WHEN excluded.produced_at >= artifact.produced_at THEN excluded.role ELSE artifact.role END,
           kind = CASE WHEN excluded.produced_at >= artifact.produced_at THEN excluded.kind ELSE artifact.kind END,
           produced_at = max(artifact.produced_at, excluded.produced_at),
           updated_at = excluded.updated_at`,
      )
      .run(
        entry.identity_key,
        entry.session_id,
        entry.session_title,
        entry.directory,
        entry.path,
        entry.absolute,
        entry.role,
        entry.kind,
        entry.produced_at,
        Date.now(),
      )
  }

  /**
   * Asks the file system about every file it holds.
   *
   * A conversation's record of writing a file says nothing about whether it is
   * still there: it may have been deleted, moved, or changed since by something
   * other than this app. MiMo re-checks the same way and keeps the answer in
   * `availability` with `last_checked_at`.
   */
  async recheck(): Promise<void> {
    if (!this.writable) return
    const rows = this.db.prepare("SELECT identity_key, absolute FROM artifact").all() as { identity_key: string; absolute: string }[]
    const now = Date.now()
    for (const row of rows) {
      const stats = await fsp.stat(row.absolute).catch(() => undefined)
      const there = Boolean(stats?.isFile())
      this.db
        .prepare("UPDATE artifact SET availability = ?, size_bytes = ?, modified_at = ?, last_checked_at = ? WHERE identity_key = ?")
        .run(there ? "available" : "missing", there ? (stats?.size ?? null) : null, there ? (stats?.mtimeMs ?? null) : null, now, row.identity_key)
    }
  }

  /**
   * Everything produced, grouped by the conversation that produced it.
   *
   * A group whose conversation has been deleted keeps the title it had, so the
   * files it made are still findable - which is the whole point of storing them
   * rather than deriving them.
   */
  list(query = ""): SessionArtifacts[] {
    const words = query.trim().toLowerCase()
    const rows = this.db.prepare("SELECT * FROM artifact ORDER BY produced_at DESC").all() as unknown as Row[]
    const groups = new Map<string, SessionArtifacts>()
    for (const row of rows) {
      if (words && !row.path.toLowerCase().includes(words) && !row.session_title.toLowerCase().includes(words)) continue
      const key = row.session_id || `gone:${row.session_title}`
      let group = groups.get(key)
      if (!group) {
        group = { sessionID: row.session_id, title: row.session_title, directory: row.directory, updated: row.produced_at, files: [] }
        groups.set(key, group)
      }
      group.updated = Math.max(group.updated, row.produced_at)
      const file: ArtifactFile = {
        path: row.path,
        at: row.produced_at,
        exists: row.availability === "available",
        role: row.role === "deliverable" ? "deliverable" : "intermediate",
        ...(row.size_bytes !== null ? { size: row.size_bytes } : {}),
        ...(row.modified_at !== null ? { modified: row.modified_at } : {}),
      }
      group.files.push(file)
    }
    return [...groups.values()].sort((a, b) => b.updated - a.updated)
  }

  /**
   * Unhooks a conversation's rows without removing them.
   *
   * This is the difference the user asked for: a file outlives the conversation
   * that made it. The row keeps the title that conversation had, so the page can
   * still say where the file came from, and stops being reconciled because there
   * is no longer a transcript behind it.
   */
  orphan(sessionID: string): void {
    if (!this.writable) return
    this.db.prepare("UPDATE artifact SET session_id = '' WHERE session_id = ?").run(sessionID)
  }

  /** How many rows it holds, for the checks. */
  count(): number {
    return Number((this.db.prepare("SELECT count(*) AS n FROM artifact").get() as { n: number }).n)
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // Closing twice, or after a failure, changes nothing worth reporting.
    }
  }
}
