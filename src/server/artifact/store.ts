import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { SqlDatabase, STORE_PRAGMAS, quarantineSqlite, sqliteDamaged, type Sql } from "../sql-worker"
import type { ArtifactFacets, ArtifactFile, Message, SessionArtifacts, SessionInfo } from "@shared/protocol"
import { sessionArtifacts } from "@shared/session-files"
import { APP_EXTENSIONS, DOC_EXTENSIONS, type ArtifactCategory } from "@shared/artifact-category"

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
 * What it deliberately does NOT do is rebuild itself when it merely cannot
 * understand the file, which is what the search index does. The search index is
 * derived from the transcripts and can always be made again; this holds the one
 * record of files whose conversations are gone, so a version it does not
 * understand is read as far as it goes and never written over.
 *
 * A file that is damaged - it fails its integrity check, or is not a database
 * at all - is another matter (L12-7). Left in place it switched the store off
 * on every launch for good, so it is moved aside with its journal files, as
 * MiMo's runner quarantines its own, and a fresh store is filled again from the
 * transcripts by the next reconcile. The damaged copy is kept and the window is
 * told where.
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
CREATE INDEX IF NOT EXISTS artifact_newest ON artifact (produced_at, id);
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
  absolute: string
  role: string
  produced_at: number
  last_checked_at: number
  availability: string
  size_bytes: number | null
  modified_at: number | null
}

/** MiMo's page size, and the most one listing may ask for. */
export const ARTIFACT_LIST_LIMIT = 50

/**
 * How many changed conversations a listing reads before it answers. More than
 * this - a first run, or an upgrade from a build without the store - is a
 * background pass, and the listing answers from what is already stored.
 */
export const INLINE_RECONCILE = 8

/** How long a conversation's writes must pause before what it produced is read again. */
export const ARTIFACT_SETTLE_MS = 2000

/** A file found missing is asked about again after this long, not on every listing. */
const MISSING_RECHECK_MS = 5 * 60_000

/** How many files are asked about at once when every file is re-checked. */
const RECHECK_PARALLEL = 16

/** How many re-check answers go into one transaction. */
const RECORD_BATCH = 200

export interface ArtifactQuery {
  query?: string
  category?: ArtifactCategory
  cursor?: string
  limit?: number
}

export interface ArtifactPage {
  artifacts: SessionArtifacts[]
  nextCursor?: string
  facets: ArtifactFacets
}

/** Whether a row's name puts it in a tab, in SQL: the same test as `artifactCategory`, on the lower-cased name. */
function categorySql(category: Exclude<ArtifactCategory, "other">): string {
  const extensions = category === "doc" ? DOC_EXTENSIONS : APP_EXTENSIONS
  // "_%" keeps a name that only starts with the dot out, as `extensionOf` does.
  return `(${extensions.map((extension) => `title_search LIKE '_%.${extension}'`).join(" OR ")})`
}

/** Where the next page starts: after the last row the previous one looked at. */
function cursorOf(row: { produced_at: number; id: number }): string {
  return `${row.produced_at}:${row.id}`
}

