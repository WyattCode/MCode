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
 * `artifact(identity_key UNIQUE, role, availability, last_checked_at, …)`, an
 * `artifact_source` table holding every observation of each artifact, an FTS5
 * mirror of the title with the trigram tokenizer, a per-session reconcile
 * checkpoint and a tombstone table for purged sessions. This is that store, at
 * MCode's scale: one row per file, addressed by an identity key, and one source
 * row for every conversation that wrote it.
 *
 * The file row also carries the source it is shown under (the newest
 * conversation that still exists, else the newest one that is gone). That copy
 * is what the page groups by, and it keeps the columns a version-1 build reads,
 * so an older build handed this file reads it correctly (read-only, as it must).
 *
 * What it deliberately does NOT do is rebuild itself when it cannot read the
 * file, which is what the search index does. The search index is derived from
 * the transcripts and can always be made again; this holds the one record of
 * files whose conversations are gone, so a version it does not understand is
 * read as far as it goes and never written over.
 */

/**
 * Bumped when the tables change in a way an older build would misread.
 *
 * 1 - one row per file, naming one conversation.
 * 2 - `artifact_source` (every conversation that wrote the file), the title and
 *     its FTS5 trigram mirror, the reconcile checkpoints and the tombstones.
 */
export const ARTIFACT_SCHEMA_VERSION = 2

const SCHEMA_V1 = `
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

const SCHEMA_V2 = `
ALTER TABLE artifact ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE artifact ADD COLUMN title_search TEXT NOT NULL DEFAULT '';

