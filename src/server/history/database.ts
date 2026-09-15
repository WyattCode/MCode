import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

/**
 * The SQLite file behind history and memory search.
 *
 * Nothing in it is a record of its own: conversations stay in the JSON store
 * and memory in its markdown files, and both indexes are rebuilt from those.
 * So a file that cannot be opened, fails its integrity check or was written by
 * a different schema is simply deleted and made again - the one thing that
 * must not happen is the app failing to start over a search index.
 */

/** Bumped whenever the tables change; a file at another version is rebuilt. */
export const SCHEMA_VERSION = 1

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
  time_created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_part_session ON history_part (session_id, time_created);
CREATE INDEX IF NOT EXISTS history_part_project ON history_part (project, time_created);
CREATE INDEX IF NOT EXISTS history_part_message ON history_part (message_id);
CREATE VIRTUAL TABLE IF NOT EXISTS history_part_fts USING fts5(
  body, content='history_part', content_rowid='id', tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS history_part_ai AFTER INSERT ON history_part BEGIN
  INSERT INTO history_part_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS history_part_ad AFTER DELETE ON history_part BEGIN
  INSERT INTO history_part_fts(history_part_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS history_part_au AFTER UPDATE ON history_part BEGIN
  INSERT INTO history_part_fts(history_part_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO history_part_fts(rowid, body) VALUES (new.id, new.body);
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
  fingerprint TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_doc_scope ON memory_doc (scope, scope_id);
CREATE INDEX IF NOT EXISTS memory_doc_type ON memory_doc (type);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_doc_fts USING fts5(
  body, content='memory_doc', content_rowid='id', tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS memory_doc_ai AFTER INSERT ON memory_doc BEGIN
  INSERT INTO memory_doc_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memory_doc_ad AFTER DELETE ON memory_doc BEGIN
  INSERT INTO memory_doc_fts(memory_doc_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memory_doc_au AFTER UPDATE ON memory_doc BEGIN
  INSERT INTO memory_doc_fts(memory_doc_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO memory_doc_fts(rowid, body) VALUES (new.id, new.body);
END;
`

/** How the file came to be open, for a caller that wants to say so. */
export type OpenedAs = "existing" | "created" | "recreated"

export class IndexDatabase {
  private constructor(
    readonly db: DatabaseSync,
    readonly file: string,
    readonly openedAs: OpenedAs,
  ) {}

  /**
   * Opens the index at `file`, making it when it is missing and making it
   * again when it is damaged or from another schema.
   */
  static open(file: string): IndexDatabase {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const existed = fs.existsSync(file)
    try {
      return new IndexDatabase(IndexDatabase.connect(file), file, existed ? "existing" : "created")
    } catch {
      IndexDatabase.remove(file)
      return new IndexDatabase(IndexDatabase.connect(file), file, "recreated")
    }
  }

  private static connect(file: string): DatabaseSync {
    const db = new DatabaseSync(file)
    try {
      const check = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined
      if (check && Object.values(check)[0] !== "ok") throw new Error("the index failed its integrity check")
      const version = Number((db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined)?.user_version ?? 0)
      const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
      // A file with tables from another schema is not patched: it is started over.
      if (tables.n > 0 && version !== SCHEMA_VERSION) throw new Error(`the index is at schema ${version}`)
      db.exec("PRAGMA journal_mode = WAL")
      db.exec(SCHEMA)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      return db
    } catch (failure) {
      try {
        db.close()
      } catch {
        // Already unusable; the file is removed next either way.
      }
      throw failure
    }
  }

  /** The file and the journal files SQLite keeps beside it. */
  private static remove(file: string): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(file + suffix, { force: true })
  }

  meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
    return row?.value
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
  }

  /** Runs `work` as one transaction: all of it lands, or none of it does. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = work()
      this.db.exec("COMMIT")
      return result
    } catch (failure) {
      this.db.exec("ROLLBACK")
      throw failure
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // Closing twice, or after a failure, changes nothing worth reporting.
    }
  }
}
