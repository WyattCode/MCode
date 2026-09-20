import fs from "node:fs"
import path from "node:path"
import { SqlDatabase, STORE_PRAGMAS, quarantineSqlite, removeSqlite, sqliteDamaged, type Sql } from "../sql-worker"

/**
 * The SQLite file behind history and memory search.
 *
 * Nothing in it is a record of its own: conversations stay in the JSON store
 * and memory in its markdown files, and both indexes are rebuilt from those.
 * So a file that cannot be opened, fails its integrity check or was written by
 * a different schema is simply deleted and made again - the one thing that
 * must not happen is the app failing to start over a search index.
 */

/**
 * Bumped whenever the tables change; a file at another version is rebuilt.
 * 2: the full-text tables index `search_body` - the body with CJK writing cut
 * into characters (history/text.ts) - rather than the body itself.
 */
export const SCHEMA_VERSION = 2

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS history_part (
  id INTEGER PRIMARY KEY,
  part_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool_name TEXT,
  body TEXT NOT NULL,
  search_body TEXT NOT NULL,
  time_created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_part_session ON history_part (session_id, time_created);
CREATE INDEX IF NOT EXISTS history_part_project ON history_part (project, time_created);
CREATE INDEX IF NOT EXISTS history_part_message ON history_part (message_id);
CREATE VIRTUAL TABLE IF NOT EXISTS history_part_fts USING fts5(
  search_body, content='history_part', content_rowid='id', tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS history_part_ai AFTER INSERT ON history_part BEGIN
  INSERT INTO history_part_fts(rowid, search_body) VALUES (new.id, new.search_body);
END;
CREATE TRIGGER IF NOT EXISTS history_part_ad AFTER DELETE ON history_part BEGIN
  INSERT INTO history_part_fts(history_part_fts, rowid, search_body) VALUES ('delete', old.id, old.search_body);
END;
CREATE TRIGGER IF NOT EXISTS history_part_au AFTER UPDATE ON history_part BEGIN
  INSERT INTO history_part_fts(history_part_fts, rowid, search_body) VALUES ('delete', old.id, old.search_body);
  INSERT INTO history_part_fts(rowid, search_body) VALUES (new.id, new.search_body);
END;
CREATE TABLE IF NOT EXISTS history_session (
  session_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_doc (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  search_body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_doc_scope ON memory_doc (scope, scope_id);
CREATE INDEX IF NOT EXISTS memory_doc_type ON memory_doc (type);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_doc_fts USING fts5(
  search_body, content='memory_doc', content_rowid='id', tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS memory_doc_ai AFTER INSERT ON memory_doc BEGIN
  INSERT INTO memory_doc_fts(rowid, search_body) VALUES (new.id, new.search_body);
END;
CREATE TRIGGER IF NOT EXISTS memory_doc_ad AFTER DELETE ON memory_doc BEGIN
  INSERT INTO memory_doc_fts(memory_doc_fts, rowid, search_body) VALUES ('delete', old.id, old.search_body);
END;
CREATE TRIGGER IF NOT EXISTS memory_doc_au AFTER UPDATE ON memory_doc BEGIN
  INSERT INTO memory_doc_fts(memory_doc_fts, rowid, search_body) VALUES ('delete', old.id, old.search_body);
  INSERT INTO memory_doc_fts(rowid, search_body) VALUES (new.id, new.search_body);
END;
`

/** How the file came to be open, for a caller that wants to say so. */
export type OpenedAs = "existing" | "created" | "recreated"

export class IndexDatabase {
  private constructor(
    /** The file, open in a worker of its own (N11-12). */
    readonly db: SqlDatabase,
    readonly file: string,
    readonly openedAs: OpenedAs,
  ) {}

  /**
   * Opens the index at `file`, making it when it is missing and making it
   * again when it is damaged or from another schema.
   */
  static async open(file: string): Promise<IndexDatabase> {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const existed = fs.existsSync(file)
    try {
      return new IndexDatabase(await IndexDatabase.connect(file), file, existed ? "existing" : "created")
    } catch (failure) {
      /*
       * Only a damaged index, or one from another schema, is started over.
       *
       * A bare catch could not tell "this file is not a database" from "another
       * instance of this app holds it", "the virus scanner has the -wal open"
       * or an EACCES on a read-only data folder. Those pass, and deleting a
       * long history's index over one is a silent, avoidable rebuild. The
       * reference gates its own recovery on the same test and rethrows
       * everything else.
       *
       * A file from another schema is not damage and is not kept (L12-15).
       * It is what a downgrade, an upgrade, or a development build sharing the
       * profile with the installed one leaves behind, and the index holds
       * nothing that cannot be made again - so keeping a copy at every flip
       * only filled the folder with whole indexes nobody would look at.
       */
      if (IndexDatabase.otherSchema(failure)) removeSqlite(file)
      else if (sqliteDamaged(failure)) IndexDatabase.quarantine(file)
      else throw failure
      return new IndexDatabase(await IndexDatabase.connect(file), file, "recreated")
    }
  }

  /** This app's own word for a file from another schema. */
  private static otherSchema(failure: unknown): boolean {
    return /is at schema/i.test(failure instanceof Error ? failure.message : String(failure))
  }

  /**
   * Moves a damaged index aside rather than deleting it.
   *
   * Nothing in it cannot be rebuilt, so this is not about recovery - it is so
   * that a file this app could not read is still there to be looked at when
   * the rebuild turns out to have been triggered by something worth fixing.
   */
  private static quarantine(file: string): void {
    // The app must open with a working index even where the rename cannot happen.
    if (!quarantineSqlite(file)) removeSqlite(file)
  }

  private static async connect(file: string): Promise<SqlDatabase> {
    const db = await SqlDatabase.open(file)
    try {
      const check = await db.get("PRAGMA quick_check")
      if (check && Object.values(check)[0] !== "ok") throw new Error("the index failed its integrity check")
      const version = Number((await db.get("PRAGMA user_version"))?.user_version ?? 0)
      const tables = (await db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'"))!
      // A file with tables from another schema is not patched: it is started over.
      if (tables.n > 0 && version !== SCHEMA_VERSION) throw new Error(`the index is at schema ${version}`)
      // MiMo's pragmas (N11-12): WAL as before, plus a busy wait and WAL's own flushing.
      for (const pragma of STORE_PRAGMAS) await db.exec(pragma)
      await db.exec(SCHEMA)
      await db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      return db
    } catch (failure) {
      // Already unusable; the file is removed next either way.
      await db.close()
      throw failure
    }
  }

  async meta(key: string): Promise<string | undefined> {
    const row = await this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
    return row?.value
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
  }

  /** Runs `work` as one transaction: all of it lands, or none of it does. Its statements go through `tx`. */
  transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    return this.db.transaction(work)
  }

  /** Closing twice, or after a failure, changes nothing worth reporting. */
  close(): Promise<void> {
    return this.db.close()
  }
}