CREATE TABLE artifact_source (
  source_key TEXT PRIMARY KEY,
  artifact_id INTEGER NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  session_title TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'intermediate',
  kind TEXT NOT NULL DEFAULT 'other',
  produced_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX artifact_source_artifact ON artifact_source (artifact_id, produced_at);
CREATE INDEX artifact_source_session ON artifact_source (session_id);

CREATE TABLE artifact_reconcile (
  session_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE artifact_purged_session (
  session_id TEXT PRIMARY KEY,
  purged_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE artifact_fts USING fts5 (artifact_id UNINDEXED, title, tokenize = 'trigram');
CREATE TRIGGER artifact_fts_insert AFTER INSERT ON artifact BEGIN
  INSERT INTO artifact_fts (artifact_id, title) VALUES (new.id, new.title_search);
END;
CREATE TRIGGER artifact_fts_update AFTER UPDATE OF title_search ON artifact BEGIN
  DELETE FROM artifact_fts WHERE artifact_id = old.id;
  INSERT INTO artifact_fts (artifact_id, title) VALUES (new.id, new.title_search);
END;
CREATE TRIGGER artifact_fts_delete AFTER DELETE ON artifact BEGIN
  DELETE FROM artifact_fts WHERE artifact_id = old.id;
END;
`

interface Row {
  id: number
  session_id: string
  session_title: string
  directory: string
  path: string
  role: string
  produced_at: number
  availability: string
  size_bytes: number | null
  modified_at: number | null
}

interface SourceRow {
  source_key: string
  session_id: string
  session_title: string
  directory: string
  path: string
  role: string
  kind: string
  produced_at: number
}

/** How two spellings of one path are told apart - the identity key MiMo dedupes on. */
export function identityKey(absolute: string): string {
  const resolved = path.resolve(absolute).replace(/[\\/]+$/, "")
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** The name a file is listed and searched under: MiMo's title is the file's display name. */
function titleOf(file: string): string {
  return file.split(/[\\/]/).pop() || file
}

/** MiMo normalises both sides of a search the same way: NFC, lower case. */
function searchable(text: string): string {
  return text.normalize("NFC").toLowerCase()
}

/** One conversation's claim on one file. */
function sourceKey(identity: string, sessionID: string): string {
  return JSON.stringify([identity, sessionID])
}

/** What a conversation looked like at its last pass: it needs reading again if this changed. */
function fingerprintOf(session: SessionInfo): string {
  return JSON.stringify([session.updated, session.title, session.directory])
}

export class ArtifactStore {
  private running: Promise<void> | undefined
  /**
   * Conversations whose messages were written since their last pass, with a
   * count that moves on every write so a pass can tell a write that landed
   * while it was reading.
   */
  private readonly dirty = new Map<string, number>()

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
    let db: DatabaseSync | undefined
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      db = new DatabaseSync(file)
      const check = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined
      if (check && Object.values(check)[0] !== "ok") throw new Error("the artifact store failed its integrity check")
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA foreign_keys = ON")
      db.exec(SCHEMA_V1)
      const latest = (db.prepare("SELECT max(version) AS v FROM schema_migrations").get() as { v: number | null } | undefined)?.v ?? 0
      if (latest > ARTIFACT_SCHEMA_VERSION) {
        // A newer build wrote this. Everything it holds is still readable; nothing here may write over it.
        return new ArtifactStore(db, false)
      }
      if (latest < 2) ArtifactStore.migrateToV2(db)
      return new ArtifactStore(db, true)
    } catch {
      db?.close()
      return undefined
    }
  }

  /**
   * Version 1 to 2, in one transaction so a crash leaves version 1 untouched.
   *
   * Every row keeps its place: the conversation it named becomes its one source
   * (a row whose conversation was already gone keeps that title, unlinked), and
   * its title is filled in so the search index covers it from the start.
   */
  private static migrateToV2(db: DatabaseSync): void {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec(SCHEMA_V2)
      const rows = db
        .prepare("SELECT id, identity_key, session_id, session_title, directory, path, role, kind, produced_at FROM artifact")
        .all() as unknown as (SourceRow & { id: number; identity_key: string })[]
      const title = db.prepare("UPDATE artifact SET title = ?, title_search = ? WHERE id = ?")
      const source = db.prepare(
        `INSERT OR IGNORE INTO artifact_source (source_key, artifact_id, session_id, session_title, directory, path, role, kind, produced_at, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const now = Date.now()
      for (const row of rows) {
        const name = titleOf(row.path)
        title.run(name, searchable(name), row.id)
        const key = row.session_id ? sourceKey(row.identity_key, row.session_id) : JSON.stringify([row.identity_key, "", row.session_title])
        source.run(key, row.id, row.session_id, row.session_title, row.directory, row.path, row.role, row.kind, row.produced_at, now)
      }
      db.prepare("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(2, now)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }

  /**
   * Brings the store up to date with what the conversations say, and re-checks
   * whether each file is still there.
   *
   * Only conversations that changed since their last pass are read again (the
   * checkpoint is MiMo's `artifact_reconcile`), so this is cheap enough to run
   * before every listing - which is what keeps a file written since launch from
   * being missing from the page. Concurrent callers share one pass.
   */
  reconcile(sessions: readonly SessionInfo[], messagesOf: (sessionID: string) => Promise<Message[]>): Promise<void> {
    if (!this.writable) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.pass(sessions, messagesOf).finally(() => (this.running = undefined))
    return this.running
  }

  private async pass(sessions: readonly SessionInfo[], messagesOf: (sessionID: string) => Promise<Message[]>): Promise<void> {
    const checkpoint = this.db.prepare("SELECT fingerprint FROM artifact_reconcile WHERE session_id = ?")
    for (const session of sessions) {
      // subagents: a subagent's work belongs to its parent, not to a conversation of its own.
      if (session.parentID) continue
      const fingerprint = fingerprintOf(session)
      const writes = this.dirty.get(session.id)
      if (writes === undefined && (checkpoint.get(session.id) as { fingerprint?: string } | undefined)?.fingerprint === fingerprint) continue
      let messages: Message[]
      try {
        messages = await messagesOf(session.id)
      } catch {
        // Unreadable now is not the same as empty: its claims stay, and the next pass tries again.
        continue
      }
      // A write that landed during the read leaves the conversation marked, and without a checkpoint.
      const settled = this.dirty.get(session.id) === writes
      if (settled) this.dirty.delete(session.id)
      this.reconcileSession(session, messages, settled ? fingerprint : undefined)
    }
    await this.recheck()
  }

  /**
   * Told of every message write and removal. The conversation's checkpoint is
   * dropped at the first one, so that even a restart before the next pass reads
   * it again; later writes only move the count.
   */
  touched(sessionID: string): void {
    if (!this.writable) return
    const writes = this.dirty.get(sessionID)
    this.dirty.set(sessionID, (writes ?? 0) + 1)
    if (writes === undefined) this.db.prepare("DELETE FROM artifact_reconcile WHERE session_id = ?").run(sessionID)
  }

  /**
   * One conversation's claims, replaced as a whole.
   *
   * Every file it wrote gets (or keeps) a source row for it. A file it no longer
   * claims - the message was edited away - loses this conversation's source, and
   * a file left with no source at all goes, as MiMo's reconcile removes it.
   */
  private reconcileSession(session: SessionInfo, messages: readonly Message[], fingerprint: string | undefined): void {
    if (this.purged(session.id)) return
    const now = Date.now()
    this.transaction(() => {
      const claimed = new Set<string>()
      const touched = new Set<number>()
      for (const artifact of sessionArtifacts(messages, session.directory)) {
        const absolute = path.resolve(session.directory, artifact.path)
        const identity = identityKey(absolute)
        const name = titleOf(artifact.path)
        this.db
          .prepare(
            `INSERT INTO artifact (identity_key, session_id, session_title, directory, path, absolute, role, kind, produced_at, updated_at, title, title_search)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(identity_key) DO NOTHING`,
          )
          .run(identity, session.id, session.title, session.directory, artifact.path, absolute, artifact.role, artifact.kind, artifact.at, now, name, searchable(name))
        const id = (this.db.prepare("SELECT id FROM artifact WHERE identity_key = ?").get(identity) as { id: number }).id
        const key = sourceKey(identity, session.id)
        claimed.add(key)
        touched.add(id)
        this.db
          .prepare(
            `INSERT INTO artifact_source (source_key, artifact_id, session_id, session_title, directory, path, role, kind, produced_at, observed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_key) DO UPDATE SET
               session_id = excluded.session_id, session_title = excluded.session_title, directory = excluded.directory, path = excluded.path,
               role = excluded.role, kind = excluded.kind, produced_at = excluded.produced_at, observed_at = excluded.observed_at`,
          )
          .run(key, id, session.id, session.title, session.directory, artifact.path, artifact.role, artifact.kind, artifact.at, now)
      }
      const stale = (
        this.db.prepare("SELECT source_key, artifact_id FROM artifact_source WHERE session_id = ?").all(session.id) as unknown as {
          source_key: string
          artifact_id: number
        }[]
      ).filter((row) => !claimed.has(row.source_key))
      for (const row of stale) {
        this.db.prepare("DELETE FROM artifact_source WHERE source_key = ?").run(row.source_key)
        touched.add(row.artifact_id)
      }
      for (const id of touched) this.settle(id, now)
      if (fingerprint === undefined) return
      this.db
        .prepare(
          `INSERT INTO artifact_reconcile (session_id, fingerprint, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
        )
        .run(session.id, fingerprint, now)
    })
  }

  /**
   * Points a file's row at the source it is shown under, or removes a row no
   * conversation claims any more.
   *
   * The newest conversation that still exists wins; a file only gone
   * conversations wrote is shown under the newest of those. Which one must not
   * depend on the order the passes ran in, so it is decided from the sources
   * alone, with the key as the last tie-break.
   */
  private settle(id: number, now: number): void {
    const best = this.db
      .prepare(
        `SELECT * FROM artifact_source WHERE artifact_id = ?
         ORDER BY (session_id <> '') DESC, produced_at DESC, source_key ASC LIMIT 1`,
      )
      .get(id) as SourceRow | undefined
    if (!best) {
      this.db.prepare("DELETE FROM artifact WHERE id = ?").run(id)
      return
    }
    const newest = (this.db.prepare("SELECT max(produced_at) AS at FROM artifact_source WHERE artifact_id = ?").get(id) as { at: number }).at
    const name = titleOf(best.path)
    this.db
      .prepare(
        `UPDATE artifact SET session_id = ?, session_title = ?, directory = ?, path = ?, role = ?, kind = ?,
           produced_at = ?, title = ?, title_search = ?, updated_at = ? WHERE id = ?`,
      )
      .run(best.session_id, best.session_title, best.directory, best.path, best.role, best.kind, newest, name, searchable(name), now, id)
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
    const rows = this.db.prepare("SELECT id, absolute FROM artifact").all() as { id: number; absolute: string }[]
    const now = Date.now()
    for (const row of rows) {
      const stats = await fsp.stat(row.absolute).catch(() => undefined)
      const there = Boolean(stats?.isFile())
      this.db
        .prepare("UPDATE artifact SET availability = ?, size_bytes = ?, modified_at = ?, last_checked_at = ? WHERE id = ?")
        .run(there ? "available" : "missing", there ? (stats?.size ?? null) : null, there ? (stats?.mtimeMs ?? null) : null, now, row.id)
    }
  }

  /**
   * Everything produced, grouped by the conversation each file is shown under.
   *
   * A group whose conversation has been deleted keeps the title it had, so the
   * files it made are still findable - which is the whole point of storing them
   * rather than deriving them.
   *
   * The search is MiMo's: the query is trimmed, NFC-normalised and lower-cased,
   * and matched against the file's title only. Three characters or more go
   * through the trigram index as one quoted phrase; shorter ones, which a
   * trigram index cannot answer, are a plain substring test.
   */
  list(query = ""): SessionArtifacts[] {
    const words = searchable(query.trim())
    const rows = (
      !words
        ? this.db.prepare("SELECT * FROM artifact ORDER BY produced_at DESC").all()
        : words.length >= 3
          ? this.db
              .prepare(
                "SELECT * FROM artifact WHERE id IN (SELECT artifact_id FROM artifact_fts WHERE artifact_fts MATCH ?) ORDER BY produced_at DESC",
              )
              .all(`"${words.replace(/"/g, '""')}"`)
          : this.db.prepare("SELECT * FROM artifact WHERE instr(title_search, ?) > 0 ORDER BY produced_at DESC").all(words)
    ) as unknown as Row[]
    const groups = new Map<string, SessionArtifacts>()
    for (const row of rows) {
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
   * Removes a deleted conversation's link to what it wrote, and nothing else.
   *
   * Its sources stay, unlinked but still carrying the title the conversation
   * had: the files are still on disk, and this is the one record of where they
   * came from. A file another existing conversation also wrote is shown under
   * that one from now on; a file only gone conversations wrote is shown under
   * the newest of them. The conversation is tombstoned, as MiMo's
   * `artifact_purged_session` is, so a pass already under way cannot link it
   * back.
   */
  detach(sessionID: string): void {
    if (!this.writable || !sessionID) return
    const now = Date.now()
    this.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO artifact_purged_session (session_id, purged_at) VALUES (?, ?)")
        .run(sessionID, now)
      this.db.prepare("DELETE FROM artifact_reconcile WHERE session_id = ?").run(sessionID)
      const touched = this.db.prepare("SELECT DISTINCT artifact_id FROM artifact_source WHERE session_id = ?").all(sessionID) as unknown as {
        artifact_id: number
      }[]
      this.db.prepare("UPDATE artifact_source SET session_id = '' WHERE session_id = ?").run(sessionID)
      for (const row of touched) this.settle(row.artifact_id, now)
    })
  }

  /** The conversations each file's sources name, for the checks. */
  sourcesOf(absolute: string): { sessionID: string; title: string }[] {
    const rows = this.db
      .prepare(
        `SELECT s.session_id, s.session_title FROM artifact_source s JOIN artifact a ON a.id = s.artifact_id
         WHERE a.identity_key = ? ORDER BY s.produced_at DESC, s.source_key ASC`,
      )
      .all(identityKey(absolute)) as { session_id: string; session_title: string }[]
    return rows.map((row) => ({ sessionID: row.session_id, title: row.session_title }))
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

  private purged(sessionID: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS x FROM artifact_purged_session WHERE session_id = ?").get(sessionID))
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      work()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}
