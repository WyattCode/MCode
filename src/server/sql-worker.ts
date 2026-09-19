import fs from "node:fs"
import { Worker } from "node:worker_threads"

/**
 * SQLite on a thread of its own (N11-12), as MiMo runs each of its databases
 * in a worker (its artifact, rolechat, transcript and review stores).
 *
 * `node:sqlite` is synchronous. Run on the main process's thread - which is
 * also where every turn streams, every tool reports and every window's socket
 * is answered - each statement stopped all of that for as long as it took, and
 * a write under the default `synchronous = FULL` waited for the disk to flush.
 * Here each database has a worker; the main thread sends it a statement and
 * carries on.
 *
 * The worker is started from source rather than from a file, so it runs the
 * same way in the packaged app, in development and in the checks - it needs
 * nothing but `node:sqlite` itself. Every statement the stores used to run is
 * run here unchanged; only the calling side became asynchronous.
 *
 * As MiMo's client does, each request has a deadline (15 seconds unless the
 * caller says otherwise), and a worker that fails or exits rejects everything
 * still waiting on it rather than leaving it hanging.
 */

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads")
const { DatabaseSync } = require("node:sqlite")
let db
const statements = new Map()
function statement(sql) {
  let found = statements.get(sql)
  if (!found) {
    found = db.prepare(sql)
    if (statements.size > 200) statements.delete(statements.keys().next().value)
    statements.set(sql, found)
  }
  return found
}
function plain(value) {
  return typeof value === "bigint" ? Number(value) : value
}
parentPort.on("message", (message) => {
  try {
    let result = null
    switch (message.op) {
      case "open":
        db = new DatabaseSync(message.file)
        break
      case "exec":
        db.exec(message.sql)
        break
      case "all":
        result = statement(message.sql).all(...message.params)
        break
      case "get":
        result = statement(message.sql).get(...message.params)
        break
      case "run": {
        const done = statement(message.sql).run(...message.params)
        result = { changes: plain(done.changes), lastInsertRowid: plain(done.lastInsertRowid) }
        break
      }
      case "close":
        statements.clear()
        if (db) db.close()
        db = undefined
        break
      default:
        throw new Error("unknown operation " + message.op)
    }
    parentPort.postMessage({ id: message.id, ok: true, result })
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: { message: String((error && error.message) || error), code: error && error.code, errcode: error && error.errcode },
    })
  }
})
`

/** MiMo's per-request deadline. */
export const SQL_REQUEST_TIMEOUT_MS = 15_000

export type SqlValue = string | number | null | bigint | Uint8Array

export interface SqlRun {
  changes: number
  lastInsertRowid: number
}

/** The statements a store runs, whether directly or inside a transaction. */
export interface Sql {
  exec(sql: string, options?: { timeoutMs?: number }): Promise<void>
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined>
  run(sql: string, ...params: SqlValue[]): Promise<SqlRun>
}

interface Waiting {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/** An error the worker sent back, with the fields `node:sqlite` gave it, so callers can still tell what it was. */
export class SqlError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly errcode?: number,
  ) {
    super(message)
  }
}

/**
 * One SQLite file, open in a worker.
 *
 * Statements run one at a time and in the order they were sent. A
 * transaction holds the database for as long as its work runs: statements
 * sent through the database meanwhile wait for it to finish, so its work must
 * use the handle it is given, never the database itself.
 */
export class SqlDatabase implements Sql {
  private readonly worker: Worker
  private next = 1
  private readonly waiting = new Map<number, Waiting>()
  private dead: Error | undefined
  /** What the database is held by: a plain statement, or a whole transaction. */
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(readonly file: string) {
    this.worker = new Worker(WORKER_SOURCE, { eval: true })
    this.worker.on("message", (reply: { id: number; ok: boolean; result?: unknown; error?: { message: string; code?: string; errcode?: number } }) => {
      const found = this.waiting.get(reply.id)
      if (!found) return
      this.waiting.delete(reply.id)
      clearTimeout(found.timer)
      if (reply.ok) found.resolve(reply.result)
      else found.reject(new SqlError(reply.error?.message ?? "SQLite failed", reply.error?.code, reply.error?.errcode))
    })
    this.worker.on("error", (error) => this.fail(error))
    this.worker.on("exit", (code) => this.fail(new Error(`the SQLite worker for ${file} exited (${code})`)))
  }

  /** Opens `file` in a worker of its own. Throws what SQLite said when the file will not open. */
  static async open(file: string): Promise<SqlDatabase> {
    const database = new SqlDatabase(file)
    try {
      await database.send({ op: "open", file })
    } catch (error) {
      await database.terminate()
      throw error
    }
    return database
  }

  private fail(error: Error): void {
    if (this.dead) return
    this.dead = error
    for (const [id, found] of this.waiting) {
      clearTimeout(found.timer)
      found.reject(error)
      this.waiting.delete(id)
    }
  }

  private send(message: Record<string, unknown>, timeoutMs = SQL_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead)
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(`SQLite did not answer within ${Math.round(timeoutMs / 1000)}s (${String(message.op)} on ${this.file})`))
      }, timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      this.worker.postMessage({ id, ...message })
    })
  }

  /** Waits its turn behind whatever holds the database, then runs. */
  private turn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(work)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** The statements themselves, without waiting for the queue - for a transaction's own work. */
  private readonly direct: Sql = {
    exec: async (sql, options) => {
      await this.send({ op: "exec", sql }, options?.timeoutMs)
    },
    all: async <T>(sql: string, ...params: SqlValue[]) => (await this.send({ op: "all", sql, params })) as T[],
    get: async <T>(sql: string, ...params: SqlValue[]) => ((await this.send({ op: "get", sql, params })) ?? undefined) as T | undefined,
    run: async (sql, ...params) => (await this.send({ op: "run", sql, params })) as SqlRun,
  }

  exec(sql: string, options?: { timeoutMs?: number }): Promise<void> {
    return this.turn(() => this.direct.exec(sql, options))
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return this.turn(() => this.direct.all<T>(sql, ...params))
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return this.turn(() => this.direct.get<T>(sql, ...params))
  }

  run(sql: string, ...params: SqlValue[]): Promise<SqlRun> {
    return this.turn(() => this.direct.run(sql, ...params))
  }

  /** Runs `work` as one transaction: all of it lands, or none of it does. */
  transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    return this.turn(async () => {
      await this.direct.exec("BEGIN IMMEDIATE")
      try {
        const result = await work(this.direct)
        await this.direct.exec("COMMIT")
        return result
      } catch (error) {
        await this.direct.exec("ROLLBACK").catch(() => undefined)
        throw error
      }
    })
  }

  /** Closes the file and ends the worker. Closing twice is harmless. */
  async close(): Promise<void> {
    if (!this.dead) await this.turn(() => this.send({ op: "close" })).catch(() => undefined)
    await this.terminate()
  }

  private async terminate(): Promise<void> {
    this.fail(new Error(`the SQLite worker for ${this.file} was closed`))
    await this.worker.terminate().catch(() => undefined)
  }
}

/**
 * The pragmas every store opens with (N11-12): MiMo's set. `busy_timeout`
 * waits out another connection's lock instead of failing at once - two
 * development instances can open one profile - and `synchronous = NORMAL` is
 * WAL's safe setting, which flushes at checkpoints rather than on every commit.
 */
export const STORE_PRAGMAS = ["PRAGMA busy_timeout = 5000", "PRAGMA journal_mode = WAL", "PRAGMA synchronous = NORMAL", "PRAGMA temp_store = MEMORY"]

/** The files SQLite keeps beside a database, which go wherever the database goes. */
const JOURNALS = ["", "-wal", "-shm", "-journal"]

/**
 * Whether a failure to open a store means the file itself is damaged.
 *
 * MiMo's `isCorruption`: only these are grounds for moving a file aside. "The
 * file is locked by another instance", "the virus scanner holds the -wal" and
 * an EACCES on a read-only folder all fail an open too, and starting a store
 * over for one of those is a silent, avoidable loss.
 */
export function sqliteDamaged(failure: unknown): boolean {
  const text = failure instanceof Error ? `${failure.message} ${String((failure as { code?: unknown }).code ?? "")}` : String(failure)
  return /integrity check failed|failed its integrity check|database disk image is malformed|file is not a database|SQLITE_(?:CORRUPT|NOTADB)/i.test(text)
}

/**
 * Moves a damaged database aside as `<file>.corrupt-<time>`, its journal files
 * with it - a `-wal` left beside a fresh database is itself a way to corrupt
 * one - as MiMo's runner quarantines its own.
 *
 * @returns where it went, or undefined when it could not be moved.
 */
export function quarantineSqlite(file: string): string | undefined {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  for (let attempt = 0; attempt < 4; attempt++) {
    const aside = attempt === 0 ? `${file}.corrupt-${stamp}` : `${file}.corrupt-${stamp}-${attempt}`
    if (fs.existsSync(aside)) continue
    try {
      for (const suffix of JOURNALS) {
        if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, aside + suffix)
      }
      return aside
    } catch {
      // Tried again under another name.
    }
  }
  return undefined
}

/** Deletes a database and the journal files beside it. */
export function removeSqlite(file: string): void {
  for (const suffix of JOURNALS) fs.rmSync(file + suffix, { force: true })
}