function readCursor(cursor: string | undefined): { at: number; id: number } | undefined {
  if (!cursor) return undefined
  const found = /^(\d+):(\d+)$/.exec(cursor)
  if (!found) throw new Error("invalid artifact cursor")
  return { at: Number(found[1]), id: Number(found[2]) }
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
  /** Whether the pass under way is a long one (more than INLINE_RECONCILE conversations), which no listing waits for. */
  private bulk = false
  /**
   * Every conversation's checkpoint as last written, read once (S13-3). A
   * listing compares the conversations with this in memory instead of asking
   * the database about each of them.
   */
  private checkpoints: Map<string, string> | undefined
  /**
   * Conversations whose messages were written since their last pass, with a
   * count that moves on every write so a pass can tell a write that landed
   * while it was reading.
   */
  private readonly dirty = new Map<string, number>()

  private constructor(
    /** The store's file, open in a worker of its own (N11-12). */
    private readonly db: SqlDatabase,
    /** False when the file was written by a later build: read it, never write it. */
    readonly writable: boolean,
  ) {}

  /**
   * Where a damaged file was moved before this store was made again, so the
   * window can say so; absent for a store that opened as it was.
   */
  recovered: string | undefined

  /**
   * Opens the store, making it if it is not there, and making it again if the
   * file is damaged. Never throws: without it the app still runs and the page
   * falls back to reading the transcripts.
   */
  static async open(file: string): Promise<ArtifactStore | undefined> {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      return await ArtifactStore.connect(file)
    } catch (failure) {
      const why = failure instanceof Error ? failure.message : String(failure)
      // A lock, a sharing violation or a read-only folder is not damage: the file is left exactly where it is.
      if (!sqliteDamaged(failure)) {
        console.warn(`[artifacts] the store could not be opened (${why}); the page reads the conversations instead`)
        return undefined
      }
      const aside = quarantineSqlite(file)
      if (!aside) {
        console.warn(`[artifacts] ${file} is damaged (${why}) and could not be moved aside; the store stays off`)
        return undefined
      }
      console.warn(`[artifacts] ${file} was damaged (${why}); it was kept as ${aside} and the store was started again`)
      try {
        const store = await ArtifactStore.connect(file)
        store.recovered = aside
        return store
      } catch {
        return undefined
      }
    }
  }

  private static async connect(file: string): Promise<ArtifactStore> {
    const db = await SqlDatabase.open(file)
    try {
      const check = await db.get("PRAGMA quick_check")
      if (check && Object.values(check)[0] !== "ok") throw new Error("the artifact store failed its integrity check")
      // MiMo's pragmas (N11-12), and foreign keys as before.
      for (const pragma of STORE_PRAGMAS) await db.exec(pragma)
      await db.exec("PRAGMA foreign_keys = ON")
      await db.exec(SCHEMA_V1)
      const latest = (await db.get<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations"))?.v ?? 0
      if (latest > ARTIFACT_SCHEMA_VERSION) {
        // A newer build wrote this. Everything it holds is still readable; nothing here may write over it.
        return new ArtifactStore(db, false)
      }
      if (latest < 2) await ArtifactStore.migrateToV2(db)
      return new ArtifactStore(db, true)
    } catch (failure) {
      await db.close()
      throw failure
    }
  }

  /**
   * Version 1 to 2, in one transaction so a crash leaves version 1 untouched.
   *
   * Every row keeps its place: the conversation it named becomes its one source
   * (a row whose conversation was already gone keeps that title, unlinked), and
   * its title is filled in so the search index covers it from the start.
   */
  private static migrateToV2(db: SqlDatabase): Promise<void> {
    return db.transaction(async (tx) => {
      await tx.exec(SCHEMA_V2)
      const rows = await tx.all<SourceRow & { id: number; identity_key: string }>(
        "SELECT id, identity_key, session_id, session_title, directory, path, role, kind, produced_at FROM artifact",
      )
      const now = Date.now()
      for (const row of rows) {
        const name = titleOf(row.path)
        await tx.run("UPDATE artifact SET title = ?, title_search = ? WHERE id = ?", name, searchable(name), row.id)
        const key = row.session_id ? sourceKey(row.identity_key, row.session_id) : JSON.stringify([row.identity_key, "", row.session_title])
        await tx.run(
          `INSERT OR IGNORE INTO artifact_source (source_key, artifact_id, session_id, session_title, directory, path, role, kind, produced_at, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          key,
          row.id,
          row.session_id,
          row.session_title,
          row.directory,
          row.path,
          row.role,
          row.kind,
          row.produced_at,
          now,
        )
      }
      await tx.run("INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)", 2, now)
    })
  }

  /** True while a long pass is filling the store, so a listing may be missing what it has not reached yet. */
  get building(): boolean {
    return this.running !== undefined && this.bulk
  }

  /**
   * Brings the store up to date with what the conversations say; with
   * `recheck`, also asks the disk whether each file is still there.
   *
   * Only conversations that changed since their last pass are read again (the
   * checkpoint is MiMo's `artifact_reconcile`), and which ones those are is
   * decided in memory. Concurrent callers share one pass.
   */
  reconcile(sessions: readonly SessionInfo[], messagesOf: (sessionID: string) => Promise<Message[]>, options: { recheck?: boolean } = {}): Promise<void> {
    if (!this.writable) return Promise.resolve()
    if (this.running) return this.running
    return (async () => {
      const known = await this.known()
      return this.running ?? this.begin(this.behind(sessions, known), messagesOf, options.recheck === true)
    })()
  }

  /** Starts a pass over `behind`; whether it is a long one is known before anything waits on it. */
  private begin(behind: readonly SessionInfo[], messagesOf: (sessionID: string) => Promise<Message[]>, recheck: boolean): Promise<void> {
    this.bulk = behind.length > INLINE_RECONCILE
    // A long pass has added files nothing has asked the disk about yet; the tabs' counts would take them on trust.
    const checkAll = recheck || this.bulk
    this.running = (async () => {
      await this.pass(behind, messagesOf)
      if (checkAll) await this.recheck()
    })().finally(() => {
      this.running = undefined
      this.bulk = false
    })
    return this.running
  }

  /** The checkpoints, read from the database the first time only. */
  private async known(): Promise<Map<string, string>> {
    if (this.checkpoints) return this.checkpoints
    const rows = await this.db.all<{ session_id: string; fingerprint: string }>("SELECT session_id, fingerprint FROM artifact_reconcile")
    // A checkpoint touched() dropped while this was read stays dropped: the dirty count is what says so.
    this.checkpoints ??= new Map(rows.map((row) => [row.session_id, row.fingerprint]))
    return this.checkpoints
  }

  /** The top-level conversations written since their last pass, or never passed at all. */
  private behind(sessions: readonly SessionInfo[], known: Map<string, string>): SessionInfo[] {
    // subagents: a subagent's work belongs to its parent, not to a conversation of its own.
    return sessions.filter((session) => !session.parentID && (this.dirty.has(session.id) || known.get(session.id) !== fingerprintOf(session)))
  }

  /**
   * One listing's answer (S13-3), as MiMo's is: never a walk of every
   * conversation and every file.
   *
   * The few conversations written since their last pass - the one in front of
   * the user, typically - are read first, so a file written a moment ago is
   * there. Many at once is a first run or an upgrade: that pass goes on in the
   * background, and the page is answered from what is stored so far and told
   * so. Only the page's own files are asked about on disk.
   */
  async answer(
    sessions: readonly SessionInfo[],
    messagesOf: (sessionID: string) => Promise<Message[]>,
    query: ArtifactQuery = {},
  ): Promise<ArtifactPage & { building: boolean }> {
    if (this.writable) {
      const known = await this.known()
      if (!this.running) {
        const behind = this.behind(sessions, known)
        if (behind.length) void this.begin(behind, messagesOf, false).catch(() => undefined)
      }
      if (this.running && !this.bulk) await this.running.catch(() => undefined)
    }
    const page = await this.list(query)
    return { ...page, building: this.building }
  }

  private async pass(sessions: readonly SessionInfo[], messagesOf: (sessionID: string) => Promise<Message[]>): Promise<void> {
    for (const session of sessions) {
      const fingerprint = fingerprintOf(session)
      const writes = this.dirty.get(session.id)
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
      await this.reconcileSession(session, messages, settled ? fingerprint : undefined)
    }
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
    this.checkpoints?.delete(sessionID)
    if (writes === undefined) void this.db.run("DELETE FROM artifact_reconcile WHERE session_id = ?", sessionID).catch(() => undefined)
  }

  /**
   * One conversation's claims, replaced as a whole.
   *
   * Every file it wrote gets (or keeps) a source row for it. A file it no longer
   * claims - the message was edited away - loses this conversation's source, and
   * a file left with no source at all goes, as MiMo's reconcile removes it.
   */
  private async reconcileSession(session: SessionInfo, messages: readonly Message[], fingerprint: string | undefined): Promise<void> {
    const now = Date.now()
    const checkpointed = await this.db.transaction(async (tx) => {
      // Checked inside the transaction, so a detach cannot land between the check and the writes.
      if (await tx.get("SELECT 1 AS x FROM artifact_purged_session WHERE session_id = ?", session.id)) return false
      const claimed = new Set<string>()
      const touched = new Set<number>()
      for (const artifact of sessionArtifacts(messages, session.directory)) {
        const absolute = path.resolve(session.directory, artifact.path)
        const identity = identityKey(absolute)
        const name = titleOf(artifact.path)
        await tx.run(
          `INSERT INTO artifact (identity_key, session_id, session_title, directory, path, absolute, role, kind, produced_at, updated_at, title, title_search)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(identity_key) DO NOTHING`,
          identity,
          session.id,
          session.title,
          session.directory,
          artifact.path,
          absolute,
          artifact.role,
          artifact.kind,
          artifact.at,
          now,
          name,
          searchable(name),
        )
        const id = (await tx.get<{ id: number }>("SELECT id FROM artifact WHERE identity_key = ?", identity))!.id
        const key = sourceKey(identity, session.id)
        claimed.add(key)
        touched.add(id)
        await tx.run(
          `INSERT INTO artifact_source (source_key, artifact_id, session_id, session_title, directory, path, role, kind, produced_at, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_key) DO UPDATE SET
             session_id = excluded.session_id, session_title = excluded.session_title, directory = excluded.directory, path = excluded.path,
             role = excluded.role, kind = excluded.kind, produced_at = excluded.produced_at, observed_at = excluded.observed_at`,
          key,
          id,
          session.id,
          session.title,
          session.directory,
          artifact.path,
          artifact.role,
          artifact.kind,
          artifact.at,
          now,
        )
      }
      const stale = (await tx.all<{ source_key: string; artifact_id: number }>("SELECT source_key, artifact_id FROM artifact_source WHERE session_id = ?", session.id)).filter(
        (row) => !claimed.has(row.source_key),
      )
      for (const row of stale) {
        await tx.run("DELETE FROM artifact_source WHERE source_key = ?", row.source_key)
        touched.add(row.artifact_id)
      }
      for (const id of touched) await ArtifactStore.settle(tx, id, now)
      if (fingerprint === undefined) return false
      await tx.run(
        `INSERT INTO artifact_reconcile (session_id, fingerprint, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
        session.id,
        fingerprint,
        now,
      )
      return true
    })
    // A write that landed since the pass began has dropped it again, and it stays dropped.
    if (checkpointed && fingerprint !== undefined && !this.dirty.has(session.id)) this.checkpoints?.set(session.id, fingerprint)
  }

  /**
   * Points a file's row at the source it is shown under, or removes a row no
   * conversation claims any more.
   *
   * The newest conversation that still exists wins; a file only gone
   * conversations wrote is shown under the newest of those. Which one must not
   * depend on the order the passes ran in, so it is decided from the sources
   * alone, with the key as the last tie-break. Always inside the caller's
   * transaction, which is why it takes the transaction's handle.
   */
  private static async settle(tx: Sql, id: number, now: number): Promise<void> {
    const best = await tx.get<SourceRow>(
      `SELECT * FROM artifact_source WHERE artifact_id = ?
       ORDER BY (session_id <> '') DESC, produced_at DESC, source_key ASC LIMIT 1`,
      id,
    )
    if (!best) {
      await tx.run("DELETE FROM artifact WHERE id = ?", id)
      return
    }
    const newest = (await tx.get<{ at: number }>("SELECT max(produced_at) AS at FROM artifact_source WHERE artifact_id = ?", id))!.at
    const name = titleOf(best.path)
    await tx.run(
      `UPDATE artifact SET session_id = ?, session_title = ?, directory = ?, path = ?, role = ?, kind = ?,
         produced_at = ?, title = ?, title_search = ?, updated_at = ? WHERE id = ?`,
      best.session_id,
      best.session_title,
      best.directory,
      best.path,
      best.role,
      best.kind,
      newest,
      name,
      searchable(name),
      now,
      id,
    )
  }

  /**
   * Asks the file system about every file it holds, at launch.
   *
   * A conversation's record of writing a file says nothing about whether it is
   * still there: it may have been deleted, moved, or changed since by something
   * other than this app. MiMo re-checks the same way and keeps the answer in
   * `availability` with `last_checked_at`.
   *
   * A few files are asked about at once, and only the rows whose answer changed
   * are written, in one transaction (N11-12). A listing asks about its own page
   * only (`inspect`); this keeps the tabs' counts honest between launches.
   */
  async recheck(): Promise<void> {
    if (!this.writable) return
    const rows = await this.db.all<Row>("SELECT * FROM artifact")
    let next = 0
    const answers: Row[] = []
    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++]!
        const answer = await ArtifactStore.ask(row)
        if (ArtifactStore.differs(row, answer)) answers.push(answer)
      }
    }
    await Promise.all(Array.from({ length: Math.min(RECHECK_PARALLEL, rows.length) }, worker))
    await this.record(answers)
  }

  /** What the disk says about one file now, as the row it would be. */
  private static async ask(row: Row): Promise<Row> {
    const stats = await fsp.stat(row.absolute).catch(() => undefined)
    const there = Boolean(stats?.isFile())
    return {
      ...row,
      availability: there ? "available" : "missing",
      size_bytes: there ? (stats?.size ?? null) : null,
      modified_at: there ? (stats?.mtimeMs ?? null) : null,
      last_checked_at: Date.now(),
    }
  }

  /** Whether an answer is worth writing: it changed, or it is a missing file whose last check is going stale. */
  private static differs(row: Row, answer: Row): boolean {
    if (row.availability !== answer.availability || row.size_bytes !== answer.size_bytes || row.modified_at !== answer.modified_at) return true
    return answer.availability === "missing" && answer.last_checked_at - row.last_checked_at > MISSING_RECHECK_MS / 2
  }

  /** Writes the answers in one transaction; a store opened read-only keeps them in memory only. */
  private async record(answers: readonly Row[]): Promise<void> {
    if (!answers.length || !this.writable) return
    // A few hundred at a time, so a listing waiting behind a launch's full check is not held for all of it.
    for (let from = 0; from < answers.length; from += RECORD_BATCH) await this.recordBatch(answers.slice(from, from + RECORD_BATCH))
  }

  private async recordBatch(answers: readonly Row[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const answer of answers) {
        await tx.run(
          "UPDATE artifact SET availability = ?, size_bytes = ?, modified_at = ?, last_checked_at = ? WHERE id = ?",
          answer.availability,
          answer.size_bytes,
          answer.modified_at,
          answer.last_checked_at,
          answer.id,
        )
      }
    })
  }

  /**
   * One page of what is produced and still on disk, newest first, grouped by
   * the conversation each file is shown under (S13-3).
   *
   * A group whose conversation has been deleted keeps the title it had, so the
   * files it made are still findable - which is the whole point of storing them
   * rather than deriving them.
   *
   * The search is MiMo's: the query is trimmed, NFC-normalised and lower-cased,
   * and matched against the file's title only. Three characters or more go
   * through the trigram index as one quoted phrase; shorter ones, which a
   * trigram index cannot answer, are a plain substring test.
   *
   * As MiMo's list does, the page's candidates are asked about on disk before
   * they are shown, and one found gone is passed over for the next; a file
   * already found missing is not asked about again for a while. The counts
   * cover every file the search matches, whatever the tab, from what is stored.
   */
  async list(options: ArtifactQuery = {}): Promise<ArtifactPage> {
    const limit = Math.max(1, Math.min(ARTIFACT_LIST_LIMIT, Math.floor(options.limit ?? ARTIFACT_LIST_LIMIT)))
    const words = searchable((options.query ?? "").trim())
    const matched: string[] = []
    const params: (string | number)[] = []
    if (words.length >= 3) {
      matched.push("id IN (SELECT artifact_id FROM artifact_fts WHERE artifact_fts MATCH ?)")
      params.push(`"${words.replace(/"/g, '""')}"`)
    } else if (words) {
      matched.push("instr(title_search, ?) > 0")
      params.push(words)
    }
    const where = [...matched]
    if (options.category === "doc" || options.category === "app") where.push(categorySql(options.category))
    else if (options.category === "other") where.push(`NOT ${categorySql("doc")} AND NOT ${categorySql("app")}`)
    where.push("NOT (availability = 'missing' AND last_checked_at > ?)")

    const shown: Row[] = []
    let after = readCursor(options.cursor)
    let more = true
    while (shown.length < limit && more) {
      const need = limit - shown.length
      const clauses = [...where, ...(after ? ["(produced_at < ? OR (produced_at = ? AND id < ?))"] : [])]
      const rows = await this.db.all<Row>(
        `SELECT * FROM artifact WHERE ${clauses.join(" AND ")} ORDER BY produced_at DESC, id DESC LIMIT ?`,
        ...params,
        Date.now() - MISSING_RECHECK_MS,
        ...(after ? [after.at, after.at, after.id] : []),
        need + 1,
      )
      more = rows.length > need
      const batch = rows.slice(0, need)
      const answers = await Promise.all(batch.map((row) => ArtifactStore.ask(row)))
      await this.record(answers.filter((answer, at) => ArtifactStore.differs(batch[at]!, answer)))
      for (const answer of answers) if (answer.availability === "available") shown.push(answer)
      if (batch.length) after = { at: batch[batch.length - 1]!.produced_at, id: batch[batch.length - 1]!.id }
    }

    const counted = await this.db.get<{ total: number; doc: number | null; app: number | null }>(
      `SELECT count(*) AS total, sum(${categorySql("doc")}) AS doc, sum(${categorySql("app")}) AS app
       FROM artifact WHERE ${[...matched, "availability <> 'missing'"].join(" AND ")}`,
      ...params,
    )
    const total = Number(counted?.total ?? 0)
    const doc = Number(counted?.doc ?? 0)
    const app = Number(counted?.app ?? 0)
    return {
      artifacts: ArtifactStore.grouped(shown),
      ...(more && after ? { nextCursor: cursorOf({ produced_at: after.at, id: after.id }) } : {}),
      facets: { total, doc, app, other: total - doc - app },
    }
  }

  /** Rows as the page's groups: one per conversation a file is shown under, newest first. */
  private static grouped(rows: readonly Row[]): SessionArtifacts[] {
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
  async detach(sessionID: string): Promise<void> {
    if (!this.writable || !sessionID) return
    const now = Date.now()
    await this.db.transaction(async (tx) => {
      await tx.run("INSERT OR IGNORE INTO artifact_purged_session (session_id, purged_at) VALUES (?, ?)", sessionID, now)
      await tx.run("DELETE FROM artifact_reconcile WHERE session_id = ?", sessionID)
      this.checkpoints?.delete(sessionID)
      const touched = await tx.all<{ artifact_id: number }>("SELECT DISTINCT artifact_id FROM artifact_source WHERE session_id = ?", sessionID)
      await tx.run("UPDATE artifact_source SET session_id = '' WHERE session_id = ?", sessionID)
      for (const row of touched) await ArtifactStore.settle(tx, row.artifact_id, now)
    })
  }

  /** The conversations each file's sources name, for the checks. */
  async sourcesOf(absolute: string): Promise<{ sessionID: string; title: string }[]> {
    const rows = await this.db.all<{ session_id: string; session_title: string }>(
      `SELECT s.session_id, s.session_title FROM artifact_source s JOIN artifact a ON a.id = s.artifact_id
       WHERE a.identity_key = ? ORDER BY s.produced_at DESC, s.source_key ASC`,
      identityKey(absolute),
    )
    return rows.map((row) => ({ sessionID: row.session_id, title: row.session_title }))
  }

  /** How many rows it holds, for the checks. */
  async count(): Promise<number> {
    return Number((await this.db.get<{ n: number }>("SELECT count(*) AS n FROM artifact"))!.n)
  }

  /** Closing twice, or after a failure, changes nothing worth reporting. */
  close(): Promise<void> {
    return this.db.close()
  }

}
